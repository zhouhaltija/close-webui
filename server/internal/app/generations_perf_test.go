// SPDX-License-Identifier: AGPL-3.0-only
package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// appendDeltaMarker identifies the single atomic statement in the query tracer.
// It is deliberately tied to the production SQL so these tests fail if the
// atomic statement is ever split back into several round trips.
const appendDeltaMarker = "WITH generation AS ("

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type perfFixture struct {
	server       *httptest.Server
	app          *App
	client       *http.Client
	schema       string
	user         string
	provider     string
	model        string
	conversation string
}

func newPerfFixture(t *testing.T, upstreamURL string) perfFixture {
	t.Helper()
	server, schema := fixture(t, upstreamURL)
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	return perfFixture{server: server, app: server.Config.Handler.(*App), client: &http.Client{Jar: jar, Timeout: 180 * time.Second}, schema: schema}
}

func (f *perfFixture) register(t *testing.T) {
	t.Helper()
	f.user = idOf(t, call(t, f.client, f.server.URL, "POST", "/auth/register", map[string]string{"username": "perf_user_" + strings.ReplaceAll(uuid.NewString(), "-", "")[:12], "password": "Test-password-123"}, 201))
}

func (f *perfFixture) configure(t *testing.T, upstreamURL, protocol, basePath, modelID string) {
	t.Helper()
	f.provider = idOf(t, call(t, f.client, f.server.URL, "POST", "/providers", map[string]any{"name": "性能仿真供应商", "templateId": "custom", "protocol": protocol, "adapter": "standard", "baseUrl": upstreamURL + basePath, "apiKey": "synthetic-perf-key", "enabled": true}, 201))
	f.model = idOf(t, call(t, f.client, f.server.URL, "POST", "/models", map[string]any{"providerId": f.provider, "modelId": modelID, "name": "性能仿真模型", "enabled": true, "maxOutputTokens": 4096, "defaultReasoning": map[string]any{}}, 201))
	f.conversation = idOf(t, call(t, f.client, f.server.URL, "POST", "/conversations", map[string]string{"title": "虚构流式性能历史"}, 201))
}

func (f *perfFixture) newConversation(t *testing.T, title string) string {
	t.Helper()
	return idOf(t, call(t, f.client, f.server.URL, "POST", "/conversations", map[string]string{"title": title}, 201))
}

func (f *perfFixture) readConversation(t *testing.T) []messageView {
	t.Helper()
	var conversation struct {
		Messages []messageView `json:"messages"`
	}
	if err := json.Unmarshal(call(t, f.client, f.server.URL, "GET", "/conversations/"+f.conversation, nil, 200), &conversation); err != nil {
		t.Fatal(err)
	}
	return conversation.Messages
}

func perfDrainBody(t *testing.T, response *http.Response) {
	t.Helper()
	finished := make(chan struct{})
	go func() {
		_, _ = io.Copy(io.Discard, response.Body)
		close(finished)
	}()
	select {
	case <-finished:
	case <-time.After(90 * time.Second):
		t.Fatal("stream response was not closed by the server")
	}
}

// ---------------------------------------------------------------------------
// Simulated upstreams for the four supported protocols
// ---------------------------------------------------------------------------

type perfUpstreamBehaviour int

const (
	// perfUpstreamComplete terminates with a native terminal event.
	perfUpstreamComplete perfUpstreamBehaviour = iota
	// perfUpstreamEOF closes the stream without any terminal event.
	perfUpstreamEOF
	// perfUpstreamError reports a provider failure inside the stream.
	perfUpstreamError
	// perfUpstreamHold keeps the stream open until the request context ends.
	perfUpstreamHold
)

type perfUpstreamRoute struct {
	prefix    string
	protocol  string
	fragments []string
	interval  time.Duration
	behaviour perfUpstreamBehaviour

	mu    sync.Mutex
	times []time.Time
	first chan time.Time
}

type perfScriptedUpstream struct {
	*httptest.Server
	mu     sync.Mutex
	routes []*perfUpstreamRoute
}

func newPerfSimulatedUpstream(t *testing.T) *perfScriptedUpstream {
	t.Helper()
	server := &perfScriptedUpstream{}
	server.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		route := server.routeFor(r.URL.Path)
		if route == nil {
			http.Error(w, "unknown upstream route", http.StatusNotFound)
			return
		}
		route.serve(w, r)
	}))
	t.Cleanup(server.Close)
	return server
}

func (s *perfScriptedUpstream) route(t *testing.T, prefix, protocol string, fragments []string, interval time.Duration, behaviour perfUpstreamBehaviour) *perfUpstreamRoute {
	t.Helper()
	route := &perfUpstreamRoute{prefix: prefix, protocol: protocol, fragments: fragments, interval: interval, behaviour: behaviour, first: make(chan time.Time, 1)}
	s.mu.Lock()
	s.routes = append(s.routes, route)
	s.mu.Unlock()
	return route
}

func (s *perfScriptedUpstream) routeFor(path string) *perfUpstreamRoute {
	s.mu.Lock()
	defer s.mu.Unlock()
	var best *perfUpstreamRoute
	for _, route := range s.routes {
		if strings.HasPrefix(path, route.prefix) && (best == nil || len(route.prefix) > len(best.prefix)) {
			best = route
		}
	}
	return best
}

func (r *perfUpstreamRoute) noteFragment() {
	r.mu.Lock()
	r.times = append(r.times, time.Now())
	r.mu.Unlock()
	select {
	case r.first <- time.Now():
	default:
	}
}

func (r *perfUpstreamRoute) fragmentTimes() []time.Time {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]time.Time(nil), r.times...)
}

