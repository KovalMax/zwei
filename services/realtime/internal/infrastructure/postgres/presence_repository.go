package postgres

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PresenceRepository struct{ db *pgxpool.Pool }

func NewPresenceRepository(db *pgxpool.Pool) *PresenceRepository { return &PresenceRepository{db: db} }

func (r *PresenceRepository) PeerIDs(ctx context.Context, userID uuid.UUID) ([]uuid.UUID, error) {
	rows, err := r.db.Query(ctx, `
		SELECT DISTINCT peers.peer_id
		FROM (
			SELECT CASE WHEN c.user_low_id = $1 THEN c.user_high_id ELSE c.user_low_id END AS peer_id
			FROM conversations c
			WHERE c.kind = 'direct' AND (c.user_low_id = $1 OR c.user_high_id = $1)

			UNION ALL

			SELECT peer.user_id AS peer_id
			FROM conversations c
			JOIN conversation_members requester
				ON requester.conversation_id = c.id AND requester.user_id = $1 AND requester.active
			JOIN conversation_members peer
				ON peer.conversation_id = c.id AND peer.active AND peer.user_id <> $1
			WHERE c.kind = 'group'
		) peers
		WHERE peers.peer_id <> $1`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	peers := make([]uuid.UUID, 0)
	for rows.Next() {
		var peerID uuid.UUID
		if err := rows.Scan(&peerID); err != nil {
			return nil, err
		}
		peers = append(peers, peerID)
	}
	return peers, rows.Err()
}

func (r *PresenceRepository) RecipientID(ctx context.Context, userID, conversationID uuid.UUID) (uuid.UUID, error) {
	var recipientID uuid.UUID
	err := r.db.QueryRow(ctx, `SELECT CASE WHEN user_low_id = $1 THEN user_high_id ELSE user_low_id END FROM conversations WHERE id = $2 AND (user_low_id = $1 OR user_high_id = $1)`, userID, conversationID).Scan(&recipientID)
	return recipientID, err
}

// ResolveReadRecipients authorizes the reader against the conversation and
// returns active peers for direct and group conversations alike.
func (r *PresenceRepository) ResolveReadRecipients(ctx context.Context, userID, conversationID uuid.UUID) ([]uuid.UUID, error) {
	rows, err := r.db.Query(ctx, `
		WITH authorized_conversation AS (
			SELECT c.id, c.kind, c.user_low_id, c.user_high_id
			FROM conversations c
			WHERE c.id = $2 AND (
				(c.kind = 'direct' AND (c.user_low_id = $1 OR c.user_high_id = $1)) OR
				(c.kind = 'group' AND EXISTS (
					SELECT 1 FROM conversation_members reader
					WHERE reader.conversation_id = c.id AND reader.user_id = $1 AND reader.active
				))
			)
		)
		SELECT true, peers.peer_id
		FROM authorized_conversation c
		LEFT JOIN LATERAL (
			SELECT CASE WHEN c.user_low_id = $1 THEN c.user_high_id ELSE c.user_low_id END AS peer_id
			WHERE c.kind = 'direct'
			UNION ALL
			SELECT peer.user_id AS peer_id
			FROM conversation_members peer
			WHERE c.kind = 'group' AND peer.conversation_id = c.id AND peer.active AND peer.user_id <> $1
		) peers ON true`, userID, conversationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	peerIDs := make([]uuid.UUID, 0)
	rowsAuthorized := false
	for rows.Next() {
		var authorized bool
		var peerID pgtype.UUID
		if err := rows.Scan(&authorized, &peerID); err != nil {
			return nil, err
		}
		rowsAuthorized = rowsAuthorized || authorized
		if peerID.Valid {
			peerIDs = append(peerIDs, peerID.Bytes)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if !rowsAuthorized {
		return nil, pgx.ErrNoRows
	}
	return peerIDs, nil
}

// ResolveTypingRecipients shares the conversation authorization and active
// membership rules with read-cursor fanout, without exposing that broader
// repository capability to the realtime application port.
func (r *PresenceRepository) ResolveTypingRecipients(ctx context.Context, userID, conversationID uuid.UUID) ([]uuid.UUID, error) {
	return r.ResolveReadRecipients(ctx, userID, conversationID)
}
