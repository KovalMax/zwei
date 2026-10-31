package application

import (
	"bytes"
	"encoding/json"
	"math"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

var groupCandidateLine = regexp.MustCompile(`(?i)^candidate:\S+\s+\d+\s+(udp|tcp)\s+\d+\s+\S+\s+\d+\s+typ\s+(host|srflx|prflx|relay)(\s+.*)?$`)
var groupCandidateUfrag = regexp.MustCompile(`(?:^|\s)ufrag\s+(\S+)`)

// Candidates are opaque beyond the identity needed by the browser's ICE
// generation fence. Never log or retain this data.
func validGroupICECandidate(raw json.RawMessage) bool {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || fields == nil {
		return false
	}
	for key := range fields {
		switch key {
		case "candidate", "sdpMid", "sdpMLineIndex", "usernameFragment":
		default:
			return false
		}
	}
	var candidate struct {
		Candidate        *string  `json:"candidate"`
		SDPMid           *string  `json:"sdpMid"`
		SDPMLineIndex    *float64 `json:"sdpMLineIndex"`
		UsernameFragment *string  `json:"usernameFragment"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&candidate) != nil || candidate.Candidate == nil {
		return false
	}
	line := *candidate.Candidate
	if utf8.RuneCountInString(line) > 4096 || (line != "" && !groupCandidateLine.MatchString(line)) {
		return false
	}
	if candidate.SDPMid == nil && candidate.SDPMLineIndex == nil {
		return false
	}
	if candidate.SDPMid != nil && (*candidate.SDPMid == "" || utf8.RuneCountInString(*candidate.SDPMid) > 256) {
		return false
	}
	if candidate.SDPMLineIndex != nil && (*candidate.SDPMLineIndex < 0 || *candidate.SDPMLineIndex > 65535 || math.Trunc(*candidate.SDPMLineIndex) != *candidate.SDPMLineIndex) {
		return false
	}
	matches := groupCandidateUfrag.FindAllStringSubmatch(line, -1)
	if len(matches) > 1 {
		return false
	}
	embedded := ""
	if len(matches) == 1 {
		embedded = matches[0][1]
		if utf8.RuneCountInString(embedded) > 256 {
			return false
		}
	}
	if candidate.UsernameFragment == nil {
		return embedded != ""
	}
	username := *candidate.UsernameFragment
	return username != "" && utf8.RuneCountInString(username) <= 256 && strings.IndexFunc(username, unicode.IsSpace) < 0 && (embedded == "" || embedded == username)
}
