// SPDX-License-Identifier: AGPL-3.0-only
package app

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"closewebui/server/internal/upstream"
)

func registerUser(t *testing.T, base, username string) *http.Client {
	t.Helper()
	client := clientFor(t)
	call(t, client, base, "POST", "/auth/register", map[string]string{"username": username, "password": "Test-password-123"}, 201)
	return client
}

func createProvider(t *testing.T, client *http.Client, base, name, adapter, protocol, upstreamURL, apiKey string) string {
	t.Helper()
	return idOf(t, call(t, client, base, "POST", "/providers", map[string]any{"name": name, "templateId": "custom", "protocol": protocol, "adapter": adapter, "baseUrl": upstreamURL + "/v1", "apiKey": apiKey, "enabled": true}, 201))
}

func modelsHandler(t *testing.T, body string, status int) http.HandlerFunc {
	t.Helper()
	return func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			http.Error(w, "wrong path", 400)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}
}

func TestModelCandidatesPrefersUpstreamList(t *testing.T) {
	up := httptest.NewServer(modelsHandler(t, `{"data":[{"id":"gpt-4o","name":"GPT 4o"},{"id":"gpt-5.2","name":"GPT-5.2"}]}`, 200))
	defer up.Close()
	s, _ := fixture(t, up.URL)
	c := registerUser(t, s.URL, "candidates_user")
	pid := createProvider(t, c, s.URL, "上游成功", "standard", "openai-chat", up.URL, "synthetic-key")
	body := call(t, c, s.URL, "POST", "/providers/"+pid+"/model-candidates", nil, 200)
	if bytes.Contains(body, []byte("synthetic-key")) {
		t.Fatal("candidate response leaked the API key")
	}
	var got modelCandidatesResponse
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	if got.Source != "upstream" || got.Warning != "" || got.CatalogVersion != upstream.CatalogVersion() {
		t.Fatalf("bad candidate envelope: %+v", got)
	}
	if len(got.Models) != 2 {
		t.Fatalf("models = %+v", got.Models)
	}
	if got.Models[0].ID != "gpt-4o" || got.Models[0].Name != "GPT 4o" {
		t.Fatalf("upstream identity not preserved: %+v", got.Models[0])
	}
	known := got.Models[1]
	if known.ID != "gpt-5.2" || !known.Capabilities.Known || known.Capabilities.Family != "openai" || known.Capabilities.OutputMax != 128000 {
		t.Fatalf("capability not resolved from registry: %+v", known)
	}
	if known.RecommendedDefaults.MaxOutputTokens != 4096 || known.RecommendedDefaults.DefaultReasoning != (upstream.Reasoning{}) {
		t.Fatalf("recommended defaults not safe: %+v", known.RecommendedDefaults)
	}
	if len(known.Capabilities.Sources) == 0 {
		t.Fatal("capability lost its documented sources")
	}
}

func TestModelCandidatesEmptyListFallsBackToCatalog(t *testing.T) {
	up := httptest.NewServer(modelsHandler(t, `{"data":[]}`, 200))
	defer up.Close()
	s, _ := fixture(t, up.URL)
	c := registerUser(t, s.URL, "empty_list_user")
	pid := createProvider(t, c, s.URL, "空列表", "standard", "openai-chat", up.URL, "synthetic-key")
	var got modelCandidatesResponse
	if err := json.Unmarshal(call(t, c, s.URL, "POST", "/providers/"+pid+"/model-candidates", nil, 200), &got); err != nil {
		t.Fatal(err)
	}
	if got.Source != "catalog" || !strings.Contains(got.Warning, "空模型列表") {
		t.Fatalf("empty list not reported: %+v", got)
	}
	if len(got.Models) == 0 {
		t.Fatal("no built-in candidates for a standard openai-chat provider")
	}
	for _, m := range got.Models {
		if !m.Capabilities.Known || m.RecommendedDefaults.MaxOutputTokens <= 0 {
			t.Fatalf("catalog candidate without verified capability: %+v", m)
		}
	}
}

