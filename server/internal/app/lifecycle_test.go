package app

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
)

type lifecycleFixture struct {
	server                              *httptest.Server
	app                                 *App
	client                              *http.Client
	user, provider, model, conversation string
}

func newLifecycleFixture(t *testing.T, upstreamURL string) lifecycleFixture {
	t.Helper()
	server, _ := fixture(t, upstreamURL)
	client := clientFor(t)
	user := idOf(t, call(t, client, server.URL, "POST", "/auth/register", map[string]string{"username": "lifecycle_user", "password": "Test-password-123"}, 201))
	provider := idOf(t, call(t, client, server.URL, "POST", "/providers", map[string]any{"name": "生命周期仿真", "templateId": "custom", "protocol": "openai-chat", "adapter": "standard", "baseUrl": upstreamURL + "/v1", "apiKey": "synthetic-lifecycle-key", "enabled": true}, 201))
	model := idOf(t, call(t, client, server.URL, "POST", "/models", map[string]any{"providerId": provider, "modelId": "o3", "name": "生命周期模型", "enabled": true, "maxOutputTokens": 4096, "defaultReasoning": map[string]any{"effort": "high"}}, 201))
	conversation := idOf(t, call(t, client, server.URL, "POST", "/conversations", map[string]string{"title": "虚构生命周期历史"}, 201))
	return lifecycleFixture{server, server.Config.Handler.(*App), client, user, provider, model, conversation}
}

func generationPayload(model string) map[string]any {
	return map[string]any{"generationId": uuid.NewString(), "userMessageId": uuid.NewString(), "assistantMessageId": uuid.NewString(), "modelId": model, "content": "虚构测试消息", "retry": false}
}

func openLifecycleStream(t *testing.T, f lifecycleFixture, input map[string]any) (*http.Response, context.CancelFunc) {
	t.Helper()
	data, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	request, err := http.NewRequestWithContext(ctx, "POST", f.server.URL+"/api/conversations/"+f.conversation+"/generations", bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Origin", f.server.URL)
	request.Header.Set("Content-Type", "application/json")
	response, err := f.client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { response.Body.Close() })
	if response.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(response.Body)
		t.Fatalf("generation returned %d: %s", response.StatusCode, body)
	}
	return response, cancel
}

func awaitLifecycleSignal(t *testing.T, ch <-chan struct{}, description string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(4 * time.Second):
		t.Fatal(description)
	}
}

func readLifecycleConversation(t *testing.T, f lifecycleFixture) []messageView {
	t.Helper()
	var conversation struct {
		Messages []messageView `json:"messages"`
	}
	if err := json.Unmarshal(call(t, f.client, f.server.URL, "GET", "/conversations/"+f.conversation, nil, 200), &conversation); err != nil {
		t.Fatal(err)
	}
	return conversation.Messages
}

func TestGenerationUUIDAliasesStopActiveUpstream(t *testing.T) {
	for _, format := range []string{"uppercase", "compact"} {
		t.Run(format, func(t *testing.T) {
			started, cancelled := make(chan struct{}, 1), make(chan struct{}, 1)
			up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				io.Copy(io.Discard, r.Body)
				w.Header().Set("Content-Type", "text/event-stream")
				w.WriteHeader(200)
				w.(http.Flusher).Flush()
				started <- struct{}{}
				select {
				case <-r.Context().Done():
					cancelled <- struct{}{}
				case <-time.After(8 * time.Second):
				}
			}))
			t.Cleanup(up.Close)
			f := newLifecycleFixture(t, up.URL)
			input := generationPayload(f.model)
			canonical := input["generationId"].(string)
			if format == "uppercase" {
				input["generationId"] = strings.ToUpper(canonical)
			} else {
				input["generationId"] = strings.ReplaceAll(canonical, "-", "")
			}
			response, _ := openLifecycleStream(t, f, input)
			awaitLifecycleSignal(t, started, "upstream did not start")
			call(t, f.client, f.server.URL, "POST", "/conversations/"+f.conversation+"/generations/"+canonical+"/stop", nil, 204)
			awaitLifecycleSignal(t, cancelled, "canonical stop did not cancel aliased generation")
			io.Copy(io.Discard, response.Body)
			messages := readLifecycleConversation(t, f)
			if len(messages) != 2 || messages[1].Status != "stopped" {
				t.Fatalf("stop not persisted: %+v", messages)
			}
		})
	}
}

