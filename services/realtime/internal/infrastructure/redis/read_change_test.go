package redis

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
)

func TestReadChangeUsesRecipientList(t *testing.T) {
	peer := uuid.New()
	encoded, err := json.Marshal(ReadChange{RecipientIDs: []uuid.UUID{peer}})
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &fields); err != nil {
		t.Fatal(err)
	}
	if _, ok := fields["recipient_id"]; ok {
		t.Fatal("read change includes obsolete singular recipient")
	}
	var recipients []uuid.UUID
	if err := json.Unmarshal(fields["recipient_ids"], &recipients); err != nil || len(recipients) != 1 || recipients[0] != peer {
		t.Fatalf("recipients = %v, err = %v", recipients, err)
	}
}
