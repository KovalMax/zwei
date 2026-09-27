package httptransport

import (
	"net/http/httptest"
	"testing"

	"github.com/KovalMax/zwei/services/chat/internal/application"
)

func TestGroupResultMapsSelfOwnershipTransferToStableBadRequest(t *testing.T) {
	response := httptest.NewRecorder()
	if (&Handler{}).groupResult(response, application.ErrSelfOwnershipTransfer) {
		t.Fatal("groupResult returned success for self-transfer error")
	}
	if response.Code != 400 || response.Body.String() != "{\"error\":\"cannot transfer group ownership to yourself\"}\n" {
		t.Fatalf("self-transfer response = %d %q", response.Code, response.Body.String())
	}
}