func TestModelCandidatesReportsCredentialFailures(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Header.Get("Authorization") {
		case "Bearer rejected-key":
			http.Error(w, "unauthorized", 401)
		case "Bearer forbidden-key":
			http.Error(w, "forbidden", 403)
		default:
			http.Error(w, "unexpected", 500)
		}
	}))
	defer up.Close()
	s, _ := fixture(t, up.URL)
	c := registerUser(t, s.URL, "credential_user")
	for _, tc := range []struct{ key, want string }{{"rejected-key", "401"}, {"forbidden-key", "403"}} {
		pid := createProvider(t, c, s.URL, "凭据 "+tc.key, "standard", "openai-chat", up.URL, tc.key)
		var got modelCandidatesResponse
		if err := json.Unmarshal(call(t, c, s.URL, "POST", "/providers/"+pid+"/model-candidates", nil, 200), &got); err != nil {
			t.Fatal(err)
		}
		if got.Source != "catalog" || !strings.Contains(got.Warning, tc.want) {
			t.Fatalf("%s not reported: %+v", tc.want, got)
		}
		if len(got.Models) == 0 {
			t.Fatal("credential failure must still list built-in candidates")
		}
	}
}

func TestModelCandidatesReportsTimeout(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(400 * time.Millisecond)
		_, _ = io.WriteString(w, `{"data":[{"id":"gpt-4o"}]}`)
	}))
	defer up.Close()
	previous := modelDiscoveryTimeout
	modelDiscoveryTimeout = 120 * time.Millisecond
	t.Cleanup(func() { modelDiscoveryTimeout = previous })
	s, _ := fixture(t, up.URL)
	c := registerUser(t, s.URL, "timeout_user")
	pid := createProvider(t, c, s.URL, "超时", "standard", "openai-chat", up.URL, "synthetic-key")
	var got modelCandidatesResponse
	if err := json.Unmarshal(call(t, c, s.URL, "POST", "/providers/"+pid+"/model-candidates", nil, 200), &got); err != nil {
		t.Fatal(err)
	}
	if got.Source != "catalog" || !strings.Contains(got.Warning, "超时") {
		t.Fatalf("timeout not reported: %+v", got)
	}
}

func TestModelCandidatesReportsInvalidResponse(t *testing.T) {
	up := httptest.NewServer(modelsHandler(t, `<html>not json</html>`, 200))
	defer up.Close()
	s, _ := fixture(t, up.URL)
	c := registerUser(t, s.URL, "invalid_user")
	pid := createProvider(t, c, s.URL, "非法响应", "standard", "openai-chat", up.URL, "synthetic-key")
	var got modelCandidatesResponse
	if err := json.Unmarshal(call(t, c, s.URL, "POST", "/providers/"+pid+"/model-candidates", nil, 200), &got); err != nil {
		t.Fatal(err)
	}
	if got.Source != "catalog" || !strings.Contains(got.Warning, "格式无效") {
		t.Fatalf("invalid response not reported: %+v", got)
	}
}

func TestModelCandidatesWithoutBuiltInCandidates(t *testing.T) {
	up := httptest.NewServer(modelsHandler(t, `{"data":[]}`, 200))
	defer up.Close()
	s, _ := fixture(t, up.URL)
	c := registerUser(t, s.URL, "nocatalog_user")
	// deepseek + openai-responses has no built-in candidate.
	pid := createProvider(t, c, s.URL, "无内置候选", "deepseek", "openai-responses", up.URL, "synthetic-key")
	body := call(t, c, s.URL, "POST", "/providers/"+pid+"/model-candidates", nil, 200)
	if !bytes.Contains(body, []byte(`"models":[]`)) {
		t.Fatalf("models must be an empty array: %s", body)
	}
	var got modelCandidatesResponse
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	if got.Source != "catalog" || got.Warning == "" || len(got.Models) != 0 {
		t.Fatalf("no-candidate fallback wrong: %+v", got)
	}
	if !strings.Contains(got.Warning, "手动填写") {
		t.Fatalf("warning does not point at manual entry: %q", got.Warning)
	}
}

