package postgres

import (
	"context"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/KovalMax/zwei/services/auth/internal/application"
	"github.com/KovalMax/zwei/services/auth/internal/domain/user"
)

type Repository struct{ db *pgxpool.Pool }

func NewRepository(db *pgxpool.Pool) *Repository { return &Repository{db: db} }

func (r *Repository) CreateUserWithDevice(ctx context.Context, params application.CreateUserParams) (uuid.UUID, uuid.UUID, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	defer tx.Rollback(ctx)
	var userID uuid.UUID
	var invitationID uuid.UUID
	if len(params.InvitationCode) > 0 {
		if err = tx.QueryRow(ctx, `SELECT id FROM invitation_codes WHERE email = $1 AND code_hash = $2 AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > now() FOR UPDATE`, params.Email, params.InvitationCode).Scan(&invitationID); err != nil {
			return uuid.Nil, uuid.Nil, application.ErrInvitationInvalid
		}
	}
	if err = tx.QueryRow(ctx, `INSERT INTO users (email, password_hash, display_name, kyc_status, email_verified_at) VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN now() ELSE NULL END) RETURNING id`, params.Email, params.PasswordHash, params.DisplayName, params.KYCStatus, params.EmailVerified).Scan(&userID); err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	deviceID, err := ensureDevice(ctx, tx, userID, params.ClientDeviceID, params.DeviceName)
	if err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	if invitationID != uuid.Nil {
		if _, err = tx.Exec(ctx, `UPDATE invitation_codes SET redeemed_at = now() WHERE id = $1`, invitationID); err != nil {
			return uuid.Nil, uuid.Nil, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	return userID, deviceID, nil
}

func (r *Repository) FindUserByEmail(ctx context.Context, email string) (user.User, error) {
	var result user.User
	err := r.db.QueryRow(ctx, `SELECT id, password_hash, session_version, kyc_status, is_admin, email_verified_at IS NOT NULL FROM users WHERE email = $1`, email).Scan(&result.ID, &result.PasswordHash, &result.SessionVersion, &result.KYCStatus, &result.IsAdmin, &result.EmailVerified)
	return result, err
}

func (r *Repository) EnsureDevice(ctx context.Context, userID uuid.UUID, clientDeviceID, deviceName string) (uuid.UUID, error) {
	return ensureDevice(ctx, r.db, userID, clientDeviceID, deviceName)
}

func (r *Repository) CreateSession(ctx context.Context, userID, deviceID uuid.UUID, tokenHash []byte, version int64, expiresAt time.Time) error {
	_, err := r.db.Exec(ctx, `INSERT INTO sessions (user_id, device_id, refresh_token_hash, user_session_version, expires_at) VALUES ($1, $2, $3, $4, $5)`, userID, deviceID, tokenHash, version, expiresAt)
	return err
}

func (r *Repository) RotateRefreshToken(ctx context.Context, tokenHash []byte) (user.Session, error) {
	var session user.Session
	err := r.db.QueryRow(ctx, `SELECT s.id, s.user_id, s.device_id, s.user_session_version FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.refresh_token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.session_version = s.user_session_version`, tokenHash).Scan(&session.ID, &session.UserID, &session.DeviceID, &session.SessionVersion)
	if err != nil {
		return user.Session{}, err
	}
	if _, err = r.db.Exec(ctx, `UPDATE sessions SET revoked_at = now(), last_used_at = now() WHERE id = $1`, session.ID); err != nil {
		return user.Session{}, err
	}
	return session, nil
}

func (r *Repository) RevokeAllSessions(ctx context.Context, userID uuid.UUID) error {
	if _, err := r.db.Exec(ctx, `UPDATE users SET session_version = session_version + 1, updated_at = now() WHERE id = $1`, userID); err != nil {
		return err
	}
	_, _ = r.db.Exec(ctx, `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, userID)
	return nil
}

func (r *Repository) Profile(ctx context.Context, userID uuid.UUID) (user.Profile, error) {
	var profile user.Profile
	err := r.db.QueryRow(ctx, `SELECT id, email, display_name, retention_period FROM users WHERE id = $1`, userID).Scan(&profile.ID, &profile.Email, &profile.DisplayName, &profile.RetentionPeriod)
	return profile, err
}

func (r *Repository) UpdateProfile(ctx context.Context, userID uuid.UUID, displayName, retention *string) error {
	_, err := r.db.Exec(ctx, `UPDATE users SET display_name = COALESCE($1, display_name), retention_period = COALESCE($2, retention_period), updated_at = now() WHERE id = $3`, displayName, retention, userID)
	return err
}

func (r *Repository) IsAdmin(ctx context.Context, userID uuid.UUID) (bool, error) {
	var isAdmin bool
	err := r.db.QueryRow(ctx, `SELECT is_admin FROM users WHERE id = $1 AND kyc_status = $2 AND email_verified_at IS NOT NULL`, userID, user.KYCActive).Scan(&isAdmin)
	return isAdmin, err
}

func (r *Repository) ListAdminUsers(ctx context.Context) ([]user.AdminUser, error) {
	rows, err := r.db.Query(ctx, `SELECT id, email, display_name, kyc_status, created_at, email_verified_at IS NOT NULL FROM users ORDER BY created_at DESC, id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	users := make([]user.AdminUser, 0)
	for rows.Next() {
		var account user.AdminUser
		if err := rows.Scan(&account.ID, &account.Email, &account.DisplayName, &account.KYCStatus, &account.CreatedAt, &account.EmailVerified); err != nil {
			return nil, err
		}
		users = append(users, account)
	}
	return users, rows.Err()
}

func (r *Repository) SetKYCStatus(ctx context.Context, userID uuid.UUID, status user.KYCStatus) error {
	if !status.Valid() {
		return application.ErrInvalidInput
	}
	result, err := r.db.Exec(ctx, `UPDATE users SET kyc_status = $1, session_version = session_version + 1, activation_token_hash = NULL, activation_expires_at = NULL, updated_at = now() WHERE id = $2`, status, userID)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	return nil
}

func (r *Repository) PrepareActivation(ctx context.Context, userID uuid.UUID, tokenHash []byte, expiresAt time.Time) (string, string, bool, error) {
	var email, displayName string
	var verified bool
	err := r.db.QueryRow(ctx, `UPDATE users SET kyc_status = $1, session_version = session_version + 1, activation_token_hash = CASE WHEN email_verified_at IS NULL THEN $2::bytea ELSE NULL END, activation_expires_at = CASE WHEN email_verified_at IS NULL THEN $3::timestamptz ELSE NULL END, updated_at = now() WHERE id = $4 RETURNING email, display_name, email_verified_at IS NOT NULL`, user.KYCActive, tokenHash, expiresAt, userID).Scan(&email, &displayName, &verified)
	return email, displayName, verified, err
}

func (r *Repository) VerifyActivation(ctx context.Context, tokenHash []byte, now time.Time) error {
	result, err := r.db.Exec(ctx, `UPDATE users SET email_verified_at = $1, activation_token_hash = NULL, activation_expires_at = NULL, updated_at = $1 WHERE activation_token_hash = $2 AND activation_expires_at > $1 AND kyc_status = $3`, now, tokenHash, user.KYCActive)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return pgx.ErrNoRows
	}
	return nil
}

func (r *Repository) CreateInvitation(ctx context.Context, email string, codeHash []byte, createdBy uuid.UUID, expiresAt time.Time) (user.Invitation, error) {
	var invitation user.Invitation
	err := r.db.QueryRow(ctx, `INSERT INTO invitation_codes (email, code_hash, created_by, expires_at) VALUES ($1, $2, $3, $4) RETURNING id, email, expires_at, redeemed_at, revoked_at, created_at`, email, codeHash, createdBy, expiresAt).Scan(&invitation.ID, &invitation.Email, &invitation.ExpiresAt, &invitation.RedeemedAt, &invitation.RevokedAt, &invitation.CreatedAt)
	return invitation, err
}

func (r *Repository) ListInvitations(ctx context.Context) ([]user.Invitation, error) {
	rows, err := r.db.Query(ctx, `SELECT id, email, expires_at, redeemed_at, revoked_at, created_at FROM invitation_codes ORDER BY created_at DESC, id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]user.Invitation, 0)
	for rows.Next() {
		var item user.Invitation
		if err := rows.Scan(&item.ID, &item.Email, &item.ExpiresAt, &item.RedeemedAt, &item.RevokedAt, &item.CreatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (r *Repository) RevokeInvitation(ctx context.Context, invitationID uuid.UUID) error {
	result, err := r.db.Exec(ctx, `UPDATE invitation_codes SET revoked_at = now() WHERE id = $1 AND redeemed_at IS NULL AND revoked_at IS NULL`, invitationID)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	return nil
}

func (r *Repository) CreateAdmin(ctx context.Context, email, passwordHash, displayName string) error {
	_, err := r.db.Exec(ctx, `INSERT INTO users (email, password_hash, display_name, kyc_status, is_admin, email_verified_at) VALUES ($1, $2, $3, $4, true, now()) ON CONFLICT (email) DO NOTHING`, email, passwordHash, displayName, user.KYCActive)
	return err
}

func ensureDevice(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, userID uuid.UUID, clientID, name string) (uuid.UUID, error) {
	var id uuid.UUID
	err := q.QueryRow(ctx, `INSERT INTO devices (user_id, client_device_id, name, last_seen_at) VALUES ($1, $2, $3, now()) ON CONFLICT (user_id, client_device_id) DO UPDATE SET name = COALESCE(EXCLUDED.name, devices.name), last_seen_at = now(), revoked_at = NULL RETURNING id`, userID, clientID, nullableString(name)).Scan(&id)
	return id, err
}

func nullableString(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return strings.TrimSpace(value)
}
