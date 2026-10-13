// SPDX-License-Identifier: AGPL-3.0-only
package app

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"closewebui/server/internal/upstream"
	"github.com/google/uuid"
)

// A terminal-save outage can leave a nonterminal row after its job exits.
// Reading it must recover only that orphan, preserving live and draining jobs.
func TestConversationReadRecoversOnlyOrphanedGeneration(t *testing.T) {
	up := newPerfSimulatedUpstream(t)
	f := newPerfFixture(t, up.URL)
	f.register(t)
	f.configure(t, up.URL, "openai-chat", "/v1", "gpt-5-mini")
	in := generationInput{GenerationID: uuid.NewString(), UserMessageID: uuid.NewString(), AssistantMessageID: uuid.NewString(), ModelID: f.model, Content: "刷新恢复测试"}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if _, _, _, err := f.app.begin(ctx, f.user, f.conversation, &in); err != nil {
		t.Fatal(err)
	}
	jobCtx, stop := context.WithCancel(context.Background())
	defer stop()
	job := &running{cancel: stop, done: make(chan struct{}), userID: f.user, conversationID: f.conversation}
	f.app.mu.Lock()
	f.app.active[in.GenerationID] = job
	f.app.mu.Unlock()
	t.Cleanup(func() { f.app.mu.Lock(); delete(f.app.active, in.GenerationID); f.app.mu.Unlock() })
	if messages := f.readConversation(t); len(messages) != 2 || messages[1].Status != "pending" || jobCtx.Err() != nil {
		t.Fatal("read changed a live pending generation")
	}
	if err := f.app.appendDelta(f.user, f.conversation, in.GenerationID, in.AssistantMessageID, "已保存前缀"); err != nil {
		t.Fatal(err)
	}
	stop() // The canceled job is still present while it drains accepted content.
	if messages := f.readConversation(t); messages[1].Status != "streaming" || messages[1].Content != "已保存前缀" {
		t.Fatal("read terminated a job before its drain finished")
	}
	f.app.mu.Lock()
	delete(f.app.active, in.GenerationID)
	f.app.mu.Unlock()
	close(job.done)
	messages := f.readConversation(t)
	if len(messages) != 2 || messages[1].Status != "stopped" || messages[1].Content != "已保存前缀" {
		t.Fatal("orphaned generation did not recover its saved prefix as stopped")
	}
	if err := f.app.appendDelta(f.user, f.conversation, in.GenerationID, in.AssistantMessageID, "迟到尾段"); !errors.Is(err, errInactive) {
		t.Fatalf("orphan recovery did not fence late persistence: %v", err)
	}
}

type parallelRoundTripper func(*http.Request) (*http.Response, error)

