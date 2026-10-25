package postgres

import (
	"context"
	"crypto/subtle"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/KovalMax/zwei/services/auth/internal/application"
	"github.com/KovalMax/zwei/services/auth/internal/domain/user"
	"github.com/KovalMax/zwei/services/shared/pushcrypto"
)

type Repository struct {
	db         *pgxpool.Pool
	codec      *pushcrypto.Codec
	vapidKeyID string
}

func NewRepository(db *pgxpool.Pool, codec *pushcrypto.Codec, vapidKeyID ...string) *Repository {
	r := &Repository{db: db, codec: codec}
	if len(vapidKeyID) > 0 {
		r.vapidKeyID = vapidKeyID[0]
	}
	return r
}

// EnsurePushFingerprintKeyIdentity fixes the durable identity of the key used
// to index push endpoints. A mismatch is intentionally generic and never
// includes either key identity.
func (r *Repository) EnsurePushFingerprintKeyIdentity(ctx context.Context) error {
	return ensurePushFingerprintKeyIdentity(ctx, r.db, r.codec.FingerprintKeyID())
}

func ensurePushFingerprintKeyIdentity(ctx context.Context, db interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}, keyID [32]byte) error {
	if _, err := db.Exec(ctx, `INSERT INTO push_fingerprint_key_identity (singleton, key_id) VALUES (true, $1) ON CONFLICT (singleton) DO NOTHING`, keyID[:]); err != nil {
		return errors.New("push fingerprint key identity check failed")
	}
	var stored []byte
	if err := db.QueryRow(ctx, `SELECT key_id FROM push_fingerprint_key_identity WHERE singleton = true`).Scan(&stored); err != nil {
		return errors.New("push fingerprint key identity check failed")
	}
	if len(stored) != len(keyID) || subtle.ConstantTimeCompare(stored, keyID[:]) != 1 {
		return errors.New("push fingerprint key identity mismatch")
	}
	return nil
}

// RekeyPushFingerprintKey is an explicitly destructive operator action. The
// caller must stop every Auth and Realtime replica before invoking it.
func (r *Repository) RekeyPushFingerprintKey(ctx context.Context) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return errors.New("push fingerprint key re-key failed")
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `DELETE FROM push_subscriptions`); err != nil {
		return errors.New("push fingerprint key re-key failed")
	}
	keyID := r.codec.FingerprintKeyID()
	if _, err = tx.Exec(ctx, `INSERT INTO push_fingerprint_key_identity (singleton, key_id) VALUES (true, $1) ON CONFLICT (singleton) DO UPDATE SET key_id = EXCLUDED.key_id`, keyID[:]); err != nil {
		return errors.New("push fingerprint key re-key failed")
	}
	if err = tx.Commit(ctx); err != nil {
		return errors.New("push fingerprint key re-key failed")
	}
	return nil
}

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
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `UPDATE users SET session_version = session_version + 1, updated_at = now() WHERE id = $1`, userID); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, userID); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM push_subscriptions WHERE user_id = $1`, userID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *Repository) StorePushSubscription(ctx context.Context, userID, deviceID uuid.UUID, sessionVersion int64, subscription application.PushSubscription) error {
	version, ciphertext, fingerprint, err := r.codec.Seal(pushcrypto.Subscription{Endpoint: subscription.Endpoint, P256DH: subscription.P256DH, Auth: subscription.Auth})
	if err != nil {
		return err
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := lockPushAccount(ctx, tx, userID, sessionVersion, true); err != nil {
		return err
	}
	if err := validatePushDevice(ctx, tx, userID, deviceID); err != nil {
		return err
	}
	var existing bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM push_subscriptions WHERE user_id = $1 AND device_id = $2)`, userID, deviceID).Scan(&existing); err != nil {
		return err
	}
	if !existing {
		var count int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM push_subscriptions WHERE user_id = $1`, userID).Scan(&count); err != nil {
			return err
		}
		if count >= maxPushSubscriptionsPerAccount {
			return application.ErrPushSubscriptionLimit
		}
	}
	result, err := tx.Exec(ctx, `INSERT INTO push_subscriptions (user_id, device_id, endpoint_fingerprint, encryption_version, encrypted_subscription, vapid_key_id) VALUES ($1, $2, $3, $4, $5, NULLIF($6, '')) ON CONFLICT (device_id) DO UPDATE SET endpoint_fingerprint = EXCLUDED.endpoint_fingerprint, encryption_version = EXCLUDED.encryption_version, encrypted_subscription = EXCLUDED.encrypted_subscription, vapid_key_id = EXCLUDED.vapid_key_id, updated_at = now() WHERE push_subscriptions.user_id = EXCLUDED.user_id AND NOT EXISTS (SELECT 1 FROM push_subscriptions other WHERE other.endpoint_fingerprint = EXCLUDED.endpoint_fingerprint AND other.device_id <> EXCLUDED.device_id)`, userID, deviceID, fingerprint, version, ciphertext, r.vapidKeyID)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return application.ErrPushSubscriptionOwned
		}
		return err
	}
	if result.RowsAffected() != 1 {
		return application.ErrPushSubscriptionOwned
	}
	return tx.Commit(ctx)
}

const maxPushSubscriptionsPerAccount = 20

func (r *Repository) DeletePushSubscription(ctx context.Context, userID, deviceID uuid.UUID, sessionVersion int64, endpoint string) error {
	fingerprint := r.codec.Fingerprint(endpoint)
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := lockPushAccount(ctx, tx, userID, sessionVersion, false); err != nil {
		return err
	}
	if err := validatePushDevice(ctx, tx, userID, deviceID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM push_subscriptions WHERE user_id = $1 AND device_id = $2 AND endpoint_fingerprint = $3`, userID, deviceID, fingerprint); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func lockPushAccount(ctx context.Context, tx pgx.Tx, userID uuid.UUID, sessionVersion int64, requireNotifications bool) error {
	var currentVersion int64
	var alertMode string
	if err := tx.QueryRow(ctx, `SELECT session_version, alert_mode FROM users WHERE id = $1 FOR UPDATE`, userID).Scan(&currentVersion, &alertMode); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return application.ErrPushSessionRevoked
		}
		return err
	}
	if currentVersion != sessionVersion {
		return application.ErrPushSessionRevoked
	}
	if requireNotifications && alertMode != "notifications" {
		return application.ErrPushUnavailable
	}
	return nil
}

