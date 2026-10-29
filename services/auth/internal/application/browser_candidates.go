package application

import (
	"context"
	"crypto/sha256"

	"github.com/google/uuid"
)

// BrowserCandidateHead is an infrastructure snapshot, not an authorization.
type BrowserCandidateHead struct {
	BrowserID, Generation uuid.UUID
	DisplayName           string
	RefreshHash           []byte
}

type BrowserCandidateDiscovery interface {
	DiscoverBrowserCandidates(context.Context, [][]byte) ([]BrowserCandidateHead, error)
}

// MaxV2RefreshCandidates bounds multi-head discovery independently of legacy
// refresh. The HTTP cookie byte limit provides an additional bound.
const MaxV2RefreshCandidates = 128

// BrowserCandidate contains only displayable selectors in JSON. Its proof must
// remain private and is revalidated by the mutation repository under lock.
type BrowserCandidate struct {
	BrowserID   uuid.UUID `json:"browser_id"`
	Generation  uuid.UUID `json:"generation"`
	DisplayName string    `json:"display_name"`
	credential  BrowserCredential
}

func DiscoverBrowserCandidates(ctx context.Context, repository BrowserCandidateDiscovery, tokens []string) ([]BrowserCandidate, error) {
	if len(tokens) == 0 || len(tokens) > MaxV2RefreshCandidates || repository == nil {
		return nil, ErrInvalidInput
	}
	proofs := make(map[[32]byte]string, len(tokens))
	hashes := make([][]byte, 0, len(tokens))
	for _, token := range tokens {
		if token == "" || len(token) > 4096 {
			return nil, ErrInvalidInput
		}
		hash := sha256.Sum256([]byte(token))
		if _, ok := proofs[hash]; !ok {
			hashes = append(hashes, hash[:])
			proofs[hash] = token
		}
	}
	heads, err := repository.DiscoverBrowserCandidates(ctx, hashes)
	if err != nil {
		return nil, err
	}
	if len(heads) == 0 {
		return nil, ErrNoLiveBrowserHead
	}
	if len(heads) > len(hashes) {
		return nil, ErrRefreshToken
	}
	result := make([]BrowserCandidate, 0, len(heads))
	seen := make(map[uuid.UUID]struct{}, len(heads))
	for _, head := range heads {
		if head.BrowserID == uuid.Nil || head.Generation == uuid.Nil || len(head.RefreshHash) != sha256.Size {
			return nil, ErrRefreshToken
		}
		if _, ok := seen[head.BrowserID]; ok {
			return nil, ErrRefreshToken
		}
		seen[head.BrowserID] = struct{}{}
		var hash [32]byte
		copy(hash[:], head.RefreshHash)
		proof, ok := proofs[hash]
		if !ok {
			return nil, ErrRefreshToken
		}
		delete(proofs, hash)
		result = append(result, BrowserCandidate{BrowserID: head.BrowserID, Generation: head.Generation, DisplayName: head.DisplayName, credential: BrowserCredential{BrowserID: head.BrowserID, Generation: head.Generation, RefreshToken: proof}})
	}
	return result, nil
}

func SelectBrowserCandidate(candidates []BrowserCandidate, browser, generation uuid.UUID) (BrowserCredential, error) {
	for _, candidate := range candidates {
		if candidate.BrowserID == browser && candidate.Generation == generation && validBrowserCredential(candidate.credential) && candidate.credential.BrowserID == browser && candidate.credential.Generation == generation {
			return candidate.credential, nil
		}
	}
	return BrowserCredential{}, ErrRefreshToken
}
