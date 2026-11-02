package httptransport

import (
	"io"
	"net/http"
	"net/http/httptest"
)

func newAllowedAuthRequest(method, target string, body io.Reader) *http.Request {
	request := httptest.NewRequest(method, target, body)
	request.Host = "chat.localhost"
	return request
}