func TestModelCandidatesCarryAvailabilityCaveats(t *testing.T) {
	up := httptest.NewServer(modelsHandler(t, `{"data":[]}`, 401))
	defer up.Close()
	s, _ := fixture(t, up.URL)
	c := registerUser(t, s.URL, "caveat_user")
	pid := createProvider(t, c, s.URL, "硅基流动", "siliconflow", "openai-chat", up.URL, "rejected-key")
	var got modelCandidatesResponse
	if err := json.Unmarshal(call(t, c, s.URL, "POST", "/providers/"+pid+"/model-candidates", nil, 200), &got); err != nil {
		t.Fatal(err)
	}
	if got.Source != "catalog" || !strings.Contains(got.Warning, "401") {
		t.Fatalf("credential failure not reported: %+v", got)
	}
	var found bool
	for _, m := range got.Models {
		if m.ID == "zai-org/GLM-5.3-Flash" {
			found = true
			if !strings.Contains(m.Notes, "未经真实调用核实") || !strings.Contains(m.Notes, "不代表账号已获权限") {
				t.Fatalf("availability caveat lost: %q", m.Notes)
			}
			if !m.Capabilities.Mandatory || m.Capabilities.OutputMax != 128000 {
				t.Fatalf("capability not carried: %+v", m.Capabilities)
			}
		}
	}
	if !found {
		t.Fatal("siliconflow catalog fallback misses the GLM-5.3 Flash alias")
	}
}

func TestModelCandidatesWithoutKeyFallsBackToCatalog(t *testing.T) {
	up := httptest.NewServer(modelsHandler(t, `{"data":[]}`, 200))
	defer up.Close()
	s, _ := fixture(t, up.URL)
	c := registerUser(t, s.URL, "nokey_user")
	pid := idOf(t, call(t, c, s.URL, "POST", "/providers", map[string]any{"name": "未填密钥", "templateId": "custom", "protocol": "openai-chat", "adapter": "standard", "baseUrl": up.URL + "/v1", "enabled": true}, 201))
	var got modelCandidatesResponse
	if err := json.Unmarshal(call(t, c, s.URL, "POST", "/providers/"+pid+"/model-candidates", nil, 200), &got); err != nil {
		t.Fatal(err)
	}
	if got.Source != "catalog" || got.Warning == "" || len(got.Models) == 0 {
		t.Fatalf("missing key must fall back to catalog: %+v", got)
	}
}

func TestModelCatalogIsOfflineAndOwned(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("offline catalog endpoint contacted the upstream")
		http.Error(w, "must not be called", 500)
	}))
	defer up.Close()
	s, _ := fixture(t, up.URL)
	one, two := registerUser(t, s.URL, "catalog_user_one"), registerUser(t, s.URL, "catalog_user_two")
	pid := createProvider(t, one, s.URL, "目录", "siliconflow", "openai-chat", up.URL, "synthetic-key")
	var got modelCatalogResponse
	if err := json.Unmarshal(call(t, one, s.URL, "GET", "/providers/"+pid+"/model-catalog", nil, 200), &got); err != nil {
		t.Fatal(err)
	}
	if got.CatalogVersion != upstream.CatalogVersion() || got.Adapter != "siliconflow" || got.Protocol != "openai-chat" {
		t.Fatalf("bad catalog envelope: %+v", got)
	}
	if len(got.Models) == 0 {
		t.Fatal("siliconflow catalog is empty")
	}
	var found bool
	for _, entry := range got.Models {
		if entry.Adapter != "siliconflow" || entry.Protocol != "openai-chat" || entry.VerifiedDate == "" || !entry.Capabilities.Known {
			t.Fatalf("unexpected catalog entry: %+v", entry)
		}
		if entry.ID == "zai-org/GLM-5.3-Flash" {
			found = true
			if !strings.Contains(entry.Notes, "未经真实调用核实") {
				t.Fatalf("GLM-5.3 Flash notes missing availability caveat: %q", entry.Notes)
			}
		}
	}
	if !found {
		t.Fatal("siliconflow catalog misses the GLM-5.3 Flash alias")
	}
	call(t, two, s.URL, "GET", "/providers/"+pid+"/model-catalog", nil, 404)
	call(t, two, s.URL, "POST", "/providers/"+pid+"/model-candidates", nil, 404)
	call(t, two, s.URL, "POST", "/providers/"+pid+"/models/batch", map[string]any{"models": []map[string]any{{"modelId": "gpt-5.2"}}}, 404)
}

