// SPDX-License-Identifier: AGPL-3.0-only
package app

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"closewebui/server/internal/db"
	"closewebui/server/internal/upstream"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type discoveryTraceKey struct{}
type discoverySQLKey struct{}

// Delay the first COMMIT's return after PostgreSQL has released its row lock.
// This exercises the real transaction/cache publication boundary.
type discoveryCommitTracer struct {
	committed, release, secondWritten, secondCommitStarted chan struct{}
}

func (tr *discoveryCommitTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if ctx.Value(discoveryTraceKey{}) == "second" && data.SQL == "commit" {
		close(tr.secondCommitStarted)
	}
	return context.WithValue(ctx, discoverySQLKey{}, data.SQL)
}

func (tr *discoveryCommitTracer) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryEndData) {
	if data.Err != nil {
		return
	}
	sql, _ := ctx.Value(discoverySQLKey{}).(string)
	operation, _ := ctx.Value(discoveryTraceKey{}).(string)
	if operation == "first" && sql == "commit" {
		close(tr.committed)
		select {
		case <-tr.release:
		case <-ctx.Done():
		}
	}
	if operation == "second" && strings.Contains(sql, "UPDATE models SET discovery_metadata=records.metadata") {
		close(tr.secondWritten)
	}
}

func TestConcurrentDiscoveriesPublishCacheInCommitOrder(t *testing.T) {
	up := httptest.NewServer(modelsHandler(t, `{"models":[{"name":"models/private-exact-id","outputTokenLimit":65536}]}`, 200))
	defer up.Close()
	s, schema := fixture(t, up.URL)
	client := registerUser(t, s.URL, "discovery_publish_race")
	pid := createProvider(t, client, s.URL, "并发发现仿真", "standard", "gemini", up.URL, "synthetic-key")
	id := idOf(t, call(t, client, s.URL, "POST", "/models", map[string]any{"providerId": pid, "modelId": "private-exact-id", "name": "虚构模型", "maxOutputTokens": 4096}, 201))
	a := s.Config.Handler.(*App)
	var user struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(call(t, client, s.URL, "GET", "/auth/me", nil, 200), &user)
	p, err := a.queries.GetProvider(context.Background(), db.GetProviderParams{ID: pid, UserID: user.ID})
	if err != nil {
		t.Fatal(err)
	}
	tr := &discoveryCommitTracer{make(chan struct{}), make(chan struct{}), make(chan struct{}), make(chan struct{})}
	pc, err := pgxpool.ParseConfig(a.cfg.DatabaseURL)
	if err != nil {
		t.Fatal("invalid test pool configuration")
	}
	pc.ConnConfig.RuntimeParams["search_path"] = schema
	pc.ConnConfig.Tracer = tr
	pool, err := pgxpool.NewWithConfig(context.Background(), pc)
	if err != nil {
		t.Fatal(err)
	}
	originalPool, originalQueries := a.pool, a.queries
	a.pool, a.queries = pool, db.New(pool)
	defer func() { a.pool, a.queries = originalPool, originalQueries; pool.Close() }()
	firstDone, secondDone := make(chan error, 1), make(chan error, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(tr.release) }) }
	defer release()
	go func() {
		firstDone <- a.rememberDiscovery(context.WithValue(ctx, discoveryTraceKey{}, "first"), p, []upstream.DiscoveredModel{{ID: "private-exact-id", Metadata: &upstream.ModelMetadata{OutputMax: 16000}}})
	}()
	select {
	case <-tr.committed:
	case err := <-firstDone:
		t.Fatalf("first discovery did not commit: %v", err)
	case <-time.After(15 * time.Second):
		t.Fatal("first discovery commit timed out")
	}
	go func() {
		secondDone <- a.rememberDiscovery(context.WithValue(ctx, discoveryTraceKey{}, "second"), p, []upstream.DiscoveredModel{{ID: "private-exact-id", Metadata: &upstream.ModelMetadata{OutputMax: 8192}}})
	}()
	select {
	case <-tr.secondWritten:
	case <-time.After(15 * time.Second):
		t.Fatal("second discovery did not reach persistence")
	}
	// The broken implementation can publish the second cache while the first
	// COMMIT return is suspended; a correct implementation serializes publication.
	var secondFinished bool
	select {
	case err = <-secondDone:
		secondFinished = true
	case <-time.After(5 * time.Second):
		select {
		case <-tr.secondCommitStarted:
			t.Fatal("database did not complete the second commit; race schedule was not established")
		default:
		}
	}
	release()
	select {
	case firstErr := <-firstDone:
		if firstErr != nil {
			t.Fatal(firstErr)
		}
	case <-ctx.Done():
		t.Fatal("first discovery did not finish after release")
	}
	if !secondFinished {
		select {
		case err = <-secondDone:
		case <-ctx.Done():
			t.Fatal("second discovery did not finish after release")
		}
	}
	if err != nil {
		t.Fatal(err)
	}
	cache, ok := a.cachedDiscovery(p)
	if !ok || cache.models["private-exact-id"].Metadata.OutputMax != 8192 {
		t.Fatalf("cache rolled back to an older discovery: %+v", cache.models["private-exact-id"].Metadata)
	}
	saved, err := a.queries.GetModel(context.Background(), db.GetModelParams{ID: id, UserID: user.ID})
	if err != nil {
		t.Fatal(err)
	}
	if modelCapability(p, saved).OutputMax != 8192 {
		t.Fatal("database and cache disagree after concurrent discovery")
	}
}
