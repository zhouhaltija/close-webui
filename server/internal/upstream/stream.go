// SPDX-License-Identifier: AGPL-3.0-only
package upstream

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"sort"
	"strings"
	"unicode/utf8"
)

var errStreamDone = errors.New("stream done")

// SSE framing is incremental and bounded. Scanner buffers complete UTF-8 JSON
// lines even if a transport splits multibyte characters. Comments and unknown
// SSE fields are ignored; data lines are joined as specified by EventSource.
func parseSSE(r io.Reader, consume func(string, string) error) error {
	s := bufio.NewScanner(r)
	s.Buffer(make([]byte, 4096), maxEventBytes)
	s.Split(splitSSELine)
	event := ""
	data := []string{}
	size := 0
	first := true
	dispatch := func() error {
		if len(data) == 0 {
			return nil
		}
		v := strings.Join(data, "\n")
		if !utf8.ValidString(v) {
			return errors.New("上游流包含无效 UTF-8")
		}
		err := consume(event, v)
		event = ""
		data = nil
		size = 0
		return err
	}
	for s.Scan() {
		line := s.Text()
		if first {
			line = strings.TrimPrefix(line, "\ufeff")
			first = false
		}
		if line == "" {
			if err := dispatch(); err != nil {
				return err
			}
			event = ""
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue
		}
		field, value, found := strings.Cut(line, ":")
		if !found {
			value = ""
		}
		value = strings.TrimPrefix(value, " ")
		switch field {
		case "event":
			event = value
		case "data":
			size += len(value) + 1
			if size > maxEventBytes {
				return errors.New("上游流事件超过大小限制")
			}
			data = append(data, value)
		}
	}
	if s.Err() != nil {
		return errors.New("读取上游流失败或事件超过大小限制")
	}
	// An unterminated SSE event at EOF is not dispatched.
	return nil
}

func splitSSELine(data []byte, atEOF bool) (advance int, token []byte, err error) {
	for i, b := range data {
		if b == '\n' {
			return i + 1, data[:i], nil
		}
		if b == '\r' {
			if i+1 == len(data) && !atEOF {
				return 0, nil, nil
			}
			n := 1
			if i+1 < len(data) && data[i+1] == '\n' {
				n = 2
			}
			return i + n, data[:i], nil
		}
	}
	if atEOF && len(data) > 0 {
		return len(data), data, nil
	}
	return 0, nil, nil
}

type streamState struct {
	meta               continuation
	onDelta            func(string) error
	terminal, textSeen bool
	stopReason         string
	blocks             map[int]map[string]any
	openBlocks         map[int]bool
	details            map[int]map[string]any
	outputItems        map[int]json.RawMessage
}

func newStreamState(p ProviderConfig, m ModelConfig, onDelta func(string) error) *streamState {
	return &streamState{meta: continuation{Protocol: p.Protocol, Model: m.ModelID, Adapter: p.Adapter, BaseURL: p.BaseURL}, onDelta: onDelta, blocks: map[int]map[string]any{}, openBlocks: map[int]bool{}, details: map[int]map[string]any{}, outputItems: map[int]json.RawMessage{}}
}
func (s *streamState) text(v string) error {
	if v == "" {
		return nil
	}
	s.textSeen = true
	if s.onDelta != nil {
		return s.onDelta(v)
	}
	return nil
}
func object(v any) map[string]any                { m, _ := v.(map[string]any); return m }
func array(v any) []any                          { a, _ := v.([]any); return a }
func str(v any) string                           { x, _ := v.(string); return x }
func index(v any) int                            { x, _ := v.(float64); return int(x) }
func raw(v any) json.RawMessage                  { b, _ := json.Marshal(v); return b }
func (s *streamState) metadata() json.RawMessage { v, _ := json.Marshal(s.meta); return v }
func (s *streamState) finish() error             { s.terminal = true; return errStreamDone }

func (s *streamState) consume(event, data string) error {
	if data == "[DONE]" {
		if s.meta.Protocol == "openai-chat" {
			return s.finish()
		}
		return errors.New("上游流包含不兼容的完成标记")
	}
	var v map[string]any
	if json.Unmarshal([]byte(data), &v) != nil {
		return errors.New("上游流事件 JSON 无效")
	}
	if _, ok := v["error"]; ok || event == "error" {
		return errors.New("上游供应商流式响应失败")
	}
	switch s.meta.Protocol {
	case "openai-chat":
		return s.chat(v)
	case "openai-responses":
		return s.responses(v, event)
	case "gemini":
		return s.gemini(v)
	case "anthropic":
		return s.anthropic(v, event)
	}
	return errors.New("上游协议无效")
}

func (s *streamState) chat(v map[string]any) error {
	for _, item := range array(v["choices"]) {
		choice := object(item)
		if index(choice["index"]) != 0 {
			continue
		}
		delta := object(choice["delta"])
		if str(delta["refusal"]) != "" {
			return errors.New("上游拒绝了本次请求")
		}
		if len(array(delta["tool_calls"])) > 0 || delta["function_call"] != nil {
			return errors.New("当前仅支持文本回答")
		}
		s.meta.ReasoningContent += str(delta["reasoning_content"])
		if str(delta["reasoning_content"]) == "" {
			s.meta.ReasoningContent += str(delta["reasoning"])
		}
		for _, detail := range array(delta["reasoning_details"]) {
			d := object(detail)
			i := index(d["index"])
			if old := s.details[i]; old != nil {
				for k, v := range d {
					if k == "text" || k == "data" || k == "signature" {
						old[k] = str(old[k]) + str(v)
					} else {
						old[k] = v
					}
				}
			} else {
				s.details[i] = d
			}
		}
		if len(s.details) > 0 {
			s.meta.ReasoningDetails = nil
			keys := []int{}
			for i := range s.details {
				keys = append(keys, i)
			}
			sort.Ints(keys)
			for _, i := range keys {
				s.meta.ReasoningDetails = append(s.meta.ReasoningDetails, raw(s.details[i]))
			}
		}
		if err := s.text(str(delta["content"])); err != nil {
			return err
		}
		if reason := str(choice["finish_reason"]); reason != "" {
			s.stopReason = reason
			if reason != "stop" {
				return errors.New("上游回答未正常完成")
			}
		}
	}
	return nil
}