func (r *perfUpstreamRoute) serve(w http.ResponseWriter, request *http.Request) {
	_, _ = io.Copy(io.Discard, request.Body)
	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	write := func(event, data string) {
		if event != "" {
			fmt.Fprintf(w, "event: %s\n", event)
		}
		fmt.Fprintf(w, "data: %s\n\n", data)
		if flusher != nil {
			flusher.Flush()
		}
	}
	blockOpen := false
	emit := func(text string) {
		switch r.protocol {
		case "openai-chat":
			write("", fmt.Sprintf(`{"choices":[{"index":0,"delta":{"content":%q}}]}`, text))
		case "openai-responses":
			write("", fmt.Sprintf(`{"type":"response.output_text.delta","delta":%q}`, text))
		case "gemini":
			write("", fmt.Sprintf(`{"candidates":[{"index":0,"content":{"parts":[{"text":%q}]}}]}`, text))
		case "anthropic":
			if !blockOpen {
				blockOpen = true
				write("content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`)
			}
			write("content_block_delta", fmt.Sprintf(`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":%q}}`, text))
		}
		r.noteFragment()
	}
	terminal := func() {
		switch r.protocol {
		case "openai-chat":
			write("", `{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`)
			write("", "[DONE]")
		case "openai-responses":
			write("", `{"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"完整回答"}]}]}}`)
		case "gemini":
			write("", `{"candidates":[{"index":0,"content":{"parts":[]},"finishReason":"STOP"}]}`)
		case "anthropic":
			write("message_delta", `{"type":"message_delta","delta":{"stop_reason":"end_turn"}}`)
			write("content_block_stop", `{"type":"content_block_stop","index":0}`)
			write("message_stop", `{"type":"message_stop"}`)
		}
	}
	failure := func() {
		switch r.protocol {
		case "openai-chat":
			write("", `{"error":{"message":"仿真上游失败"}}`)
		case "openai-responses":
			write("", `{"type":"error","message":"仿真上游失败"}`)
		case "gemini":
			write("", `{"error":{"code":500,"message":"仿真上游失败","status":"INTERNAL"}}`)
		case "anthropic":
			write("error", `{"type":"error","error":{"type":"overloaded_error","message":"仿真上游失败"}}`)
		}
	}
	for i, fragment := range r.fragments {
		if i > 0 && r.interval > 0 {
			time.Sleep(r.interval)
		}
		emit(fragment)
	}
	switch r.behaviour {
	case perfUpstreamComplete:
		terminal()
	case perfUpstreamError:
		failure()
	case perfUpstreamHold:
		<-request.Context().Done()
	case perfUpstreamEOF:
	}
}

// ---------------------------------------------------------------------------
// NDJSON stream collection
// ---------------------------------------------------------------------------

type perfStreamEvent struct {
	Type    string    `json:"type"`
	Content string    `json:"content"`
	Code    string    `json:"code"`
	Message string    `json:"message"`
	At      time.Time `json:"-"`
}

type perfStreamCollector struct {
	mu     sync.Mutex
	events []perfStreamEvent
	done   chan struct{}
}

func perfCollectStream(response *http.Response) *perfStreamCollector {
	collector := &perfStreamCollector{done: make(chan struct{})}
	go func() {
		defer close(collector.done)
		decoder := json.NewDecoder(response.Body)
		for {
			var event perfStreamEvent
			if err := decoder.Decode(&event); err != nil {
				return
			}
			event.At = time.Now()
			collector.mu.Lock()
			collector.events = append(collector.events, event)
			collector.mu.Unlock()
		}
	}()
	return collector
}

func (c *perfStreamCollector) snapshot() []perfStreamEvent {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]perfStreamEvent(nil), c.events...)
}

func (c *perfStreamCollector) waitFor(t *testing.T, description string, predicate func([]perfStreamEvent) bool) []perfStreamEvent {
	t.Helper()
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		if events := c.snapshot(); predicate(events) {
			return events
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("等待 %s 超时：%+v", description, c.snapshot())
	return nil
}

func perfHasEventOfType(events []perfStreamEvent, kind string) bool {
	for _, event := range events {
		if event.Type == kind {
			return true
		}
	}
	return false
}

func perfLastEventOfType(events []perfStreamEvent, kind string) (perfStreamEvent, bool) {
	for i := len(events) - 1; i >= 0; i-- {
		if events[i].Type == kind {
			return events[i], true
		}
	}
	return perfStreamEvent{}, false
}

func perfVisibleText(events []perfStreamEvent) string {
	text := strings.Builder{}
	for _, event := range events {
		if event.Type == "delta" {
			text.WriteString(event.Content)
		}
	}
	return text.String()
}

func (f *perfFixture) startGeneration(t *testing.T, content string) (*http.Response, map[string]any, *perfStreamCollector) {
	t.Helper()
	input := map[string]any{"generationId": uuid.NewString(), "userMessageId": uuid.NewString(), "assistantMessageId": uuid.NewString(), "modelId": f.model, "content": content, "retry": false}
	body, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequestWithContext(context.Background(), "POST", f.server.URL+"/api/conversations/"+f.conversation+"/generations", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", f.server.URL)
	response, err := f.client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK {
		data, _ := io.ReadAll(response.Body)
		response.Body.Close()
		t.Fatalf("generation returned %d: %s", response.StatusCode, data)
	}
	return response, input, perfCollectStream(response)
}

// ---------------------------------------------------------------------------
// Query tracer: records statements, measures latency, injects slow/failed writes
// ---------------------------------------------------------------------------

type perfTraceRecord struct {
	SQL   string
	Args  []any
	Start time.Time
	End   time.Time
	Err   error
	Delta bool
	Ended bool
}

type perfQueryTracer struct {
	mu        sync.Mutex
	records   []*perfTraceRecord
	deltaRuns int
	delay     atomic.Int64
	// failFrom makes every appendDelta statement from the Nth one onwards fail,
	// which injects a deterministic mid-stream persistence failure.
	failFrom atomic.Int64
}

type perfTraceContextKey struct{}

func isAppendDelta(sql string) bool { return strings.Contains(sql, appendDeltaMarker) }

func (p *perfQueryTracer) TraceQueryStart(ctx context.Context, conn *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	record := &perfTraceRecord{SQL: data.SQL, Args: append([]any(nil), data.Args...), Start: time.Now(), Delta: isAppendDelta(data.SQL)}
	p.mu.Lock()
	p.records = append(p.records, record)
	fail := false
	if record.Delta {
		p.deltaRuns++
		fail = p.failFrom.Load() > 0 && int64(p.deltaRuns) >= p.failFrom.Load()
	}
	p.mu.Unlock()
	if !record.Delta {
		return context.WithValue(ctx, perfTraceContextKey{}, record)
	}
	if delay := time.Duration(p.delay.Load()); delay > 0 {
		time.Sleep(delay)
	}
	if fail {
		record.End = time.Now()
		record.Ended = true
		record.Err = context.Canceled
		cancelled, cancel := context.WithCancel(ctx)
		cancel()
		return cancelled
	}
	return context.WithValue(ctx, perfTraceContextKey{}, record)
}

func (p *perfQueryTracer) TraceQueryEnd(ctx context.Context, conn *pgx.Conn, data pgx.TraceQueryEndData) {
	record, ok := ctx.Value(perfTraceContextKey{}).(*perfTraceRecord)
	if !ok || record.Ended {
		return
	}
	record.End = time.Now()
	record.Err = data.Err
	record.Ended = true
}

func (p *perfQueryTracer) snapshot() []*perfTraceRecord {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]*perfTraceRecord(nil), p.records...)
}

