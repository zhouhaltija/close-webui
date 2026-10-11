package migrations

import (
	"context"
	"database/sql"
	"embed"

	"github.com/pressly/goose/v3"
)

// Files bundles migrations into the server binary for deployment.
//
//go:embed *.sql
var Files embed.FS

func Up(ctx context.Context, database *sql.DB) error {
	provider, err := goose.NewProvider(goose.DialectPostgres, database, Files, goose.WithDisableGlobalRegistry(true))
	if err != nil {
		return err
	}
	_, err = provider.Up(ctx)
	return err
}

// Down rolls back one migration only when explicitly invoked by an operator.
func Down(ctx context.Context, database *sql.DB) error {
	provider, err := goose.NewProvider(goose.DialectPostgres, database, Files, goose.WithDisableGlobalRegistry(true))
	if err != nil {
		return err
	}
	_, err = provider.Down(ctx)
	return err
}
