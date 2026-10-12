// SPDX-License-Identifier: AGPL-3.0-only
package upstream

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const maxResponseBytes = 64 << 20
const maxDiscoveryBytes = 4 << 20
const maxEventBytes = 1 << 20

func NewClient(h *http.Client) *Client {
	if h == nil {
		h = &http.Client{Timeout: 5 * time.Minute}
	}
	copyClient := *h
	// Never forward credentials on redirects, including a supplied client's
	// permissive redirect policy. Dial-time SSRF checks belong to its transport.
	copyClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &Client{http: &copyClient}
}

func (c *Client) request(ctx context.Context, p ProviderConfig, method, path string, query url.Values, body any) (*http.Response, error) {
	u, err := url.Parse(p.BaseURL)
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("供应商地址格式无效")
	}
	u.Path = strings.TrimRight(u.Path, "/") + path
	u.RawPath = ""
	u.RawQuery = query.Encode()
	var reader io.Reader
	if body != nil {
		b, e := json.Marshal(body)
		if e != nil {
			return nil, errors.New("上游请求编码失败")
		}
		reader = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), reader)
	if err != nil {
		return nil, errors.New("上游请求地址无效")
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "text/event-stream")
	}
	switch p.Protocol {
	case "gemini":
		req.Header.Set("x-goog-api-key", p.APIKey)
	case "anthropic":
		req.Header.Set("x-api-key", p.APIKey)
		req.Header.Set("anthropic-version", "2023-06-01")
	default:
		req.Header.Set("Authorization", "Bearer "+p.APIKey)
	}
	res, err := c.http.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, errors.New("连接上游供应商失败")
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		res.Body.Close()
		return nil, fmt.Errorf("上游供应商返回 HTTP %d", res.StatusCode)
	}
	return res, nil
}

func (c *Client) Discover(ctx context.Context, p ProviderConfig) ([]DiscoveredModel, error) {
	if !validProtocol(p.Protocol) {
		return nil, errors.New("不支持的供应商协议")
	}
	models := []DiscoveredModel{}
	seen := map[string]bool{}
	cursor := ""
	seenCursor := map[string]bool{}
	for page := 0; page < 10; page++ {
		q := url.Values{}
		if p.Protocol == "gemini" {
			q.Set("pageSize", "100")
			if cursor != "" {
				q.Set("pageToken", cursor)
			}
		}
		if p.Protocol == "anthropic" {
			q.Set("limit", "100")
			if cursor != "" {
				q.Set("after_id", cursor)
			}
		}
		res, err := c.request(ctx, p, http.MethodGet, "/models", q, nil)
		if err != nil {
			return nil, err
		}
		data, err := io.ReadAll(io.LimitReader(res.Body, maxDiscoveryBytes+1))
		res.Body.Close()
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			return nil, errors.New("读取上游模型列表失败")
		}
		if len(data) > maxDiscoveryBytes {
			return nil, errors.New("上游模型列表超过大小限制")
		}
		var response struct {
			Error         json.RawMessage   `json:"error"`
			Data          []json.RawMessage `json:"data"`
			Models        []json.RawMessage `json:"models"`
			NextPageToken string            `json:"nextPageToken"`
			HasMore       bool              `json:"has_more"`
			LastID        string            `json:"last_id"`
		}
		if json.Unmarshal(data, &response) != nil {
			return nil, errors.New("上游模型列表格式无效")
		}
		if len(response.Error) > 0 && string(response.Error) != "null" {
			return nil, errors.New("上游模型列表返回错误")
		}
		var shape map[string]json.RawMessage
		_ = json.Unmarshal(data, &shape)
		listField := "data"
		if p.Protocol == "gemini" {
			listField = "models"
		}
		if _, ok := shape[listField]; !ok {
			return nil, errors.New("上游模型列表格式无效")
		}
		if p.Protocol == "gemini" {
			for _, raw := range response.Models {
				var v struct {
					Name        string   `json:"name"`
					DisplayName string   `json:"displayName"`
					Methods     []string `json:"supportedGenerationMethods"`
				}
				if json.Unmarshal(raw, &v) != nil {
					return nil, errors.New("上游模型列表格式无效")
				}
				if len(v.Methods) > 0 && !contains(v.Methods, "generateContent") {
					continue
				}
				id := strings.TrimPrefix(v.Name, "models/")
				if id != "" && !seen[id] {
					name := v.DisplayName
					if name == "" {
						name = id
					}
					models = append(models, DiscoveredModel{ID: id, Name: name, Metadata: publicMetadata(p, raw)})
					seen[id] = true
				}
			}
			cursor = response.NextPageToken
		} else {
			for _, raw := range response.Data {
				var v struct {
					ID          string `json:"id"`
					Name        string `json:"name"`
					DisplayName string `json:"display_name"`
				}
				if json.Unmarshal(raw, &v) != nil {
					return nil, errors.New("上游模型列表格式无效")
				}
				if v.ID != "" && !seen[v.ID] {
					name := v.Name
					if v.DisplayName != "" {
						name = v.DisplayName
					}
					if name == "" {
						name = v.ID
					}
					models = append(models, DiscoveredModel{ID: v.ID, Name: name, Metadata: publicMetadata(p, raw)})
					seen[v.ID] = true
				}
			}
			cursor = ""
			if p.Protocol == "anthropic" && response.HasMore {
				cursor = response.LastID
				if cursor == "" {
					return nil, errors.New("上游模型列表分页游标缺失")
				}
			}
		}
		if cursor == "" {
			return models, nil
		}
		if seenCursor[cursor] {
			return nil, errors.New("上游模型列表分页循环")
		}
		seenCursor[cursor] = true
	}
	return nil, errors.New("上游模型列表超过分页限制")
}

