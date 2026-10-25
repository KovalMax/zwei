package postgres

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/KovalMax/zwei/services/realtime/internal/application/messagepush"
	"github.com/KovalMax/zwei/services/shared/pushcrypto"
)

// MessagePushIntent contains identifiers only; message content is never stored
// in the durable notification queue.
type MessagePushIntent = messagepush.Intent

type MessagePushOutbox struct {
	db         *pgxpool.Pool
	codec      *pushcrypto.Codec
	vapidKeyID string
}

func NewMessagePushOutbox(db *pgxpool.Pool, codec *pushcrypto.Codec, vapidKeyID ...string) *MessagePushOutbox {
	r := &MessagePushOutbox{db: db, codec: codec}
	if len(vapidKeyID) > 0 {
		r.vapidKeyID = vapidKeyID[0]
	}
	return r
}

func (r *MessagePushOutbox) Claim(ctx context.Context, limit int) ([]MessagePushIntent, error) {
	if limit < 1 || limit > 100 {
		return nil, nil
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `WITH expired AS (
		SELECT id FROM message_push_outbox
		WHERE processed_at IS NULL AND expires_at <= now()
		  AND (claim_expires_at IS NULL OR claim_expires_at <= now())
		ORDER BY expires_at, id FOR UPDATE SKIP LOCKED LIMIT 100
	)
	UPDATE message_push_outbox event SET processed_at = now(), claim_token = NULL, claim_expires_at = NULL
	FROM expired WHERE event.id = expired.id`); err != nil {
		return nil, err
	}
	token := uuid.New()
	rows, err := tx.Query(ctx, `WITH claimable AS (
		SELECT id FROM message_push_outbox
		WHERE processed_at IS NULL AND expires_at > now() AND attempt_count < 12
		  AND next_attempt_at <= now()
		  AND (claim_expires_at IS NULL OR claim_expires_at <= now())
		ORDER BY next_attempt_at, created_at, id
		FOR UPDATE SKIP LOCKED LIMIT $1
	)
	UPDATE message_push_outbox event
	SET claim_token = $2, claim_expires_at = now() + interval '45 seconds'
	FROM claimable WHERE event.id = claimable.id
	RETURNING event.id, event.message_id, event.conversation_id, event.sender_id,
	 event.recipient_id, event.expires_at, event.attempt_count`, limit, token)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	events := make([]MessagePushIntent, 0)
	for rows.Next() {
		var event MessagePushIntent
		if err := rows.Scan(&event.ID, &event.MessageID, &event.ConversationID, &event.SenderID,
			&event.RecipientID, &event.ExpiresAt, &event.AttemptCount); err != nil {
			return nil, err
		}
		event.ClaimToken = token
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return events, nil
}

// PurgeProcessed removes only terminal outbox rows older than the retention
// period. The batch is selected with SKIP LOCKED so concurrent dispatchers do
// not contend, and unprocessed claims are never eligible for deletion.
func (r *MessagePushOutbox) PurgeProcessed(ctx context.Context, limit int) error {
	if limit < 1 || limit > 100 {
		return nil
	}
	_, err := r.db.Exec(ctx, `WITH expired AS (
		SELECT id FROM message_push_outbox
		WHERE processed_at IS NOT NULL AND processed_at < now() - interval '30 days'
		  AND (claim_token IS NULL OR claim_expires_at <= now())
		ORDER BY processed_at, id
		FOR UPDATE SKIP LOCKED
		LIMIT $1
	)
	DELETE FROM message_push_outbox event USING expired WHERE event.id = expired.id`, limit)
	return err
}

func (r *MessagePushOutbox) Resolve(ctx context.Context, event messagepush.Intent) (string, []messagepush.Subscription, bool, error) {
	var name string
	var eligible bool
	err := r.db.QueryRow(ctx, `SELECT sender.display_name,
		(m.expires_at IS NULL OR m.expires_at > now())
		AND recipient.alert_mode = 'notifications'
		AND $5::timestamptz > now()
		AND EXISTS (SELECT 1 FROM conversation_members member
			WHERE member.conversation_id = m.conversation_id AND member.user_id = $2
			  AND member.active AND m.sequence >= member.visible_from_sequence)
		FROM messages m JOIN users sender ON sender.id = m.sender_id
		JOIN users recipient ON recipient.id = $2
		WHERE m.id = $1 AND m.conversation_id = $3 AND m.sender_id = $4`, event.MessageID, event.RecipientID, event.ConversationID, event.SenderID, event.ExpiresAt).Scan(&name, &eligible)
	if err != nil {
		return "", nil, false, err
	}
	if !eligible {
		return name, nil, false, nil
	}
	rows, err := r.db.Query(ctx, `SELECT subscription.id, subscription.encryption_version, subscription.encrypted_subscription, subscription.endpoint_fingerprint
		FROM push_subscriptions subscription JOIN devices device ON device.id = subscription.device_id
		WHERE subscription.user_id = $1 AND device.revoked_at IS NULL AND subscription.vapid_key_id = $2 ORDER BY subscription.created_at, subscription.id`, event.RecipientID, r.vapidKeyID)
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

func (r *MessagePushOutbox) DeleteSubscription(ctx context.Context, id uuid.UUID, fingerprint []byte) error {
	_, err := r.db.Exec(ctx, `DELETE FROM push_subscriptions WHERE id = $1 AND endpoint_fingerprint = $2`, id, fingerprint)
	return err
}

func (r *MessagePushOutbox) Complete(ctx context.Context, event messagepush.Intent) error {
	_, err := r.db.Exec(ctx, `UPDATE message_push_outbox SET processed_at = now(), claim_token = NULL, claim_expires_at = NULL
		WHERE id = $1 AND claim_token = $2 AND processed_at IS NULL`, event.ID, event.ClaimToken)
	return err
}

// Retry releases only the current claim, and permanently completes work at its
// bounded attempt or expiry limit. The database computes a capped backoff.
func (r *MessagePushOutbox) Retry(ctx context.Context, event messagepush.Intent) error {
	_, err := r.db.Exec(ctx, `UPDATE message_push_outbox
		SET attempt_count = attempt_count + 1,
		    processed_at = CASE WHEN attempt_count + 1 >= 12 OR expires_at <= now() THEN now() ELSE NULL END,
		    next_attempt_at = LEAST(expires_at, now() + LEAST(interval '1 hour', interval '5 seconds' * power(2, LEAST(attempt_count, 9)))),
		    claim_token = NULL, claim_expires_at = NULL
		WHERE id = $1 AND claim_token = $2 AND processed_at IS NULL`, event.ID, event.ClaimToken)
	return err
}

func (r *MessagePushOutbox) Drop(ctx context.Context, event messagepush.Intent) error {
	return r.Complete(ctx, event)
}
