// SPDX-License-Identifier: AGPL-3.0-only
package upstream

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const chatStream = "data: {\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"private\"},\"finish_reason\":null}]}\n\ndata: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"你好\"},\"finish_reason\":null}]}\n\ndata: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"
const responseStream = "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"你好\"}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[{\"type\":\"reasoning\",\"id\":\"r1\",\"encrypted_content\":\"signed\",\"summary\":[]},{\"type\":\"message\",\"role\":\"assistant\",\"phase\":\"final_answer\",\"content\":[{\"type\":\"output_text\",\"text\":\"你好\"}]}]}}\n\n"
const geminiStream = "data: {\"candidates\":[{\"index\":0,\"content\":{\"role\":\"model\",\"parts\":[{\"thought\":true,\"text\":\"private\"},{\"text\":\"你好\",\"thoughtSignature\":\"signed\"}]}}]}\n\ndata: {\"candidates\":[{\"index\":0,\"finishReason\":\"STOP\"}]}\n\n"
const anthropicStream = "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"m1\",\"role\":\"assistant\",\"content\":[],\"stop_reason\":null}}\n\nevent: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\",\"signature\":\"\"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"private\"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"signed\"}}\n\nevent: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\nevent: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"你好\"}}\n\nevent: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":1}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"

func TestNativeProtocolsStreamTextAndReplayOpaqueMetadata(t *testing.T) {
	for _, tc := range []struct {
		protocol, path, model, body string
		r                           Reasoning
	}{
		{"openai-chat", "/v1/chat/completions", "o3", chatStream, Reasoning{Effort: "high"}},
		{"openai-responses", "/v1/responses", "gpt-5", responseStream, Reasoning{Effort: "high"}},
		{"gemini", "/v1/models/gemini-2.5-pro:streamGenerateContent", "gemini-2.5-pro", geminiStream, Reasoning{BudgetTokens: intptr(1024)}},
		{"anthropic", "/v1/messages", "claude-sonnet-4-5", anthropicStream, Reasoning{Enabled: boolptr(true), BudgetTokens: intptr(1024)}},
	} {
		t.Run(tc.protocol, func(t *testing.T) {
			calls := 0
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				if r.URL.Path != tc.path {
					t.Errorf("path %s", r.URL.Path)
				}
				if tc.protocol == "gemini" {
					if r.Header.Get("x-goog-api-key") != "test-key" || r.URL.Query().Get("alt") != "sse" {
						t.Error("gemini authentication/query")
					}
				} else if tc.protocol == "anthropic" {
					if r.Header.Get("x-api-key") != "test-key" || r.Header.Get("anthropic-version") != "2023-06-01" {
						t.Error("anthropic auth/version")
					}
				} else if r.Header.Get("Authorization") != "Bearer test-key" {
					t.Error("bearer auth")
				}
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				b, _ := json.Marshal(body)
				if calls == 2 && !strings.Contains(string(b), "signed") && tc.protocol != "openai-chat" {
					t.Errorf("lost signed metadata: %s", b)
				}
				switch tc.protocol {
				case "openai-chat":
					if body["reasoning_effort"] != "high" || body["max_completion_tokens"] != float64(4096) {
						t.Errorf("chat parameters %s", b)
					}
				case "openai-responses":
					if body["store"] != false || !strings.Contains(string(b), "reasoning.encrypted_content") {
						t.Errorf("responses opaque-state configuration: %s", b)
					}
				case "gemini":
					if !strings.Contains(string(b), "thinkingBudget") {
						t.Errorf("gemini thinking %s", b)
					}
				case "anthropic":
					if !strings.Contains(string(b), "budget_tokens") {
						t.Errorf("anthropic thinking %s", b)
					}
				}
				w.Header().Set("Content-Type", "text/event-stream")
				// Byte-at-a-time writes exercise UTF-8 across transport chunks.
				for _, v := range []byte(tc.body) {
					_, _ = w.Write([]byte{v})
					w.(http.Flusher).Flush()
				}
			}))
			defer s.Close()
			p := ProviderConfig{Protocol: tc.protocol, Adapter: "standard", BaseURL: s.URL + "/v1", APIKey: "test-key"}
			m := ModelConfig{ModelID: tc.model, MaxOutputTokens: 4096, Reasoning: tc.r}
			client := NewClient(s.Client())
			var text strings.Builder
			meta, err := client.Stream(context.Background(), p, m, []Message{{Role: "user", Content: "问题"}}, func(v string) error { text.WriteString(v); return nil })
			if err != nil {
				t.Fatal(err)
			}
			if text.String() != "你好" {
				t.Fatalf("body leaked/lost: %q", text.String())
			}
			if len(meta) == 0 {
				t.Fatal("lost metadata")
			}
			_, err = client.Stream(context.Background(), p, m, []Message{{Role: "user", Content: "问题"}, {Role: "assistant", Content: "你好", Metadata: meta}, {Role: "user", Content: "继续"}}, func(string) error { return nil })
			if err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestGatewayFieldsOverrideVendorParameters(t *testing.T) {
	for _, tc := range []struct {
		adapter, model string
		r              Reasoning
		yes, no        []string
	}{
		{"openrouter", "anthropic/claude-sonnet-4.5", Reasoning{Enabled: boolptr(true), BudgetTokens: intptr(1024)}, []string{"reasoning", "max_tokens"}, []string{"thinking", "budget_tokens", "max_completion_tokens"}},
		{"siliconflow", "Qwen/Qwen3-235B-A22B", Reasoning{Enabled: boolptr(true), BudgetTokens: intptr(1024)}, []string{"enable_thinking", "thinking_budget"}, []string{"thinking", "reasoning", "max_completion_tokens"}},
		{"deepseek", "deepseek-flash", Reasoning{Enabled: boolptr(true), Effort: "max"}, []string{"thinking", "reasoning_effort"}, []string{"enable_thinking", "budget_tokens"}},
		{"qwen", "qwen-plus", Reasoning{Enabled: boolptr(true), BudgetTokens: intptr(1024)}, []string{"enable_thinking", "thinking_budget"}, []string{"thinking", "reasoning"}},
		{"kimi", "kimi-k3", Reasoning{Effort: "max"}, []string{"reasoning_effort"}, []string{"thinking", "enable_thinking"}},
		{"glm", "glm-5.3", Reasoning{Effort: "low"}, []string{"reasoning_effort"}, []string{"enable_thinking"}},
		{"standard", "custom-o3", Reasoning{}, []string{"max_tokens"}, []string{"reasoning_effort", "thinking"}},
	} {
		t.Run(tc.adapter+tc.model, func(t *testing.T) {
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var b map[string]any
				_ = json.NewDecoder(r.Body).Decode(&b)
				for _, k := range tc.yes {
					if _, ok := b[k]; !ok {
						t.Errorf("missing %s: %+v", k, b)
					}
				}
				for _, k := range tc.no {
					if _, ok := b[k]; ok {
						t.Errorf("unexpected %s: %+v", k, b)
					}
				}
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = io.WriteString(w, chatStream)
			}))
			defer s.Close()
			_, err := NewClient(s.Client()).Stream(context.Background(), ProviderConfig{Protocol: "openai-chat", Adapter: tc.adapter, BaseURL: s.URL}, ModelConfig{ModelID: tc.model, MaxOutputTokens: 4096, Reasoning: tc.r}, []Message{{Role: "user", Content: "hi"}}, func(string) error { return nil })
			if err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestStreamRejectsPrematureEOFAndProviderErrors(t *testing.T) {
	for _, tc := range []struct{ protocol, body string }{
		{"openai-chat", "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n"},
		{"openai-chat", "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}\n\ndata: [DONE]\n\n"},
		{"openai-chat", "data: {\"error\":{\"message\":\"secret-key\"}}\n\n"},
		{"openai-responses", "data: {\"type\":\"response.incomplete\",\"response\":{\"status\":\"incomplete\"}}\n\n"},
		{"openai-responses", "data: {\"type\":\"response.refusal.delta\",\"delta\":\"no\"}\n\n"},
		{"gemini", "data: {\"promptFeedback\":{\"blockReason\":\"SAFETY\"}}\n\n"},
		{"anthropic", "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"refusal\"}}\n\n"},
		{"anthropic", "data: {\"type\":\"message_stop\"}\n\n"},
	} {
		t.Run(tc.protocol+tc.body[:20], func(t *testing.T) {
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = io.WriteString(w, tc.body)
			}))
			defer s.Close()
			_, err := NewClient(s.Client()).Stream(context.Background(), ProviderConfig{Protocol: tc.protocol, BaseURL: s.URL, APIKey: "secret-key"}, ModelConfig{ModelID: "unknown", MaxOutputTokens: 4096}, []Message{{Role: "user", Content: "hi"}}, func(string) error { return nil })
			if err == nil {
				t.Fatal("accepted incomplete/error response")
			}
			if strings.Contains(err.Error(), "secret-key") {
				t.Fatal("leaked key")
			}
		})
	}
}

