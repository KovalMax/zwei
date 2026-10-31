package application

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
)

func TestProtocolV3GroupCandidateWhitespacePatterns(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "protocol", "websocket", "v3.json"))
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Defs map[string]struct {
			Properties map[string]struct {
				Pattern string `json:"pattern"`
			} `json:"properties"`
			AllOf []struct {
				AnyOf []struct {
					Properties map[string]struct {
						Pattern string `json:"pattern"`
					} `json:"properties"`
				} `json:"anyOf"`
			} `json:"allOf"`
		} `json:"$defs"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatal(err)
	}
	schema := doc.Defs["groupIceCandidate"]
	patterns := map[string]string{"line": schema.Properties["candidate"].Pattern, "username": schema.Properties["usernameFragment"].Pattern, "embedded": schema.AllOf[1].AnyOf[1].Properties["candidate"].Pattern}
	for _, tc := range []struct {
		name, pattern, value string
		want                 bool
	}{
		{"ascii spaces", "line", "candidate:1 1 udp 1 host 9 typ host", true},
		{"ascii tabs", "line", "candidate:1\t1\tudp\t1\thost\t9\ttyp\thost", true},
		{"nbsp separator", "line", "candidate:1\u00a01 udp 1 host 9 typ host", false},
		{"nbsp token", "line", "candidate:a\u00a0b 1 udp 1 host 9 typ host", true},
		{"line ending newline", "line", "candidate:1 1 udp 1 host 9 typ host\n", true},
		{"line ending newline after tail", "line", "candidate:1 1 udp 1 host 9 typ host tail\n", false},
		{"line carriage-return tail", "line", "candidate:1 1 udp 1 host 9 typ host\r", true},
		{"embedded ascii", "embedded", "x ufrag abc", true},
		{"embedded nbsp separator", "embedded", "x\u00a0ufrag abc", false},
		{"embedded nbsp value", "embedded", "x ufrag\u00a0abc", false},
		{"username ascii", "username", "abc", true},
		{"username nbsp", "username", "a\u00a0b", false},
		{"username next line", "username", "a\u0085b", false},
		{"username trailing newline", "username", "abc\n", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// RE2 lacks lookahead; its $ is a strict end-of-text anchor, matching
			// the contract's ECMAScript (?![\d\D]) end-of-text assertion.
			re, err := regexp.Compile(strings.ReplaceAll(patterns[tc.pattern], `(?![\d\D])`, `$`))
			if err != nil {
				t.Fatal(err)
			}
			if got := re.MatchString(tc.value); got != tc.want {
				t.Fatalf("pattern match = %v, want %v", got, tc.want)
			}
		})
	}
}

// This checks the actual shared contract, not a copy of runtime validation.
// Exact schemas prevent both references and individual constraints drifting.
func TestProtocolV3CallSignalSchemas(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "protocol", "websocket", "v3.json"))
	if err != nil {
		t.Fatal(err)
	}
	var contract struct {
		Client map[string]json.RawMessage `json:"clientEventFieldSchemas"`
		Server map[string]json.RawMessage `json:"serverEventFields"`
		Defs   map[string]json.RawMessage `json:"$defs"`
	}
	if err := json.Unmarshal(data, &contract); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		fields   map[string]json.RawMessage
		key, ref string
	}{
		{contract.Client, "call.signal.payload.signal", "#/$defs/callSignal"},
		{contract.Server, "call.signal.signal", "#/$defs/callSignal"},
		{contract.Client, "group.call.signal.payload.signal", "#/$defs/groupCallSignal"},
		{contract.Server, "group.call.signal.signal", "#/$defs/groupCallSignal"},
	} {
		var ref struct {
			Ref string `json:"$ref"`
		}
		if err := json.Unmarshal(tc.fields[tc.key], &ref); err != nil || ref.Ref != tc.ref {
			t.Errorf("%s reference = %q, want %q (error %v)", tc.key, ref.Ref, tc.ref, err)
		}
	}
	const direct = `{"oneOf":[
		{"type":"object","required":["type","sdp"],"properties":{"type":{"const":"offer"},"sdp":{"type":"string","minLength":1}},"additionalProperties":false},
		{"type":"object","required":["type","sdp"],"properties":{"type":{"const":"answer"},"sdp":{"type":"string","minLength":1}},"additionalProperties":false},
		{"type":"object","required":["type","candidate"],"properties":{"type":{"const":"candidate"},"candidate":{"type":"object"}},"additionalProperties":false},
		{"type":"object","required":["type"],"properties":{"type":{"const":"screen-share-started"}},"additionalProperties":false},
		{"type":"object","required":["type"],"properties":{"type":{"const":"screen-share-stopped"}},"additionalProperties":false}]}`
	const group = `{"oneOf":[
		{"type":"object","required":["type","sdp","negotiation_id"],"properties":{"type":{"enum":["offer","answer"]},"sdp":{"type":"string","minLength":1},"negotiation_id":{"type":"string","format":"uuid","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$","not":{"const":"00000000-0000-0000-0000-000000000000"}}},"additionalProperties":false},
		{"type":"object","required":["type","candidate"],"properties":{"type":{"const":"candidate"},"candidate":{"$ref":"#/$defs/groupIceCandidate"}},"additionalProperties":false},
		{"type":"object","required":["type"],"properties":{"type":{"const":"screen-share-started"}},"additionalProperties":false},
		{"type":"object","required":["type"],"properties":{"type":{"const":"screen-share-stopped"}},"additionalProperties":false}]}`
	for name, expected := range map[string]string{"callSignal": direct, "groupCallSignal": group} {
		var got, want any
		if err := json.Unmarshal(contract.Defs[name], &got); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if err := json.Unmarshal([]byte(expected), &want); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%s schema does not match the v3 signal contract", name)
		}
	}
	const groupCandidate = `{
		"type":"object", "required":["candidate"],
		"properties": {
			"candidate":{"type":"string","maxLength":4096,"pattern":"^(?:|[cC][aA][nN][dD][iI][dD][aA][tT][eE]:[^ \\t\\n\\f\\r]+[ \\t\\n\\f\\r]+\\d+[ \\t\\n\\f\\r]+(?:[uU][dD][pP]|[tT][cC][pP])[ \\t\\n\\f\\r]+\\d+[ \\t\\n\\f\\r]+[^ \\t\\n\\f\\r]+[ \\t\\n\\f\\r]+\\d+[ \\t\\n\\f\\r]+[tT][yY][pP][ \\t\\n\\f\\r]+(?:[hH][oO][sS][tT]|[sS][rR][fF][lL][xX]|[pP][rR][fF][lL][xX]|[rR][eE][lL][aA][yY])(?:[ \\t\\n\\f\\r]+[^\\n]*)?)(?![\\d\\D])"},
			"sdpMid":{"type":["string","null"],"minLength":1,"maxLength":256},
			"sdpMLineIndex":{"type":["integer","null"],"minimum":0,"maximum":65535},
			"usernameFragment":{"type":["string","null"],"minLength":1,"maxLength":256,"pattern":"^[^\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+(?![\\d\\D])"}
		}, "additionalProperties":false,
		"allOf":[
			{"anyOf":[{"required":["sdpMid"],"properties":{"sdpMid":{"type":"string"}}},{"required":["sdpMLineIndex"],"properties":{"sdpMLineIndex":{"type":"integer"}}}]},
			{"anyOf":[{"required":["usernameFragment"],"properties":{"usernameFragment":{"type":"string"}}},{"properties":{"candidate":{"pattern":"(?:^|[ \\t\\n\\f\\r])ufrag[ \\t\\n\\f\\r]+[^ \\t\\n\\f\\r]+"}}}]}
		]}`
	var candidateGot, candidateWant any
	if err := json.Unmarshal(contract.Defs["groupIceCandidate"], &candidateGot); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(groupCandidate), &candidateWant); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(candidateGot, candidateWant) {
		t.Error("group ICE candidate schema does not match the v3 contract")
	}
}

func TestProtocolV3RejectsOlderCommands(t *testing.T) {
	if ProtocolVersion != 3 {
		t.Fatalf("protocol version = %d, want 3", ProtocolVersion)
	}
	hub := NewHub(nil, nil, nil, nil, nil, nil, nil)
	if err := hub.HandleVersion(context.Background(), testClient{}, 3, []byte(`{"version":2,"type":"presence.refresh"}`)); err == nil {
		t.Fatal("v2 command accepted on v3")
	}
}