func validProtocol(p string) bool {
	return p == "openai-chat" || p == "openai-responses" || p == "gemini" || p == "anthropic"
}
func contains(a []string, v string) bool {
	for _, x := range a {
		if x == v {
			return true
		}
	}
	return false
}

// continuation stays server-side. Raw blocks/items preserve encrypted data,
// signatures, block order and provider-specific extension fields.
type continuation struct {
	Protocol         string            `json:"protocol"`
	Model            string            `json:"model"`
	Adapter          string            `json:"adapter"`
	BaseURL          string            `json:"baseUrl"`
	Content          []json.RawMessage `json:"content,omitempty"`
	Parts            []json.RawMessage `json:"parts,omitempty"`
	Output           []json.RawMessage `json:"output,omitempty"`
	ReasoningContent string            `json:"reasoningContent,omitempty"`
	ReasoningDetails []json.RawMessage `json:"reasoningDetails,omitempty"`
}

func readContinuation(p ProviderConfig, m ModelConfig, msg Message) (continuation, error) {
	var v continuation
	if msg.Role != "assistant" || len(msg.Metadata) == 0 || string(msg.Metadata) == "null" {
		return v, nil
	}
	if len(msg.Metadata) > maxResponseBytes || json.Unmarshal(msg.Metadata, &v) != nil {
		return v, errors.New("历史消息续接数据无效")
	}
	if v.Protocol != p.Protocol || v.Model != m.ModelID || v.Adapter != p.Adapter || v.BaseURL != p.BaseURL {
		return continuation{}, nil
	}
	return v, nil
}