func TestStreamContextCancellationReachesUpstream(t *testing.T) {
	started := make(chan struct{})
	canceled := make(chan struct{})
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		close(started)
		<-r.Context().Done()
		close(canceled)
	}))
	defer s.Close()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := NewClient(s.Client()).Stream(ctx, ProviderConfig{Protocol: "openai-chat", BaseURL: s.URL}, ModelConfig{ModelID: "custom", MaxOutputTokens: 4096}, []Message{{Role: "user", Content: "hi"}}, func(string) error { return nil })
		done <- err
	}()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("request not started")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("wrong error %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("cancel blocked")
	}
	select {
	case <-canceled:
	case <-time.After(3 * time.Second):
		t.Fatal("upstream connection stayed open")
	}
}

func TestDiscoveryPaginationAuthenticationAndNames(t *testing.T) {
	for _, protocol := range []string{"openai-chat", "anthropic", "gemini"} {
		t.Run(protocol, func(t *testing.T) {
			calls := 0
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				w.Header().Set("Content-Type", "application/json")
				if r.URL.Path != "/v1/models" {
					t.Errorf("path %s", r.URL.Path)
				}
				switch protocol {
				case "gemini":
					if r.Header.Get("x-goog-api-key") != "k" {
						t.Error("auth")
					}
					if calls == 1 {
						_, _ = io.WriteString(w, `{"models":[{"name":"models/gemini-2.5-pro","displayName":"Gemini Pro","supportedGenerationMethods":["generateContent"]}],"nextPageToken":"next"}`)
					} else {
						if r.URL.Query().Get("pageToken") != "next" {
							t.Error("page token")
						}
						_, _ = io.WriteString(w, `{"models":[{"name":"models/gemini-2.5-flash","displayName":"Gemini Flash"}]}`)
					}
				case "anthropic":
					if calls == 1 {
						_, _ = io.WriteString(w, `{"data":[{"id":"claude-sonnet-4-5","display_name":"Claude"}],"has_more":true,"last_id":"cursor"}`)
					} else {
						if r.URL.Query().Get("after_id") != "cursor" {
							t.Error("cursor")
						}
						_, _ = io.WriteString(w, `{"data":[{"id":"claude-haiku-4-5"}],"has_more":false}`)
					}
				default:
					_, _ = io.WriteString(w, `{"data":[{"id":"o3","name":"OpenAI o3"},{"id":"gpt-5"}]}`)
				}
			}))
			defer s.Close()
			models, err := NewClient(s.Client()).Discover(context.Background(), ProviderConfig{Protocol: protocol, BaseURL: s.URL + "/v1", APIKey: "k"})
			if err != nil {
				t.Fatal(err)
			}
			if len(models) != 2 || models[0].Name == "" || models[0].ID == "" {
				t.Fatalf("models %+v", models)
			}
			if protocol != "openai-chat" && calls != 2 {
				t.Fatal("pagination omitted")
			}
		})
	}
}

