package postgres

import (
	"context"
	"crypto/sha256"
	"errors"
	"time"

	"github.com/KovalMax/zwei/services/auth/internal/application"
	"github.com/KovalMax/zwei/services/auth/internal/domain/user"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (r *Repository) RegisterBrowserInvitation(ctx context.Context, p application.CreateUserParams, current *application.BrowserCredential, browser, generation uuid.UUID, hash []byte, expires time.Time, issue func(user.Session) error) error {
	if browser == uuid.Nil || generation == uuid.Nil || len(hash) != 32 || len(p.InvitationCode) != 32 || issue == nil || (current != nil && (current.BrowserID != browser || current.Generation == uuid.Nil || current.Generation == generation || current.RefreshToken == "" || len(current.RefreshToken) > 4096)) {
		return application.ErrInvalidInput
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var oldHash [32]byte
	if current != nil {
		oldHash = sha256.Sum256([]byte(current.RefreshToken))
		var owner uuid.UUID
		err = tx.QueryRow(ctx, `SELECT u.id FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.refresh_token_hash=$1 FOR UPDATE OF u`, oldHash[:]).Scan(&owner)
		if errors.Is(err, pgx.ErrNoRows) {
			return application.ErrRefreshToken
		}
		if err != nil {
			return err
		}
		if err = lockCurrentBrowserHead(ctx, tx, browser, current.Generation, owner, oldHash[:]); err != nil {
			return err
		}
	}
	var invitation uuid.UUID
	err = tx.QueryRow(ctx, `SELECT id FROM invitation_codes WHERE email=$1 AND code_hash=$2 AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at>now() FOR UPDATE`, p.Email, p.InvitationCode).Scan(&invitation)
	if errors.Is(err, pgx.ErrNoRows) {
		return application.ErrInvitationInvalid
	}
	if err != nil {
		return err
	}
	var userID uuid.UUID
	if err = tx.QueryRow(ctx, `INSERT INTO users (email,password_hash,display_name,kyc_status,email_verified_at) VALUES ($1,$2,$3,$4,now()) RETURNING id`, p.Email, p.PasswordHash, p.DisplayName, user.KYCActive).Scan(&userID); err != nil {
		return err
	}
	device, err := ensureDevice(ctx, tx, userID, p.ClientDeviceID, p.DeviceName)
	if err != nil {
		return err
	}
	var session user.Session
	err = tx.QueryRow(ctx, `INSERT INTO sessions (user_id,device_id,refresh_token_hash,user_session_version,expires_at) VALUES ($1,$2,$3,1,$4) RETURNING id,user_id,device_id,user_session_version`, userID, device, hash, expires).Scan(&session.ID, &session.UserID, &session.DeviceID, &session.SessionVersion)
	if err != nil {
		return err
	}
	if current == nil {
		_, err = tx.Exec(ctx, `INSERT INTO browser_auth_heads (browser_id,generation,user_id,current_refresh_hash) VALUES ($1,$2,$3,$4)`, browser, generation, userID, hash)
	} else {
		_, err = tx.Exec(ctx, `UPDATE sessions SET revoked_at=now(),last_used_at=now() WHERE refresh_token_hash=$1`, oldHash[:])
		if err == nil {
			_, err = tx.Exec(ctx, `UPDATE browser_auth_heads SET generation=$2,user_id=$3,current_refresh_hash=$4,updated_at=now() WHERE browser_id=$1`, browser, generation, userID, hash)
		}
	}
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE invitation_codes SET redeemed_at=now() WHERE id=$1`, invitation); err != nil {
		return err
	}
	if err = issue(session); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
