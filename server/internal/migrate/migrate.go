package migrate

import (
	"context"
	"database/sql"

	"closewebui/server/migrations"
)

func Up(ctx context.Context, database *sql.DB) error   { return migrations.Up(ctx, database) }
func Down(ctx context.Context, database *sql.DB) error { return migrations.Down(ctx, database) }
