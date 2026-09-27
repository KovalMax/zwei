package postgres

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/KovalMax/zwei/services/realtime/internal/application"
)

// GroupCallRepository serializes group-call commands with group membership
// mutations, which take the same conversations row lock.
type GroupCallRepository struct{ db *pgxpool.Pool }

func NewGroupCallRepository(db *pgxpool.Pool) *GroupCallRepository {
	return &GroupCallRepository{db: db}
}

func (r *GroupCallRepository) BeginGroupCall(ctx context.Context, conversationID, userID uuid.UUID) (application.GroupCallLease, error) {
	tx, err := r.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return nil, err
	}
	lease := &groupCallLease{tx: tx}
	var lockedID uuid.UUID
	err = tx.QueryRow(ctx, `SELECT id FROM conversations WHERE id = $1 AND kind = 'group' FOR UPDATE`, conversationID).Scan(&lockedID)
	if err != nil {
		rollbackGroupCallLease(ctx, tx)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, application.ErrCallNotAllowed
		}
		return nil, err
	}
	// This is a fresh READ COMMITTED statement after any lock wait. A revocation
	// committed while we waited is therefore observed before Redis is touched.
	err = tx.QueryRow(ctx, `SELECT c.membership_revision FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id AND m.user_id = $2 AND m.active WHERE c.id = $1 AND c.kind = 'group'`, conversationID, userID).Scan(&lease.revision)
	if err != nil {
		rollbackGroupCallLease(ctx, tx)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, application.ErrCallNotAllowed
		}
		return nil, err
	}
	rows, err := tx.Query(ctx, `SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND active ORDER BY user_id`, conversationID)
	if err != nil {
		rollbackGroupCallLease(ctx, tx)
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var memberID uuid.UUID
		if err := rows.Scan(&memberID); err != nil {
			rollbackGroupCallLease(ctx, tx)
			return nil, err
		}
		lease.memberIDs = append(lease.memberIDs, memberID)
	}
	if err := rows.Err(); err != nil {
		rollbackGroupCallLease(ctx, tx)
		return nil, err
	}
	return lease, nil
}

// GroupMembershipRevision verifies projection fanout without depending on an
// active actor. Membership removals can invalidate that actor before replicas
// consume the outbox event.
func (r *GroupCallRepository) GroupMembershipRevision(ctx context.Context, conversationID uuid.UUID) (int64, error) {
	var revision int64
	err := r.db.QueryRow(ctx, `SELECT membership_revision FROM conversations WHERE id = $1 AND kind = 'group'`, conversationID).Scan(&revision)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, application.ErrCallNotAllowed
	}
	return revision, err
}

func rollbackGroupCallLease(ctx context.Context, tx pgx.Tx) {
	rollbackCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Second)
	defer cancel()
	_ = tx.Rollback(rollbackCtx)
}

type groupCallLease struct {
	tx        pgx.Tx
	revision  int64
	memberIDs []uuid.UUID
}

func (l *groupCallLease) MembershipRevision() int64 { return l.revision }

func (l *groupCallLease) ActiveMemberIDs() []uuid.UUID {
	return append([]uuid.UUID(nil), l.memberIDs...)
}

func (l *groupCallLease) Commit(ctx context.Context) error { return l.tx.Commit(ctx) }

func (l *groupCallLease) Rollback(ctx context.Context) error {
	err := l.tx.Rollback(ctx)
	if errors.Is(err, pgx.ErrTxClosed) {
		return nil
	}
	return err
}

var _ application.GroupCallAuthorizer = (*GroupCallRepository)(nil)
var _ application.GroupProjectionVerifier = (*GroupCallRepository)(nil)
