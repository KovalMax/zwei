package httptransport

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"time"

	"github.com/google/uuid"

	"github.com/KovalMax/zwei/services/chat/internal/application"
)

const maxGroupCursorLength = 512

type groupCursorWire struct {
	Version int              `json:"v"`
	Upper   groupSortKeyWire `json:"upper"`
	After   groupSortKeyWire `json:"after"`
}

type groupSortKeyWire struct {
	SortAt  string `json:"sort_at"`
	GroupID string `json:"group_id"`
}

func parseGroupPageQuery(rawQuery string) (int, *application.GroupPageCursor, error) {
	values, err := url.ParseQuery(rawQuery)
	if err != nil {
		return 0, nil, application.ErrInvalidGroupPage
	}
	limit := application.DefaultGroupPageLimit
	if raw, present := values["limit"]; present {
		if len(raw) != 1 || raw[0] == "" {
			return 0, nil, application.ErrInvalidGroupPage
		}
		limit = 0
		for _, digit := range raw[0] {
			if digit < '0' || digit > '9' {
				return 0, nil, application.ErrInvalidGroupPage
			}
			limit = limit*10 + int(digit-'0')
			if limit > application.MaxGroupPageLimit {
				return 0, nil, application.ErrInvalidGroupPage
			}
		}
		if limit == 0 {
			return 0, nil, application.ErrInvalidGroupPage
		}
	}
	var cursor *application.GroupPageCursor
	if raw, present := values["cursor"]; present {
		if len(raw) != 1 || raw[0] == "" || len(raw[0]) > maxGroupCursorLength {
			return 0, nil, application.ErrInvalidGroupPage
		}
		cursor, err = decodeGroupCursor(raw[0])
		if err != nil {
			return 0, nil, application.ErrInvalidGroupPage
		}
	}
	return limit, cursor, nil
}

func decodeGroupCursor(value string) (*application.GroupPageCursor, error) {
	data, err := base64.RawURLEncoding.Strict().DecodeString(value)
	if err != nil || len(data) == 0 || len(data) > maxGroupCursorLength || base64.RawURLEncoding.EncodeToString(data) != value {
		return nil, errors.New("invalid cursor")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var wire groupCursorWire
	if err := decoder.Decode(&wire); err != nil {
		return nil, err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return nil, errors.New("trailing cursor data")
	}
	if wire.Version != 1 {
		return nil, errors.New("unsupported cursor version")
	}
	upper, err := decodeGroupSortKey(wire.Upper)
	if err != nil {
		return nil, err
	}
	after, err := decodeGroupSortKey(wire.After)
	if err != nil {
		return nil, err
	}
	cursor := &application.GroupPageCursor{Upper: upper, After: after}
	if err := application.ValidateGroupPageCursor(cursor); err != nil {
		return nil, err
	}
	canonical, err := json.Marshal(groupCursorWire{Version: 1, Upper: encodeGroupSortKey(upper), After: encodeGroupSortKey(after)})
	if err != nil || !bytes.Equal(canonical, data) {
		return nil, errors.New("non-canonical cursor")
	}
	return cursor, nil
}

func decodeGroupSortKey(wire groupSortKeyWire) (application.GroupSortKey, error) {
	at, err := time.Parse(time.RFC3339Nano, wire.SortAt)
	if err != nil {
		return application.GroupSortKey{}, err
	}
	id, err := uuid.Parse(wire.GroupID)
	if err != nil || id.String() != wire.GroupID {
		return application.GroupSortKey{}, errors.New("invalid group ID")
	}
	return application.GroupSortKey{SortAt: at.UTC(), GroupID: id}, nil
}

func encodeGroupCursor(cursor application.GroupPageCursor) (string, error) {
	wire := groupCursorWire{Version: 1, Upper: encodeGroupSortKey(cursor.Upper), After: encodeGroupSortKey(cursor.After)}
	data, err := json.Marshal(wire)
	if err != nil {
		return "", err
	}
	encoded := base64.RawURLEncoding.EncodeToString(data)
	if len(encoded) > maxGroupCursorLength {
		return "", errors.New("group cursor too large")
	}
	return encoded, nil
}

func encodeGroupSortKey(key application.GroupSortKey) groupSortKeyWire {
	return groupSortKeyWire{SortAt: key.SortAt.UTC().Format(time.RFC3339Nano), GroupID: key.GroupID.String()}
}