func (p *perfQueryTracer) deltaRecords() []*perfTraceRecord {
	records := []*perfTraceRecord{}
	for _, record := range p.snapshot() {
		if record.Delta {
			records = append(records, record)
		}
	}
	return records
}

func (p *perfQueryTracer) statementCount(sql string) int {
	count := 0
	for _, record := range p.snapshot() {
		if record.SQL == sql {
			count++
		}
	}
	return count
}

// swapPool points the application at an instrumented pool for the duration of
// the test and restores the original pool afterwards.
func (p *perfQueryTracer) swapPool(t *testing.T, a *App, schema string) {
	t.Helper()
	pc, err := pgxpool.ParseConfig(os.Getenv("DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	pc.ConnConfig.RuntimeParams["search_path"] = schema
	pc.ConnConfig.Tracer = p
	pc.MaxConns = 4
	pc.ShouldPing = func(context.Context, pgxpool.ShouldPingParams) bool { return false }
	pool, err := pgxpool.NewWithConfig(context.Background(), pc)
	if err != nil {
		t.Fatal(err)
	}
	original := a.pool
	a.pool = pool
	t.Cleanup(func() {
		a.pool = original
		pool.Close()
	})
}

func perfMeasureRoundTrip(t *testing.T, pool *pgxpool.Pool) time.Duration {
	t.Helper()
	best := time.Duration(0)
	for i := 0; i < 3; i++ {
		start := time.Now()
		var one int
		if err := pool.QueryRow(context.Background(), "SELECT 1").Scan(&one); err != nil {
			t.Fatal(err)
		}
		if elapsed := time.Since(start); best == 0 || elapsed < best {
			best = elapsed
		}
	}
	return best
}

func peakConcurrentWrites(writes []*perfTraceRecord) int {
	type point struct {
		at    time.Time
		delta int
	}
	points := []point{}
	for _, write := range writes {
		if write.End.IsZero() {
			continue
		}
		points = append(points, point{write.Start, 1}, point{write.End, -1})
	}
	sort.Slice(points, func(i, j int) bool {
		if points[i].at.Equal(points[j].at) {
			return points[i].delta < points[j].delta
		}
		return points[i].at.Before(points[j].at)
	})
	current, peak := 0, 0
	for _, item := range points {
		current += item.delta
		if current > peak {
			peak = current
		}
	}
	return peak
}

func peakInFlightFragments(fragmentTimes []time.Time, writes []*perfTraceRecord) int {
	type point struct {
		at    time.Time
		delta int
	}
	points := []point{}
	for _, at := range fragmentTimes {
		points = append(points, point{at, 1})
	}
	for _, write := range writes {
		if write.End.IsZero() {
			continue
		}
		text, _ := write.Args[3].(string)
		points = append(points, point{write.End, -strings.Count(text, "段")})
	}
	sort.Slice(points, func(i, j int) bool {
		if points[i].at.Equal(points[j].at) {
			return points[i].delta < points[j].delta
		}
		return points[i].at.Before(points[j].at)
	})
	current, peak := 0, 0
	for _, item := range points {
		current += item.delta
		if current > peak {
			peak = current
		}
	}
	return peak
}

// ---------------------------------------------------------------------------
// 1. Single atomic statement
// ---------------------------------------------------------------------------

type perfCountingConn struct {
	net.Conn
	writes atomic.Int64
}

func (c *perfCountingConn) Write(b []byte) (int, error) {
	c.writes.Add(1)
	return c.Conn.Write(b)
}

type perfCountingDialer struct {
	mu    sync.Mutex
	conns []*perfCountingConn
}

func (d *perfCountingDialer) dial(ctx context.Context, network, addr string) (net.Conn, error) {
	var dialer net.Dialer
	conn, err := dialer.DialContext(ctx, network, addr)
	if err != nil {
		return nil, err
	}
	counted := &perfCountingConn{Conn: conn}
	d.mu.Lock()
	d.conns = append(d.conns, counted)
	d.mu.Unlock()
	return counted, nil
}

func (d *perfCountingDialer) writes() int64 {
	d.mu.Lock()
	defer d.mu.Unlock()
	var total int64
	for _, conn := range d.conns {
		total += conn.writes.Load()
	}
	return total
}

// legacyAppendDelta reproduces the pre-change implementation: BEGIN, two
// UPDATEs and COMMIT, i.e. four database round trips per batch.
func legacyAppendDelta(ctx context.Context, pool *pgxpool.Pool, uid, cid, gid, assistantID, delta string) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var id string
	if err = tx.QueryRow(ctx, "UPDATE generations SET status='streaming' WHERE id=$1 AND user_id=$2 AND conversation_id=$3 AND status IN ('pending','streaming') RETURNING id", gid, uid, cid).Scan(&id); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return errInactive
		}
		return err
	}
	result, err := tx.Exec(ctx, "UPDATE messages SET content=content || $1,status='streaming' WHERE id=$2 AND user_id=$3 AND conversation_id=$4 AND generation_id=$5 AND status IN ('pending','streaming')", delta, assistantID, uid, cid, gid)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return errInactive
	}
	return tx.Commit(ctx)
}

