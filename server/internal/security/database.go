package security

import (
	"errors"
	"net/url"
)

// RequireDatabaseTLS is shared by production startup and migration commands.
// It validates configuration before either path opens a database connection.
func RequireDatabaseTLS(dsn string) error {
	u, err := url.Parse(dsn)
	if err != nil {
		return errors.New("production DATABASE_URL requires PostgreSQL TLS")
	}
	switch u.Query().Get("sslmode") {
	case "require", "verify-ca", "verify-full":
		return nil
	default:
		return errors.New("production DATABASE_URL requires PostgreSQL TLS")
	}
}