func (f parallelRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// Reintroducing save-before-send must fail while actual PostgreSQL writes are
// gated. Conversely, reporting done before releasing the gate must also fail.
func TestGenerationParallelDisplaysBeforeSavingAndWaitsForCompletion(t *testing.T) {
	for _, protocol := range []struct{ name, base, model string }{
		{"openai-chat", "/v1", "gpt-5-mini"},
		{"openai-responses", "/v1", "gpt-5-mini"},
		{"gemini", "/v1beta", "gemini-2.5-flash"},
		{"anthropic", "/v1", "claude-sonnet-4-5"},
	} {
		t.Run(protocol.name, func(t *testing.T) {
			upstream := newPerfSimulatedUpstream(t)
			upstream.route(t, "/v1", protocol.name, []string{"即时中文正文"}, 0, perfUpstreamComplete)
			f := newPerfFixture(t, upstream.URL)
			f.register(t)
			f.configure(t, upstream.URL, protocol.name, protocol.base, protocol.model)
			gate := make(chan struct{})
			var once sync.Once
			release := func() { once.Do(func() { close(gate) }) }
			tracer := &perfQueryTracer{gate: gate, entered: make(chan struct{}, 1)}
			tracer.swapPool(t, f.app, f.schema)
			t.Cleanup(release)
			response, _, collector := f.startGeneration(t, "并行保存")
			defer response.Body.Close()
			select {
			case <-tracer.entered:
			case <-time.After(5 * time.Second):
				t.Fatal("write did not reach gate")
			}
			deadline := time.Now().Add(2 * time.Second)
			for !perfHasEventOfType(collector.snapshot(), "delta") && time.Now().Before(deadline) {
				time.Sleep(5 * time.Millisecond)
			}
			events := collector.snapshot()
			if perfVisibleText(events) != "即时中文正文" {
				t.Fatal("body is blocked by database persistence")
			}
			if perfHasEventOfType(events, "done") {
				t.Fatal("done preceded persistence")
			}
			messages := f.readConversation(t)
			if len(messages) != 2 || messages[1].Content != "" {
				t.Fatalf("recovery returned uncommitted text: %+v", messages)
			}
			release()
			collector.waitFor(t, "durable completion", func(events []perfStreamEvent) bool { return perfHasEventOfType(events, "done") })
			<-collector.done
			messages = f.readConversation(t)
			if len(messages) != 2 || messages[1].Content != "即时中文正文" || messages[1].Status != "completed" {
				t.Fatalf("completion lost persisted body: %+v", messages)
			}
		})
	}
}

// Failing the completed transaction must produce a saving error, never done or
// a silent EOF whose only indication would be a generic transport failure.
func TestGenerationParallelTerminalSaveFailureIsExplicit(t *testing.T) {
	upstream := newPerfSimulatedUpstream(t)
	upstream.route(t, "/v1", "openai-chat", []string{"完整正文"}, 0, perfUpstreamComplete)
	f := newPerfFixture(t, upstream.URL)
	f.register(t)
	f.configure(t, upstream.URL, "openai-chat", "/v1", "gpt-5-mini")
	tracer := &perfQueryTracer{}
	tracer.failCompleted.Store(true)
	tracer.swapPool(t, f.app, f.schema)
	response, _, collector := f.startGeneration(t, "终态保存失败")
	defer response.Body.Close()
	select {
	case <-collector.done:
	case <-time.After(20 * time.Second):
		t.Fatal("failed save did not end stream")
	}
	events := collector.snapshot()
	if perfHasEventOfType(events, "done") {
		t.Fatal("failed completed transaction reported done")
	}
	problem, ok := perfLastEventOfType(events, "error")
	if !ok || problem.Code != "SAVE_FAILED" || !strings.Contains(problem.Message, "保存") {
		t.Fatalf("missing saving failure: %+v", events)
	}
	if perfVisibleText(events) != "完整正文" {
		t.Fatalf("lost live body: %+v", events)
	}
	messages := f.readConversation(t)
	if messages[1].Status != "failed" || messages[1].Content != "完整正文" {
		t.Fatalf("save failure recovery: %+v", messages)
	}
}

// Large native fragments cannot bypass the total unsaved byte cap, even while
// the first SQL call owns its entire batch. Splitting must preserve UTF-8.
func TestGenerationParallelCapacityIncludesInFlightAndSplitsNativeFragment(t *testing.T) {
	fragment := strings.Repeat("中文", 120000) // Below the native SSE 1MiB limit.
	text := fragment + fragment
	upstream := newPerfSimulatedUpstream(t)
	upstream.route(t, "/v1", "openai-chat", []string{fragment, fragment}, 0, perfUpstreamComplete)
	f := newPerfFixture(t, upstream.URL)
	f.register(t)
	f.configure(t, upstream.URL, "openai-chat", "/v1", "gpt-5-mini")
	gate := make(chan struct{})
	var once sync.Once
	release := func() { once.Do(func() { close(gate) }) }
	tracer := &perfQueryTracer{gate: gate, entered: make(chan struct{}, 1)}
	tracer.swapPool(t, f.app, f.schema)
	t.Cleanup(release)
	response, _, collector := f.startGeneration(t, "大块中文")
	defer response.Body.Close()
	select {
	case <-tracer.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("large fragment never reached write gate")
	}
	deadline := time.Now().Add(2 * time.Second)
	for len(perfVisibleText(collector.snapshot())) < streamQueueBytes/2 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	visible := perfVisibleText(collector.snapshot())
	if len(visible) < streamQueueBytes/2 || len(visible) > streamQueueBytes {
		t.Fatalf("visible unsaved byte count %d is not bounded while SQL is in flight", len(visible))
	}
	if !strings.HasPrefix(text, visible) {
		t.Fatal("large native fragment split corrupted UTF-8 or order")
	}
	release()
	collector.waitFor(t, "bounded completion", func(events []perfStreamEvent) bool { return perfHasEventOfType(events, "done") })
	<-collector.done
	if perfVisibleText(collector.snapshot()) != text {
		t.Fatal("split native fragment lost live text")
	}
	messages := f.readConversation(t)
	if messages[1].Content != text || messages[1].Status != "completed" {
		t.Fatal("split native fragment lost saved text")
	}
}

// Cancellation after native EOF but during the durable drain is still a stop.
// The upstream context cancellation is the finalization barrier; no sleep is
// used to guess whether the handler has selected the completed branch.
func TestGenerationParallelStopDuringEOFDrainNeverCompletes(t *testing.T) {
	up := newPerfSimulatedUpstream(t)
	up.route(t, "/v1", "openai-chat", []string{"停止前的实时正文"}, 0, perfUpstreamComplete)
	f := newPerfFixture(t, up.URL)
	f.register(t)
	f.configure(t, up.URL, "openai-chat", "/v1", "gpt-5-mini")
	gate := make(chan struct{})
	var once sync.Once
	release := func() { once.Do(func() { close(gate) }) }
	tracer := &perfQueryTracer{gate: gate, entered: make(chan struct{}, 1)}
	tracer.swapPool(t, f.app, f.schema)
	t.Cleanup(release)
	finalizing := make(chan struct{})
	f.app.upstream = upstream.NewClient(&http.Client{Transport: parallelRoundTripper(func(r *http.Request) (*http.Response, error) {
		go func() { <-r.Context().Done(); close(finalizing) }()
		return http.DefaultTransport.RoundTrip(r)
	})})
	response, input, collector := f.startGeneration(t, "结束排空时停止")
	defer response.Body.Close()
	select {
	case <-tracer.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("write gate not reached")
	}
	select {
	case <-finalizing:
	case <-time.After(5 * time.Second):
		t.Fatal("EOF finalization not reached")
	}
	f.app.mu.Lock()
	job := f.app.active[input["generationId"].(string)]
	f.app.mu.Unlock()
	if job == nil {
		t.Fatal("generation ended before save drain")
	}
	job.cancel() // Same cancellation operation as the stop endpoint.
	release()
	select {
	case <-collector.done:
	case <-time.After(20 * time.Second):
		t.Fatal("stop did not finish drain")
	}
	if perfHasEventOfType(collector.snapshot(), "done") {
		t.Fatal("EOF drain cancellation emitted late done")
	}
	messages := f.readConversation(t)
	if len(messages) != 2 || messages[1].Status != "stopped" {
		t.Fatalf("EOF drain cancellation saved wrong terminal state: %+v", messages)
	}
}

func TestGenerationParallelCanceledErrorFinalizationHasNoLateEvent(t *testing.T) {
	up := newPerfSimulatedUpstream(t)
	up.route(t, "/v1", "openai-chat", []string{"错误前正文"}, 0, perfUpstreamError)
	f := newPerfFixture(t, up.URL)
	f.register(t)
	f.configure(t, up.URL, "openai-chat", "/v1", "gpt-5-mini")
	gate := make(chan struct{})
	var once sync.Once
	release := func() { once.Do(func() { close(gate) }) }
	tracer := &perfQueryTracer{gate: gate, entered: make(chan struct{}, 1), gateTerminal: true}
	tracer.swapPool(t, f.app, f.schema)
	t.Cleanup(release)
	response, input, collector := f.startGeneration(t, "错误收尾时停止")
	defer response.Body.Close()
	select {
	case <-tracer.entered:
	case <-time.After(10 * time.Second):
		t.Fatal("failed terminal write gate not reached")
	}
	f.app.mu.Lock()
	job := f.app.active[input["generationId"].(string)]
	f.app.mu.Unlock()
	if job == nil {
		t.Fatal("generation ended before terminal write")
	}
	job.cancel()
	release()
	select {
	case <-collector.done:
	case <-time.After(20 * time.Second):
		t.Fatal("cancelled terminal did not close stream")
	}
	events := collector.snapshot()
	if perfHasEventOfType(events, "error") || perfHasEventOfType(events, "done") {
		t.Fatal("cancelled terminal emitted late event")
	}
}