func TestModelEnableFlagSurvivesEditingWhileProviderIsDisabled(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	t.Cleanup(up.Close)
	f := newLifecycleFixture(t, up.URL)
	call(t, f.client, f.server.URL, "PATCH", "/providers/"+f.provider, map[string]bool{"enabled": false}, 200)
	var model modelView
	if err := json.Unmarshal(call(t, f.client, f.server.URL, "GET", "/models/"+f.model, nil, 200), &model); err != nil {
		t.Fatal(err)
	}
	if !model.Enabled {
		t.Fatal("provider disable overwrote the model's own enabled setting")
	}
	call(t, f.client, f.server.URL, "PATCH", "/models/"+f.model, map[string]any{"name": "改名后的模型", "enabled": model.Enabled}, 200)
	call(t, f.client, f.server.URL, "PATCH", "/providers/"+f.provider, map[string]bool{"enabled": true}, 200)
	if err := json.Unmarshal(call(t, f.client, f.server.URL, "GET", "/models/"+f.model, nil, 200), &model); err != nil || !model.Enabled {
		t.Fatalf("renamed model did not remain enabled: %+v %v", model, err)
	}
}

func TestUUIDAliasesCannotDeleteConfigurationDuringGeneration(t *testing.T) {
	up, started, cancelled, _ := waitingLifecycleUpstream(t, "")
	f := newLifecycleFixture(t, up.URL)
	input := generationPayload(f.model)
	response, _ := openLifecycleStream(t, f, input)
	awaitLifecycleSignal(t, started, "upstream did not start")
	for _, format := range []func(string) string{strings.ToUpper, func(id string) string { return strings.ReplaceAll(id, "-", "") }} {
		call(t, f.client, f.server.URL, "DELETE", "/models/"+format(f.model), nil, 409)
		call(t, f.client, f.server.URL, "DELETE", "/providers/"+format(f.provider), nil, 409)
	}
	call(t, f.client, f.server.URL, "POST", "/conversations/"+f.conversation+"/generations/"+input["generationId"].(string)+"/stop", nil, 204)
	awaitLifecycleSignal(t, cancelled, "upstream not cancelled")
	io.Copy(io.Discard, response.Body)
	call(t, f.client, f.server.URL, "DELETE", "/models/"+strings.ToUpper(f.model), nil, 204)
	call(t, f.client, f.server.URL, "DELETE", "/providers/"+strings.ToUpper(f.provider), nil, 204)
}

