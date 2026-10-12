// Test-only executable: real Go app, isolated PostgreSQL schema, local upstream.
package main

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"closewebui/server/internal/app"
	"closewebui/server/migrations"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/joho/godotenv"
)

func main() {
	if err := run(); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}
func run() (runErr error) {
	address := flag.String("listen", "127.0.0.1:4175", "test HTTP address")
	static := flag.String("static", "../.test-dist/backend", "test frontend")
	flag.Parse()
	_ = godotenv.Load("../.env.backend.local")
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		return fmt.Errorf("DATABASE_URL required for backend E2E")
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	admin, err := pgx.Connect(ctx, dsn)
	if err != nil {
		return fmt.Errorf("test database connection failed")
	}
	defer admin.Close(context.Background())
	schema := "closewebui_e2e_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		return fmt.Errorf("cannot create isolated test schema")
	}
	var cleanupOnce sync.Once
	var cleanupErr error
	cleaned := make(chan struct{})
	cleanupSchema := func() error {
		cleanupOnce.Do(func() {
			cleanup, done := context.WithTimeout(context.Background(), 15*time.Second)
			defer done()
			if _, err := admin.Exec(cleanup, "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE"); err != nil {
				cleanupErr = fmt.Errorf("isolated test schema cleanup failed")
			}
			close(cleaned)
		})
		return cleanupErr
	}
	defer func() {
		if err := cleanupSchema(); err != nil && runErr == nil {
			runErr = err
		}
	}()
	u, err := url.Parse(dsn)
	if err != nil {
		return fmt.Errorf("invalid test database configuration")
	}
	q := u.Query()
	q.Set("search_path", schema)
	u.RawQuery = q.Encode()
	std, err := sql.Open("pgx", u.String())
	if err != nil {
		return fmt.Errorf("invalid test database configuration")
	}
	if err = migrations.Up(ctx, std); err != nil {
		_ = std.Close()
		return fmt.Errorf("test schema migration failed")
	}
	_ = std.Close()
	var mu sync.Mutex
	attempts := map[string]int{}
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer synthetic-key" {
			http.Error(w, "synthetic test key required", 401)
			return
		}
		if r.URL.Path == "/v1/models" {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]string{{"id": "gpt-5.1", "name": "测试推理模型"}, {"id": "gpt-4o", "name": "测试聊天模型"}}})
			return
		}
		if r.URL.Path != "/v1/chat/completions" {
			http.NotFound(w, r)
			return
		}
		var body struct {
			Model    string                           `json:"model"`
			Messages []struct{ Role, Content string } `json:"messages"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil || len(body.Messages) == 0 {
			http.Error(w, "invalid request", 400)
			return
		}
		last := body.Messages[len(body.Messages)-1].Content
		mu.Lock()
		attempts[last]++
		attempt := attempts[last]
		mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		send := func(text string) bool {
			v, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]string{"content": text}}}})
			if _, e := fmt.Fprintf(w, "data: %s\n\n", v); e != nil {
				return false
			}
			w.(http.Flusher).Flush()
			return true
		}
		if !send("# 测试回答\n\n") {
			return
		}
		if strings.Contains(last, "[failure]") && attempt == 1 {
			_, _ = io.WriteString(w, "data: {\"error\":{\"message\":\"synthetic stream failure\"}}\n\n")
			return
		}
		if strings.Contains(last, "[slow]") {
			ticker := time.NewTicker(300 * time.Millisecond)
			defer ticker.Stop()
			for i := 0; i < 80; i++ {
				select {
				case <-r.Context().Done():
					return
				case <-ticker.C:
					if !send("这是可停止的流式测试内容。 ") {
						return
					}
				}
			}
		} else if strings.Contains(last, "[perf]") {
			// Fixed cadence performance fixture: one chunk every 50ms, 20k characters
			// including a code fence and a Markdown table, so the browser measurement
			// exercises long answers and repeated highlighting.
			ticker := time.NewTicker(50 * time.Millisecond)
			defer ticker.Stop()
			filler := strings.Repeat("性能采样内容 ", 62)
			chunks := []string{"# 性能采样\n\n"}
			for i := 0; i < 40; i++ {
				chunks = append(chunks, filler)
			}
			chunks = append(chunks, "\n\n| 列一 | 列二 |\n| --- | --- |\n| 甲 | 乙 |\n\n```go\npackage main\n\nfunc main() { println(\"CloseWebUI\") }\n```\n")
			for _, chunk := range chunks {
				select {
				case <-r.Context().Done():
					return
				case <-ticker.C:
					if !send(chunk) {
						return
					}
				}
			}
		} else {
			if !send("这条回答经过真实 Go 服务和 PostgreSQL 保存；模型上游为本地仿真。\n\n") {
				return
			}
			if !send("| 项目 | 状态 |\n| --- | --- |\n| 流式回答 | 已完成 |\n\n```go\nfmt.Println(\"CloseWebUI\")\n```\n") {
				return
			}
		}
		_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer up.Close()
	host, _ := url.Parse(up.URL)
	service, err := app.New(ctx, app.Config{DatabaseURL: dsn, Schema: schema, EncryptionKey: base64.StdEncoding.EncodeToString(make([]byte, 32)), AllowedHosts: []string{host.Host}, StaticDir: *static})
	if err != nil {
		return fmt.Errorf("test application initialization failed: %w", err)
	}
	defer service.Close()
	mux := http.NewServeMux()
	mux.Handle("/", service)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })
	mux.HandleFunc("/__test/upstream", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"url": up.URL + "/v1"})
	})
	var shutdownOnce sync.Once
	mux.HandleFunc("/__test/shutdown", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			w.WriteHeader(405)
			return
		}
		shutdownOnce.Do(cancel)
		<-cleaned
		if cleanupErr != nil {
			http.Error(w, "isolated test schema cleanup failed", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(204)
	})
	server := &http.Server{Addr: *address, Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		service.Close()
		_ = cleanupSchema()
		closeCtx, done := context.WithTimeout(context.Background(), 10*time.Second)
		defer done()
		_ = server.Shutdown(closeCtx)
	}()
	log.Print("isolated backend test server ready")
	if err = server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return fmt.Errorf("test HTTP server failed")
	}
	return nil
}
