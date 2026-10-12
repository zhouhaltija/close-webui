// SPDX-License-Identifier: AGPL-3.0-only
package upstream

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Dropping public protocol metadata prevents the discovered output ceiling and
// thinking support from surviving the first boundary of the save/request chain.
func TestDiscoveryPreservesDocumentedMetadata(t *testing.T) {
	for _, tc := range []struct {
		name, adapter, protocol, body string
		output, context               int
		thinking                      bool
	}{
		{"anthropic", "standard", "anthropic", `{"data":[{"id":"private-exact-id","max_tokens":64000,"max_input_tokens":200000,"capabilities":{"thinking":{"supported":true,"types":{"adaptive":{"supported":true},"disabled":{"supported":false},"enabled":{"supported":false}}},"effort":{"supported":true,"low":{"supported":true},"high":{"supported":false}}}}]}`, 64000, 200000, true},
		{"gemini", "standard", "gemini", `{"models":[{"name":"models/private-exact-id","outputTokenLimit":65536,"inputTokenLimit":1048576,"thinking":false}]}`, 65536, 1048576, false},
		{"openrouter", "openrouter", "openai-chat", `{"data":[{"id":"unknown/private-exact-id","context_length":200000,"top_provider":{"max_completion_tokens":32000},"supported_parameters":["reasoning","max_tokens"]}]}`, 32000, 200000, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, tc.body) }))
			defer s.Close()
			models, err := NewClient(s.Client()).Discover(context.Background(), ProviderConfig{Protocol: tc.protocol, Adapter: tc.adapter, BaseURL: s.URL})
			if err != nil || len(models) != 1 {
				t.Fatalf("discovery: %v, %+v", err, models)
			}
			data, _ := json.Marshal(models[0])
			var got struct {
				Metadata struct {
					OutputMax          int   `json:"outputMax"`
					ContextWindow      int   `json:"contextWindow"`
					ReasoningSupported *bool `json:"reasoningSupported"`
				} `json:"metadata"`
			}
			_ = json.Unmarshal(data, &got)
			if got.Metadata.OutputMax != tc.output || got.Metadata.ContextWindow != tc.context || got.Metadata.ReasoningSupported == nil || *got.Metadata.ReasoningSupported != tc.thinking {
				t.Fatalf("public metadata lost: %s", data)
			}
		})
	}
}

func TestStreamUsesDiscoveredOutputAndAnthropicControls(t *testing.T) {
	for _, tc := range []struct {
		name, adapter, protocol, id string
		metadata                    *ModelMetadata
		reasoning                   Reasoning
		wantField                   string
	}{
		{"unknown-gemini-output", "standard", "gemini", "private-exact-id", &ModelMetadata{OutputMax: 65536, ReasoningSupported: boolptr(true)}, Reasoning{}, "generationConfig"},
		{"unknown-anthropic-adaptive", "standard", "anthropic", "private-exact-id", &ModelMetadata{OutputMax: 64000, ReasoningSupported: boolptr(true), ThinkingTypes: &ThinkingTypes{Adaptive: boolptr(true), Disabled: boolptr(false)}, EffortSupported: boolptr(true), Efforts: []string{"low"}}, Reasoning{Enabled: boolptr(true), Effort: "low"}, "thinking"},
		{"unknown-anthropic-manual", "standard", "anthropic", "private-exact-id", &ModelMetadata{OutputMax: 64000, ReasoningSupported: boolptr(true), ThinkingTypes: &ThinkingTypes{Enabled: boolptr(true), Disabled: boolptr(true)}}, Reasoning{Enabled: boolptr(true), BudgetTokens: intptr(2048)}, "thinking"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var body map[string]json.RawMessage
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_ = json.NewDecoder(r.Body).Decode(&body)
				w.Header().Set("Content-Type", "text/event-stream")
				if tc.protocol == "gemini" {
					_, _ = io.WriteString(w, "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"ok\"}]},\"finishReason\":\"STOP\"}]}\n\n")
				} else {
					_, _ = io.WriteString(w, anthropicStream)
				}
			}))
			defer s.Close()
			_, err := NewClient(s.Client()).Stream(context.Background(), ProviderConfig{Protocol: tc.protocol, Adapter: tc.adapter, BaseURL: s.URL}, ModelConfig{ModelID: tc.id, MaxOutputTokens: 16000, Reasoning: tc.reasoning, Metadata: tc.metadata}, nil, func(string) error { return nil })
			if err != nil {
				t.Fatalf("discovered configuration rejected: %v", err)
			}
			if len(body[tc.wantField]) == 0 {
				t.Fatalf("native field absent: %+v", body)
			}
			if tc.reasoning.BudgetTokens != nil && !strings.Contains(string(body["thinking"]), `"budget_tokens":2048`) {
				t.Fatalf("manual budget absent: %+v", body)
			}
		})
	}
}