func (c *Client) Stream(ctx context.Context, p ProviderConfig, m ModelConfig, history []Message, onDelta func(string) error) (json.RawMessage, error) {
	if !validProtocol(p.Protocol) {
		return nil, errors.New("不支持的供应商协议")
	}
	if m.ModelID == "" || len(m.ModelID) > 256 {
		return nil, errors.New("模型标识无效")
	}
	prof := profileWithMetadata(p.Adapter, p.Protocol, m.ModelID, m.Metadata)
	if m.MaxOutputTokens == 0 {
		m.MaxOutputTokens = prof.capability.OutputMax
	}
	if err := ValidateReasoning(prof.capability, m.Reasoning, m.MaxOutputTokens); err != nil {
		return nil, err
	}
	body, path, query, err := buildRequest(p, m, history, prof)
	if err != nil {
		return nil, err
	}
	res, err := c.request(ctx, p, http.MethodPost, path, query, body)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	media, _, _ := mime.ParseMediaType(res.Header.Get("Content-Type"))
	if media != "text/event-stream" {
		return nil, errors.New("上游未返回 SSE 流")
	}
	state := newStreamState(p, m, onDelta)
	err = parseSSE(io.LimitReader(res.Body, maxResponseBytes+1), func(event, data string) error { return state.consume(event, data) })
	if ctx.Err() != nil {
		return state.metadata(), ctx.Err()
	}
	if err != nil && !errors.Is(err, errStreamDone) {
		return state.metadata(), err
	}
	if !state.terminal {
		return state.metadata(), errors.New("上游流在完成标记前关闭")
	}
	if !state.textSeen {
		return state.metadata(), errors.New("上游未返回文本回答")
	}
	return state.metadata(), nil
}

func buildRequest(p ProviderConfig, m ModelConfig, history []Message, prof profile) (map[string]any, string, url.Values, error) {
	b := map[string]any{"model": m.ModelID, "stream": true}
	q := url.Values{}
	path := ""
	items := []any{}
	systems := []string{}
	for _, msg := range history {
		if msg.Role != "user" && msg.Role != "assistant" && msg.Role != "system" {
			return nil, "", nil, errors.New("历史消息角色无效")
		}
		meta, err := readContinuation(p, m, msg)
		if err != nil {
			return nil, "", nil, err
		}
		switch p.Protocol {
		case "gemini":
			if msg.Role == "system" {
				systems = append(systems, msg.Content)
				continue
			}
			role := "user"
			if msg.Role == "assistant" {
				role = "model"
			}
			parts := []any{map[string]any{"text": msg.Content}}
			if len(meta.Parts) > 0 {
				parts = []any{}
				for _, v := range meta.Parts {
					parts = append(parts, v)
				}
			}
			items = append(items, map[string]any{"role": role, "parts": parts})
		case "anthropic":
			if msg.Role == "system" {
				systems = append(systems, msg.Content)
				continue
			}
			var content any = msg.Content
			if len(meta.Content) > 0 {
				content = meta.Content
			}
			items = append(items, map[string]any{"role": msg.Role, "content": content})
		case "openai-responses":
			if len(meta.Output) > 0 {
				for _, v := range meta.Output {
					items = append(items, v)
				}
			} else {
				items = append(items, map[string]any{"role": msg.Role, "content": msg.Content})
			}
		default:
			v := map[string]any{"role": msg.Role, "content": msg.Content}
			if meta.ReasoningContent != "" {
				v["reasoning_content"] = meta.ReasoningContent
			}
			if len(meta.ReasoningDetails) > 0 {
				v["reasoning_details"] = meta.ReasoningDetails
			}
			items = append(items, v)
		}
	}
	switch p.Protocol {
	case "openai-chat":
		path = "/chat/completions"
		b["messages"] = items
		key := "max_tokens"
		if prof.capability.Family == "openai" && p.Adapter != "openrouter" && p.Adapter != "siliconflow" {
			key = "max_completion_tokens"
		}
		b[key] = m.MaxOutputTokens
	case "openai-responses":
		path = "/responses"
		b["input"] = items
		b["max_output_tokens"] = m.MaxOutputTokens
		b["store"] = false
		if prof.capability.Known && prof.capability.Family == "openai" {
			b["include"] = []string{"reasoning.encrypted_content"}
		}
	case "anthropic":
		path = "/messages"
		b["messages"] = items
		b["max_tokens"] = m.MaxOutputTokens
		if len(systems) > 0 {
			b["system"] = strings.Join(systems, "\n\n")
		}
	case "gemini":
		id := strings.TrimPrefix(m.ModelID, "models/")
		if strings.ContainsAny(id, "/:?#\\") {
			return nil, "", nil, errors.New("Gemini 模型标识无效")
		}
		path = "/models/" + id + ":streamGenerateContent"
		q.Set("alt", "sse")
		delete(b, "model")
		delete(b, "stream")
		b["contents"] = items
		b["generationConfig"] = map[string]any{"maxOutputTokens": m.MaxOutputTokens}
		if len(systems) > 0 {
			b["systemInstruction"] = map[string]any{"parts": []any{map[string]any{"text": strings.Join(systems, "\n\n")}}}
		}
	}
	applyReasoning(b, p, m, prof)
	return b, path, q, nil
}

