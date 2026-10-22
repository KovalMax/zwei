package user

import "testing"

func TestValidAlertMode(t *testing.T) {
	for _, mode := range []string{"off", "sounds", "notifications"} {
		if !ValidAlertMode(mode) {
			t.Errorf("ValidAlertMode(%q) = false", mode)
		}
	}
	for _, mode := range []string{"", "all", "Sounds", "notification"} {
		if ValidAlertMode(mode) {
			t.Errorf("ValidAlertMode(%q) = true", mode)
		}
	}
}
