//go:build e2e_turn

package main

import (
	"testing"
	"time"
)

func TestTURNCredentialLifetimeIsolatedE2E(t *testing.T) {
	if got := turnCredentialLifetime; got != 45*time.Second {
		t.Fatalf("isolated E2E TURN credential lifetime = %s, want 45s", got)
	}
}
