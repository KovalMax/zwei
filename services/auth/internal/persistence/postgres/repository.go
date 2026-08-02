package postgres

import (
	"context"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/maxkoval/p2p-webchat/services/auth/internal/domain/user"
)

type Repository struct{ db *pgxpool.Pool }

func NewRepository(db *pgxpool.Pool) *Repository { return &Repository{db: db} }

func (r *Repository) CreateUserWithDevice(ctx context.Context, email, passwordHash, displayName, clientDeviceID, deviceName string) (uuid.UUID, uuid.UUID, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	defer tx.Rollback(ctx)
	var userID uuid.UUID
	if err = tx.QueryRow(ctx, `INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id`, email, passwordHash, displayName).Scan(&userID); err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	deviceID, err := ensureDevice(ctx, tx, userID, clientDeviceID, deviceName)
	if err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	return userID, deviceID, nil
}

func (r *Repository) FindUserByEmail(ctx context.Context, email string) (user.User, error) {
	var result user.User
	err := r.db.QueryRow(ctx, `SELECT id, password_hash, session_version FROM users WHERE email = $1`, email).Scan(&result.ID, &result.PasswordHash, &result.SessionVersion)
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