func TestAdaptiveThinkingAndProviderDefaults(t *testing.T) {
	for _, tc := range []struct {
		protocol, id string
		r            Reasoning
		want, absent string
	}{
		{"anthropic", "claude-sonnet-5-5", Reasoning{Enabled: boolptr(false), Effort: "low"}, `"type":"between_tools"`, `"budget_tokens"`},
		{"anthropic", "claude-opus-5-5", Reasoning{Enabled: boolptr(true), Effort: "max"}, `"type":"adaptive"`, `"budget_tokens"`},
		{"gemini", "gemini-3-flash-preview", Reasoning{Enabled: boolptr(true), Effort: "low"}, `"thinkingLevel":"low"`, `"thinkingBudget"`},
		{"openai-chat", "gpt-5.1", Reasoning{Enabled: boolptr(true)}, `"reasoning_effort":"medium"`, `"thinking"`},
		{"openai-chat", "o3", Reasoning{}, `"max_completion_tokens":4096`, `"reasoning_effort"`},
	} {
		t.Run(tc.id, func(t *testing.T) {
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				body, _ := io.ReadAll(r.Body)
				if !strings.Contains(string(body), tc.want) || strings.Contains(string(body), tc.absent) {
					t.Errorf("incorrect parameters %s", body)
				}
				w.Header().Set("Content-Type", "text/event-stream")
				bodyText := chatStream
				if tc.protocol == "anthropic" {
					bodyText = anthropicStream
				}
				if tc.protocol == "gemini" {
					bodyText = geminiStream
				}
				_, _ = io.WriteString(w, bodyText)
			}))
			defer s.Close()
			_, err := NewClient(s.Client()).Stream(context.Background(), ProviderConfig{Protocol: tc.protocol, Adapter: "standard", BaseURL: s.URL}, ModelConfig{ModelID: tc.id, MaxOutputTokens: 4096, Reasoning: tc.r}, []Message{{Role: "user", Content: "hi"}}, func(string) error { return nil })
			if err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestMetadataIsNotReplayedAcrossProviderModelOrProtocol(t *testing.T) {
	metadata := json.RawMessage(`{"protocol":"anthropic","adapter":"standard","model":"claude-sonnet-4-5","baseUrl":"https://different.example/v1","content":[{"type":"thinking","thinking":"private","signature":"secret-signature"},{"type":"text","text":"answer"}]}`)
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if strings.Contains(string(body), "secret-signature") {
			t.Error("cross-provider signature replay")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, anthropicStream)
	}))
	defer s.Close()
	_, err := NewClient(s.Client()).Stream(context.Background(), ProviderConfig{Protocol: "anthropic", Adapter: "standard", BaseURL: s.URL}, ModelConfig{ModelID: "claude-sonnet-4-5", MaxOutputTokens: 4096}, []Message{{Role: "user", Content: "hi"}, {Role: "assistant", Content: "answer", Metadata: metadata}, {Role: "user", Content: "again"}}, func(string) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
}

