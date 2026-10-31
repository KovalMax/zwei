//go:build e2e_turn

package main

import "time"

// Only the dedicated, isolated TURN acceptance image may use this build tag.
const turnCredentialLifetime = 45 * time.Second
