// SPDX-License-Identifier: AGPL-3.0-only
package app

// This harness depends only on the integration fixture/API shared with 29483aa.
// Copying it to an exported baseline tests the actual old handler and database
// implementation; it does not reconstruct a synthetic legacy generation path.
import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"closewebui/server/internal/db"
	"closewebui/server/internal/upstream"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var stageMarker = regexp.MustCompile(`【P[0-9]{3}】`)

type stagePoint struct {
	text string
	at   time.Time
}
type stageQuery struct {
	kind, text string
	start, end time.Time
	writes     int64
}
type stageRun struct {
	mu               sync.Mutex
	start, connected time.Time
	body, flush      []stagePoint
	queries          []stageQuery
	writes           atomic.Int64
}
type stageConn struct {
	net.Conn
	run *stageRun
}

func (c *stageConn) Write(p []byte) (int, error) { c.run.writes.Add(1); return c.Conn.Write(p) }

type stageQueryKey struct{}
type stageQueryPending struct {
	query  stageQuery
	writes int64
}

func (s *stageRun) TraceQueryStart(ctx context.Context, _ *pgx.Conn, d pgx.TraceQueryStartData) context.Context {
	q := stageQuery{kind: strings.ToLower(strings.TrimSpace(d.SQL)), start: time.Now()}
	if strings.Contains(d.SQL, "WITH generation AS (") {
		q.kind = "atomic"
		q.text, _ = d.Args[3].(string)
	}
	if strings.Contains(d.SQL, "UPDATE messages SET content=content ||") {
		q.kind = "legacy-append"
		q.text, _ = d.Args[0].(string)
	}
	if q.kind != "atomic" && q.kind != "legacy-append" && q.kind != "begin" && q.kind != "commit" {
		q.kind = "other"
	}
	return context.WithValue(ctx, stageQueryKey{}, stageQueryPending{q, s.writes.Load()})
}
func (s *stageRun) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, d pgx.TraceQueryEndData) {
	p := ctx.Value(stageQueryKey{}).(stageQueryPending)
	p.query.end = time.Now()
	p.query.writes = s.writes.Load() - p.writes
	if d.Err != nil {
		p.query.kind = "failed"
	}
	s.mu.Lock()
	s.queries = append(s.queries, p.query)
	s.mu.Unlock()
}

type stageTransport struct {
	base http.RoundTripper
	run  *stageRun
}

func (t stageTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	response, err := t.base.RoundTrip(r)
	if err != nil {
		return nil, err
	}
	t.run.mu.Lock()
	t.run.connected = time.Now()
	t.run.mu.Unlock()
	response.Body = &stageBody{ReadCloser: response.Body, run: t.run}
	return response, nil
}

type stageBody struct {
	io.ReadCloser
	pending []byte
	run     *stageRun
}

func (b *stageBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	at := time.Now()
	b.pending = append(b.pending, p[:n]...)
	for {
		line, rest, ok := bytes.Cut(b.pending, []byte{'\n'})
		if !ok {
			break
		}
		b.pending = rest
		line = bytes.TrimSpace(line)
		if !bytes.HasPrefix(line, []byte("data:")) {
			continue
		}
		data := bytes.TrimSpace(bytes.TrimPrefix(line, []byte("data:")))
		if !json.Valid(data) {
			continue
		}
		// Only the fixed fixture's valid native text delta contains these markers.
		// Timestamp is complete native JSON line receipt, before protocol parsing.
		for _, marker := range stageMarker.FindAllString(string(data), -1) {
			b.run.mu.Lock()
			b.run.body = append(b.run.body, stagePoint{marker, at})
			b.run.mu.Unlock()
		}
	}
	return n, err
}

type stageWriter struct {
	http.ResponseWriter
	run     *stageRun
	pending []byte
}

