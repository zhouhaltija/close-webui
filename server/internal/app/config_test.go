package app

import (
	"context"
	"testing"
)

func TestRejectInvalidEncryptionKeyBeforeConnecting(t *testing.T) {
	for _, key := range []string{"", "not-base64", "YWJj"} {
		_, err := New(context.Background(), Config{DatabaseURL: "postgres://unreachable", EncryptionKey: key})
		if err == nil {
			t.Fatalf("invalid encryption key %q was accepted", key)
		}
	}
}
