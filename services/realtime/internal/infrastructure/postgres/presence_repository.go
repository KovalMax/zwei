package postgres

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PresenceRepository struct{ db *pgxpool.Pool }

func NewPresenceRepository(db *pgxpool.Pool) *PresenceRepository { return &PresenceRepository{db: db} }

func (r *PresenceRepository) PeerIDs(ctx context.Context, userID uuid.UUID) ([]uuid.UUID, error) {
	rows, err := r.db.Query(ctx, `SELECT user_high_id FROM conversations WHERE user_low_id = $1 UNION ALL SELECT user_low_id FROM conversations WHERE user_high_id = $1`, userID)
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