func (w *stageWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *stageWriter) Write(p []byte) (int, error) {
	n, err := w.ResponseWriter.Write(p)
	w.pending = append(w.pending, p[:n]...)
	return n, err
}
func (w *stageWriter) FlushError() error {
	if err := http.NewResponseController(w.ResponseWriter).Flush(); err != nil {
		return err
	}
	at := time.Now()
	for _, line := range bytes.Split(w.pending, []byte{'\n'}) {
		var event struct{ Type, Content string }
		if json.Unmarshal(line, &event) == nil && event.Type == "delta" {
			w.run.mu.Lock()
			w.run.flush = append(w.run.flush, stagePoint{event.Content, at})
			w.run.mu.Unlock()
		}
	}
	w.pending = nil
	return nil
}

func stageUpstream(protocol string) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		var delay int
		_, _ = fmt.Sscanf(r.URL.Query().Get("delay"), "%d", &delay)
		// Delay is set by the test transport URL, never by a paid upstream.
		if delay > 0 {
			time.Sleep(time.Duration(delay) * time.Millisecond)
		}
		write := func(data string) { _, _ = fmt.Fprintf(w, "data: %s\n\n", data); w.(http.Flusher).Flush() }
		ticker := time.NewTicker(50 * time.Millisecond)
		defer ticker.Stop()
		for i := 0; i < 42; i++ {
			if i > 0 {
				select {
				case <-r.Context().Done():
					return
				case <-ticker.C:
				}
			}
			text := fmt.Sprintf("【P%03d】", i) + strings.Repeat("性能采样内容 ", 72)
			if i == 0 {
				text = "# 性能采样\n\n" + text
			}
			if i == 41 {
				text += "\n\n| A | B |\n| --- | --- |\n| 甲 | 乙 |\n\n```go\npackage main\nfunc main() { println(\"CloseWebUI\") }\n```\n"
			}
			switch protocol {
			case "openai-chat":
				write(fmt.Sprintf(`{"choices":[{"delta":{"content":%q}}]}`, text))
			case "openai-responses":
				write(fmt.Sprintf(`{"type":"response.output_text.delta","delta":%q}`, text))
			case "gemini":
				write(fmt.Sprintf(`{"candidates":[{"content":{"parts":[{"text":%q}]}}]}`, text))
			case "anthropic":
				if i == 0 {
					write(`{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`)
				}
				write(fmt.Sprintf(`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":%q}}`, text))
			}
		}
		switch protocol {
		case "openai-chat":
			write(`{"choices":[{"delta":{},"finish_reason":"stop"}]}`)
			write("[DONE]")
		case "openai-responses":
			write(`{"type":"response.completed","response":{"status":"completed"}}`)
		case "gemini":
			write(`{"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}]}`)
		case "anthropic":
			write(`{"type":"message_delta","delta":{"stop_reason":"end_turn"}}`)
			write(`{"type":"content_block_stop","index":0}`)
			write(`{"type":"message_stop"}`)
		}
	}))
}

type stageDelayTransport struct {
	stageTransport
	delay int
}

func (t stageDelayTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	clone := r.Clone(r.Context())
	u := *r.URL
	q := u.Query()
	q.Set("delay", fmt.Sprint(t.delay))
	u.RawQuery = q.Encode()
	clone.URL = &u
	return t.stageTransport.RoundTrip(clone)
}

type stageFragmentReport struct {
	Index                                                                      int `json:"index"`
	BodyMs, DeltaStartMs, DeltaCommitMs, FlushMs, BodyToFlushMs, PersistenceMs float64
}
type stageSampleReport struct {
	Index                                                                    int
	Warmup                                                                   bool
	FirstTextDelayMs                                                         int
	CreateMs, SubmitCommitMs, UpstreamConnectedMs, FirstBodyMs, FirstFlushMs float64
	SQLNetworkWrites                                                         int64
	SQLStatements, DeltaBatches                                              int
	DeltaNetworkWrites                                                       []int64
	Fragments                                                                []stageFragmentReport
}

func stageMs(d time.Duration) float64 { return float64(d) / float64(time.Millisecond) }
func stagePercentile(values []float64, p float64) float64 {
	if len(values) == 0 {
		return -1
	}
	v := append([]float64(nil), values...)
	sort.Float64s(v)
	return v[int(math.Ceil(p*float64(len(v))))-1]
}

