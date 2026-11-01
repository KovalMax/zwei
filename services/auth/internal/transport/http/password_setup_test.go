package httptransport

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/KovalMax/zwei/services/auth/internal/application"
)

type passwordSetupRepository struct {
	application.Repository
	tokenHash []byte
	password  string
	called    bool
}

func (r *passwordSetupRepository) SetPasswordFromSetup(_ context.Context, tokenHash []byte, password string, _ time.Time) error {
	r.called = true
	r.tokenHash = append([]byte(nil), tokenHash...)
	r.password = password
	return nil
}

type passwordSetupHasher struct{}

func (passwordSetupHasher) Hash(value string) (string, error) { return "hashed:" + value, nil }
func (passwordSetupHasher) Compare(string, string) error      { return nil }

func TestPasswordSetupEndpointConsumesBoundedJSONWithoutSession(t *testing.T) {
	repository := &passwordSetupRepository{}
	auth := application.NewService(repository, passwordSetupHasher{}, nil, time.Minute, time.Hour)
	mux := http.NewServeMux()
	(&Handler{auth: auth}).Register(mux)
	token := strings.Repeat("x", 43)
	request := httptest.NewRequest(http.MethodPost, "/api/auth/activate/setup", strings.NewReader(`{"token":"`+token+`","password":"newpassword"}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["status"] != "password_set" || body["access_token"] != nil || body["refresh_token"] != nil {
		t.Fatalf("setup response=%v", body)
	}
	want := sha256.Sum256([]byte(token))
	if !repository.called || string(repository.tokenHash) != string(want[:]) || repository.password != "hashed:newpassword" {
		t.Fatalf("repository mutation: called=%v hash=%x password=%q", repository.called, repository.tokenHash, repository.password)
	}
}

func TestPasswordSetupEndpointRejectsNonJSONAndOversizedBody(t *testing.T) {
	mux := http.NewServeMux()
	(&Handler{auth: application.NewService(&passwordSetupRepository{}, passwordSetupHasher{}, nil, time.Minute, time.Hour)}).Register(mux)
	for _, test := range []struct {
		name        string
		contentType string
		body        string
		status      int
	}{
		{name: "media type", contentType: "text/plain", body: `{}`, status: http.StatusUnsupportedMediaType},
		{name: "body limit", contentType: "application/json", body: `{"token":"` + strings.Repeat("x", 17<<10) + `","password":"newpassword"}`, status: http.StatusBadRequest},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/api/auth/activate/setup", strings.NewReader(test.body))
			request.Header.Set("Content-Type", test.contentType)
			response := httptest.NewRecorder()
			mux.ServeHTTP(response, request)
			if response.Code != test.status {
				t.Fatalf("status=%d want=%d body=%s", response.Code, test.status, response.Body.String())
			}
		})
	}
}