func TestRedirectCannotForwardAPIKeyAndHTTPErrorsStaySanitized(t *testing.T) {
	leaked := false
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked = true }))
	defer target.Close()
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer s.Close()
	_, err := NewClient(s.Client()).Discover(context.Background(), ProviderConfig{Protocol: "openai-chat", BaseURL: s.URL, APIKey: "sensitive"})
	if err == nil || leaked || strings.Contains(err.Error(), "sensitive") {
		t.Fatalf("redirect leaked=%v err=%v", leaked, err)
	}
}

func TestSSEFramingPreservesMultilineDataAndComments(t *testing.T) {
	input := "\ufeff: comment\r\nevent: response.output_text.delta\r\ndata: {\"type\":\"response.output_text.delta\",\r\ndata: \"delta\":\"你好\"}\r\n\r\n"
	state := newStreamState(ProviderConfig{Protocol: "openai-responses"}, ModelConfig{ModelID: "x"}, func(v string) error {
		if v != "你好" {
			t.Errorf("delta %q", v)
		}
		return nil
	})
	if err := parseSSE(strings.NewReader(input), state.consume); err != nil {
		t.Fatal(err)
	}
	if !state.textSeen {
		t.Fatal("lost multiline data")
	}
	if err := parseSSE(strings.NewReader("data: "+strings.Repeat("x", maxEventBytes)+"\n\n"), state.consume); err == nil {
		t.Fatal("accepted oversized event")
	}
}

func TestCallbackErrorStopsUpstreamImmediately(t *testing.T) {
	want := errors.New("persistence failure")
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, chatStream)
	}))
	defer s.Close()
	_, err := NewClient(s.Client()).Stream(context.Background(), ProviderConfig{Protocol: "openai-chat", BaseURL: s.URL}, ModelConfig{ModelID: "custom", MaxOutputTokens: 4096}, []Message{{Role: "user", Content: "hi"}}, func(string) error { return want })
	if !errors.Is(err, want) {
		t.Fatalf("callback error lost: %v", err)
	}
}

func TestDiscoveryRejectsPaginationLoopsAndMalformedBodies(t *testing.T) {
	for _, body := range []string{`{"models":[],"nextPageToken":"same"}`, `{"error":{"message":"secret"}}`, `garbage`} {
		t.Run(body, func(t *testing.T) {
			calls := 0
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; _, _ = io.WriteString(w, body) }))
			defer s.Close()
			_, err := NewClient(s.Client()).Discover(context.Background(), ProviderConfig{Protocol: "gemini", BaseURL: s.URL})
			if err == nil || calls > 10 {
				t.Fatalf("accepted invalid discovery, calls=%d err=%v", calls, err)
			}
		})
	}
}

