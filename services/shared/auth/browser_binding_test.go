package auth

import (
	"context"
	"errors"
	"testing"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestBrowserBindingClaims(t *testing.T) {
	secret := []byte("01234567890123456789012345678901")
	user, browser, generation := uuid.New(), uuid.New(), uuid.New()
	cases := []struct {
		name         string
		extra        jwt.MapClaims
		valid, bound bool
	}{
		{"legacy", nil, true, false},
		{"paired", jwt.MapClaims{"browser_id": browser.String(), "browser_generation": generation.String()}, true, true},
		{"missing generation", jwt.MapClaims{"browser_id": browser.String()}, false, false},
		{"missing browser", jwt.MapClaims{"browser_generation": generation.String()}, false, false},
		{"invalid uuid", jwt.MapClaims{"browser_id": "bad", "browser_generation": generation.String()}, false, false},
		{"nil uuid", jwt.MapClaims{"browser_id": uuid.Nil.String(), "browser_generation": generation.String()}, false, false},
		{"null", jwt.MapClaims{"browser_id": nil, "browser_generation": nil}, false, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			claims := jwt.MapClaims{"sub": user.String(), "session_version": 1}
			for k, v := range tc.extra {
				claims[k] = v
			}
			raw, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(secret)
			if err != nil {
				t.Fatal(err)
			}
			identity, err := Parse(raw, secret)
			if (err == nil) != tc.valid {
				t.Fatalf("parse error: %v", err)
			}
			if tc.bound && (identity.BrowserID != browser || identity.BrowserGeneration != generation) {
				t.Fatalf("binding lost: %+v", identity)
			}
		})
	}
}

type bindingReader struct {
	version int64
	active  bool
	err     error
	calls   int
}

func (r *bindingReader) QueryRow(_ context.Context, _ string, args ...any) pgx.Row {
	r.calls++
	match := true
	if len(args) == 4 {
		match = args[1] == r.version
	}
	return bindingRow{r, match}
}

type bindingRow struct {
	r     *bindingReader
	match bool
}

func (r bindingRow) Scan(dest ...any) error {
	if r.r.err != nil {
		return r.r.err
	}
	if p, ok := dest[0].(*int64); ok {
		*p = r.r.version
	} else {
		*dest[0].(*bool) = r.r.active && r.match
	}
	return nil
}
func TestValidateBrowserBinding(t *testing.T) {
	identity := Identity{UserID: uuid.New(), SessionVersion: 2, BrowserID: uuid.New(), BrowserGeneration: uuid.New()}
	for _, tc := range []struct {
		name    string
		version int64
		active  bool
		err     error
		valid   bool
	}{
		{"active", 2, true, nil, true}, {"stale or wrong user", 2, false, nil, false}, {"account revoked", 3, true, nil, false}, {"database error", 2, true, errors.New("database failed"), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := &bindingReader{version: tc.version, active: tc.active, err: tc.err}
			err := NewSessionValidator(r, nil).Validate(context.Background(), identity, false)
			if (err == nil) != tc.valid {
				t.Fatalf("error %v", err)
			}
		})
	}
	r := &bindingReader{version: 2}
	legacy := identity
	legacy.BrowserID = uuid.Nil
	legacy.BrowserGeneration = uuid.Nil
	if err := NewSessionValidator(r, nil).Validate(context.Background(), legacy, false); !errors.Is(err, ErrSessionInvalid) || r.calls != 0 {
		t.Fatalf("legacy: %v calls %d", err, r.calls)
	}
	legacy.BrowserID = uuid.New()
	if err := NewSessionValidator(r, nil).Validate(context.Background(), legacy, false); !errors.Is(err, ErrSessionInvalid) {
		t.Fatalf("partial binding accepted: %v", err)
	}
}
