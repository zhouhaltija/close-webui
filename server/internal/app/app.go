package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"closewebui/server/internal/db"
	"closewebui/server/internal/security"
	"closewebui/server/internal/upstream"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Config struct {
	DatabaseURL   string
	EncryptionKey string
	AllowedHosts  []string
	Origin        string
	SecureCookies bool
	StaticDir     string
	Schema        string
}

type running struct {
	cancel                 context.CancelFunc
	done                   chan struct{}
	userID, conversationID string
}
type rateWindow struct {
	start    time.Time
	attempts int
}
type App struct {
	handler   http.Handler
	cfg       Config
	pool      *pgxpool.Pool
	queries   *db.Queries
	cipher    *security.Cipher
	upstream  *upstream.Client
	lease     *pgxpool.Conn
	mu        sync.Mutex
	closeOnce sync.Once
	active    map[string]*running
	rates     map[string]rateWindow
	authSlots chan struct{}
	dummyHash string
}

func New(ctx context.Context, cfg Config) (*App, error) {
	key, err := base64.StdEncoding.DecodeString(cfg.EncryptionKey)
	if err != nil || len(key) != 32 {
		return nil, errors.New("ENCRYPTION_KEY must be base64-encoded 32 bytes")
	}
	if cfg.SecureCookies {
		if e := security.RequireDatabaseTLS(cfg.DatabaseURL); e != nil {
			return nil, e
		}
		origin, e := url.Parse(cfg.Origin)
		if e != nil || origin.Scheme != "https" || origin.Host == "" {
			return nil, errors.New("production PUBLIC_ORIGIN requires HTTPS")
		}
	}
	cipher, err := security.NewCipher(cfg.EncryptionKey)
	if err != nil {
		return nil, err
	}
	client, err := security.NewHTTPClient(cfg.AllowedHosts)
	if err != nil {
		return nil, err
	}
	// Generation and discovery own their deadlines; a whole-response timeout
	// would terminate a valid long-running reasoning stream prematurely.
	client.Timeout = 0
	pc, err := pgxpool.ParseConfig(cfg.DatabaseURL)
	if err != nil {
		return nil, errors.New("invalid DATABASE_URL")
	}
	if cfg.Schema != "" {
		pc.ConnConfig.RuntimeParams["search_path"] = cfg.Schema
	}
	pc.MaxConns = 12
	pool, err := pgxpool.NewWithConfig(ctx, pc)
	if err != nil {
		return nil, errors.New("database initialization failed")
	}
	if err = pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, errors.New("cannot connect to PostgreSQL")
	}
	lease, err := pool.Acquire(ctx)
	if err != nil {
		pool.Close()
		return nil, err
	}
	var locked bool
	err = lease.QueryRow(ctx, "SELECT pg_try_advisory_lock(hashtext(current_database() || ':' || current_schema()), 870911)").Scan(&locked)
	if err != nil || !locked {
		lease.Release()
		pool.Close()
		return nil, errors.New("another server instance already owns this database schema")
	}
	a := &App{cfg: cfg, pool: pool, queries: db.New(pool), cipher: cipher, upstream: upstream.NewClient(client), lease: lease, active: map[string]*running{}, rates: map[string]rateWindow{}, authSlots: make(chan struct{}, 4)}
	a.dummyHash, err = security.HashPassword("dummy-account-password-123")
	if err != nil {
		a.Close()
		return nil, err
	}
	if err = a.recoverInterrupted(ctx); err != nil {
		a.Close()
		return nil, errors.New("cannot recover interrupted generations; run database migrations first")
	}
	a.handler = a.routes()
	return a, nil
}

func (a *App) ServeHTTP(w http.ResponseWriter, r *http.Request) { a.handler.ServeHTTP(w, r) }
func (a *App) Close() {
	a.closeOnce.Do(a.close)
}
func (a *App) close() {
	a.mu.Lock()
	jobs := make([]*running, 0, len(a.active))
	for _, job := range a.active {
		job.cancel()
		jobs = append(jobs, job)
	}
	a.mu.Unlock()
	for _, job := range jobs {
		select {
		case <-job.done:
		case <-time.After(10 * time.Second):
		}
	}
	if a.lease != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		_, _ = a.lease.Exec(ctx, "SELECT pg_advisory_unlock(hashtext(current_database() || ':' || current_schema()), 870911)")
		cancel()
		a.lease.Release()
		a.lease = nil
	}
	if a.pool != nil {
		a.pool.Close()
	}
}

