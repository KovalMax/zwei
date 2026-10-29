package application

import (
	"context"
	"crypto/sha256"
	"fmt"

	"github.com/google/uuid"
)

// ErrNoLiveBrowserHead distinguishes an empty discovery result from ambiguity.
// It remains an invalid refresh proof for callers that do not support recovery.
var ErrNoLiveBrowserHead = fmt.Errorf("no live browser head: %w", ErrRefreshToken)

// BrowserHead is a point-in-time discovery result, not authorization for a
// subsequent mutation. Mutations must revalidate the returned credential.
type BrowserHead struct {
	BrowserID, Generation uuid.UUID
	RefreshHash           []byte
}

type BrowserHeadDiscovery interface {
	DiscoverBrowserHead(context.Context, [][]byte) (BrowserHead, error)
}

// DiscoverBrowserCredential accepts only bearer proofs, never client-supplied
// selectors. Duplicate cookie values represent one proof, not ambiguity.
func DiscoverBrowserCredential(ctx context.Context, repository BrowserHeadDiscovery, tokens []string) (BrowserCredential, error) {
	if len(tokens) == 0 || len(tokens) > MaxV2RefreshCandidates {
		return BrowserCredential{}, ErrInvalidInput
	}
	hashes := make([][]byte, 0, len(tokens))
	proofs := make(map[[32]byte]string, len(tokens))
	for _, token := range tokens {
		if token == "" || len(token) > 4096 {
			return BrowserCredential{}, ErrInvalidInput
		}
		hash := sha256.Sum256([]byte(token))
		if _, exists := proofs[hash]; !exists {
			hashes = append(hashes, hash[:])
			proofs[hash] = token
		}
	}
	head, err := repository.DiscoverBrowserHead(ctx, hashes)
	if err != nil {
		return BrowserCredential{}, err
	}
	if head.BrowserID == uuid.Nil || head.Generation == uuid.Nil || len(head.RefreshHash) != 32 {
		return BrowserCredential{}, ErrRefreshToken
	}
	var hash [32]byte
	copy(hash[:], head.RefreshHash)
	token, ok := proofs[hash]
	if !ok {
		return BrowserCredential{}, ErrRefreshToken
	}
	return BrowserCredential{BrowserID: head.BrowserID, Generation: head.Generation, RefreshToken: token}, nil
}