func TestNativeContinuationIsRetainedOnlyForCompatibleProviderConfiguration(t *testing.T) {
	type captured struct {
		Path     string
		Messages []map[string]any
	}
	requests := make(chan captured, 3)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Messages []map[string]any `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			http.Error(w, "invalid request", 400)
			return
		}
		requests <- captured{r.URL.Path, input.Messages}
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"private-native-thinking\",\"content\":\"正文回答\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	t.Cleanup(up.Close)
	f := newLifecycleFixture(t, up.URL)
	for turn := 0; turn < 3; turn++ {
		if turn == 2 {
			call(t, f.client, f.server.URL, "PATCH", "/providers/"+f.provider, map[string]string{"baseUrl": up.URL + "/v2"}, 200)
		}
		stream := call(t, f.client, f.server.URL, "POST", "/conversations/"+f.conversation+"/generations", generationPayload(f.model), 200)
		if !bytes.Contains(stream, []byte(`"type":"done"`)) || bytes.Contains(stream, []byte("private-native-thinking")) {
			t.Fatalf("turn %d failed or leaked native thinking: %s", turn, stream)
		}
		req := <-requests
		for _, message := range req.Messages {
			if message["role"] != "assistant" {
				continue
			}
			if message["content"] != "正文回答" {
				t.Fatal("provider change lost prior answer text")
			}
			if turn == 1 && message["reasoning_content"] != "private-native-thinking" {
				t.Fatal("compatible continuation lost native thinking")
			}
			if turn == 2 && message["reasoning_content"] != nil {
				t.Fatal("changed provider received incompatible native thinking")
			}
		}
		if turn == 2 && req.Path != "/v2/chat/completions" {
			t.Fatalf("old provider address used: %s", req.Path)
		}
	}
}

func TestFailedRetryUsesOriginalSnapshotWithoutDuplicatingUser(t *testing.T) {
	type upstreamRequest struct {
		Model     string                           `json:"model"`
		Effort    string                           `json:"reasoning_effort"`
		MaxOutput int                              `json:"max_completion_tokens"`
		Messages  []struct{ Role, Content string } `json:"messages"`
	}
	requests := make(chan upstreamRequest, 2)
	var attempts atomic.Int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var input upstreamRequest
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			http.Error(w, "bad request", 400)
			return
		}
		requests <- input
		w.Header().Set("Content-Type", "text/event-stream")
		if attempts.Add(1) == 1 {
			io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"失败前保留片段\"}}]}\n\n")
			return // A clean EOF without a native terminal event must still fail.
		}
		io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"重试成功\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	t.Cleanup(up.Close)
	f := newLifecycleFixture(t, up.URL)
	input := generationPayload(f.model)
	stream := call(t, f.client, f.server.URL, "POST", "/conversations/"+f.conversation+"/generations", input, 200)
	if !bytes.Contains(stream, []byte(`"type":"error"`)) || bytes.Contains(stream, []byte(`"type":"done"`)) {
		t.Fatalf("unterminated stream did not fail: %s", stream)
	}
	messages := readLifecycleConversation(t, f)
	if len(messages) != 2 || messages[1].Status != "failed" || messages[1].Content != "失败前保留片段" {
		t.Fatalf("partial failure not persisted: %+v", messages)
	}
	alternate := idOf(t, call(t, f.client, f.server.URL, "POST", "/models", map[string]any{"providerId": f.provider, "modelId": "gpt-4o", "name": "其他模型", "enabled": true, "maxOutputTokens": 2048, "defaultReasoning": map[string]any{}}, 201))
	call(t, f.client, f.server.URL, "PATCH", "/models/"+f.model, map[string]any{"providerId": f.provider, "modelId": "o3", "name": "已改变默认值", "enabled": true, "maxOutputTokens": 2048, "defaultReasoning": map[string]any{"effort": "low"}}, 200)
	call(t, f.client, f.server.URL, "PATCH", "/preferences", map[string]any{"defaultModelId": alternate}, 200)
	originalGeneration := input["generationId"].(string)
	input["generationId"] = uuid.NewString()
	input["retry"] = true
	input["modelId"] = alternate
	input["reasoning"] = map[string]any{"effort": "low"}
	input["content"] = "客户端不同文本"
	stream = call(t, f.client, f.server.URL, "POST", "/conversations/"+f.conversation+"/generations", input, 200)
	if !bytes.Contains(stream, []byte(`"type":"done"`)) {
		t.Fatalf("retry did not complete: %s", stream)
	}
	for attempt := 0; attempt < 2; attempt++ {
		select {
		case request := <-requests:
			if request.Model != "o3" || request.Effort != "high" || request.MaxOutput != 4096 || len(request.Messages) != 1 || request.Messages[0].Role != "user" || request.Messages[0].Content != "虚构测试消息" {
				t.Fatalf("attempt %d did not use snapshot/history: %+v", attempt, request)
			}
		case <-time.After(time.Second):
			t.Fatal("upstream request missing")
		}
	}
	messages = readLifecycleConversation(t, f)
	if len(messages) != 2 || messages[0].ID != input["userMessageId"] || messages[1].ID != input["assistantMessageId"] || messages[1].Content != "重试成功" || messages[1].Status != "completed" || messages[1].GenerationID == nil || *messages[1].GenerationID == originalGeneration {
		t.Fatalf("retry duplicated or failed to replace messages: %+v", messages)
	}
	if attempts.Load() != 2 {
		t.Fatal("unexpected upstream call count")
	}
}

func waitingLifecycleUpstream(t *testing.T, partial string) (*httptest.Server, <-chan struct{}, <-chan struct{}, *atomic.Int32) {
	t.Helper()
	started, cancelled := make(chan struct{}, 4), make(chan struct{}, 4)
	count := new(atomic.Int32)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		count.Add(1)
		io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		if partial != "" {
			chunk, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"content": partial}}}})
			io.WriteString(w, "data: "+string(chunk)+"\n\n")
		}
		w.(http.Flusher).Flush()
		started <- struct{}{}
		select {
		case <-r.Context().Done():
			cancelled <- struct{}{}
		case <-time.After(8 * time.Second):
		}
	}))
	t.Cleanup(up.Close)
	return up, started, cancelled, count
}

func TestConcurrentGenerationDoesNotCallUpstreamOrDuplicateMessages(t *testing.T) {
	up, started, cancelled, count := waitingLifecycleUpstream(t, "")
	f := newLifecycleFixture(t, up.URL)
	first := generationPayload(f.model)
	response, _ := openLifecycleStream(t, f, first)
	awaitLifecycleSignal(t, started, "first upstream did not start")
	call(t, f.client, f.server.URL, "POST", "/conversations/"+f.conversation+"/generations", generationPayload(f.model), 409)
	if count.Load() != 1 {
		t.Fatal("concurrent generation called upstream")
	}
	messages := readLifecycleConversation(t, f)
	if len(messages) != 2 {
		t.Fatalf("concurrent generation duplicated messages: %+v", messages)
	}
	call(t, f.client, f.server.URL, "POST", "/conversations/"+f.conversation+"/generations/"+first["generationId"].(string)+"/stop", nil, 204)
	awaitLifecycleSignal(t, cancelled, "first upstream not cancelled")
	io.Copy(io.Discard, response.Body)
}

func waitLifecycleStatus(t *testing.T, f lifecycleFixture, want string) []messageView {
	t.Helper()
	deadline := time.Now().Add(4 * time.Second)
	for {
		messages := readLifecycleConversation(t, f)
		if len(messages) > 0 && messages[len(messages)-1].Status == want {
			return messages
		}
		if time.Now().After(deadline) {
			t.Fatalf("did not persist %s: %+v", want, messages)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestClientDisconnectCancelsUpstreamAndKeepsDurablePartialAnswer(t *testing.T) {
	up, started, cancelled, _ := waitingLifecycleUpstream(t, "断连前保留片段")
	f := newLifecycleFixture(t, up.URL)
	response, cancel := openLifecycleStream(t, f, generationPayload(f.model))
	awaitLifecycleSignal(t, started, "upstream did not start")
	var event struct{ Type, Content string }
	if err := json.NewDecoder(response.Body).Decode(&event); err != nil {
		t.Fatal(err)
	}
	if event.Type != "delta" || event.Content != "断连前保留片段" {
		t.Fatalf("unexpected visible delta: %+v", event)
	}
	messages := readLifecycleConversation(t, f)
	if len(messages) != 2 || !strings.HasPrefix(event.Content, messages[1].Content) {
		t.Fatal("database snapshot is not a prefix of the live response")
	}
	cancel()
	response.Body.Close()
	awaitLifecycleSignal(t, cancelled, "client disconnect did not cancel upstream")
	messages = waitLifecycleStatus(t, f, "stopped")
	if messages[1].Content != "断连前保留片段" {
		t.Fatal("disconnect discarded saved partial answer")
	}
}

func TestDeleteActiveConversationCancelsUpstreamAndRejectsLateWrites(t *testing.T) {
	up, started, cancelled, _ := waitingLifecycleUpstream(t, "")
	f := newLifecycleFixture(t, up.URL)
	input := generationPayload(f.model)
	response, _ := openLifecycleStream(t, f, input)
	awaitLifecycleSignal(t, started, "upstream did not start")
	call(t, f.client, f.server.URL, "DELETE", "/conversations/"+f.conversation, nil, 204)
	awaitLifecycleSignal(t, cancelled, "delete did not cancel upstream")
	io.Copy(io.Discard, response.Body)
	err := f.app.appendDelta(f.user, f.conversation, input["generationId"].(string), input["assistantMessageId"].(string), "迟到片段")
	if err == nil {
		t.Fatal("late delta succeeded after deletion")
	}
	saved, err := f.app.finish(f.user, f.conversation, input["generationId"].(string), "completed", nil, nil)
	if err != nil || saved {
		t.Fatalf("late terminal write succeeded: saved=%v err=%v", saved, err)
	}
	call(t, f.client, f.server.URL, "GET", "/conversations/"+f.conversation, nil, 404)
	var count int
	if err := f.app.pool.QueryRow(context.Background(), "SELECT (SELECT count(*) FROM messages WHERE conversation_id=$1)+(SELECT count(*) FROM generations WHERE conversation_id=$1)", f.conversation).Scan(&count); err != nil || count != 0 {
		t.Fatalf("late write resurrected deleted records: %d %v", count, err)
	}
}

func TestStartupRecoveryPreservesHistoryAndRejectsSecondInstance(t *testing.T) {
	var upstreamCalls atomic.Int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls.Add(1)
		http.Error(w, "unexpected restart generation", 500)
	}))
	t.Cleanup(up.Close)
	f := newLifecycleFixture(t, up.URL)
	type interrupted struct{ conversation, message, generation, before, after string }
	records := []interrupted{}
	for _, status := range []string{"pending", "streaming", "completed"} {
		cid := f.conversation
		if status != "pending" {
			cid = idOf(t, call(t, f.client, f.server.URL, "POST", "/conversations", map[string]string{"title": "虚构重启历史"}, 201))
		}
		message, generation := uuid.NewString(), uuid.NewString()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_, err := f.app.pool.Exec(ctx, "INSERT INTO messages(id,user_id,conversation_id,ordinal,role,content,status) VALUES($1,$2,$3,0,'user','重启前问题','completed')", uuid.NewString(), f.user, cid)
		if err == nil {
			_, err = f.app.pool.Exec(ctx, "INSERT INTO messages(id,user_id,conversation_id,ordinal,role,content,status,model_id,generation_id,reasoning) VALUES($1,$2,$3,1,'assistant','重启前已保存片段',$4,$5,$6,'{\"effort\":\"high\"}'::jsonb)", message, f.user, cid, status, f.model, generation)
		}
		if err == nil {
			_, err = f.app.pool.Exec(ctx, "INSERT INTO generations(id,user_id,conversation_id,assistant_message_id,status) VALUES($1,$2,$3,$4,$5)", generation, f.user, cid, message, status)
		}
		cancel()
		if err != nil {
			t.Fatal(err)
		}
		after := "stopped"
		if status == "completed" {
			after = "completed"
		}
		records = append(records, interrupted{cid, message, generation, status, after})
	}
	cfg := f.app.cfg
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	second, err := New(ctx, cfg)
	cancel()
	if err == nil {
		second.Close()
		t.Fatal("second server acquired the same database schema")
	}
	var before string
	if err := f.app.pool.QueryRow(context.Background(), "SELECT status FROM messages WHERE id=$1", records[0].message).Scan(&before); err != nil || before != "pending" {
		t.Fatal("denied second instance modified running instance history")
	}
	f.app.Close()
	ctx, cancel = context.WithTimeout(context.Background(), 10*time.Second)
	restarted, err := New(ctx, cfg)
	cancel()
	if err != nil {
		t.Fatal(err)
	}
	restartedServer := httptest.NewServer(restarted)
	t.Cleanup(func() { restartedServer.Close(); restarted.Close() })
	f.server, f.app = restartedServer, restarted
	call(t, f.client, f.server.URL, "GET", "/auth/me", nil, 200)
	for _, record := range records {
		f.conversation = record.conversation
		messages := readLifecycleConversation(t, f)
		if len(messages) != 2 || messages[0].Status != "completed" || messages[1].ID != record.message || messages[1].Status != record.after || messages[1].Content != "重启前已保存片段" || messages[1].Reasoning == nil || messages[1].Reasoning.Effort != "high" {
			t.Fatalf("recovery changed history for %s: %+v", record.before, messages)
		}
		var status string
		if err := restarted.pool.QueryRow(context.Background(), "SELECT status FROM generations WHERE id=$1", record.generation).Scan(&status); err != nil || status != record.after {
			t.Fatalf("generation recovery=%s want%s: %v", status, record.after, err)
		}
	}
	if upstreamCalls.Load() != 0 {
		t.Fatal("restart automatically resent an interrupted generation")
	}
}
