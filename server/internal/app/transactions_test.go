// SPDX-License-Identifier: AGPL-3.0-only
package app

import (
	"context"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Cancel after the user INSERT has completed, before the session INSERT. This
// exercises cancellation between statements while the transaction owns locks.
type registrationCancelTracer struct {
	cancel      context.CancelFunc
	rollbackErr error
	rolledBack  bool
	pid         uint32
}

type transactionQueryKey struct{}

func (p *registrationCancelTracer) TraceQueryStart(ctx context.Context, conn *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	p.pid = conn.PgConn().PID()
	return context.WithValue(ctx, transactionQueryKey{}, data.SQL)
}

func (p *registrationCancelTracer) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryEndData) {
	sql, _ := ctx.Value(transactionQueryKey{}).(string)
	if strings.Contains(sql, "-- name: CreateUser") && data.Err == nil {
		p.cancel()
	}
	if sql == "rollback" {
		p.rolledBack = true
		p.rollbackErr = data.Err
	}
}

func TestCanceledRegistrationRollsBackBeforeReleasingConnection(t *testing.T) {
	s, schema := fixture(t, "")
	a := s.Config.Handler.(*App)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	tracer := &registrationCancelTracer{cancel: cancel}
	config, err := pgxpool.ParseConfig(os.Getenv("DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	config.ConnConfig.Tracer = tracer
	config.MaxConns = 1
	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	original := a.pool
	a.pool = pool
	defer func() { a.pool = original }()
	r := httptest.NewRequest("POST", "/api/auth/register", strings.NewReader(`{"username":"cancelled_registration","password":"Test-password-123"}`)).WithContext(ctx)
	a.register(httptest.NewRecorder(), r)
	if ctx.Err() == nil {
		t.Fatal("registration was not canceled after user INSERT")
	}
	if !tracer.rolledBack || tracer.rollbackErr != nil {
		t.Fatalf("canceled registration did not complete rollback: attempted=%v error=%v", tracer.rolledBack, tracer.rollbackErr)
	}
	check, stopCheck := context.WithTimeout(context.Background(), 10*time.Second)
	defer stopCheck()
	var users int
	if err := original.QueryRow(check, "SELECT count(*) FROM users WHERE username='cancelled_registration'").Scan(&users); err != nil {
		t.Fatal(err)
	}
	if users != 0 {
		t.Fatalf("canceled registration left %d users", users)
	}
	var idleTransaction bool
	if err := original.QueryRow(check, "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND state LIKE 'idle in transaction%')", tracer.pid).Scan(&idleTransaction); err != nil {
		t.Fatal(err)
	}
	if idleTransaction {
		t.Fatal("canceled registration left an idle transaction")
	}
}
