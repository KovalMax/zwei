package postgres

import (
	"context"
	"crypto/subtle"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/KovalMax/zwei/services/realtime/internal/application"
	"github.com/KovalMax/zwei/services/realtime/internal/application/callpush"
	"github.com/KovalMax/zwei/services/realtime/internal/application/messagepush"
	"github.com/KovalMax/zwei/services/shared/pushcrypto"
)

// EnsurePushFingerprintKeyIdentity atomically claims the shared durable key
// identity on first use and rejects a configured key that differs later.
func EnsurePushFingerprintKeyIdentity(ctx context.Context, db *pgxpool.Pool, codec *pushcrypto.Codec) error {
	keyID := codec.FingerprintKeyID()
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

// CallPushRepository composes authoritative ephemeral state with current
// account policy and encrypted subscriptions. It contains no queue/history.
type CallPushRepository struct {
	db         *pgxpool.Pool
	codec      *pushcrypto.Codec
	vapidKeyID string
	calls      application.CallCoordinator
	rooms      application.GroupRoomCoordinator
	authorizer application.GroupCallAuthorizer
	now        func() time.Time
}

func NewCallPushRepository(db *pgxpool.Pool, codec *pushcrypto.Codec, vapidKeyID string, calls application.CallCoordinator, rooms application.GroupRoomCoordinator, authorizer application.GroupCallAuthorizer, clock ...func() time.Time) *CallPushRepository {
	now := time.Now
	if len(clock) > 0 && clock[0] != nil {
		now = clock[0]
	}
	return &CallPushRepository{db: db, codec: codec, vapidKeyID: vapidKeyID, calls: calls, rooms: rooms, authorizer: authorizer, now: now}
}

func (r *CallPushRepository) Resolve(ctx context.Context, job callpush.Job, recipient uuid.UUID) (string, []messagepush.Subscription, bool, error) {
	if !job.ExpiresAt.After(r.now()) {
		return "", nil, false, nil
	}
	if job.Group {
		if r.rooms == nil || r.authorizer == nil {
			return "", nil, false, errors.New("call state unavailable")
		}
		room, err := r.rooms.GetGroupRoomForConversation(ctx, job.ConversationID)
		if err != nil {
			return "", nil, false, err
		}
		if room.ID != job.CallID || room.ConversationID != job.ConversationID || room.Status != application.GroupRoomRinging || room.MembershipRevision <= 0 || !room.ExpiresAt.Equal(job.ExpiresAt) {
			return "", nil, false, nil
		}
		lease, err := r.authorizer.BeginGroupCall(ctx, job.ConversationID, recipient)
		if err != nil {
			if errors.Is(err, application.ErrCallNotAllowed) {
				return "", nil, false, nil
			}
			return "", nil, false, err
		}
		defer func() {
			rollback, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Second)
			defer cancel()
			_ = lease.Rollback(rollback)
		}()
		if lease.MembershipRevision() != room.MembershipRevision || !containsCallRecipient(lease.ActiveMemberIDs(), recipient) {
			return "", nil, false, nil
		}
	} else {
		if r.calls == nil {
			return "", nil, false, errors.New("call state unavailable")
		}
		call, err := r.calls.Get(ctx, job.CallID)
		if err != nil {
			if errors.Is(err, application.ErrCallNotFound) {
				return "", nil, false, nil
			}
			return "", nil, false, err
		}
		if call.ID != job.CallID || call.ConversationID != job.ConversationID || call.CallerID != job.StarterID || call.RecipientID != recipient || call.Status != application.CallRinging || !call.ExpiresAt.Equal(job.ExpiresAt) {
			return "", nil, false, nil
		}
	}
	var name string
	err := r.db.QueryRow(ctx, `SELECT sender.display_name FROM users sender JOIN users recipient ON recipient.id=$2
		WHERE sender.id=$1 AND recipient.alert_mode='notifications'`, job.StarterID, recipient).Scan(&name)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", nil, false, nil
		}
		return "", nil, false, err
	}
	rows, err := r.db.Query(ctx, `SELECT subscription.id, subscription.encryption_version, subscription.encrypted_subscription, subscription.endpoint_fingerprint
		FROM push_subscriptions subscription JOIN devices device ON device.id=subscription.device_id
		WHERE subscription.user_id=$1 AND device.revoked_at IS NULL AND subscription.vapid_key_id=$2
		ORDER BY subscription.created_at, subscription.id`, recipient, r.vapidKeyID)
	if err != nil {
		return "", nil, false, err
	}
	defer rows.Close()
	subscriptions := make([]messagepush.Subscription, 0)
	for rows.Next() {
		var id uuid.UUID
		var version string
		var encrypted []byte
		var fingerprint []byte
		if err := rows.Scan(&id, &version, &encrypted, &fingerprint); err != nil {
			return "", nil, false, err
		}
		decrypted, err := r.codec.Open(version, encrypted)
		if err != nil {
			return "", nil, false, err
		}
		subscriptions = append(subscriptions, messagepush.Subscription{ID: id, Endpoint: decrypted.Endpoint, P256DH: decrypted.P256DH, Auth: decrypted.Auth, Fingerprint: fingerprint})
	}
	if err := rows.Err(); err != nil {
		return "", nil, false, err
	}
	return name, subscriptions, true, nil
}

func (r *CallPushRepository) DeleteSubscription(ctx context.Context, id uuid.UUID, fingerprint []byte) error {
	_, err := r.db.Exec(ctx, `DELETE FROM push_subscriptions WHERE id=$1 AND endpoint_fingerprint=$2`, id, fingerprint)
	return err
}

func containsCallRecipient(ids []uuid.UUID, id uuid.UUID) bool {
	for _, candidate := range ids {
		if candidate == id {
			return true
		}
	}
	return false
}
