// SPDX-License-Identifier: AGPL-3.0-only
package app

import (
	"closewebui/server/internal/db"
	"context"
	"encoding/json"
	"github.com/google/uuid"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestAnthropicDiscoveryControlsReachGenerationAndSnapshotRetry(t *testing.T) {
	var narrowed atomic.Bool
	var attempts atomic.Int32
	var payloads []map[string]json.RawMessage
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			level, limit := "low", 64000
			if narrowed.Load() {
				level, limit = "high", 8192
			}
			_, _ = io.WriteString(w, `{"data":[{"id":"private-exact-id","max_tokens":`+jsonNumber(int64(limit))+`,"capabilities":{"thinking":{"supported":true,"types":{"adaptive":{"supported":true},"disabled":{"supported":false}}},"effort":{"supported":true,"`+level+`":{"supported":true}}}}]}`)
			return
		}
		var payload map[string]json.RawMessage
		_ = json.NewDecoder(r.Body).Decode(&payload)
		payloads = append(payloads, payload)
		if attempts.Add(1) == 1 {
			http.Error(w, "synthetic upstream failure", 502)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"m1\",\"content\":[]}}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
	}))
	defer up.Close()
	s, _ := fixture(t, up.URL)
	c := registerUser(t, s.URL, "anthropic_metadata")
	pid := createProvider(t, c, s.URL, "原生元数据仿真", "standard", "anthropic", up.URL, "synthetic-key")
	id := idOf(t, call(t, c, s.URL, "POST", "/models", map[string]any{"providerId": pid, "modelId": "private-exact-id", "name": "虚构原生模型", "maxOutputTokens": 16000, "defaultReasoning": map[string]any{"enabled": true, "effort": "low"}}, 201))
	cid := idOf(t, call(t, c, s.URL, "POST", "/conversations", map[string]string{"title": "虚构元数据历史"}, 201))
	input := generationPayload(id)
	first := call(t, c, s.URL, "POST", "/conversations/"+cid+"/generations", input, 200)
	if !strings.Contains(string(first), `"type":"error"`) {
		t.Fatalf("first call was not a recoverable error: %s", first)
	}
	narrowed.Store(true)
	call(t, c, s.URL, "POST", "/providers/"+pid+"/model-candidates", nil, 200)
	input["generationId"] = uuid.NewString()
	input["retry"] = true
	retried := call(t, c, s.URL, "POST", "/conversations/"+cid+"/generations", input, 200)
	if !strings.Contains(string(retried), `"type":"done"`) {
		t.Fatalf("snapshot retry lost original metadata: %s", retried)
	}
	if len(payloads) != 2 {
		t.Fatalf("upstream attempts=%d", len(payloads))
	}
	for _, payload := range payloads {
		if string(payload["model"]) != `"private-exact-id"` || string(payload["max_tokens"]) != "16000" || !strings.Contains(string(payload["thinking"]), `"type":"adaptive"`) || !strings.Contains(string(payload["output_config"]), `"effort":"low"`) {
			t.Fatalf("native metadata not serialized: %+v", payload)
		}
	}
	call(t, c, s.URL, "POST", "/conversations/"+cid+"/generations", generationPayload(id), 400)
}

func TestStaleProviderCannotSaveCandidateMetadata(t *testing.T) {
	up := httptest.NewServer(modelsHandler(t, `{"models":[{"name":"models/private-exact-id","outputTokenLimit":64000}]}`, 200))
	defer up.Close()
	s, _ := fixture(t, up.URL)
	c := registerUser(t, s.URL, "stale_metadata")
	pid := createProvider(t, c, s.URL, "配置失效仿真", "standard", "gemini", up.URL, "synthetic-key")
	call(t, c, s.URL, "POST", "/providers/"+pid+"/model-candidates", nil, 200)
	a := s.Config.Handler.(*App)
	var user struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(call(t, c, s.URL, "GET", "/auth/me", nil, 200), &user)
	p, err := a.queries.GetProvider(context.Background(), db.GetProviderParams{ID: pid, UserID: user.ID})
	if err != nil {
		t.Fatal(err)
	}
	call(t, c, s.URL, "PATCH", "/providers/"+pid, map[string]any{"apiKey": "synthetic-key-rotated"}, 200)
	max := int32(16000)
	result := a.batchOneModel(httptest.NewRequest(http.MethodPost, "/", nil), p, user.ID, batchModelItem{ModelID: "private-exact-id", MaxOutputTokens: &max})
	if result.Status != "failed" {
		t.Fatalf("stale connection saved model: %+v", result)
	}
}

func TestModelCreateRechecksLatestDiscoveredCeiling(t *testing.T) {
	var limit atomic.Int64
	limit.Store(65536)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"models":[{"name":"models/private-exact-id","outputTokenLimit":`+jsonNumber(limit.Load())+`}]}`)
	}))
	defer up.Close()
	s, _ := fixture(t, up.URL)
	c := registerUser(t, s.URL, "create_metadata_race")
	pid := createProvider(t, c, s.URL, "添加竞态仿真", "standard", "gemini", up.URL, "synthetic-key")
	call(t, c, s.URL, "POST", "/providers/"+pid+"/model-candidates", nil, 200)
	a := s.Config.Handler.(*App)
	var user struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(call(t, c, s.URL, "GET", "/auth/me", nil, 200), &user)
	p, err := a.queries.GetProvider(context.Background(), db.GetProviderParams{ID: pid, UserID: user.ID})
	if err != nil {
		t.Fatal(err)
	}
	cache, _ := a.cachedDiscovery(p)
	stale := discoveryBytes(p, "private-exact-id", cache.models["private-exact-id"].Metadata)
	limit.Store(8192)
	call(t, c, s.URL, "POST", "/providers/"+pid+"/model-candidates", nil, 200)
	_, err = a.saveValidatedModel(context.Background(), p, db.Model{ID: uuid.NewString(), UserID: user.ID, ProviderID: pid, ModelID: "private-exact-id", Name: "虚构模型", Enabled: true, MaxOutputTokens: 16000, DefaultReasoning: []byte("{}"), DiscoveryMetadata: stale}, true)
	if err == nil {
		t.Fatal("model created against a stale discovered ceiling")
	}
}