func TestOpenRouterReasoningFieldsAndEncryptedDetailsSurviveContinuation(t *testing.T) {
	body := `data: {"choices":[{"index":0,"delta":{"reasoning":"private","reasoning_details":[{"type":"reasoning.encrypted","index":0,"id":"r1","data":"first","format":"anthropic-claude-v1"}]}}]}` + "\n\n" + `data: {"choices":[{"index":0,"delta":{"reasoning_details":[{"type":"reasoning.encrypted","index":0,"id":"r1","data":"second","format":"anthropic-claude-v1"}],"content":"hello"}}]}` + "\n\n" + `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}` + "\n\ndata: [DONE]\n\n"
	calls := 0
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 2 {
			var b map[string]any
			_ = json.NewDecoder(r.Body).Decode(&b)
			msg := object(array(b["messages"])[1])
			if str(msg["reasoning_content"]) != "private" {
				t.Errorf("lost reasoning: %+v", msg)
			}
			detail := object(array(msg["reasoning_details"])[0])
			if str(detail["data"]) != "firstsecond" || str(detail["format"]) != "anthropic-claude-v1" {
				t.Errorf("changed encrypted reasoning: %+v", detail)
			}
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, body)
	}))
	defer s.Close()
	p := ProviderConfig{Protocol: "openai-chat", Adapter: "openrouter", BaseURL: s.URL}
	m := ModelConfig{ModelID: "anthropic/claude-sonnet-4.5", MaxOutputTokens: 4096}
	client := NewClient(s.Client())
	meta, err := client.Stream(context.Background(), p, m, []Message{{Role: "user", Content: "hi"}}, func(string) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.Stream(context.Background(), p, m, []Message{{Role: "user", Content: "hi"}, {Role: "assistant", Content: "hello", Metadata: meta}, {Role: "user", Content: "continue"}}, func(string) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
}

func TestAnthropicRedactedThinkingAndUnknownSignedFieldsArePreserved(t *testing.T) {
	body := strings.Replace(anthropicStream, `"type":"thinking","thinking":"","signature":""`, `"type":"thinking","thinking":"","signature":"","provider_extension":{"version":1}`, 1)
	body = strings.Replace(body, "event: message_delta", "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":2,\"content_block\":{\"type\":\"redacted_thinking\",\"data\":\"opaque-redacted\"}}\n\nevent: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":2}\n\nevent: message_delta", 1)
	calls := 0
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 2 {
			var b map[string]any
			_ = json.NewDecoder(r.Body).Decode(&b)
			msg := object(array(b["messages"])[1])
			blocks := array(msg["content"])
			if len(blocks) != 3 {
				t.Fatalf("lost block order: %+v", blocks)
			}
			if object(blocks[0])["provider_extension"] == nil || str(object(blocks[0])["signature"]) != "signed" || str(object(blocks[2])["data"]) != "opaque-redacted" {
				t.Errorf("signed blocks changed: %+v", blocks)
			}
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, body)
	}))
	defer s.Close()
	p := ProviderConfig{Protocol: "anthropic", Adapter: "standard", BaseURL: s.URL}
	m := ModelConfig{ModelID: "claude-sonnet-4-5", MaxOutputTokens: 4096}
	client := NewClient(s.Client())
	meta, err := client.Stream(context.Background(), p, m, []Message{{Role: "user", Content: "hi"}}, func(string) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.Stream(context.Background(), p, m, []Message{{Role: "user", Content: "hi"}, {Role: "assistant", Content: "你好", Metadata: meta}, {Role: "user", Content: "continue"}}, func(string) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
}

func TestUnknownResponseModelUsesOrdinaryTextRequest(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["include"] != nil || body["reasoning"] != nil {
			t.Errorf("sent unverified reasoning fields: %+v", body)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, responseStream)
	}))
	defer s.Close()
	_, err := NewClient(s.Client()).Stream(context.Background(), ProviderConfig{Protocol: "openai-responses", Adapter: "standard", BaseURL: s.URL}, ModelConfig{ModelID: "custom", MaxOutputTokens: 4096}, []Message{{Role: "user", Content: "hi"}}, func(string) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
}
