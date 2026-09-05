package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/openclaw/openclaw-enterprise/components/runtime-security/openshell"
)

func TestHelpAndInvalidArguments(t *testing.T) {
	for _, args := range [][]string{{"--help"}, {"identity", "check", "--help"}} {
		var out, diagnostic bytes.Buffer
		if code := run(context.Background(), args, strings.NewReader(""), &out, &diagnostic); code != 0 || !strings.Contains(out.String(), "--socket-path") || diagnostic.Len() != 0 {
			t.Fatalf("unexpected help result: %d", code)
		}
	}
	for _, args := range [][]string{nil, {"openshell", "unexpected"}, {"identity", "check"}, {"identity", "check", "--socket-path"},
		{"identity", "check", "--socket-path", "/tmp/agent.sock", "--spiffe-id", "spiffe://example.test/test", "--timeout-ms", "999"},
		{"identity", "check", "--socket-path", "/tmp/agent.sock", "--socket-path", "/tmp/other.sock", "--spiffe-id", "spiffe://example.test/test"},
	} {
		var out, diagnostic bytes.Buffer
		if code := run(context.Background(), args, strings.NewReader(""), &out, &diagnostic); code != 2 || out.Len() != 0 || !strings.Contains(diagnostic.String(), "Invalid") {
			t.Fatalf("unexpected invalid args result: %d", code)
		}
	}
}

func TestMalformedOpenShellWire(t *testing.T) {
	for name, input := range map[string]string{
		"empty": "", "invalid": "{", "null": "null", "array": "[]",
		"oversized":             strings.Repeat(" ", maxWireBytes+1),
		"extra_document":        `{"schemaVersion":1,"operation":"health","gateway":{"endpoint":"127.0.0.1:9"}} {}`,
		"unsupported_version":   `{"schemaVersion":2,"operation":"health","gateway":{"endpoint":"127.0.0.1:9"}}`,
		"unknown_field":         `{"schemaVersion":1,"operation":"health","gateway":{"endpoint":"127.0.0.1:9"},"token":"must-not-echo"}`,
		"duplicate_key":         `{"schemaVersion":1,"operation":"health","operation":"create","gateway":{"endpoint":"127.0.0.1:9"}}`,
		"case_alias":            `{"SchemaVersion":1,"operation":"health","gateway":{"endpoint":"127.0.0.1:9"}}`,
		"unknown_gateway_field": `{"schemaVersion":1,"operation":"health","gateway":{"endpoint":"127.0.0.1:9","token":"must-not-echo"}}`,
		"null_endpoint":         `{"schemaVersion":1,"operation":"health","gateway":{"endpoint":null}}`,
		"null_timeout":          `{"schemaVersion":1,"operation":"health","gateway":{"endpoint":"127.0.0.1:9","requestTimeoutMs":null}}`,
		"extra_health_fields":   `{"schemaVersion":1,"operation":"health","gateway":{"endpoint":"127.0.0.1:9"},"sandbox":null}`,
		"missing_create":        `{"schemaVersion":1,"operation":"create","gateway":{"endpoint":"127.0.0.1:9"}}`,
		"unknown_get_field":     `{"schemaVersion":1,"operation":"get","gateway":{"endpoint":"127.0.0.1:9"},"sandbox":{"name":"a","workspace":"b","spec":{}}}`,
		"nested_duplicate":      `{"schemaVersion":1,"operation":"create","gateway":{"endpoint":"127.0.0.1:9"},"sandbox":{"name":"a","workspace":"b","spec":{"command":[],"command":["must-not-echo"]}}}`,
		"deeply_nested":         `{"schemaVersion":1,"operation":"create","gateway":{"endpoint":"127.0.0.1:9"},"sandbox":{"spec":` + strings.Repeat("[", 129) + "0" + strings.Repeat("]", 129) + "}}",
	} {
		t.Run(name, func(t *testing.T) {
			var out, diagnostic bytes.Buffer
			code := run(context.Background(), []string{"openshell"}, strings.NewReader(input), &out, &diagnostic)
			if code != 1 || diagnostic.Len() != 0 || out.String() != "{\"schemaVersion\":1,\"ok\":false,\"error\":{\"code\":\"invalid_wire_request\"}}\n" {
				t.Fatalf("unexpected malformed response %d %s", code, out.String())
			}
		})
	}
}

func TestInvalidNativeConfigurationIsSanitized(t *testing.T) {
	for _, gateway := range []string{
		`{"endpoint":"https://user:must-not-echo@example.test"}`,
		`{"endpoint":"http://127.0.0.1:9","auth":{"mode":"bearerTokenFile","path":"/must-not-echo"}}`,
		`{"endpoint":"127.0.0.1:9","requestTimeoutMs":9223372036854775807}`,
		`{"endpoint":"127.0.0.1:9","auth":{"mode":"unauthenticated","path":"/must-not-echo"}}`,
	} {
		var out bytes.Buffer
		if code := runOpenShell(context.Background(), strings.NewReader(`{"schemaVersion":1,"operation":"health","gateway":`+gateway+`}`), &out); code != 1 {
			t.Fatalf("unexpected exit %d", code)
		}
		if out.String() != "{\"schemaVersion\":1,\"ok\":false,\"error\":{\"code\":\"invalid_configuration\"}}\n" {
			t.Fatalf("unexpected response: %s", out.String())
		}
	}
}

func TestNativeOutputBound(t *testing.T) {
	var out bytes.Buffer
	code := writeResponse(&out, wireResponse{SchemaVersion: 1, OK: true, Result: &openshell.Sandbox{Name: strings.Repeat("x", maxWireBytes)}})
	if code != 1 || out.Len() > maxWireBytes {
		t.Fatal("oversized output was not bounded")
	}
	var response wireResponse
	if err := json.Unmarshal(out.Bytes(), &response); err != nil || response.Error == nil || response.Error.Code != "response_too_large" {
		t.Fatal("missing bounded response")
	}
}

func TestIdentityFailurePrintsNoSocketOrSPIFFEInput(t *testing.T) {
	var out, diagnostic bytes.Buffer
	code := run(context.Background(), []string{"identity", "check", "--socket-path", "/not-present-must-not-echo/agent.sock", "--spiffe-id", "spiffe://example.test/must-not-echo", "--timeout-ms", "1000"}, strings.NewReader(""), &out, &diagnostic)
	if code != 1 || out.Len() != 0 || strings.Contains(diagnostic.String(), "must-not-echo") || !strings.Contains(diagnostic.String(), "unavailable") {
		t.Fatalf("unsafe identity failure: %d %s", code, diagnostic.String())
	}
}

func TestNativeOutputPipeBackpressureIsBounded(t *testing.T) {
	for _, cancelled := range []bool{true, false} {
		name := "deadline"
		if cancelled {
			name = "cancelled"
		}
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			reader, writer, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			defer reader.Close()
			defer writer.Close()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if cancelled {
				timer := time.AfterFunc(100*time.Millisecond, cancel)
				defer timer.Stop()
			}
			start := time.Now()
			// The real OS pipe is deliberately unread. Its finite capacity forces
			// the production writer to exercise cancellation/output deadlines.
			_, err = (boundedWriter{ctx: ctx, writer: writer}).Write(bytes.Repeat([]byte("x"), maxWireBytes))
			expected, limit := context.DeadlineExceeded, 7*time.Second
			if cancelled {
				expected, limit = context.Canceled, time.Second
			}
			if !errors.Is(err, expected) || time.Since(start) > limit {
				t.Fatalf("output remained blocked: %v", err)
			}
		})
	}
}
