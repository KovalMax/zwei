package postgres

import (
	"context"

	"github.com/KovalMax/zwei/services/auth/internal/application"
)

var _ application.BrowserHeadDiscovery = (*Repository)(nil)
var _ application.BrowserCandidateDiscovery = (*Repository)(nil)

// Candidate discovery is a bounded snapshot. Mutations must revalidate proof.
func (r *Repository) DiscoverBrowserCandidates(ctx context.Context, hashes [][]byte) ([]application.BrowserCandidateHead, error) {
	if len(hashes) == 0 || len(hashes) > application.MaxV2RefreshCandidates {
		return nil, application.ErrInvalidInput
	}
	for _, hash := range hashes {
		if len(hash) != 32 {
			return nil, application.ErrInvalidInput
		}
	}
	rows, err := r.db.Query(ctx, `SELECT h.browser_id,h.generation,u.display_name,h.current_refresh_hash
 FROM browser_auth_heads h JOIN sessions s ON s.refresh_token_hash=h.current_refresh_hash AND s.user_id=h.user_id
 JOIN users u ON u.id=s.user_id
 WHERE h.current_refresh_hash=ANY($1::bytea[]) AND s.revoked_at IS NULL AND s.expires_at>now() AND s.user_session_version=u.session_version
 ORDER BY h.browser_id LIMIT $2`, hashes, application.MaxV2RefreshCandidates+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var heads []application.BrowserCandidateHead
	for rows.Next() {
		var head application.BrowserCandidateHead
		if err := rows.Scan(&head.BrowserID, &head.Generation, &head.DisplayName, &head.RefreshHash); err != nil {
			return nil, err
		}
		heads = append(heads, head)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(heads) > application.MaxV2RefreshCandidates {
		return nil, application.ErrRefreshToken
	}
	return heads, nil
}

// Discovery is a snapshot only; all write operations revalidate under locks.
func (r *Repository) DiscoverBrowserHead(ctx context.Context, hashes [][]byte) (application.BrowserHead, error) {
	if len(hashes) == 0 || len(hashes) > application.MaxV2RefreshCandidates {
		return application.BrowserHead{}, application.ErrInvalidInput
	}
	for _, hash := range hashes {
		if len(hash) != 32 {
			return application.BrowserHead{}, application.ErrInvalidInput
		}
	}
	rows, err := r.db.Query(ctx, `SELECT h.browser_id,h.generation,h.current_refresh_hash
 FROM browser_auth_heads h JOIN sessions s ON s.refresh_token_hash=h.current_refresh_hash AND s.user_id=h.user_id
 JOIN users u ON u.id=s.user_id
 WHERE h.current_refresh_hash=ANY($1::bytea[]) AND s.revoked_at IS NULL AND s.expires_at>now() AND s.user_session_version=u.session_version
 LIMIT 2`, hashes)
	if err != nil {
		return application.BrowserHead{}, err
	}
	defer rows.Close()
	var head application.BrowserHead
	count := 0
	for rows.Next() {
		count++
		if err := rows.Scan(&head.BrowserID, &head.Generation, &head.RefreshHash); err != nil {
			return application.BrowserHead{}, err
		}
	}
	if err := rows.Err(); err != nil {
		return application.BrowserHead{}, err
	}
	if count == 0 {
		return application.BrowserHead{}, application.ErrNoLiveBrowserHead
	}
	if count != 1 {
		return application.BrowserHead{}, application.ErrRefreshToken
	}
	return head, nil
}