func perfCountingPool(t *testing.T, schema string, dialer *perfCountingDialer) *pgxpool.Pool {
	t.Helper()
	pc, err := pgxpool.ParseConfig(os.Getenv("DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	pc.ConnConfig.RuntimeParams["search_path"] = schema
	pc.ConnConfig.DialFunc = dialer.dial
	pc.MaxConns = 1
	pc.MinConns = 1
	pc.MinIdleConns = 1
	pc.ShouldPing = func(context.Context, pgxpool.ShouldPingParams) bool { return false }
	pool, err := pgxpool.NewWithConfig(context.Background(), pc)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func TestAppendDeltaRejectsForeignRowsAndInactiveGenerations(t *testing.T) {
	upstream := newPerfSimulatedUpstream(t)
	f := newPerfFixture(t, upstream.URL)
	f.register(t)
	f.configure(t, upstream.URL, "openai-chat", "/v1", "gpt-5-mini")
	tracer := &perfQueryTracer{}
	tracer.swapPool(t, f.app, f.schema)
	other := idOf(t, call(t, f.client, f.server.URL, "POST", "/auth/register", map[string]string{"username": "perf_other_" + strings.ReplaceAll(uuid.NewString(), "-", "")[:8], "password": "Test-password-123"}, 201))
	otherConversation := f.newConversation(t, "他人对话")
	ctx := context.Background()
	var ordinal int64
	// seed creates a dedicated conversation so the single active generation per
	// conversation index never collides between cases.
	seed := func(t *testing.T, generationStatus, messageStatus string, bindToGeneration bool) (string, string, string) {
		t.Helper()
		ordinal++
		cid, gid, mid := uuid.NewString(), uuid.NewString(), uuid.NewString()
		messageGeneration := gid
		if !bindToGeneration {
			messageGeneration = uuid.NewString()
		}
		if _, err := f.app.pool.Exec(ctx, "INSERT INTO conversations(id,user_id,title) VALUES($1,$2,'归属与活动条件测试')", cid, f.user); err != nil {
			t.Fatal(err)
		}
		if _, err := f.app.pool.Exec(ctx, "INSERT INTO messages(id,user_id,conversation_id,ordinal,role,content,status,generation_id) VALUES($1,$2,$3,$4,'assistant','已保存',$5,$6)", mid, f.user, cid, ordinal, messageStatus, messageGeneration); err != nil {
			t.Fatal(err)
		}
		if _, err := f.app.pool.Exec(ctx, "INSERT INTO generations(id,user_id,conversation_id,assistant_message_id,status) VALUES($1,$2,$3,$4,$5)", gid, f.user, cid, mid, generationStatus); err != nil {
			t.Fatal(err)
		}
		return cid, gid, mid
	}
	for _, testCase := range []struct {
		name             string
		generationStatus string
		messageStatus    string
		bindToGeneration bool
	}{
		{"pending generation", "pending", "pending", true},
		{"streaming generation", "streaming", "streaming", true},
		{"completed generation", "completed", "streaming", true},
		{"stopped generation", "stopped", "streaming", true},
		{"cancelled generation", "cancelled", "streaming", true},
		{"failed generation", "failed", "streaming", true},
		{"completed message", "pending", "completed", true},
		{"failed message", "pending", "failed", true},
		{"stopped message", "pending", "stopped", true},
		{"message owned by another generation", "pending", "pending", false},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			cid, gid, mid := seed(t, testCase.generationStatus, testCase.messageStatus, testCase.bindToGeneration)
			err := f.app.appendDelta(f.user, cid, gid, mid, "迟到片段")
			active := testCase.bindToGeneration &&
				(testCase.generationStatus == "pending" || testCase.generationStatus == "streaming") &&
				(testCase.messageStatus == "pending" || testCase.messageStatus == "streaming")
			if active {
				if err != nil {
					t.Fatalf("active batch rejected: %v", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("inactive batch accepted for %s", testCase.name)
			}
			if !errors.Is(err, errInactive) {
				t.Fatalf("%s returned %v, want errInactive", testCase.name, err)
			}
			var content, messageStatus, generationStatus string
			if err := f.app.pool.QueryRow(ctx, "SELECT content,status FROM messages WHERE id=$1", mid).Scan(&content, &messageStatus); err != nil {
				t.Fatal(err)
			}
			if err := f.app.pool.QueryRow(ctx, "SELECT status FROM generations WHERE id=$1", gid).Scan(&generationStatus); err != nil {
				t.Fatal(err)
			}
			if content != "已保存" || messageStatus != testCase.messageStatus || generationStatus != testCase.generationStatus {
				t.Fatalf("rejected append changed persisted rows: content=%q message=%q generation=%q", content, messageStatus, generationStatus)
			}
		})
	}
	t.Run("foreign bindings", func(t *testing.T) {
		cid, gid, mid := seed(t, "pending", "pending", true)
		if err := f.app.appendDelta(other, cid, gid, mid, "迟到片段"); !errors.Is(err, errInactive) {
			t.Fatalf("cross-user write returned %v, want errInactive", err)
		}
		if err := f.app.appendDelta(f.user, otherConversation, gid, mid, "迟到片段"); !errors.Is(err, errInactive) {
			t.Fatalf("cross-conversation write returned %v, want errInactive", err)
		}
		if err := f.app.appendDelta(f.user, cid, uuid.NewString(), mid, "迟到片段"); !errors.Is(err, errInactive) {
			t.Fatalf("unknown generation returned %v, want errInactive", err)
		}
		if err := f.app.appendDelta(f.user, cid, gid, uuid.NewString(), "迟到片段"); !errors.Is(err, errInactive) {
			t.Fatalf("unknown message returned %v, want errInactive", err)
		}
		var content, messageStatus, generationStatus string
		if err := f.app.pool.QueryRow(ctx, "SELECT m.content,m.status,g.status FROM messages m JOIN generations g ON g.assistant_message_id=m.id WHERE m.id=$1 AND g.id=$2", mid, gid).Scan(&content, &messageStatus, &generationStatus); err != nil {
			t.Fatal(err)
		}
		if content != "已保存" || messageStatus != "pending" || generationStatus != "pending" {
			t.Fatalf("foreign binding changed persisted rows: content=%q message=%q generation=%q", content, messageStatus, generationStatus)
		}
	})
	for _, record := range tracer.deltaRecords() {
		if !strings.Contains(record.SQL, appendDeltaMarker) {
			t.Fatalf("appendDelta issued a non-atomic statement: %s", record.SQL)
		}
		if strings.Contains(record.SQL, "BEGIN") || strings.Contains(record.SQL, "COMMIT") {
			t.Fatalf("appendDelta still opens a transaction: %s", record.SQL)
		}
	}
	if count := tracer.statementCount("BEGIN"); count != 0 {
		t.Fatalf("appendDelta issued %d BEGIN statements", count)
	}
}

func TestAppendDeltaUsesOneAtomicStatementPerBatch(t *testing.T) {
	upstream := newPerfSimulatedUpstream(t)
	f := newPerfFixture(t, upstream.URL)
	f.register(t)
	f.configure(t, upstream.URL, "openai-chat", "/v1", "gpt-5-mini")
	dialer := &perfCountingDialer{}
	pool := perfCountingPool(t, f.schema, dialer)
	ctx := context.Background()
	uid, cid, gid, mid := f.user, f.conversation, uuid.NewString(), uuid.NewString()
	if _, err := pool.Exec(ctx, "INSERT INTO messages(id,user_id,conversation_id,ordinal,role,content,status,generation_id) VALUES($1,$2,$3,1,'assistant','已保存','pending',$4)", mid, uid, cid, gid); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "INSERT INTO generations(id,user_id,conversation_id,assistant_message_id,status) VALUES($1,$2,$3,$4,'pending')", gid, uid, cid, mid); err != nil {
		t.Fatal(err)
	}
	app := &App{pool: pool}
	// Warm the statement cache for both shapes so only the steady state round
	// trips of each implementation are counted.
	if err := legacyAppendDelta(ctx, pool, uid, cid, gid, mid, "预热"); err != nil {
		t.Fatal(err)
	}
	if err := app.appendDelta(uid, cid, gid, mid, ""); err != nil {
		t.Fatal(err)
	}
	before := dialer.writes()
	if err := legacyAppendDelta(ctx, pool, uid, cid, gid, mid, "旧实现"); err != nil {
		t.Fatal(err)
	}
	legacyWrites := dialer.writes() - before
	before = dialer.writes()
	if err := app.appendDelta(uid, cid, gid, mid, "新实现"); err != nil {
		t.Fatal(err)
	}
	atomicWrites := dialer.writes() - before
	var content, generationStatus, messageStatus string
	if err := pool.QueryRow(ctx, "SELECT content FROM messages WHERE id=$1", mid).Scan(&content); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, "SELECT status FROM generations WHERE id=$1", gid).Scan(&generationStatus); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, "SELECT status FROM messages WHERE id=$1", mid).Scan(&messageStatus); err != nil {
		t.Fatal(err)
	}
	if content != "已保存预热旧实现新实现" {
		t.Fatalf("atomic statement lost content: %q", content)
	}
	if generationStatus != "streaming" || messageStatus != "streaming" {
		t.Fatalf("atomic statement lost statuses: %q %q", generationStatus, messageStatus)
	}
	t.Logf("SQL round trips per batch: legacy BEGIN+2×UPDATE+COMMIT = %d, atomic CTE = %d", legacyWrites, atomicWrites)
	if legacyWrites < 4 {
		t.Fatalf("legacy path used %d round trips, want at least 4", legacyWrites)
	}
	if atomicWrites > 2 {
		t.Fatalf("appendDelta used %d round trips, want at most 2", atomicWrites)
	}
	if atomicWrites*3 > legacyWrites {
		t.Fatalf("appendDelta round trips %d are not at least 3× fewer than legacy %d", atomicWrites, legacyWrites)
	}
}