func (a *App) routes() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.Recoverer, a.securityHeaders, a.checkOrigin)
	r.Route("/api", func(r chi.Router) {
		r.Post("/auth/register", a.register)
		r.Post("/auth/login", a.login)
		r.Group(func(r chi.Router) {
			r.Use(a.authenticate)
			r.Get("/auth/me", func(w http.ResponseWriter, r *http.Request) {
				u := currentUser(r)
				respond(w, 200, map[string]string{"id": u.ID, "username": u.Username})
			})
			r.Post("/auth/logout", a.logout)
			r.Post("/auth/password", a.password)
			r.Get("/provider-templates", func(w http.ResponseWriter, r *http.Request) { respond(w, 200, upstream.Templates()) })
			r.Get("/providers", a.listProviders)
			r.Post("/providers", a.saveProvider)
			r.Get("/providers/{id}", a.getProvider)
			r.Patch("/providers/{id}", a.saveProvider)
			r.Delete("/providers/{id}", a.deleteProvider)
			r.Post("/providers/{id}/discover", a.discover)
			r.Get("/models", a.listModels)
			r.Post("/models", a.saveModel)
			r.Get("/models/{id}", a.getModel)
			r.Patch("/models/{id}", a.saveModel)
			r.Delete("/models/{id}", a.deleteModel)
			r.Get("/preferences", a.preferences)
			r.Patch("/preferences", a.preferences)
			r.Get("/conversations", a.listConversations)
			r.Post("/conversations", a.createConversation)
			r.Get("/conversations/{id}", a.getConversation)
			r.Patch("/conversations/{id}", a.renameConversation)
			r.Delete("/conversations/{id}", a.deleteConversation)
			r.Post("/conversations/{id}/generations", a.generate)
			r.Post("/conversations/{id}/generations/{generationId}/stop", a.stop)
		})
		r.NotFound(func(w http.ResponseWriter, r *http.Request) { failure(w, 404, "NOT_FOUND", "接口不存在。") })
	})
	r.Get("/*", a.static)
	return r
}

func respond(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if status != 204 {
		_ = json.NewEncoder(w).Encode(v)
	}
}
func failure(w http.ResponseWriter, status int, code, message string) {
	respond(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		failure(w, 400, "INVALID_REQUEST", "请求数据无效。请检查填写内容。")
		return false
	}
	if err := d.Decode(new(any)); err != io.EOF {
		failure(w, 400, "INVALID_REQUEST", "请求包含多余数据。")
		return false
	}
	return true
}
func dbError(w http.ResponseWriter, err error) {
	if errors.Is(err, context.Canceled) {
		return
	}
	if errors.Is(err, pgx.ErrNoRows) {
		failure(w, 404, "NOT_FOUND", "记录不存在。")
		return
	}
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		if pg.Code == "23505" {
			failure(w, 409, "CONFLICT", "记录已存在或已有活动生成。")
			return
		}
		if pg.Code == "22P02" {
			failure(w, 400, "INVALID_ID", "记录标识无效。")
			return
		}
	}
	slog.Error("database operation failed", "type", errors.Unwrap(err) != nil)
	failure(w, 500, "DATABASE_ERROR", "保存或读取数据失败，请稍后重试。")
}
func (a *App) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "same-origin")
		if strings.HasPrefix(r.URL.Path, "/api") {
			w.Header().Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}
func (a *App) checkOrigin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" && r.Method != "HEAD" && r.Method != "OPTIONS" {
			origin := r.Header.Get("Origin")
			if origin != "" {
				u, err := url.Parse(origin)
				same := err == nil && u.Host == r.Host && (u.Scheme == "http" || u.Scheme == "https")
				if (!same || (a.cfg.SecureCookies && u.Scheme != "https")) && origin != strings.TrimRight(a.cfg.Origin, "/") {
					failure(w, 403, "INVALID_ORIGIN", "不允许跨来源操作。")
					return
				}
			}
			if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
				failure(w, 403, "INVALID_ORIGIN", "不允许跨来源操作。")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

type userContextKey struct{}

func currentUser(r *http.Request) db.User {
	u, _ := r.Context().Value(userContextKey{}).(db.User)
	return u
}
func (a *App) authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie("closewebui_session")
		if err != nil || c.Value == "" {
			failure(w, 401, "UNAUTHENTICATED", "请先登录。")
			return
		}
		u, err := a.queries.GetSession(r.Context(), security.HashToken(c.Value))
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				failure(w, 401, "UNAUTHENTICATED", "登录已失效，请重新登录。")
			} else {
				dbError(w, err)
			}
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userContextKey{}, u)))
	})
}
func (a *App) static(w http.ResponseWriter, r *http.Request) {
	if a.cfg.StaticDir == "" {
		http.NotFound(w, r)
		return
	}
	clean := filepath.Clean("/" + r.URL.Path)
	name := filepath.Join(a.cfg.StaticDir, clean)
	// filepath.Join on Windows retains the base for a rooted cleaned path.
	if info, err := os.Stat(name); err == nil && !info.IsDir() {
		http.ServeFile(w, r, name)
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeFile(w, r, filepath.Join(a.cfg.StaticDir, "index.html"))
}
func remoteIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
