package app

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"closewebui/server/migrations"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/joho/godotenv"
)

func fixture(t *testing.T, upstreamURL string) (*httptest.Server, string) {
	t.Helper()
	_ = godotenv.Load("../../../.env.backend.local")
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL is required for PostgreSQL integration tests")
	}
	ctx, setupCancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer setupCancel()
	admin, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal("connect test database:", err)
	}
	schema := "closewebui_test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if _, err := admin.Exec(cleanup, "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE"); err != nil {
			t.Error("isolated test schema cleanup failed:", err)
		}
		_ = admin.Close(cleanup)
	})
	parsed, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	parsed.RuntimeParams["search_path"] = schema
	// Connection string carries only this test's schema; no destructive migration touches public.
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	q.Set("search_path", schema)
	u.RawQuery = q.Encode()
	std, err := sql.Open("pgx", u.String())
	if err != nil {
		t.Fatal(err)
	}
	// Register disposal before Up: a migration error calls Fatal, which must still
	// release its SQL connections before the schema cleanup runs.
	t.Cleanup(func() { _ = std.Close() })
	if err = migrations.Up(ctx, std); err != nil {
		t.Fatal(err)
	}
	_ = std.Close()
	allowed := []string{}
	if upstreamURL != "" {
		p, _ := url.Parse(upstreamURL)
		allowed = append(allowed, p.Host)
	}
	a, err := New(ctx, Config{DatabaseURL: dsn, Schema: schema, EncryptionKey: base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32)), AllowedHosts: allowed})
	if err != nil {
		t.Fatal(err)
	}
	s := httptest.NewServer(a)
	t.Cleanup(func() { s.Close(); a.Close() })
	return s, schema
}

func clientFor(t *testing.T) *http.Client {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	return &http.Client{Jar: jar, Timeout: 15 * time.Second}
}

