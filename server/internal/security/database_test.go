package security

import (
	"strings"
	"testing"
)

func TestRequireDatabaseTLSBeforeAnyConnection(t *testing.T) {
	for _, mode := range []string{"", "disable", "allow", "prefer"} {
		if err := RequireDatabaseTLS("postgres://example.invalid/dev?sslmode=" + mode); err == nil || !strings.Contains(err.Error(), "TLS") {
			t.Fatalf("accepted non-TLS mode %q: %v", mode, err)
		}
	}
	for _, mode := range []string{"require", "verify-ca", "verify-full"} {
		if err := RequireDatabaseTLS("postgres://example.invalid/dev?sslmode=" + mode); err != nil {
			t.Fatalf("rejected TLS mode %q: %v", mode, err)
		}
	}
}