func applyReasoning(b map[string]any, p ProviderConfig, m ModelConfig, prof profile) {
	r := m.Reasoning
	if r.Enabled == nil && r.Effort == "" && r.BudgetTokens == nil {
		return
	}
	if prof.mode == "router" {
		v := map[string]any{}
		if r.Enabled != nil {
			v["enabled"] = *r.Enabled
		}
		if r.Effort != "" {
			v["effort"] = r.Effort
		}
		if r.BudgetTokens != nil {
			v["max_tokens"] = *r.BudgetTokens
		}
		b["reasoning"] = v
		return
	}
	switch p.Protocol {
	case "gemini":
		v := map[string]any{}
		if r.Effort != "" {
			v["thinkingLevel"] = r.Effort
		}
		if r.BudgetTokens != nil {
			v["thinkingBudget"] = *r.BudgetTokens
		}
		if r.Enabled != nil && prof.mode == "budget" {
			if !*r.Enabled {
				v["thinkingBudget"] = 0
			} else if r.BudgetTokens == nil {
				v["thinkingBudget"] = -1
			}
		}
		b["generationConfig"].(map[string]any)["thinkingConfig"] = v
	case "anthropic":
		if r.Effort != "" {
			b["output_config"] = map[string]any{"effort": r.Effort}
		}
		if r.Enabled != nil || r.BudgetTokens != nil {
			kind := "adaptive"
			if r.Enabled != nil && !*r.Enabled {
				kind = prof.offType
			} else if prof.mode == "manual" {
				kind = "enabled"
			}
			v := map[string]any{"type": kind}
			if kind == "enabled" {
				budget := 1024
				if r.BudgetTokens != nil {
					budget = *r.BudgetTokens
				}
				v["budget_tokens"] = budget
			}
			b["thinking"] = v
		}
	case "openai-responses":
		v := map[string]any{}
		if r.Effort != "" {
			v["effort"] = r.Effort
		}
		if r.Enabled != nil && !*r.Enabled {
			v["effort"] = "none"
		}
		if r.Enabled != nil && *r.Enabled && r.Effort == "" && prof.capability.SupportsToggle {
			v["effort"] = "medium"
		}
		if len(v) > 0 {
			b["reasoning"] = v
		}
	default:
		if r.Effort != "" {
			b["reasoning_effort"] = r.Effort
		}
		switch prof.mode {
		case "enable":
			if r.Enabled != nil {
				b["enable_thinking"] = *r.Enabled
			}
			if r.BudgetTokens != nil {
				b["thinking_budget"] = *r.BudgetTokens
			}
		case "toggle":
			if r.Enabled != nil {
				kind := "enabled"
				if !*r.Enabled {
					kind = "disabled"
				}
				b["thinking"] = map[string]any{"type": kind}
			}
		case "effort":
			if r.Enabled != nil && !*r.Enabled {
				b["reasoning_effort"] = "none"
			}
			if r.Enabled != nil && *r.Enabled && r.Effort == "" && prof.capability.SupportsToggle {
				b["reasoning_effort"] = "medium"
			}
		}
	}
}
