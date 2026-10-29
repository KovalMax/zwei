package postgres

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/KovalMax/zwei/services/auth/internal/application"
	"github.com/KovalMax/zwei/services/auth/internal/domain/user"
)

var _ application.BrowserSessionRepository = (*Repository)(nil)

// These unwired methods implement the persistence boundary only. All operations
// acquire the user row before the browser head, matching account revocation.
// Browser IDs and generations are selectors, not authorization credentials.
func (r *Repository) CreateBrowserSession(ctx context.Context, browser, generation, userID, deviceID uuid.UUID, hash []byte, version int64, expires time.Time, issue func(user.Session) error) error {
	if browser == uuid.Nil || generation == uuid.Nil || userID == uuid.Nil || deviceID == uuid.Nil || len(hash) != 32 || issue == nil {
		return application.ErrInvalidInput
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var actual int64
	err = tx.QueryRow(ctx, `SELECT session_version FROM users WHERE id=$1 FOR UPDATE`, userID).Scan(&actual)
	if errors.Is(err, pgx.ErrNoRows) {
		return application.ErrRefreshToken
	}
	if err != nil {
		return err
	}
	if actual != version {
		return application.ErrRefreshToken
	}
	var session user.Session
	err = tx.QueryRow(ctx, `INSERT INTO sessions (user_id, device_id, refresh_token_hash, user_session_version, expires_at)
        SELECT $1, d.id, $3, $4, $5 FROM devices d WHERE d.id=$2 AND d.user_id=$1 AND d.revoked_at IS NULL
        RETURNING id, user_id, device_id, user_session_version`, userID, deviceID, hash, version, expires).Scan(&session.ID, &session.UserID, &session.DeviceID, &session.SessionVersion)
	if errors.Is(err, pgx.ErrNoRows) {
		return application.ErrRefreshToken
	}
	if err != nil {
		return err
	}
	result, err := tx.Exec(ctx, `INSERT INTO browser_auth_heads (browser_id, generation, user_id, current_refresh_hash) VALUES ($1,$2,$3,$4) ON CONFLICT (browser_id) DO NOTHING`, browser, generation, userID, hash)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return application.ErrRefreshToken
	}
	if err = issue(session); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *Repository) RotateBrowserSession(ctx context.Context, browser, generation uuid.UUID, hash, next []byte, expires time.Time, issue func(user.Session) error) error {
	if browser == uuid.Nil || generation == uuid.Nil || len(hash) != 32 || len(next) != 32 || issue == nil {
		return application.ErrInvalidInput
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var id uuid.UUID
	err = tx.QueryRow(ctx, `SELECT u.id FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.refresh_token_hash=$1 FOR UPDATE OF u`, hash).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return application.ErrRefreshToken
	}
	if err != nil {
		return err
	}
	var found bool
	err = tx.QueryRow(ctx, `SELECT true FROM browser_auth_heads WHERE browser_id=$1 AND generation=$2 AND user_id=$3 AND current_refresh_hash=$4 FOR UPDATE`, browser, generation, id, hash).Scan(&found)
	if errors.Is(err, pgx.ErrNoRows) {
		return application.ErrRefreshToken
	}
	if err != nil {
		return err
	}
	var session user.Session
	err = tx.QueryRow(ctx, `UPDATE sessions s SET revoked_at=now(), last_used_at=now() FROM users u WHERE s.refresh_token_hash=$1 AND s.user_id=u.id AND s.revoked_at IS NULL AND s.expires_at>now() AND s.user_session_version=u.session_version RETURNING s.id,s.user_id,s.device_id,s.user_session_version`, hash).Scan(&session.ID, &session.UserID, &session.DeviceID, &session.SessionVersion)
	if errors.Is(err, pgx.ErrNoRows) {
		return application.ErrRefreshToken
	}
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO sessions (user_id,device_id,refresh_token_hash,user_session_version,expires_at) VALUES ($1,$2,$3,$4,$5)`, session.UserID, session.DeviceID, next, session.SessionVersion, expires)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE browser_auth_heads SET current_refresh_hash=$2, updated_at=now() WHERE browser_id=$1`, browser, next)
	if err != nil {
		return err
	}
	if err = issue(session); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ReplaceBrowserSession requires the currently live credential; the selector
