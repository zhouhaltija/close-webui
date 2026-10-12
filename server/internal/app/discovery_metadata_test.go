// SPDX-License-Identifier: AGPL-3.0-only
package app

import (
	"closewebui/server/internal/db"
	"closewebui/server/internal/upstream"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestDiscoveredMetadataSurvivesSaveRefreshAndRestart(t *testing.T) {
	var ceiling atomic.Int64
	ceiling.Store(65536)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"models":[{"name":"models/private-exact-id","inputTokenLimit":1048576,"outputTokenLimit":`+jsonNumber(ceiling.Load())+`,"thinking":true}]}`)
	}))
	defer up.Close()
	s, _ := fixture(t, up.URL)
	client := registerUser(t, s.URL, "metadata_user")
	pid := createProvider(t, client, s.URL, "元数据仿真", "standard", "gemini", up.URL, "synthetic-key")
	call(t, client, s.URL, "POST", "/providers/"+pid+"/model-candidates", nil, 200)
	var batch struct {
		Results []batchModelResult `json:"results"`
	}
	_ = json.Unmarshal(call(t, client, s.URL, "POST", "/providers/"+pid+"/models/batch", map[string]any{"models": []map[string]any{{"modelId": "private-exact-id", "maxOutputTokens": 16000}}}, 200), &batch)
	if len(batch.Results) != 1 || batch.Results[0].Status != "added" {
		t.Fatalf("discovered ceiling lost in save: %+v", batch)
	}
	id := batch.Results[0].ID
	read := func(base string) modelView {
		t.Helper()
		var got modelView
		_ = json.Unmarshal(call(t, client, base, "GET", "/models/"+id, nil, 200), &got)
		return got
	}
	got := read(s.URL)
	if got.Capabilities.OutputMax != 65536 || got.Capabilities.Known || got.Capabilities.ReasoningSupported == nil || !*got.Capabilities.ReasoningSupported {
		t.Fatalf("metadata missing: %+v", got)
	}
	old := s.Config.Handler.(*App)
	s.Close()
	old.Close()
	restarted, err := New(context.Background(), old.cfg)
	if err != nil {
		t.Fatal(err)
	}
	s2 := httptest.NewServer(restarted)
	defer s2.Close()
	defer restarted.Close()
	got = read(s2.URL)
	if got.Capabilities.OutputMax != 65536 || got.MaxOutputTokens != 16000 {
		t.Fatalf("restart lost metadata: %+v", got)
	}
	ceiling.Store(8192)
	call(t, client, s2.URL, "POST", "/providers/"+pid+"/model-candidates", nil, 200)
	got = read(s2.URL)
	if got.Capabilities.OutputMax != 8192 || got.MaxOutputTokens != 16000 {
		t.Fatalf("refresh changed user override: %+v", got)
	}
	call(t, client, s2.URL, "PATCH", "/models/"+id, map[string]any{"enabled": false}, 400)
	call(t, client, s2.URL, "PATCH", "/models/"+id, map[string]any{"maxOutputTokens": 4096}, 200)
	call(t, client, s2.URL, "PATCH", "/providers/"+pid, map[string]any{"apiKey": "synthetic-key-rotated"}, 200)
	got = read(s2.URL)
	if got.Capabilities.OutputMax != 4096 || got.Capabilities.ReasoningSupported != nil {
		t.Fatalf("rotated credential reused metadata: %+v", got)
	}
	call(t, client, s2.URL, "PATCH", "/models/"+id, map[string]any{"capabilities": map[string]any{"outputMax": 999999}}, 400)
}

func jsonNumber(n int64) string { data, _ := json.Marshal(n); return string(data) }

func TestModelBeyondDiscoveryCacheCapacityKeepsVerifiedMetadata(t *testing.T) {
	// A truncated cache is not evidence that the last discovered model lacks
	// documented limits. Exercise the real HTTP create and batch-create paths.
	models := make([]map[string]any, 2052)
	for i := range models {
		models[i] = map[string]any{"name": fmt.Sprintf("models/private-%04d", i), "outputTokenLimit": 65536}
	}
	models[2051] = map[string]any{"name": "models/gemini-2.5-flash", "outputTokenLimit": 1024}
	body, err := json.Marshal(map[string]any{"models": models})
	if err != nil {
		t.Fatal(err)
	}
	up := httptest.NewServer(modelsHandler(t, string(body), 200))
	defer up.Close()
	s, _ := fixture(t, up.URL)
	client := registerUser(t, s.URL, "metadata_capacity")
	pid := createProvider(t, client, s.URL, "长模型列表仿真", "standard", "gemini", up.URL, "synthetic-key")
	call(t, client, s.URL, "POST", "/providers/"+pid+"/model-candidates", nil, 200)
	id := idOf(t, call(t, client, s.URL, "POST", "/models", map[string]any{"providerId": pid, "modelId": "private-2048", "name": "末尾模型", "maxOutputTokens": 16000}, 201))
	var got modelView
	_ = json.Unmarshal(call(t, client, s.URL, "GET", "/models/"+id, nil, 200), &got)
	if got.Capabilities.OutputMax != 65536 || got.MaxOutputTokens != 16000 {
		t.Fatalf("tail candidate lost metadata: %+v", got)
	}
	var batch struct {
		Results []batchModelResult `json:"results"`
	}
	_ = json.Unmarshal(call(t, client, s.URL, "POST", "/providers/"+pid+"/models/batch", map[string]any{"models": []map[string]any{{"modelId": "private-2049", "maxOutputTokens": 16000}}}, 200), &batch)
	if len(batch.Results) != 1 || batch.Results[0].Status != "added" {
		t.Fatalf("tail batch candidate lost metadata: %+v", batch)
	}
	_ = json.Unmarshal(call(t, client, s.URL, "GET", "/models/"+batch.Results[0].ID, nil, 200), &got)
	if got.Capabilities.OutputMax != 65536 {
		t.Fatalf("tail batch metadata not persisted: %+v", got)
	}
	// A known static profile must also honor a narrower tail-entry ceiling.
	call(t, client, s.URL, "POST", "/models", map[string]any{"providerId": pid, "modelId": "gemini-2.5-flash", "name": "较低上游上限", "maxOutputTokens": 4096}, 400)
	id = idOf(t, call(t, client, s.URL, "POST", "/models", map[string]any{"providerId": pid, "modelId": "gemini-2.5-flash", "name": "较低上游上限", "maxOutputTokens": 512}, 201))
	_ = json.Unmarshal(call(t, client, s.URL, "GET", "/models/"+id, nil, 200), &got)
	if got.Capabilities.OutputMax != 1024 {
		t.Fatalf("static tail profile bypassed upstream ceiling: %+v", got)
	}
	// Rebinding an existing row has the same freshness requirement as creation.
	a := s.Config.Handler.(*App)
	var user struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(call(t, client, s.URL, "GET", "/auth/me", nil, 200), &user)
	p, err := a.queries.GetProvider(context.Background(), db.GetProviderParams{ID: pid, UserID: user.ID})
	if err != nil {
		t.Fatal(err)
	}
	old, err := a.queries.GetModel(context.Background(), db.GetModelParams{ID: id, UserID: user.ID})
	if err != nil {
		t.Fatal(err)
	}
	old.ModelID = "private-2050"
	old.MaxOutputTokens = 16000
	old.DiscoveryMetadata = discoveryBytes(p, old.ModelID, &upstream.ModelMetadata{OutputMax: 65536})
	newer := make([]upstream.DiscoveredModel, 2052)
	for i := range newer {
		newer[i] = upstream.DiscoveredModel{ID: fmt.Sprintf("private-%04d", i), Metadata: &upstream.ModelMetadata{OutputMax: 8192}}
	}
	if err = a.rememberDiscovery(context.Background(), p, newer); err != nil {
		t.Fatal(err)
	}
	if _, err = a.saveValidatedModel(context.Background(), p, old, false); err == nil {
		t.Fatal("model rebind saved an outdated tail candidate ceiling")
	}
	var problem *requestError
	if !errors.As(err, &problem) || problem.code != "DISCOVERY_CHANGED" {
		t.Fatalf("rebind rejected for a different reason: %v", err)
	}
}