func call(t *testing.T, client *http.Client, base, method, path string, payload any, want int) json.RawMessage {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(method, base+"/api"+path, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", base)
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != want {
		t.Fatalf("%s %s = %d, want %d: %s", method, path, resp.StatusCode, want, data)
	}
	return data
}

func idOf(t *testing.T, body []byte) string {
	t.Helper()
	var value struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(body, &value); err != nil {
		t.Fatal(err)
	}
	if value.ID == "" {
		t.Fatal("missing ID:", string(body))
	}
	return value.ID
}

func TestAccountsConfigurationAndOwnership(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" || r.Header.Get("Authorization") != "Bearer synthetic-key" {
			http.Error(w, "wrong request", 400)
			return
		}
		_, _ = io.WriteString(w, `{"data":[{"id":"gpt-4o","name":"GPT 4o"}]}`)
	}))
	defer up.Close()
	s, schema := fixture(t, up.URL)
	one, two := clientFor(t), clientFor(t)
	call(t, one, s.URL, "GET", "/auth/me", nil, 401)
	u1 := idOf(t, call(t, one, s.URL, "POST", "/auth/register", map[string]any{"username": "test_user_one", "password": "Test-password-123"}, 201))
	call(t, two, s.URL, "POST", "/auth/register", map[string]any{"username": "test_user_two", "password": "Test-password-456"}, 201)
	call(t, two, s.URL, "POST", "/auth/register", map[string]any{"username": "test_user_one", "password": "Test-password-123"}, 409)
	pid := idOf(t, call(t, one, s.URL, "POST", "/providers", map[string]any{"name": "测试供应商", "templateId": "custom", "protocol": "openai-chat", "adapter": "standard", "baseUrl": up.URL + "/v1", "apiKey": "synthetic-key", "enabled": true}, 201))
	provider := call(t, one, s.URL, "GET", "/providers/"+pid, nil, 200)
	if bytes.Contains(provider, []byte("synthetic-key")) {
		t.Fatal("API key disclosed")
	}
	call(t, two, s.URL, "GET", "/providers/"+pid, nil, 404)
	call(t, two, s.URL, "DELETE", "/providers/"+pid, nil, 404)
	call(t, one, s.URL, "PATCH", "/providers/"+pid, map[string]any{"name": "保留密钥", "templateId": "custom", "protocol": "openai-chat", "adapter": "standard", "baseUrl": up.URL + "/v1", "apiKey": "", "enabled": true}, 200)
	call(t, one, s.URL, "POST", "/providers/"+pid+"/discover", nil, 200)
	modelID := idOf(t, call(t, one, s.URL, "POST", "/models", map[string]any{"providerId": pid, "modelId": "gpt-4o", "name": "测试模型", "enabled": true, "maxOutputTokens": 4096, "defaultReasoning": map[string]any{}}, 201))
	call(t, two, s.URL, "GET", "/models/"+modelID, nil, 404)
	call(t, one, s.URL, "PATCH", "/preferences", map[string]any{"defaultModelId": modelID}, 200)
	call(t, two, s.URL, "PATCH", "/preferences", map[string]any{"defaultModelId": modelID}, 404)
	cid := idOf(t, call(t, one, s.URL, "POST", "/conversations", map[string]string{"title": "测试对话"}, 201))
	call(t, two, s.URL, "GET", "/conversations/"+cid, nil, 404)
	call(t, one, s.URL, "PATCH", "/conversations/"+cid, map[string]string{"title": "重命名"}, 200)
	call(t, one, s.URL, "DELETE", "/conversations/"+cid, nil, 204)
	call(t, one, s.URL, "GET", "/conversations/"+cid, nil, 404)
	req, _ := http.NewRequest("POST", s.URL+"/api/conversations", strings.NewReader(`{"title":"CSRF"}`))
	req.Header.Set("Origin", "https://attacker.invalid")
	resp, err := one.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Fatal("cross-origin mutation accepted:", resp.StatusCode)
	}
	call(t, one, s.URL, "POST", "/auth/password", map[string]string{"currentPassword": "wrong-password", "newPassword": "Test-new-password-123"}, 400)
	call(t, one, s.URL, "POST", "/auth/password", map[string]string{"currentPassword": "Test-password-123", "newPassword": "Test-new-password-123"}, 204)
	call(t, one, s.URL, "GET", "/auth/me", nil, 401)
	call(t, one, s.URL, "POST", "/auth/login", map[string]string{"username": "test_user_one", "password": "Test-new-password-123"}, 200)
	// Expire this user's session independently to check server-side seven-day enforcement.
	admin, err := pgx.Connect(context.Background(), os.Getenv("DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(context.Background())
	_, err = admin.Exec(context.Background(), fmt.Sprintf("UPDATE %s.sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1", pgx.Identifier{schema}.Sanitize()), u1)
	if err != nil {
		t.Fatal(err)
	}
	call(t, one, s.URL, "GET", "/auth/me", nil, 401)
}

func TestGenerationPersistenceRetryStopAndCancellationIntent(t *testing.T) {
	started, cancelled := make(chan struct{}, 4), make(chan struct{}, 4)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/v1/models" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"data":[{"id":"gpt-4o"}]}`)
			return
		}
		var body struct {
			Messages []struct {
				Content string `json:"content"`
			} `json:"messages"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		content := body.Messages[len(body.Messages)-1].Content
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\n\n")
		w.(http.Flusher).Flush()
		if content == "等待" {
			started <- struct{}{}
			<-r.Context().Done()
			cancelled <- struct{}{}
			return
		}
		_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"，世界\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer up.Close()
	s, _ := fixture(t, up.URL)
	c := clientFor(t)
	call(t, c, s.URL, "POST", "/auth/register", map[string]string{"username": "generation_user", "password": "Test-password-123"}, 201)
	pid := idOf(t, call(t, c, s.URL, "POST", "/providers", map[string]any{"name": "本地仿真", "templateId": "custom", "protocol": "openai-chat", "adapter": "standard", "baseUrl": up.URL + "/v1", "apiKey": "synthetic-key", "enabled": true}, 201))
	mid := idOf(t, call(t, c, s.URL, "POST", "/models", map[string]any{"providerId": pid, "modelId": "gpt-4o", "name": "测试模型", "enabled": true, "maxOutputTokens": 4096, "defaultReasoning": map[string]any{}}, 201))
	cid := idOf(t, call(t, c, s.URL, "POST", "/conversations", map[string]string{"title": "生成测试"}, 201))
	input := map[string]any{"generationId": uuid.NewString(), "modelId": mid, "userMessageId": uuid.NewString(), "assistantMessageId": uuid.NewString(), "content": "你好", "retry": false}
	stream := call(t, c, s.URL, "POST", "/conversations/"+cid+"/generations", input, 200)
	if !bytes.Contains(stream, []byte(`"type":"done"`)) || !bytes.Contains(stream, []byte("你好")) {
		t.Fatal("missing terminal/text event:", string(stream))
	}
	var conv struct {
		Messages []struct{ Content, Status string }
	}
	_ = json.Unmarshal(call(t, c, s.URL, "GET", "/conversations/"+cid, nil, 200), &conv)
	if len(conv.Messages) != 2 || conv.Messages[1].Content != "你好，世界" || conv.Messages[1].Status != "completed" {
		t.Fatalf("bad persisted response: %+v", conv)
	}
	call(t, c, s.URL, "POST", "/conversations/"+cid+"/generations", input, 409)
	pre := uuid.NewString()
	call(t, c, s.URL, "POST", "/conversations/"+cid+"/generations/"+pre+"/stop", nil, 204)
	input["generationId"] = pre
	input["userMessageId"] = uuid.NewString()
	input["assistantMessageId"] = uuid.NewString()
	call(t, c, s.URL, "POST", "/conversations/"+cid+"/generations", input, 409)
	input["generationId"] = uuid.NewString()
	input["content"] = "等待"
	gid := input["generationId"].(string)
	data, _ := json.Marshal(input)
	req, _ := http.NewRequest("POST", s.URL+"/api/conversations/"+cid+"/generations", bytes.NewReader(data))
	req.Header.Set("Origin", s.URL)
	resp, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("upstream not started")
	}
	call(t, c, s.URL, "POST", "/conversations/"+cid+"/generations/"+gid+"/stop", nil, 204)
	select {
	case <-cancelled:
	case <-time.After(5 * time.Second):
		t.Fatal("upstream not cancelled")
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = json.Unmarshal(call(t, c, s.URL, "GET", "/conversations/"+cid, nil, 200), &conv)
	if len(conv.Messages) != 4 || conv.Messages[3].Status != "stopped" {
		t.Fatalf("stop not persisted: %+v", conv)
	}
	call(t, c, s.URL, "DELETE", "/conversations/"+cid, nil, 204)
	call(t, c, s.URL, "GET", "/conversations/"+cid, nil, 404)
}