// alone can never replace another browser's head. Both accounts are locked in
// UUID order before the head and the credential is revalidated under the locks.
func (r *Repository) ReplaceBrowserSession(ctx context.Context, browser, expectedGeneration uuid.UUID, currentHash []byte, generation, userID, deviceID uuid.UUID, hash []byte, version int64, expires time.Time, issue func(user.Session) error) error {
	if browser == uuid.Nil || expectedGeneration == uuid.Nil || generation == uuid.Nil || generation == expectedGeneration || userID == uuid.Nil || deviceID == uuid.Nil || len(currentHash) != 32 || len(hash) != 32 || issue == nil {
		return application.ErrInvalidInput
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var owner uuid.UUID
	err = tx.QueryRow(ctx, `SELECT user_id FROM sessions WHERE refresh_token_hash=$1`, currentHash).Scan(&owner)
	if errors.Is(err, pgx.ErrNoRows) {
		return application.ErrRefreshToken
	}
	if err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `SELECT id, session_version FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`, []uuid.UUID{owner, userID})
	if err != nil {
		return err
	}
	var foundOwner, foundNew bool
	var actual int64
	for rows.Next() {
		var id uuid.UUID
		var v int64
		if err = rows.Scan(&id, &v); err != nil {
			rows.Close()
			return err
		}
		if id == owner {
			foundOwner = true
		}
		if id == userID {
			foundNew = true
			actual = v
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if !foundOwner || !foundNew || actual != version {
		return application.ErrRefreshToken
	}
	if err = lockCurrentBrowserHead(ctx, tx, browser, expectedGeneration, owner, currentHash); err != nil {
		return err
	}
	// The validated old session identifies the only registration being retired.
	// The account lock also serializes this deletion with push enrollment.
	if _, err = tx.Exec(ctx, `DELETE FROM push_subscriptions WHERE user_id=$1 AND device_id=(SELECT device_id FROM sessions WHERE user_id=$1 AND refresh_token_hash=$2)`, owner, currentHash); err != nil {
		return err
	}
	var session user.Session
	err = tx.QueryRow(ctx, `INSERT INTO sessions (user_id,device_id,refresh_token_hash,user_session_version,expires_at)
		SELECT $1,d.id,$3,$4,$5 FROM devices d WHERE d.id=$2 AND d.user_id=$1 AND d.revoked_at IS NULL
		RETURNING id,user_id,device_id,user_session_version`, userID, deviceID, hash, version, expires).Scan(&session.ID, &session.UserID, &session.DeviceID, &session.SessionVersion)
	if errors.Is(err, pgx.ErrNoRows) {
		return application.ErrRefreshToken
	}
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE sessions SET revoked_at=now(), last_used_at=now() WHERE refresh_token_hash=$1`, currentHash)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE browser_auth_heads SET generation=$2,user_id=$3,current_refresh_hash=$4,updated_at=now() WHERE browser_id=$1`, browser, generation, userID, hash)
	if err != nil {
		return err
	}
	if err = issue(session); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Caller must first lock the relevant user row. This also rejects a credential
// invalidated by expiry, account-wide revocation, or a concurrent rotation.
func lockCurrentBrowserHead(ctx context.Context, tx pgx.Tx, browser, generation, userID uuid.UUID, hash []byte) error {
	var found bool
	err := tx.QueryRow(ctx, `SELECT true FROM browser_auth_heads h JOIN sessions s ON s.user_id=h.user_id AND s.refresh_token_hash=h.current_refresh_hash JOIN users u ON u.id=s.user_id WHERE h.browser_id=$1 AND h.generation=$2 AND h.user_id=$3 AND h.current_refresh_hash=$4 AND s.revoked_at IS NULL AND s.expires_at>now() AND s.user_session_version=u.session_version FOR UPDATE OF h`, browser, generation, userID, hash).Scan(&found)
	if errors.Is(err, pgx.ErrNoRows) {
		return application.ErrRefreshToken
	}
	return err
}

// Logout revalidates the signed bearer binding under the account and head locks.
// Refresh rotation preserves the generation and must not defeat logout.
func (r *Repository) LogoutBrowserSession(ctx context.Context, browser, generation, userID uuid.UUID, version int64) error {
	return r.logoutBrowserSession(ctx, browser, generation, userID, version, nil, time.Time{})
}

// LogoutBrowserSessionWithReceipt stores a caller-hashed receipt atomically with revocation.
func (r *Repository) LogoutBrowserSessionWithReceipt(ctx context.Context, browser, generation, userID uuid.UUID, version int64, receiptHash []byte, expiresAt time.Time) error {
	if len(receiptHash) != 32 || !expiresAt.After(time.Now()) {
		return application.ErrInvalidInput
	}
	return r.logoutBrowserSession(ctx, browser, generation, userID, version, receiptHash, expiresAt)
}

func (r *Repository) logoutBrowserSession(ctx context.Context, browser, generation, userID uuid.UUID, version int64, receiptHash []byte, expiresAt time.Time) error {
	if browser == uuid.Nil || generation == uuid.Nil || userID == uuid.Nil || version <= 0 {
		return application.ErrInvalidInput
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var locked uuid.UUID
	err = tx.QueryRow(ctx, `SELECT id FROM users WHERE id=$1 AND session_version=$2 FOR UPDATE`, userID, version).Scan(&locked)
	if errors.Is(err, pgx.ErrNoRows) {
		return application.ErrRefreshToken
	}
	if err != nil {
		return err
	}
	var refreshHash []byte
	err = tx.QueryRow(ctx, `SELECT current_refresh_hash FROM browser_auth_heads WHERE browser_id=$1 AND generation=$2 AND user_id=$3 AND current_refresh_hash IS NOT NULL FOR UPDATE`, browser, generation, userID).Scan(&refreshHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return application.ErrRefreshToken
	}
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE users SET session_version=session_version+1, updated_at=now() WHERE id=$1`, userID)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE browser_auth_heads SET user_id=NULL, current_refresh_hash=NULL, updated_at=now() WHERE browser_id=$1 AND generation=$2 AND user_id=$3`, browser, generation, userID)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, userID)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `DELETE FROM push_subscriptions WHERE user_id=$1`, userID)
	if err != nil {
		return err
	}
	if receiptHash != nil {
		if err = insertLogoutReceipt(ctx, tx, receiptHash, browser, generation, userID, expiresAt, refreshHash); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// VerifyBrowserLogoutReceipt performs no session mutation and rejects expired receipts.
func (r *Repository) VerifyBrowserLogoutReceipt(ctx context.Context, browser, generation, userID uuid.UUID, receiptHash []byte) error {
	if browser == uuid.Nil || generation == uuid.Nil || userID == uuid.Nil || len(receiptHash) != 32 {
		return application.ErrInvalidInput
	}
	var found bool
	err := r.db.QueryRow(ctx, `SELECT true FROM browser_logout_receipts WHERE receipt_hash=$1 AND browser_id=$2 AND generation=$3 AND user_id=$4 AND expires_at>now()`, receiptHash, browser, generation, userID).Scan(&found)
	if errors.Is(err, pgx.ErrNoRows) {
		return application.ErrRefreshToken
	}
	return err
}

// LogoutBrowserSessionWithProof revalidates the current, unexpired proof after
// acquiring the account and head locks, before account-wide revocation.
func (r *Repository) LogoutBrowserSessionWithProof(ctx context.Context, browser, generation, userID uuid.UUID, hash []byte) error {
	return r.logoutBrowserSessionWithProof(ctx, browser, generation, userID, hash, nil, time.Time{})
}

func (r *Repository) LogoutBrowserSessionWithProofAndReceipt(ctx context.Context, browser, generation, userID uuid.UUID, hash, receipt []byte, expiresAt time.Time) error {
	if len(receipt) != 32 || !expiresAt.After(time.Now()) {
		return application.ErrInvalidInput
	}
	return r.logoutBrowserSessionWithProof(ctx, browser, generation, userID, hash, receipt, expiresAt)
}

func (r *Repository) logoutBrowserSessionWithProof(ctx context.Context, browser, generation, userID uuid.UUID, hash, receipt []byte, expiresAt time.Time) error {
	if browser == uuid.Nil || generation == uuid.Nil || userID == uuid.Nil || len(hash) != 32 {
		return application.ErrInvalidInput
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var locked uuid.UUID
	err = tx.QueryRow(ctx, `SELECT id FROM users WHERE id=$1 FOR UPDATE`, userID).Scan(&locked)
	if errors.Is(err, pgx.ErrNoRows) {
		return application.ErrRefreshToken
	}
	if err != nil {
		return err
	}
	if err = lockCurrentBrowserHead(ctx, tx, browser, generation, userID, hash); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE users SET session_version=session_version+1, updated_at=now() WHERE id=$1`, userID); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE browser_auth_heads SET user_id=NULL, current_refresh_hash=NULL, updated_at=now() WHERE browser_id=$1 AND generation=$2 AND user_id=$3`, browser, generation, userID); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, userID); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM push_subscriptions WHERE user_id=$1`, userID); err != nil {
		return err
	}
	if receipt != nil {
		if err = insertLogoutReceipt(ctx, tx, receipt, browser, generation, userID, expiresAt, hash); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// Expired receipts are pruned in bounded batches as part of successful writes.
// SKIP LOCKED prevents concurrent logouts from waiting on the same batch.
func insertLogoutReceipt(ctx context.Context, tx pgx.Tx, receipt []byte, browser, generation, userID uuid.UUID, expiresAt time.Time, refreshHash []byte) error {
	if _, err := tx.Exec(ctx, `DELETE FROM browser_logout_receipts WHERE receipt_hash IN (SELECT receipt_hash FROM browser_logout_receipts WHERE expires_at <= now() ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)`); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `INSERT INTO browser_logout_receipts (receipt_hash, browser_id, generation, user_id, expires_at, refresh_hash) VALUES ($1,$2,$3,$4,$5,$6)`, receipt, browser, generation, userID, expiresAt, refreshHash)
	return err
}

func (r *Repository) ReceiptMatchesRefresh(ctx context.Context, browser, generation, userID uuid.UUID, receipt, refresh []byte) (bool, error) {
	var matched bool
	err := r.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM browser_logout_receipts WHERE receipt_hash=$1 AND browser_id=$2 AND generation=$3 AND user_id=$4 AND expires_at>now() AND refresh_hash=$5)`, receipt, browser, generation, userID, refresh).Scan(&matched)
	return matched, err
}
