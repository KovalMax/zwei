package application

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/KovalMax/zwei/services/auth/internal/domain/user"
	"github.com/google/uuid"
)

type browserLoginRepository struct {
	fakeRepository
	email                     string
	ensuredUser               uuid.UUID
	deviceName, clientDevice  string
	ensureCalls, sessionCalls int
	findErr, ensureErr        error
}

func (r *browserLoginRepository) FindUserByEmail(_ context.Context, email string) (user.User, error) {
	r.email = email
	return r.account, r.findErr
}
func (r *browserLoginRepository) EnsureDevice(_ context.Context, id uuid.UUID, client, name string) (uuid.UUID, error) {
	r.ensureCalls++
	r.ensuredUser, r.clientDevice, r.deviceName = id, client, name
	return r.deviceID, r.ensureErr
}
func (r *browserLoginRepository) CreateSession(context.Context, uuid.UUID, uuid.UUID, []byte, int64, time.Time) error {
	r.sessionCalls++
	return nil
}

func TestAuthenticateBrowserLogin(t *testing.T) {
	accountID, deviceID := uuid.New(), uuid.New()
	account := user.User{ID: accountID, PasswordHash: "hash", SessionVersion: 7, KYCStatus: user.KYCActive, EmailVerified: true}
	input := Credentials{Email: "  USER@example.test ", Password: "password", DeviceID: "browser-device", DeviceName: "Laptop"}
	repo := &browserLoginRepository{fakeRepository: fakeRepository{account: account, deviceID: deviceID}}
	service := NewService(repo, fakePasswords{}, fakeTokens{}, time.Minute, time.Hour)
	target, err := service.AuthenticateBrowserLogin(context.Background(), input)
	if err != nil || target != (BrowserSessionTarget{UserID: accountID, DeviceID: deviceID, SessionVersion: 7}) {
		t.Fatalf("target = %+v, error = %v", target, err)
	}
	if repo.email != "user@example.test" || repo.ensuredUser != accountID || repo.clientDevice != "browser-device" || repo.deviceName != "Laptop" || repo.sessionCalls != 0 {
		t.Fatalf("unexpected repository calls: %+v", repo)
	}

	storageErr := errors.New("device failure")
	for _, tc := range []struct {
		name                     string
		input                    Credentials
		account                  user.User
		findErr, ensureErr, want error
		ensures                  int
	}{
		{"invalid", Credentials{}, account, nil, nil, ErrInvalidInput, 0},
		{"unknown", input, account, errors.New("not found"), nil, ErrCredentials, 0},
		{"password", Credentials{Email: input.Email, Password: "wrongpassword", DeviceID: "browser-device"}, account, nil, nil, ErrCredentials, 0},
		{"inactive", input, user.User{PasswordHash: "hash", KYCStatus: user.KYCPending}, nil, nil, ErrAccountInactive, 0},
		{"unverified", input, user.User{PasswordHash: "hash", KYCStatus: user.KYCActive}, nil, nil, ErrAccountInactive, 0},
		{"device error", input, account, nil, storageErr, storageErr, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := &browserLoginRepository{fakeRepository: fakeRepository{account: tc.account, deviceID: deviceID}, findErr: tc.findErr, ensureErr: tc.ensureErr}
			target, err := NewService(r, fakePasswords{}, fakeTokens{}, time.Minute, time.Hour).AuthenticateBrowserLogin(context.Background(), tc.input)
			if !errors.Is(err, tc.want) || target != (BrowserSessionTarget{}) || r.ensureCalls != tc.ensures || r.sessionCalls != 0 {
				t.Fatalf("target = %+v, error = %v, ensure = %d, sessions = %d", target, err, r.ensureCalls, r.sessionCalls)
			}
		})
	}
}