func (s *streamState) responses(v map[string]any, event string) error {
	kind := str(v["type"])
	if kind == "" {
		kind = event
	}
	switch kind {
	case "error", "response.failed", "response.incomplete":
		return errors.New("上游回答失败或未完成")
	case "response.refusal.delta", "response.refusal.done":
		return errors.New("上游拒绝了本次请求")
	case "response.output_text.delta":
		return s.text(str(v["delta"]))
	case "response.output_item.done":
		item := object(v["item"])
		if err := validateResponseItem(item); err != nil {
			return err
		}
		s.outputItems[index(v["output_index"])] = raw(item)
	case "response.completed":
		response := object(v["response"])
		if str(response["status"]) != "completed" {
			return errors.New("上游回答未正常完成")
		}
		s.meta.Output = nil
		if output := array(response["output"]); len(output) > 0 {
			for _, item := range output {
				if err := validateResponseItem(object(item)); err != nil {
					return err
				}
				s.meta.Output = append(s.meta.Output, raw(item))
			}
		} else {
			keys := []int{}
			for k := range s.outputItems {
				keys = append(keys, k)
			}
			sort.Ints(keys)
			for _, k := range keys {
				s.meta.Output = append(s.meta.Output, s.outputItems[k])
			}
		}
		return s.finish()
	}
	return nil
}

func validateResponseItem(item map[string]any) error {
	kind := str(item["type"])
	if kind != "message" && kind != "reasoning" {
		return errors.New("当前仅支持文本回答")
	}
	if kind == "message" {
		for _, part := range array(item["content"]) {
			p := object(part)
			if str(p["type"]) == "refusal" {
				return errors.New("上游拒绝了本次请求")
			}
			if str(p["type"]) != "output_text" {
				return errors.New("当前仅支持文本回答")
			}
		}
	}
	return nil
}

func (s *streamState) gemini(v map[string]any) error {
	if feedback := object(v["promptFeedback"]); str(feedback["blockReason"]) != "" {
		return errors.New("上游拒绝了本次请求")
	}
	for _, item := range array(v["candidates"]) {
		candidate := object(item)
		if index(candidate["index"]) != 0 {
			continue
		}
		content := object(candidate["content"])
		for _, part := range array(content["parts"]) {
			p := object(part)
			if p["functionCall"] != nil || p["inlineData"] != nil || p["fileData"] != nil {
				return errors.New("当前仅支持文本回答")
			}
			s.meta.Parts = append(s.meta.Parts, raw(part))
			thought, _ := p["thought"].(bool)
			if !thought {
				if err := s.text(str(p["text"])); err != nil {
					return err
				}
			}
		}
		if reason := str(candidate["finishReason"]); reason != "" {
			if reason != "STOP" {
				return errors.New("上游回答未正常完成")
			}
			return s.finish()
		}
	}
	return nil
}

func (s *streamState) anthropic(v map[string]any, event string) error {
	kind := str(v["type"])
	if kind == "" {
		kind = event
	}
	i := index(v["index"])
	switch kind {
	case "error":
		return errors.New("上游供应商流式响应失败")
	case "content_block_start":
		block := object(v["content_block"])
		typ := str(block["type"])
		if typ != "text" && typ != "thinking" && typ != "redacted_thinking" {
			return errors.New("当前仅支持文本回答")
		}
		if s.blocks[i] != nil {
			return errors.New("上游内容块序列无效")
		}
		s.blocks[i] = block
		s.openBlocks[i] = true
		if typ == "text" {
			return s.text(str(block["text"]))
		}
	case "content_block_delta":
		block := s.blocks[i]
		if block == nil || !s.openBlocks[i] {
			return errors.New("上游内容块序列无效")
		}
		delta := object(v["delta"])
		switch str(delta["type"]) {
		case "text_delta":
			if str(block["type"]) != "text" {
				return errors.New("上游内容块类型无效")
			}
			text := str(delta["text"])
			block["text"] = str(block["text"]) + text
			return s.text(text)
		case "thinking_delta":
			if str(block["type"]) != "thinking" {
				return errors.New("上游内容块类型无效")
			}
			block["thinking"] = str(block["thinking"]) + str(delta["thinking"])
		case "signature_delta":
			block["signature"] = str(block["signature"]) + str(delta["signature"])
		}
	case "content_block_stop":
		if !s.openBlocks[i] {
			return errors.New("上游内容块序列无效")
		}
		delete(s.openBlocks, i)
	case "message_delta":
		reason := str(object(v["delta"])["stop_reason"])
		if reason != "" {
			s.stopReason = reason
			if reason != "end_turn" && reason != "stop_sequence" {
				return errors.New("上游回答未正常完成")
			}
		}
	case "message_stop":
		if s.stopReason == "" || len(s.openBlocks) > 0 {
			return errors.New("上游流在内容完成前结束")
		}
		keys := []int{}
		for k := range s.blocks {
			keys = append(keys, k)
		}
		sort.Ints(keys)
		s.meta.Content = nil
		for _, k := range keys {
			s.meta.Content = append(s.meta.Content, raw(s.blocks[k]))
		}
		return s.finish()
	}
	return nil
}