// Catch delayed/premature Flush, reintroduced four-round-trip batches, dropped
// text and artificial batching delay using the actual handler and PostgreSQL.
// Dedicated opt-in avoids running a 120-send benchmark under concurrent suites.
func TestGenerationStagePerformance(t *testing.T) {
	if os.Getenv("RUN_PERFORMANCE") != "1" {
		t.Skip("set RUN_PERFORMANCE=1 for sequential 30-send-per-protocol measurement")
	}
	label := os.Getenv("PERF_IMPLEMENTATION")
	if label == "" {
		label = "current"
	}
	for _, protocol := range []string{"openai-chat", "openai-responses", "gemini", "anthropic"} {
		t.Run(protocol, func(t *testing.T) {
			up := stageUpstream(protocol)
			t.Cleanup(up.Close)
			server, schema := fixture(t, up.URL)
			a := server.Config.Handler.(*App)
			client := clientFor(t)
			client.Timeout = 90 * time.Second
			call(t, client, server.URL, "POST", "/auth/register", map[string]string{"username": "stage_" + strings.ReplaceAll(uuid.NewString(), "-", "")[:12], "password": "Test-password-123"}, 201)
			base, model := "/v1", "gpt-5-mini"
			if protocol == "gemini" {
				base, model = "/v1beta", "gemini-2.5-flash"
			}
			if protocol == "anthropic" {
				model = "claude-sonnet-4-5"
			}
			pid := idOf(t, call(t, client, server.URL, "POST", "/providers", map[string]any{"name": "仿真性能", "templateId": "custom", "protocol": protocol, "adapter": "standard", "baseUrl": up.URL + base, "apiKey": "synthetic-key", "enabled": true}, 201))
			mid := idOf(t, call(t, client, server.URL, "POST", "/models", map[string]any{"providerId": pid, "modelId": model, "name": "仿真模型", "enabled": true, "maxOutputTokens": 4096, "defaultReasoning": map[string]any{}}, 201))
			state := &stageRun{}
			pc, err := pgxpool.ParseConfig(os.Getenv("DATABASE_URL"))
			if err != nil {
				t.Fatal(err)
			}
			pc.ConnConfig.RuntimeParams["search_path"] = schema
			pc.ConnConfig.Tracer = state
			pc.MaxConns = 1
			pc.ConnConfig.DialFunc = func(ctx context.Context, network, addr string) (net.Conn, error) {
				c, e := (&net.Dialer{}).DialContext(ctx, network, addr)
				if e != nil {
					return nil, e
				}
				return &stageConn{c, state}, nil
			}
			pool, err := pgxpool.NewWithConfig(context.Background(), pc)
			if err != nil {
				t.Fatal(err)
			}
			original := a.pool
			originalQueries := a.queries
			a.pool = pool
			a.queries = db.New(pool)
			t.Cleanup(func() { a.pool = original; a.queries = originalQueries; pool.Close() })
			// Keep request bodies, query arguments and credentials out of artifacts.
			originalHandler := a.handler
			a.handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				originalHandler.ServeHTTP(&stageWriter{ResponseWriter: w, run: state}, r)
			})
			t.Cleanup(func() { a.handler = originalHandler })
			var raw []stageSampleReport
			var bodyLatency, persistence, rtts []float64
			for i := 0; i < 31; i++ {
				start := time.Now()
				cid := idOf(t, call(t, client, server.URL, "POST", "/conversations", map[string]string{"title": "虚构性能历史"}, 201))
				createMs := stageMs(time.Since(start))
				var one int
				rt := time.Now()
				if err := pool.QueryRow(context.Background(), "SELECT 1").Scan(&one); err != nil {
					t.Fatal(err)
				}
				rtt := stageMs(time.Since(rt))
				state.mu.Lock()
				state.start = time.Now()
				state.connected = time.Time{}
				state.body = nil
				state.flush = nil
				state.queries = nil
				state.mu.Unlock()
				beforeWrites := state.writes.Load()
				delay := []int{0, 500, 2000}[max(0, i-1)%3]
				a.upstream = upstream.NewClient(&http.Client{Transport: stageDelayTransport{stageTransport{http.DefaultTransport, state}, delay}})
				payload := map[string]any{"generationId": uuid.NewString(), "userMessageId": uuid.NewString(), "assistantMessageId": uuid.NewString(), "modelId": mid, "content": "固定性能采样", "retry": false}
				body, _ := json.Marshal(payload)
				request, _ := http.NewRequest("POST", server.URL+"/api/conversations/"+cid+"/generations", bytes.NewReader(body))
				request.Header.Set("Content-Type", "application/json")
				request.Header.Set("Origin", server.URL)
				response, err := client.Do(request)
				if err != nil {
					t.Fatal(err)
				}
				data, err := io.ReadAll(response.Body)
				response.Body.Close()
				if err != nil || response.StatusCode != 200 {
					t.Fatalf("generation failed: status=%d read=%v", response.StatusCode, err)
				}
				// Handler deferred cleanup performs SQL after body EOF. Wait for its
				// active-map entry to disappear before freezing timestamps/resetting.
				deadline := time.Now().Add(20 * time.Second)
				for {
					a.mu.Lock()
					_, active := a.active[payload["generationId"].(string)]
					a.mu.Unlock()
					if !active {
						break
					}
					if time.Now().After(deadline) {
						t.Fatal("generation cleanup timeout")
					}
					time.Sleep(time.Millisecond)
				}
				state.mu.Lock()
				points := append([]stagePoint(nil), state.body...)
				flushes := append([]stagePoint(nil), state.flush...)
				queries := append([]stageQuery(nil), state.queries...)
				origin, connected := state.start, state.connected
				state.mu.Unlock()
				result := stageSampleReport{Index: i, Warmup: i == 0, FirstTextDelayMs: delay, CreateMs: createMs, UpstreamConnectedMs: stageMs(connected.Sub(origin)), SQLStatements: len(queries), SQLNetworkWrites: state.writes.Load() - beforeWrites, DeltaBatches: len(flushes)}
				var persisted, status string
				if err := pool.QueryRow(context.Background(), "SELECT content,status FROM messages WHERE generation_id=$1 AND role='assistant'", payload["generationId"]).Scan(&persisted, &status); err != nil {
					t.Fatal(err)
				}
				var visible strings.Builder
				for _, flush := range flushes {
					visible.WriteString(flush.text)
				}
				if persisted != visible.String() || status != "completed" {
					t.Fatal("persisted response differs from flushed text or lacks completed status")
				}
				for _, q := range queries {
					if q.kind == "commit" && q.end.Before(connected) {
						result.SubmitCommitMs = stageMs(q.end.Sub(origin))
						break
					}
				}
				if len(points) != 42 || len(flushes) == 0 || !bytes.Contains(data, []byte(`"type":"done"`)) {
					t.Fatalf("incomplete measurement: body=%d batches=%d", len(points), len(flushes))
				}
				result.FirstBodyMs = stageMs(points[0].at.Sub(origin))
				result.FirstFlushMs = stageMs(flushes[0].at.Sub(origin))
				measuredBatches := map[time.Time]bool{}
				for index, p := range points {
					matched := false
					for _, f := range flushes {
						if !strings.Contains(f.text, p.text) {
							continue
						}
						for qi, q := range queries {
							if q.text != f.text || (q.kind != "atomic" && q.kind != "legacy-append") {
								continue
							}
							begin, commit := q.start, q.end
							if q.kind == "legacy-append" {
								for j := qi - 1; j >= 0; j-- {
									if queries[j].kind == "begin" {
										begin = queries[j].start
										break
									}
								}
								for j := qi + 1; j < len(queries); j++ {
									if queries[j].kind == "commit" {
										commit = queries[j].end
										break
									}
								}
							}
							if commit.After(f.at) {
								t.Fatal("Flush preceded database commit")
							}
							latency := stageMs(f.at.Sub(p.at))
							durable := stageMs(commit.Sub(begin))
							result.Fragments = append(result.Fragments, stageFragmentReport{index, stageMs(p.at.Sub(origin)), stageMs(begin.Sub(origin)), stageMs(commit.Sub(origin)), stageMs(f.at.Sub(origin)), latency, durable})
							if !measuredBatches[f.at] {
								var networkWrites int64
								for _, batchQuery := range queries {
									if !batchQuery.start.Before(begin) && !batchQuery.end.After(commit) {
										networkWrites += batchQuery.writes
									}
								}
								result.DeltaNetworkWrites = append(result.DeltaNetworkWrites, networkWrites)
								if i > 0 {
									persistence = append(persistence, durable)
								}
								measuredBatches[f.at] = true
							}
							if i > 0 {
								bodyLatency = append(bodyLatency, latency)
							}
							matched = true
							break
						}
						break
					}
					if !matched {
						t.Fatalf("fragment %d has no matching persisted Flush", index)
					}
				}
				if i > 0 {
					rtts = append(rtts, rtt)
				}
				raw = append(raw, result)
			}
			p95 := stagePercentile(bodyLatency, .95)
			persistence95 := stagePercentile(persistence, .95)
			report := map[string]any{"implementation": label, "protocol": protocol, "samples": 30, "warmupSamples": 1, "fixture": "42 native text chunks, 50ms cadence, >20k characters, table/code; first-text delay 0/500/2000ms (10 sends each)", "semantics": "native complete valid JSON text line receipt before adapter -> successful underlying ResponseController.Flush completion; actual PostgreSQL durable query/transaction completion; all milliseconds relative to POST start; networkWrites counts net.Conn.Write calls (not claimed as packets)", "bodyToFlushMs": map[string]float64{"p50": stagePercentile(bodyLatency, .5), "p95": p95}, "persistenceMs": map[string]float64{"p50": stagePercentile(persistence, .5), "p95": persistence95}, "databaseSelect1Ms": map[string]float64{"p50": stagePercentile(rtts, .5), "p95": stagePercentile(rtts, .95)}, "targetMs": persistence95 + 100, "meetsBodyToFlushTarget": p95 <= persistence95+100, "raw": raw}
			report["timestampDefinitions"] = map[string]string{
				"CreateMs":            "POST create conversation response fully received, measured separately before generation",
				"SubmitCommitMs":      "initial generation transaction COMMIT completed, relative to POST generation start",
				"UpstreamConnectedMs": "native HTTP response headers received, not TCP connect duration",
				"BodyMs":              "complete valid native text JSON line read, before adapter parsing",
				"DeltaCommitMs":       "atomic query completion or actual legacy COMMIT completion, never intermediate UPDATE completion",
				"FlushMs":             "underlying ResponseController.Flush returned successfully",
			}
			stageValues := map[string][]float64{}
			for _, sample := range raw {
				if sample.Warmup {
					continue
				}
				for name, value := range map[string]float64{"create": sample.CreateMs, "submitCommit": sample.SubmitCommitMs, "upstreamHeaders": sample.UpstreamConnectedMs, "firstBody": sample.FirstBodyMs, "firstFlush": sample.FirstFlushMs} {
					stageValues[name] = append(stageValues[name], value)
				}
			}
			stages := map[string]map[string]float64{}
			for name, values := range stageValues {
				stages[name] = map[string]float64{"p50": stagePercentile(values, .5), "p95": stagePercentile(values, .95)}
			}
			report["stagesMs"] = stages
			dir := os.Getenv("PERF_OUTPUT_DIR")
			if dir == "" {
				dir = filepath.Join("..", "..", "..", "test-results")
			}
			if err := os.MkdirAll(dir, 0755); err != nil {
				t.Fatal(err)
			}
			encoded, _ := json.MarshalIndent(report, "", "  ")
			if err := os.WriteFile(filepath.Join(dir, "performance-go-"+label+"-"+protocol+".json"), append(encoded, '\n'), 0644); err != nil {
				t.Fatal(err)
			}
			t.Logf("%s %s body-to-Flush p95 %.2fms; persistence p95 %.2fms; SELECT 1 p95 %.2fms", label, protocol, p95, persistence95, stagePercentile(rtts, .95))
			if label == "current" && p95 > persistence95+100 {
				t.Errorf("body-to-Flush p95 %.2f > persistence p95 %.2f + 100ms", p95, persistence95)
			}
			if label == "current" && persistence95 <= 100 && p95 > 200 {
				t.Errorf("body-to-Flush p95 %.2f > 200ms for persistence <=100ms", p95)
			}
		})
	}
}
