package application

import (
	"context"
	"crypto/sha256"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
)

type discoveryFake struct {
	hashes [][]byte
	head   BrowserHead
	err    error
}

func (f *discoveryFake) DiscoverBrowserHead(_ context.Context, hashes [][]byte) (BrowserHead, error) {
	f.hashes = hashes
	return f.head, f.err
}

func TestDiscoverBrowserCredential(t *testing.T) {
	hash := sha256.Sum256([]byte("proof"))
	head := BrowserHead{BrowserID: uuid.New(), Generation: uuid.New(), RefreshHash: hash[:]}
	repo := &discoveryFake{head: head}
	credential, err := DiscoverBrowserCredential(context.Background(), repo, []string{"other", "proof", "proof"})
	if err != nil || credential.BrowserID != head.BrowserID || credential.Generation != head.Generation || credential.RefreshToken != "proof" || len(repo.hashes) != 2 {
		t.Fatalf("discovery failed: %v", err)
	}
	for _, input := range [][]string{nil, {""}, {strings.Repeat("x", 4097)}, make([]string, MaxV2RefreshCandidates+1)} {
		repo.hashes = nil
		if _, err := DiscoverBrowserCredential(context.Background(), repo, input); !errors.Is(err, ErrInvalidInput) || repo.hashes != nil {
			t.Fatalf("invalid input accepted: %v", err)
		}
	}
	repo.err = ErrRefreshToken
	if _, err := DiscoverBrowserCredential(context.Background(), repo, []string{"proof"}); !errors.Is(err, ErrRefreshToken) {
		t.Fatal(err)
	}
	repo.err = nil
	repo.head.RefreshHash = make([]byte, 32)
	if _, err := DiscoverBrowserCredential(context.Background(), repo, []string{"proof"}); !errors.Is(err, ErrRefreshToken) {
		t.Fatal("unpresented hash accepted")
	}
}
