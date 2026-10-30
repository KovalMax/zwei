//go:build !e2e_turn

package main

import (
	"testing"
	"time"
)

func TestTURNCredentialLifetimeProduction(t *testing.T) {
	if got := turnCredentialLifetime; got != 2*time.Hour {
		t.Fatalf("TURN credential lifetime = %s, want 2h", got)
	}
}