func TestAppendDeltaRejectsLateBatchesAfterStopDeleteAndRetry(t *testing.T) {
	upstream := newPerfSimulatedUpstream(t)
	hold := upstream.route(t, "/hold", "openai-chat", []string{"第一段"}, 0, perfUpstreamHold)
	upstream.route(t, "/fail", "openai-chat", []string{"失败片段"}, 0, perfUpstreamEOF)
	f := newPerfFixture(t, upstream.URL)
	f.register(t)
	f.configure(t, upstream.URL, "openai-chat", "/hold/v1", "gpt-5-mini")
	response, input, collector := f.startGeneration(t, "流式中停止")
	select {
	case <-hold.first:
	case <-time.After(30 * time.Second):
		t.Fatal("upstream did not start")
	}
	events := collector.waitFor(t, "first durable delta", func(events []perfStreamEvent) bool { return perfHasEventOfType(events, "delta") })
	if events[0].Content != "第一段" {
		t.Fatalf("unexpected first delta: %+v", events[0])
	}
	gid := input["generationId"].(string)
	mid := input["assistantMessageId"].(string)
	if err := f.app.appendDelta(f.user, f.conversation, gid, mid, "并发片段"); err != nil {
		t.Fatalf("concurrent batch rejected before stop: %v", err)
	}
	call(t, f.client, f.server.URL, "POST", "/conversations/"+f.conversation+"/generations/"+gid+"/stop", nil, 204)
	perfDrainBody(t, response)
	if err := f.app.appendDelta(f.user, f.conversation, gid, mid, "停止后迟到片段"); !errors.Is(err, errInactive) {
		t.Fatalf("late batch after stop returned %v, want errInactive", err)
	}
	messages := f.readConversation(t)
	if len(messages) != 2 || messages[1].Status != "stopped" || messages[1].Content != "第一段并发片段" {
		t.Fatalf("stop did not persist the saved batches: %+v", messages)
	}
	// Deleting the conversation must reject every later write without resurrecting rows.
	call(t, f.client, f.server.URL, "DELETE", "/conversations/"+f.conversation, nil, 204)
	if err := f.app.appendDelta(f.user, f.conversation, gid, mid, "删除后迟到片段"); err == nil {
		t.Fatal("late batch succeeded after deletion")
	}
	if saved, err := f.app.finish(f.user, f.conversation, gid, "completed", nil, nil); err != nil || saved {
		t.Fatalf("late terminal write succeeded: saved=%v err=%v", saved, err)
	}
	var count int
	if err := f.app.pool.QueryRow(context.Background(), "SELECT (SELECT count(*) FROM messages WHERE conversation_id=$1)+(SELECT count(*) FROM generations WHERE conversation_id=$1)", f.conversation).Scan(&count); err != nil || count != 0 {
		t.Fatalf("late write resurrected deleted records: %d %v", count, err)
	}
	// A retry rebinds the assistant message to a new generation id, so batches of
	// the replaced generation must no longer hit.
	f.conversation = f.newConversation(t, "虚构重试历史")
	f.provider = idOf(t, call(t, f.client, f.server.URL, "POST", "/providers", map[string]any{"name": "重试供应商", "templateId": "custom", "protocol": "openai-chat", "adapter": "standard", "baseUrl": upstream.URL + "/fail/v1", "apiKey": "synthetic-perf-key", "enabled": true}, 201))
	f.model = idOf(t, call(t, f.client, f.server.URL, "POST", "/models", map[string]any{"providerId": f.provider, "modelId": "gpt-5-mini", "name": "重试模型", "enabled": true, "maxOutputTokens": 4096, "defaultReasoning": map[string]any{}}, 201))
	response, retryInput, retryCollector := f.startGeneration(t, "重试前")
	retryCollector.waitFor(t, "failed terminal", func(events []perfStreamEvent) bool { return perfHasEventOfType(events, "error") })
	perfDrainBody(t, response)
	oldGeneration := retryInput["generationId"].(string)
	oldMessage := retryInput["assistantMessageId"].(string)
	if err := f.app.appendDelta(f.user, f.conversation, oldGeneration, oldMessage, "旧生成迟到片段"); !errors.Is(err, errInactive) {
		t.Fatalf("batch of a finished generation returned %v, want errInactive", err)
	}
	retryInput["generationId"] = uuid.NewString()
	retryInput["retry"] = true
	body, err := json.Marshal(retryInput)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequestWithContext(context.Background(), "POST", f.server.URL+"/api/conversations/"+f.conversation+"/generations", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", f.server.URL)
	retryResponse, err := f.client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	retryCollector = perfCollectStream(retryResponse)
	retryCollector.waitFor(t, "retry terminal", func(events []perfStreamEvent) bool {
		return perfHasEventOfType(events, "error") || perfHasEventOfType(events, "done")
	})
	perfDrainBody(t, retryResponse)
	if err := f.app.appendDelta(f.user, f.conversation, oldGeneration, oldMessage, "重试后旧批次"); !errors.Is(err, errInactive) {
		t.Fatalf("batch bound to the replaced generation returned %v, want errInactive", err)
	}
	messages = f.readConversation(t)
	if len(messages) != 2 || messages[1].Content != "失败片段" {
		t.Fatalf("retry changed persisted history: %+v", messages)
	}
}

// ---------------------------------------------------------------------------
// 2. Four protocol simulation: first segment, 50ms fragments, EOF, errors
// ---------------------------------------------------------------------------

func TestGenerationStreamFourProtocolsPersistEverythingVisible(t *testing.T) {
	protocols := []struct {
		name     string
		protocol string
		basePath string
		model    string
	}{
		{"openai-chat", "openai-chat", "/v1", "gpt-5-mini"},
		{"openai-responses", "openai-responses", "/v1", "gpt-5-mini"},
		{"gemini", "gemini", "/v1beta", "gemini-2.5-flash"},
		{"anthropic", "anthropic", "/v1", "claude-sonnet-4-5"},
	}
	for _, protocol := range protocols {
		t.Run(protocol.name, func(t *testing.T) {
			fragments := []string{"第一段", "，第二段", "，第三段", "，第四段", "，第五段", "，第六段"}
			upstream := newPerfSimulatedUpstream(t)
			route := upstream.route(t, "/v1", protocol.protocol, fragments, 50*time.Millisecond, perfUpstreamComplete)
			f := newPerfFixture(t, upstream.URL)
			f.register(t)
			f.configure(t, upstream.URL, protocol.protocol, protocol.basePath, protocol.model)
			tracer := &perfQueryTracer{}
			tracer.swapPool(t, f.app, f.schema)
			roundTrip := perfMeasureRoundTrip(t, f.app.pool)
			response, _, collector := f.startGeneration(t, "四协议仿真")
			select {
			case firstFragment := <-route.first:
				events := collector.waitFor(t, "first delta", func(events []perfStreamEvent) bool { return perfHasEventOfType(events, "delta") })
				latency := events[0].At.Sub(firstFragment)
				budget := streamMergeWindow + 4*roundTrip + 150*time.Millisecond
				t.Logf("%s: round trip %s, first visible segment after %s (budget %s)", protocol.name, roundTrip, latency, budget)
				if latency > budget {
					t.Fatalf("first visible segment waited %s, want under %s", latency, budget)
				}
				if events[0].Content != fragments[0] {
					t.Fatalf("first delta did not carry the first segment: %q", events[0].Content)
				}
			case <-time.After(30 * time.Second):
				t.Fatal("upstream did not emit the first fragment")
			}
			collector.waitFor(t, "done", func(events []perfStreamEvent) bool { return perfHasEventOfType(events, "done") })
			perfDrainBody(t, response)
			events := collector.snapshot()
			want := strings.Join(fragments, "")
			if visible := perfVisibleText(events); visible != want {
				t.Fatalf("visible text %q, want %q", visible, want)
			}
			messages := f.readConversation(t)
			if len(messages) != 2 || messages[1].Status != "completed" || messages[1].Content != want {
				t.Fatalf("persisted response %+v, want %q completed", messages, want)
			}
			if events[len(events)-1].Type != "done" {
				t.Fatalf("done was not the final event: %+v", events)
			}
			// Save-then-send: every emitted batch was persisted before it was sent.
			writes := tracer.deltaRecords()
			if len(writes) == 0 {
				t.Fatal("no atomic appendDelta statement was issued")
			}
			if len(writes) > len(fragments) {
				t.Fatalf("%d writes for %d fragments: merging was lost", len(writes), len(fragments))
			}
			for _, event := range events {
				if event.Type != "delta" {
					continue
				}
				matched := false
				for _, write := range writes {
					if len(write.Args) < 4 || write.Err != nil || write.End.IsZero() {
						continue
					}
					if text, _ := write.Args[3].(string); text != event.Content {
						continue
					}
					if !event.At.Before(write.End.Add(-2 * time.Millisecond)) {
						matched = true
						break
					}
				}
				if !matched {
					t.Fatalf("delta %q was emitted before it was persisted", event.Content)
				}
			}
			if peak := peakConcurrentWrites(writes); peak != 1 {
				t.Fatalf("peak concurrent appendDelta statements = %d, want 1", peak)
			}
			t.Logf("%s: %d fragments merged into %d atomic writes", protocol.name, len(fragments), len(writes))
		})
	}
}

func TestGenerationStreamUpstreamEOFAndErrorPersistVisibleText(t *testing.T) {
	for _, testCase := range []struct {
		name      string
		behaviour perfUpstreamBehaviour
		status    string
		event     string
	}{
		{"clean eof without terminal", perfUpstreamEOF, "failed", "error"},
		{"provider error event", perfUpstreamError, "failed", "error"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			fragments := []string{"保留甲", "保留乙"}
			upstream := newPerfSimulatedUpstream(t)
			upstream.route(t, "/v1", "openai-chat", fragments, 50*time.Millisecond, testCase.behaviour)
			f := newPerfFixture(t, upstream.URL)
			f.register(t)
			f.configure(t, upstream.URL, "openai-chat", "/v1", "gpt-5-mini")
			response, _, collector := f.startGeneration(t, "失败场景")
			collector.waitFor(t, testCase.event, func(events []perfStreamEvent) bool { return perfHasEventOfType(events, testCase.event) })
			perfDrainBody(t, response)
			events := collector.snapshot()
			if perfHasEventOfType(events, "done") {
				t.Fatalf("failed stream reported success: %+v", events)
			}
			want := strings.Join(fragments, "")
			if visible := perfVisibleText(events); visible != want {
				t.Fatalf("visible text %q, want %q", visible, want)
			}
			messages := f.readConversation(t)
			if len(messages) != 2 || messages[1].Status != testCase.status || messages[1].Content != want {
				t.Fatalf("persisted response %+v, want %q %s", messages, want, testCase.status)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// 3. Slow database: bounded accumulation, backpressure, single writer
// ---------------------------------------------------------------------------

func TestGenerationStreamSlowDatabaseAppliesBackpressure(t *testing.T) {
	// 8KiB fragments keep the kernel socket buffers small relative to the
	// bounded hand-off, so the measured in-flight window reflects the Go level
	// queue instead of TCP buffering.
	const total = 600
	const fragmentSize = 8 << 10
	fragments := make([]string, 0, total)
	for i := 0; i < total; i++ {
		marker := fmt.Sprintf("片%04d段", i)
		fragments = append(fragments, marker+strings.Repeat("x", fragmentSize-len(marker)))
	}
	upstream := newPerfSimulatedUpstream(t)
	route := upstream.route(t, "/v1", "openai-chat", fragments, 5*time.Millisecond, perfUpstreamComplete)
	f := newPerfFixture(t, upstream.URL)
	f.register(t)
	f.configure(t, upstream.URL, "openai-chat", "/v1", "gpt-5-mini")
	tracer := &perfQueryTracer{}
	tracer.delay.Store(int64(500 * time.Millisecond))
	tracer.swapPool(t, f.app, f.schema)
	response, _, collector := f.startGeneration(t, "慢库背压")
	collector.waitFor(t, "done", func(events []perfStreamEvent) bool { return perfHasEventOfType(events, "done") })
	perfDrainBody(t, response)
	events := collector.snapshot()
	want := strings.Join(fragments, "")
	if visible := perfVisibleText(events); visible != want {
		t.Fatalf("backpressure lost visible text: %d of %d bytes", len(visible), len(want))
	}
	messages := f.readConversation(t)
	if len(messages) != 2 || messages[1].Status != "completed" || messages[1].Content != want {
		t.Fatalf("backpressure lost persisted text: %d of %d bytes, status %q", len(messages[1].Content), len(want), messages[1].Status)
	}
	writes := tracer.deltaRecords()
	if len(writes) == 0 {
		t.Fatal("no writes recorded")
	}
	if len(writes) >= total/4 {
		t.Fatalf("%d writes for %d fragments: nothing was merged under backpressure", len(writes), total)
	}
	if peak := peakConcurrentWrites(writes); peak != 1 {
		t.Fatalf("peak concurrent appendDelta statements = %d, want 1", peak)
	}
	// Writes are strictly ordered and cover the whole answer exactly once.
	persisted := strings.Builder{}
	for _, write := range writes {
		text, _ := write.Args[3].(string)
		persisted.WriteString(text)
	}
	if persisted.String() != want {
		t.Fatalf("atomic writes lost or reordered text: %d of %d bytes", persisted.Len(), len(want))
	}
	inFlight := peakInFlightFragments(route.fragmentTimes(), writes)
	// The hand-off is bounded by the 1MiB byte budget (≈128 fragments of 8KiB),
	// the 128 slot queue, the 16 slot upstream channel and the writer's merge
	// window. An unbounded queue would hold all 600 fragments.
	bound := streamQueueBytes/fragmentSize + streamQueueItems + 16 + 128
	t.Logf("slow database: %d fragments merged into %d writes, peak in-flight fragments %d (bound %d)", total, len(writes), inFlight, bound)
	if inFlight > bound {
		t.Fatalf("peak in-flight fragments %d exceeded the bounded hand-off %d", inFlight, bound)
	}
	for _, write := range writes {
		text, _ := write.Args[3].(string)
		if count := strings.Count(text, "段"); count == 0 {
			t.Fatalf("write carried no complete fragment: %q", text[:32])
		}
	}
}

// ---------------------------------------------------------------------------
// 4. Write failure must never be reported as success
// ---------------------------------------------------------------------------

func TestGenerationStreamWriteFailureNeverReportsSuccess(t *testing.T) {
	fragments := []string{"首段落库", "，第二段", "，第三段", "，第四段"}
	upstream := newPerfSimulatedUpstream(t)
	upstream.route(t, "/v1", "openai-chat", fragments, 60*time.Millisecond, perfUpstreamComplete)
	f := newPerfFixture(t, upstream.URL)
	f.register(t)
	f.configure(t, upstream.URL, "openai-chat", "/v1", "gpt-5-mini")
	tracer := &perfQueryTracer{}
	// The first batch is persisted, every later batch fails.
	tracer.failFrom.Store(2)
	tracer.swapPool(t, f.app, f.schema)
	response, _, collector := f.startGeneration(t, "写失败")
	collector.waitFor(t, "first durable delta", func(events []perfStreamEvent) bool { return perfHasEventOfType(events, "delta") })
	collector.waitFor(t, "error", func(events []perfStreamEvent) bool { return perfHasEventOfType(events, "error") })
	perfDrainBody(t, response)
	events := collector.snapshot()
	if perfHasEventOfType(events, "done") {
		t.Fatalf("failed persistence reported success: %+v", events)
	}
	messages := f.readConversation(t)
	if len(messages) != 2 || messages[1].Status != "failed" {
		t.Fatalf("write failure did not persist a failed state: %+v", messages)
	}
	if messages[1].Content != perfVisibleText(events) {
		t.Fatalf("client saw %q but only %q was persisted", perfVisibleText(events), messages[1].Content)
	}
	if !strings.HasPrefix(strings.Join(fragments, ""), messages[1].Content) {
		t.Fatalf("persisted text %q is not a prefix of the answer", messages[1].Content)
	}
	if messages[1].Content == "" {
		t.Fatal("nothing was persisted before the failure was reported")
	}
	t.Logf("write failure: %d of %d bytes persisted before the failure was reported", len(messages[1].Content), len(strings.Join(fragments, "")))
}

// ---------------------------------------------------------------------------
// 5. Size limit and single request lock
// ---------------------------------------------------------------------------

func TestGenerationStreamEnforcesSizeLimit(t *testing.T) {
	fragments := make([]string, 0, 140)
	for i := 0; i < 140; i++ {
		fragments = append(fragments, strings.Repeat("x", 60000))
	}
	upstream := newPerfSimulatedUpstream(t)
	upstream.route(t, "/v1", "openai-chat", fragments, 0, perfUpstreamComplete)
	f := newPerfFixture(t, upstream.URL)
	f.register(t)
	f.configure(t, upstream.URL, "openai-chat", "/v1", "gpt-5-mini")
	response, _, collector := f.startGeneration(t, "超长回答")
	collector.waitFor(t, "error", func(events []perfStreamEvent) bool { return perfHasEventOfType(events, "error") })
	perfDrainBody(t, response)
	events := collector.snapshot()
	if perfHasEventOfType(events, "done") {
		t.Fatal("oversized answer reported success")
	}
	failure, ok := perfLastEventOfType(events, "error")
	if !ok || failure.Message != "回答超过大小限制。" {
		t.Fatalf("unexpected terminal error: %+v", failure)
	}
	messages := f.readConversation(t)
	if len(messages) != 2 || messages[1].Status != "failed" {
		t.Fatalf("oversized answer state: %+v", messages)
	}
	if len(messages[1].Content) < 8<<20-1<<20 || len(messages[1].Content) > 8<<20+1<<20 {
		t.Fatalf("persisted %d bytes, expected the 8MB limit to trigger", len(messages[1].Content))
	}
	t.Logf("size limit: persisted %d bytes before failing", len(messages[1].Content))
}

func TestGenerationStreamSingleRequestLock(t *testing.T) {
	upstream, started, cancelled, count := waitingLifecycleUpstream(t, "")
	f := newPerfFixture(t, upstream.URL)
	f.register(t)
	f.configure(t, upstream.URL, "openai-chat", "/v1", "gpt-5-mini")
	response, input, _ := f.startGeneration(t, "单请求锁")
	awaitLifecycleSignal(t, started, "upstream did not start")
	call(t, f.client, f.server.URL, "POST", "/conversations/"+f.conversation+"/generations", map[string]any{"generationId": uuid.NewString(), "userMessageId": uuid.NewString(), "assistantMessageId": uuid.NewString(), "modelId": f.model, "content": "并发请求", "retry": false}, 409)
	if count.Load() != 1 {
		t.Fatalf("concurrent generation called upstream %d times", count.Load())
	}
	messages := f.readConversation(t)
	if len(messages) != 2 {
		t.Fatalf("concurrent generation duplicated messages: %+v", messages)
	}
	call(t, f.client, f.server.URL, "POST", "/conversations/"+f.conversation+"/generations/"+input["generationId"].(string)+"/stop", nil, 204)
	awaitLifecycleSignal(t, cancelled, "upstream not cancelled")
	perfDrainBody(t, response)
}
