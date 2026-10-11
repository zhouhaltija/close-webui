package main

import (
	"context"
	"database/sql"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"closewebui/server/internal/app"
	"closewebui/server/internal/security"
	"closewebui/server/migrations"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/joho/godotenv"
)

func main() {
	operation := flag.String("migrate", "", "explicit database migration: up or down")
	flag.Parse()
	_ = godotenv.Load("../.env.backend.local")
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		slog.Error("DATABASE_URL is required; see server/.env.example")
		os.Exit(1)
	}
	secure := os.Getenv("COOKIE_SECURE") != "false"
	if secure {
		if err := security.RequireDatabaseTLS(dsn); err != nil {
			slog.Error(err.Error())
			os.Exit(1)
		}
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if *operation != "" {
		std, err := sql.Open("pgx", dsn)
		if err != nil {
			slog.Error("invalid database configuration")
			os.Exit(1)
		}
		defer std.Close()
		switch *operation {
		case "up":
			err = migrations.Up(ctx, std)
		case "down":
			err = migrations.Down(ctx, std)
		default:
			slog.Error("migration must be up or down")
			os.Exit(1)
		}
		if err != nil {
			slog.Error("database migration failed; check connection and schema permissions")
			os.Exit(1)
		}
		slog.Info("database migration completed", "operation", *operation)
		return
	}
	allowed := []string{}
	for _, host := range strings.Split(os.Getenv("UPSTREAM_ALLOWED_HOSTS"), ",") {
		if strings.TrimSpace(host) != "" {
			allowed = append(allowed, strings.TrimSpace(host))
		}
	}
	static := os.Getenv("STATIC_DIR")
	if static == "" {
		static = "../dist"
	}
	cfg := app.Config{DatabaseURL: dsn, EncryptionKey: os.Getenv("ENCRYPTION_KEY"), AllowedHosts: allowed, Origin: os.Getenv("PUBLIC_ORIGIN"), SecureCookies: secure, StaticDir: static}
	startup, startupCancel := context.WithTimeout(ctx, 30*time.Second)
	service, err := app.New(startup, cfg)
	startupCancel()
	if err != nil {
		slog.Error("server initialization failed", "reason", err.Error())
		os.Exit(1)
	}
	defer service.Close()
	address := os.Getenv("LISTEN_ADDR")
	if address == "" {
		address = "127.0.0.1:8080"
	}
	server := &http.Server{Addr: address, Handler: service, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	go func() {
		<-ctx.Done()
		service.Close()
		shutdown, done := context.WithTimeout(context.Background(), 15*time.Second)
		defer done()
		_ = server.Shutdown(shutdown)
	}()
	slog.Info("CloseWebUI listening", "address", address)
	if err = server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		slog.Error("HTTP server failed", "reason", err.Error())
		os.Exit(1)
	}
}
