package httptransport

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/KovalMax/zwei/services/auth/internal/application"
)

func TestRefreshCandidateCookiesBindingAndBounds(t *testing.T) {
	r := httptest.NewRequest("POST", "/", nil)
	name := uniqueRefreshCookieName("new-token")
	r.Header.Add("Cookie", "unrelated=x; zwei_refresh=legacy; "+name+"=new-token")
	cookies, err := refreshCandidateCookies(r)
	if err != nil || len(cookies) != 2 || cookies[0].Name != "zwei_refresh" || cookies[1].Name != name {
		t.Fatalf("candidates = %#v, err %v", cookies, err)
	}
	r.Header.Set("Cookie", name+"=other-token")
	if _, err := refreshCandidateCookies(r); err == nil {
		t.Fatal("accepted mismatched name")
	}
	r.Header.Set("Cookie", "zwei_refresh=a; zwei_refresh=b")
	if _, err := refreshCandidateCookies(r); err == nil {
		t.Fatal("accepted conflicting duplicate name")
	}
	r.Header.Set("Cookie", strings.Repeat("zwei_refresh=a; ", application.MaxRefreshCandidates+1))
	if _, err := refreshCandidateCookies(r); err == nil {
		t.Fatal("accepted too many cookies")
	}
	r.Header.Set("Cookie", "unrelated="+strings.Repeat("x", 17000))
	if _, err := refreshCandidateCookies(r); err == nil {
		t.Fatal("accepted oversized header")
	}
}
