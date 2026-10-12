// SPDX-License-Identifier: AGPL-3.0-only
package app

import (
	"context"
	"encoding/json"
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
