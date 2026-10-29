package application

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
)

type candidateDiscoveryFake struct{ heads []BrowserCandidateHead }

func (f candidateDiscoveryFake) DiscoverBrowserCandidates(context.Context, [][]byte) ([]BrowserCandidateHead, error) {
	return f.heads, nil
}

func TestBrowserCandidatesRequireMatchingProofAndUniqueSelectors(t *testing.T) {
	h1, h2 := sha256.Sum256([]byte("one")), sha256.Sum256([]byte("two"))
	b1, b2, g1, g2 := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	heads := []BrowserCandidateHead{{BrowserID: b1, Generation: g1, DisplayName: "Alice", RefreshHash: h1[:]}, {BrowserID: b2, Generation: g2, DisplayName: "Bob", RefreshHash: h2[:]}}
	candidates, err := DiscoverBrowserCandidates(context.Background(), candidateDiscoveryFake{heads}, []string{"one", "two"})
	if err != nil || len(candidates) != 2 || candidates[1].DisplayName != "Bob" {
		t.Fatalf("discovery failed: %v", err)
	}
	encoded, err := json.Marshal(candidates)
	if err != nil || strings.Contains(string(encoded), "one") || strings.Contains(string(encoded), "two") || strings.Contains(string(encoded), "refresh") {
		t.Fatal("candidate JSON exposed proof")
	}
	credential, err := SelectBrowserCandidate(candidates, b2, g2)
	if err != nil || credential.RefreshToken != "two" {
		t.Fatalf("selection failed: %v", err)
	}
	if _, err := SelectBrowserCandidate(candidates, b1, g2); !errors.Is(err, ErrRefreshToken) {
		t.Fatal("mismatched selector accepted")
	}
	if _, err := DiscoverBrowserCandidates(context.Background(), candidateDiscoveryFake{heads}, []string{"one"}); !errors.Is(err, ErrRefreshToken) {
		t.Fatal("unpresented proof accepted")
	}
	heads[1].BrowserID, heads[1].Generation = b1, g1
	if _, err := DiscoverBrowserCandidates(context.Background(), candidateDiscoveryFake{heads}, []string{"one", "two"}); !errors.Is(err, ErrRefreshToken) {
		t.Fatal("duplicate selector accepted")
	}
}