func validatePushDevice(ctx context.Context, tx pgx.Tx, userID, deviceID uuid.UUID) error {
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM devices WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL)`, deviceID, userID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return application.ErrPushSessionRevoked
	}
	return nil
}

func (r *Repository) Profile(ctx context.Context, userID uuid.UUID) (user.Profile, error) {
	var profile user.Profile
	err := r.db.QueryRow(ctx, `SELECT id, email, display_name, retention_period, alert_mode, auto_load_approved_media FROM users WHERE id = $1`, userID).Scan(&profile.ID, &profile.Email, &profile.DisplayName, &profile.RetentionPeriod, &profile.AlertMode, &profile.AutoLoadApprovedMedia)
	return profile, err
}
func (r *Repository) UpdateProfile(ctx context.Context, userID uuid.UUID, displayName, retention, alertMode *string, autoLoadApprovedMedia *bool) error {
	_, err := r.db.Exec(ctx, `UPDATE users SET display_name = COALESCE($1, display_name), retention_period = COALESCE($2, retention_period), alert_mode = COALESCE($3, alert_mode), auto_load_approved_media = COALESCE($4, auto_load_approved_media), updated_at = now() WHERE id = $5`, displayName, retention, alertMode, autoLoadApprovedMedia, userID)
	return err
}

func (r *Repository) GiphyEnabled(ctx context.Context) (bool, error) {
	var enabled bool
	err := r.db.QueryRow(ctx, `SELECT enabled FROM media_source_settings WHERE source = 'giphy'`).Scan(&enabled)
	return enabled, err
}

func (r *Repository) SetGiphyEnabled(ctx context.Context, enabled bool) (bool, error) {
	var persisted bool
	err := r.db.QueryRow(ctx, `UPDATE media_source_settings SET enabled = $1, updated_at = now() WHERE source = 'giphy' RETURNING enabled`, enabled).Scan(&persisted)
	return persisted, err
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

func (r *Repository) PrepareActivationEmail(ctx context.Context, userID uuid.UUID, tokenHash []byte, expiresAt time.Time) (string, string, error) {
	var email, displayName string
	err := r.db.QueryRow(ctx, `UPDATE users SET activation_token_hash = $1, activation_expires_at = $2, updated_at = now() WHERE id = $3 AND kyc_status = $4 AND email_verified_at IS NULL RETURNING email, display_name`, tokenHash, expiresAt, userID, user.KYCActive).Scan(&email, &displayName)
	return email, displayName, err
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
