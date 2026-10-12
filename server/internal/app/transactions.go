// SPDX-License-Identifier: AGPL-3.0-only
package app

import (
	"errors"
	"log/slog"

	"github.com/jackc/pgx/v5"
)

// Rollback needs its own bounded lifetime: the request or persistence context
// may already be canceled. Explicitly release transaction locks rather than
// relying on closing the connection to discard an unfinished transaction.
func rollbackTransaction(tx pgx.Tx) {
	ctx, cancel := durableContext()
	defer cancel()
	if err := tx.Rollback(ctx); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
		slog.Error("transaction cleanup failed")
	}
}