func TestBatchModelsDedupAndPerItemFailure(t *testing.T) {
	up := httptest.NewServer(modelsHandler(t, `{"data":[]}`, 200))
	defer up.Close()
	s, _ := fixture(t, up.URL)
	c := registerUser(t, s.URL, "batch_user")
	pid := createProvider(t, c, s.URL, "批量", "standard", "openai-chat", up.URL, "synthetic-key")
	body := call(t, c, s.URL, "POST", "/providers/"+pid+"/models/batch", map[string]any{"models": []map[string]any{
		{"modelId": "gpt-5.2", "name": "GPT-5.2", "maxOutputTokens": 8192, "enabled": true},
		{"modelId": "gpt-4o"},
		{"modelId": "", "name": "空 ID"},
		{"modelId": "o3", "name": "o3", "maxOutputTokens": 0},
		{"modelId": "o3", "name": "o3", "defaultReasoning": map[string]any{"enabled": false}},
		{"modelId": "gpt-5.2", "name": "尝试改写", "maxOutputTokens": 4096},
	}}, 200)
	var out struct {
		Results []batchModelResult `json:"results"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatal(err)
	}
	want := []string{"added", "added", "failed", "failed", "failed", "exists"}
	if len(out.Results) != len(want) {
		t.Fatalf("results = %+v", out.Results)
	}
	for i, status := range want {
		if out.Results[i].Status != status {
			t.Fatalf("result %d = %+v, want %s", i, out.Results[i], status)
		}
	}
	if out.Results[0].ID == "" || out.Results[5].ID == "" || out.Results[5].ID != out.Results[0].ID {
		t.Fatalf("added/exists ids wrong: %+v", out.Results)
	}
	for _, i := range []int{2, 3, 4} {
		if out.Results[i].Error == "" {
			t.Fatalf("failed item %d has no reason", i)
		}
	}
	var models []modelView
	if err := json.Unmarshal(call(t, c, s.URL, "GET", "/models", nil, 200), &models); err != nil {
		t.Fatal(err)
	}
	saved := map[string]modelView{}
	for _, m := range models {
		if m.ProviderID == pid {
			saved[m.ModelID] = m
		}
	}
	if len(saved) != 2 {
		t.Fatalf("saved models = %+v", saved)
	}
	if saved["gpt-5.2"].Name != "GPT-5.2" || saved["gpt-5.2"].MaxOutputTokens != 8192 {
		t.Fatalf("existing user override rewritten: %+v", saved["gpt-5.2"])
	}
	if saved["gpt-4o"].Name != "gpt-4o" || !saved["gpt-4o"].Enabled {
		t.Fatalf("unknown model default wrong: %+v", saved["gpt-4o"])
	}
	// A second batch must report the same rows as existing and never rewrite them.
	var again struct {
		Results []batchModelResult `json:"results"`
	}
	if err := json.Unmarshal(call(t, c, s.URL, "POST", "/providers/"+pid+"/models/batch", map[string]any{"models": []map[string]any{{"modelId": "gpt-5.2", "name": "再次尝试", "maxOutputTokens": 4096}}}, 200), &again); err != nil {
		t.Fatal(err)
	}
	if len(again.Results) != 1 || again.Results[0].Status != "exists" || again.Results[0].ID != out.Results[0].ID {
		t.Fatalf("dedup failed: %+v", again.Results)
	}
	if err := json.Unmarshal(call(t, c, s.URL, "GET", "/models", nil, 200), &models); err != nil {
		t.Fatal(err)
	}
	for _, m := range models {
		if m.ModelID == "gpt-5.2" && (m.Name != "GPT-5.2" || m.MaxOutputTokens != 8192) {
			t.Fatalf("override rewritten on second batch: %+v", m)
		}
	}
}

func TestBatchModelsRejectsUnsupportedReasoning(t *testing.T) {
	up := httptest.NewServer(modelsHandler(t, `{"data":[]}`, 200))
	defer up.Close()
	s, _ := fixture(t, up.URL)
	c := registerUser(t, s.URL, "batch_reasoning_user")
	pid := createProvider(t, c, s.URL, "思考校验", "standard", "openai-chat", up.URL, "synthetic-key")
	var out struct {
		Results []batchModelResult `json:"results"`
	}
	if err := json.Unmarshal(call(t, c, s.URL, "POST", "/providers/"+pid+"/models/batch", map[string]any{"models": []map[string]any{
		{"modelId": "o3", "name": "o3", "defaultReasoning": map[string]any{"effort": "xhigh"}},
		{"modelId": "o3", "name": "o3", "defaultReasoning": map[string]any{"enabled": false}},
		{"modelId": "gpt-5.2", "name": "gpt-5.2", "defaultReasoning": map[string]any{"effort": "high"}},
	}}, 200), &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Results) != 3 {
		t.Fatalf("results = %+v", out.Results)
	}
	if out.Results[0].Status != "failed" || out.Results[1].Status != "failed" {
		t.Fatalf("invalid reasoning accepted: %+v", out.Results)
	}
	if out.Results[2].Status != "added" {
		t.Fatalf("valid reasoning rejected: %+v", out.Results[2])
	}
}

func TestBatchModelsLimits(t *testing.T) {
	up := httptest.NewServer(modelsHandler(t, `{"data":[]}`, 200))
	defer up.Close()
	s, _ := fixture(t, up.URL)
	c := registerUser(t, s.URL, "batch_limit_user")
	pid := createProvider(t, c, s.URL, "批量上限", "standard", "openai-chat", up.URL, "synthetic-key")
	call(t, c, s.URL, "POST", "/providers/"+pid+"/models/batch", map[string]any{"models": []map[string]any{}}, 400)
	tooMany := make([]map[string]any, 0, 101)
	for i := 0; i < 101; i++ {
		tooMany = append(tooMany, map[string]any{"modelId": "model-" + strings.Repeat("x", i%5) + "-" + string(rune('a'+i%26))})
	}
	call(t, c, s.URL, "POST", "/providers/"+pid+"/models/batch", map[string]any{"models": tooMany}, 400)
}

func TestLegacyDiscoverArrayContractUnchanged(t *testing.T) {
	up := httptest.NewServer(modelsHandler(t, `{"data":[{"id":"gpt-4o","name":"GPT 4o"}]}`, 200))
	defer up.Close()
	s, _ := fixture(t, up.URL)
	c := registerUser(t, s.URL, "legacy_discover_user")
	pid := createProvider(t, c, s.URL, "旧接口", "standard", "openai-chat", up.URL, "synthetic-key")
	body := call(t, c, s.URL, "POST", "/providers/"+pid+"/discover", nil, 200)
	if !bytes.HasPrefix(bytes.TrimSpace(body), []byte("[")) {
		t.Fatalf("legacy discover must return an array: %s", body)
	}
	var models []upstream.DiscoveredModel
	if err := json.Unmarshal(body, &models); err != nil {
		t.Fatal(err)
	}
	if len(models) != 1 || models[0].ID != "gpt-4o" || models[0].Name != "GPT 4o" {
		t.Fatalf("legacy discover payload changed: %+v", models)
	}
}