func TestStreamIntersectsRegisteredAndDiscoveredLimits(t *testing.T) {
	called := false
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, anthropicStream)
	}))
	defer s.Close()
	for _, model := range []ModelConfig{
		{ModelID: "claude-sonnet-4-5", MaxOutputTokens: 4096, Metadata: &ModelMetadata{OutputMax: 2048}},
		{ModelID: "claude-sonnet-4-5", MaxOutputTokens: 4096, Reasoning: Reasoning{Enabled: boolptr(true)}, Metadata: &ModelMetadata{ReasoningSupported: boolptr(false)}},
		{ModelID: "claude-opus-4-5", MaxOutputTokens: 4096, Reasoning: Reasoning{Effort: "high"}, Metadata: &ModelMetadata{EffortSupported: boolptr(true), Efforts: []string{"low"}}},
	} {
		_, err := NewClient(s.Client()).Stream(context.Background(), ProviderConfig{Protocol: "anthropic", Adapter: "standard", BaseURL: s.URL}, model, nil, func(string) error { return nil })
		if err == nil {
			t.Fatalf("constraint ignored: %+v", model)
		}
	}
	if called {
		t.Fatal("invalid settings reached upstream")
	}
}

func TestDiscoveryMetadataNeverGuessesControlsOrUsesContextAsOutput(t *testing.T) {
	for _, tc := range []struct{ adapter, protocol, body string }{
		{"standard", "openai-chat", `{"data":[{"id":"my-o3-clone","context_length":1000000,"max_tokens":128000,"capabilities":{"thinking":{"supported":true}}}]}`},
		{"standard", "openai-responses", `{"data":[{"id":"my-o3-clone","top_provider":{"max_completion_tokens":128000},"supported_parameters":["reasoning"]}]}`},
		{"openrouter", "openai-responses", `{"data":[{"id":"openai/o3","top_provider":{"max_completion_tokens":128000},"supported_parameters":["reasoning"]}]}`},
		{"standard", "gemini", `{"models":[{"name":"models/private-exact-id","inputTokenLimit":1000000,"outputTokenLimit":0,"thinking":true}]}`},
		{"openrouter", "openai-chat", `{"data":[{"id":"private-exact-id","context_length":1000000,"top_provider":{"max_completion_tokens":null},"supported_parameters":["reasoning"]}]}`},
	} {
		s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, tc.body) }))
		models, err := NewClient(s.Client()).Discover(context.Background(), ProviderConfig{Adapter: tc.adapter, Protocol: tc.protocol, BaseURL: s.URL})
		s.Close()
		if err != nil || len(models) != 1 {
			t.Fatalf("discovery: %v", err)
		}
		got := CapabilitiesWithMetadata(tc.adapter, tc.protocol, models[0].ID, models[0].Metadata)
		if got.OutputMax != 4096 || got.Known || got.BudgetSupported || len(got.Efforts) > 0 {
			t.Fatalf("invented output/control: %+v", got)
		}
	}
	for _, raw := range []string{`0`, `-1`, `1.5`, `"65536"`, `null`, `true`, `1000000000000000`} {
		if positiveLimit(json.RawMessage(raw)) != 0 {
			t.Fatalf("invalid limit accepted: %s", raw)
		}
	}
}

func TestAnthropicMetadataControlsRequireExplicitTypesAndLegalEfforts(t *testing.T) {
	for _, tc := range []struct {
		metadata                 *ModelMetadata
		known, toggle, mandatory bool
		effortCount              int
	}{
		{&ModelMetadata{ReasoningSupported: boolptr(true)}, false, false, false, 0},
		{&ModelMetadata{ReasoningSupported: boolptr(true), ThinkingTypes: &ThinkingTypes{Adaptive: boolptr(true)}}, true, false, false, 0},
		{&ModelMetadata{ThinkingTypes: &ThinkingTypes{Adaptive: boolptr(true), Disabled: boolptr(false)}, EffortSupported: boolptr(true), Efforts: []string{"low", "custom-secret-level"}}, true, false, true, 1},
		{&ModelMetadata{ReasoningSupported: boolptr(false), ThinkingTypes: &ThinkingTypes{Adaptive: boolptr(true)}}, false, false, false, 0},
	} {
		got := CapabilitiesWithMetadata("standard", "anthropic", "private-exact-id", tc.metadata)
		if got.Known != tc.known || got.SupportsToggle != tc.toggle || got.Mandatory != tc.mandatory || len(got.Efforts) != tc.effortCount {
			t.Fatalf("incorrect explicit control contract: %+v", got)
		}
	}
	known := CapabilitiesWithMetadata("standard", "anthropic", "claude-opus-4-5", &ModelMetadata{OutputMax: 128000, EffortSupported: boolptr(true), Efforts: []string{"low", "max"}})
	if known.OutputMax != 64000 || len(known.Efforts) != 1 || known.Efforts[0] != "low" {
		t.Fatalf("registered contract widened: %+v", known)
	}
}

func TestDiscoveredAnthropicToggleSerializesDisabledType(t *testing.T) {
	var body map[string]json.RawMessage
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, anthropicStream)
	}))
	defer s.Close()
	metadata := &ModelMetadata{OutputMax: 64000, ReasoningSupported: boolptr(true), ThinkingTypes: &ThinkingTypes{Adaptive: boolptr(true), Disabled: boolptr(true)}}
	_, err := NewClient(s.Client()).Stream(context.Background(), ProviderConfig{Protocol: "anthropic", Adapter: "standard", BaseURL: s.URL}, ModelConfig{ModelID: "private-exact-id", MaxOutputTokens: 4096, Reasoning: Reasoning{Enabled: boolptr(false)}, Metadata: metadata}, nil, func(string) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body["thinking"]), `"type":"disabled"`) {
		t.Fatalf("invalid discovered off type: %s", body["thinking"])
	}
}
