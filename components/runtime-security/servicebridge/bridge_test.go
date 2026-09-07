package servicebridge_test

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/openclaw/openclaw-enterprise/components/runtime-security/servicebridge"
)

// The native library tests use the same actual Workload API and TLS fixture as
// the Node integration. Its controller messages exercise transport custody and
// framing, not registry admission or an invented successful authority factory.
type fixtureProcess struct {
	command  *exec.Cmd
	input    io.WriteCloser
	messages chan map[string]any
	pending  []map[string]any
	ready    map[string]any
	done     chan error
	serial   int
}

func buildFixture(t *testing.T) string {
	t.Helper()
	binary := filepath.Join(t.TempDir(), "runtime-authority-service")
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	build := exec.CommandContext(ctx, "go", "build", "-p=2", "-mod=readonly", "-trimpath", "-buildvcs=false", "-o", binary, "../../tests/fixtures/runtime-authority-service/main.go")
	build.Dir = ".."
	build.Env = append(os.Environ(), "GOTOOLCHAIN=local", "GOPROXY=off", "GOSUMDB=off", "GOMAXPROCS=2")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build real Workload API/TLS fixture: %v\n%s", err, output)
	}
	return binary
}

func startFixture(t *testing.T, binary string) *fixtureProcess {
	t.Helper()
	command := exec.Command(binary)
	command.Env = []string{"TMPDIR=" + os.TempDir()}
	input, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var diagnostics bytes.Buffer
	command.Stderr = &diagnostics
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	f := &fixtureProcess{command: command, input: input, messages: make(chan map[string]any, 64), done: make(chan error, 1)}
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		defer close(f.messages)
		scanner := bufio.NewScanner(output)
		scanner.Buffer(make([]byte, 4096), 262144)
		for scanner.Scan() {
			var value map[string]any
			if json.Unmarshal(scanner.Bytes(), &value) != nil {
				return
			}
			f.messages <- value
		}
	}()
	go func() { <-readDone; f.done <- command.Wait() }()
	t.Cleanup(func() {
		_ = json.NewEncoder(input).Encode(map[string]any{"kind": "shutdown"})
		input.Close()
		select {
		case err := <-f.done:
			if err != nil {
				t.Errorf("fixture failed to join: %v; %s", err, diagnostics.Bytes())
			}
		case <-time.After(3 * time.Second):
			command.Process.Kill()
			<-f.done
			t.Error("fixture required forced termination")
		}
	})
	f.ready = f.next(t, "ready", "")
	return f
}

func (f *fixtureProcess) next(t *testing.T, kind, id string) map[string]any {
	t.Helper()
	match := func(value map[string]any) bool { return value["kind"] == kind && (id == "" || value["id"] == id) }
	for index, value := range f.pending {
		if match(value) {
			f.pending = append(f.pending[:index], f.pending[index+1:]...)
			return value
		}
	}
	timer := time.NewTimer(8 * time.Second)
	defer timer.Stop()
	for {
		select {
		case value, ok := <-f.messages:
			if !ok {
				t.Fatal("fixture closed before expected message")
			}
			if value["kind"] == "fatal" {
				t.Fatal("fixture reported fatal startup/execution failure")
			}
			if match(value) {
				return value
			}
			f.pending = append(f.pending, value)
		case <-timer.C:
			t.Fatalf("fixture did not emit %s", kind)
		}
	}
}

func (f *fixtureProcess) send(t *testing.T, value any) {
	t.Helper()
	if err := json.NewEncoder(f.input).Encode(value); err != nil {
		t.Fatal(err)
	}
}
func (f *fixtureProcess) request(t *testing.T, address string, wire []byte) string {
	t.Helper()
	f.serial++
	id := time.Now().Format("150405.000000000")
	f.send(t, map[string]any{"kind": "request", "id": id, "address": address, "wireBase64": base64.StdEncoding.EncodeToString(wire)})
	return id
}
func (f *fixtureProcess) change(t *testing.T, kind string) {
	t.Helper()
	id := time.Now().Format("150405.000000000")
	f.send(t, map[string]any{"kind": kind, "id": id})
	f.next(t, "changed", id)
}

type bridgeHarness struct {
	fixture  *fixtureProcess
	input    *io.PipeWriter
	output   *io.PipeReader
	cancel   context.CancelFunc
	done     chan error
	readDone chan struct{}
	events   chan servicebridge.Event
	pending  []servicebridge.Event
	boot     servicebridge.Bootstrap
	sequence int64
	finished bool
}

func testDigest(raw []byte) string {
	value := sha256.Sum256(raw)
	return "sha256:" + hex.EncodeToString(value[:])
}

func bootstrap(t *testing.T, f *fixtureProcess) servicebridge.Bootstrap {
	t.Helper()
	profile := profileValue()
	profile.WorkloadAPISocketPath = f.ready["workloadApiSocketPath"].(string)
	profile.OwnSPIFFEID = f.ready["ownSPIFFEId"].(string)
	profile.PeerSPIFFEID = f.ready["peerSPIFFEId"].(string)
	profile.RecipientSPIFFEID = profile.OwnSPIFFEID
	profile.TrustDomain = f.ready["trustDomain"].(string)
	profile.TrustBundleSHA256 = f.ready["trustBundleSha256"].(string)
	raw := jsonBytes(t, profile)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	listener.Close()
	return servicebridge.Bootstrap{SchemaVersion: 1, Kind: "bootstrap", Incarnation: strings.Repeat("a", 32), Sequence: 1,
		ProfileBase64: base64.StdEncoding.EncodeToString(raw), ProfileDigest: testDigest(raw), ConfigurationVersion: 1, ListenAddress: address}
}

func newBridge(t *testing.T, f *fixtureProcess) *bridgeHarness {
	return newBridgeWithPolicy(t, f, "read-operation-only-v1")
}

func newBridgeWithPolicy(t *testing.T, f *fixtureProcess, policy string) *bridgeHarness {
	t.Helper()
	input, writer := io.Pipe()
	reader, output := io.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	h := &bridgeHarness{fixture: f, input: writer, output: reader, cancel: cancel, done: make(chan error, 1), events: make(chan servicebridge.Event, 64), readDone: make(chan struct{}), boot: bootstrap(t, f), sequence: 1}
	if policy == "initial-harness-bind-v1" || policy == "installation-gateway-startup-v1" {
		profileRaw, err := base64.StdEncoding.DecodeString(h.boot.ProfileBase64)
		if err != nil {
			t.Fatal(err)
		}
		var profile servicebridge.Profile
		if err = json.Unmarshal(profileRaw, &profile); err != nil {
			t.Fatal(err)
		}
		profile.OperationPolicy = policy
		profile.TransportProfileRef = "owned-child-stdio-initial-harness-bind-v1"
		if policy == "installation-gateway-startup-v1" {
			profile.TransportProfileRef = "owned-child-stdio-installation-gateway-startup-v1"
		}
		profileRaw = jsonBytes(t, profile)
		h.boot.ProfileBase64, h.boot.ProfileDigest = base64.StdEncoding.EncodeToString(profileRaw), testDigest(profileRaw)
	} else if policy != "read-operation-only-v1" {
		t.Fatal("unknown test transport profile")
	}
	go func() { h.done <- servicebridge.Run(ctx, input, output) }()
	go func() {
		defer close(h.readDone)
		defer close(h.events)
		for {
			raw, err := servicebridge.ReadFrame(reader, servicebridge.MaxFrameBytes)
			if err != nil {
				return
			}
			var event servicebridge.Event
			if json.Unmarshal(raw, &event) != nil {
				return
			}
			h.events <- event
		}
	}()
	t.Cleanup(func() {
		cancel()
		writer.Close()
		reader.Close()
		if !h.finished {
			select {
			case <-h.done:
			case <-time.After(4 * time.Second):
				t.Error("native bridge did not join")
			}
		}
		select {
		case <-h.readDone:
		case <-time.After(time.Second):
			t.Error("event reader did not join")
		}
	})
	if err := servicebridge.WriteFrame(writer, jsonBytes(t, h.boot), servicebridge.MaxFrameBytes); err != nil {
		t.Fatal(err)
	}
	ready := h.next(t, "ready")
	if ready.Sequence != 1 || ready.Incarnation != h.boot.Incarnation || ready.ProfileDigest != h.boot.ProfileDigest || ready.ConfigurationVersion != 1 {
		t.Fatal("ready event lost exact bootstrap binding")
	}
	return h
}

func (h *bridgeHarness) next(t *testing.T, kind string) servicebridge.Event {
	t.Helper()
	for index, value := range h.pending {
		if value.Kind == kind {
			h.pending = append(h.pending[:index], h.pending[index+1:]...)
			return value
		}
	}
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	for {
		select {
		case value, ok := <-h.events:
			if !ok {
				t.Fatalf("native output closed before %s", kind)
			}
			if value.Kind == kind {
				return value
			}
			h.pending = append(h.pending, value)
		case <-timer.C:
			t.Fatalf("native bridge did not emit %s", kind)
		}
	}
}

func (h *bridgeHarness) send(t *testing.T, kind string, event servicebridge.Event, challenge string, payload []byte) {
	t.Helper()
	h.sequence++
	command := servicebridge.Command{SchemaVersion: 1, Kind: kind, Incarnation: h.boot.Incarnation, Sequence: h.sequence,
		ConnectionID: event.ConnectionID, ExchangeID: event.ExchangeID, RequestDigest: event.RequestDigest, Challenge: challenge}
	if payload != nil {
		command.PayloadBase64 = base64.StdEncoding.EncodeToString(payload)
	}
	if err := servicebridge.WriteFrame(h.input, jsonBytes(t, command), servicebridge.MaxFrameBytes); err != nil {
		t.Fatal(err)
	}
}

func (h *bridgeHarness) inspect(t *testing.T, event servicebridge.Event, challenge string) servicebridge.Inspection {
	t.Helper()
	h.send(t, "inspect", event, challenge, nil)
	reply := h.next(t, "inspected")
	if reply.ConnectionID != event.ConnectionID || reply.ExchangeID != event.ExchangeID || reply.RequestDigest != event.RequestDigest || reply.Challenge != challenge || reply.Incarnation != h.boot.Incarnation || reply.ProfileDigest != h.boot.ProfileDigest || reply.ConfigurationVersion != h.boot.ConfigurationVersion {
		t.Fatal("inspection lost original exchange or configuration binding")
	}
	raw, err := base64.StdEncoding.DecodeString(reply.PayloadBase64)
	if err != nil {
		t.Fatal(err)
	}
	var inspection servicebridge.Inspection
	if err := json.Unmarshal(raw, &inspection); err != nil {
		t.Fatal(err)
	}
	return inspection
}

func (h *bridgeHarness) shutdown(t *testing.T) {
	t.Helper()
	h.send(t, "shutdown", servicebridge.Event{}, "", nil)
	select {
	case err := <-h.done:
		h.finished = true
		if err != nil {
			t.Fatalf("native shutdown failed: %v", err)
		}
	case <-time.After(4 * time.Second):
		t.Fatal("native shutdown did not join")
	}
	h.assertReleased(t)
}

func (h *bridgeHarness) assertReleased(t *testing.T) {
	t.Helper()
	listener, err := net.Listen("tcp", h.boot.ListenAddress)
	if err != nil {
		t.Fatal("joined bridge retained its listener")
	}
	listener.Close()
	// The fixture's client Source remains live. Only the native Source's stream
	// must disappear after Run returns; observe the actual gRPC server watchers.
	deadline := time.Now().Add(time.Second)
	for {
		id := time.Now().Format("150405.000000000")
		h.fixture.send(t, map[string]any{"kind": "status", "id": id})
		if h.fixture.next(t, "status", id)["watchers"] == float64(1) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("native Source stream remained after joined shutdown")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func operationRequest(t *testing.T, deadline time.Time) []byte {
	t.Helper()
	return jsonBytes(t, servicebridge.Request{SchemaVersion: 1, Method: "readOperation", Deadline: deadline.UTC().Format("2006-01-02T15:04:05.000Z"), Operation: json.RawMessage(`{"schemaVersion":1,"installationId":"ins_11111111-1111-4111-8111-111111111111","namespaceId":"ns_22222222-2222-4222-8222-222222222222","agentId":"agt_33333333-3333-4333-8333-333333333333","operationRef":"44444444-4444-4444-8444-444444444444","operationKind":"bind","canonicalPayloadDigest":"sha256:1111111111111111111111111111111111111111111111111111111111111111","requestRef":"request/transport-fixture"}`)})
}

func responseBytes(t *testing.T, f *fixtureProcess, id string) []byte {
	t.Helper()
	result := f.next(t, "result", id)
	encoded, _ := result["wireBase64"].(string)
	wire, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatal(err)
	}
	return wire
}

func TestActualNativeBridgeCustodyAndRevocation(t *testing.T) {
	binary := buildFixture(t)
	t.Run("fresh inspections and original request delivery", func(t *testing.T) {
		f := startFixture(t, binary)
		h := newBridge(t, f)
		raw := operationRequest(t, time.Now().Add(2500*time.Millisecond))
		id := f.request(t, h.boot.ListenAddress, rawFrame(raw))
		event := h.next(t, "request")
		original, err := base64.StdEncoding.DecodeString(event.PayloadBase64)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(original, raw) || event.RequestDigest != testDigest(raw) || event.ConnectionID == "" || event.ExchangeID == "" {
			t.Fatal("native ingress failed to retain original bytes and connection")
		}
		for _, challenge := range []string{strings.Repeat("b", 32), strings.Repeat("c", 32)} {
			inspection := h.inspect(t, event, challenge)
			if !inspection.Valid || inspection.OwnSPIFFEID != f.ready["ownSPIFFEId"] || inspection.PeerSPIFFEID != f.ready["peerSPIFFEId"] || inspection.RecipientSPIFFEID != f.ready["ownSPIFFEId"] {
				t.Fatal("fresh inspection did not authenticate actual exact TLS peers")
			}
		}
		// This negative authority result proves transport delivery only. Actual
		// registry admission and retained-history disclosure belong to Node/PG tests.
		result := []byte(`{"schemaVersion":1,"result":"not-visible","reasonCode":"scope-hidden"}`)
		h.send(t, "result", event, "", result)
		h.next(t, "completed")
		h.next(t, "closed")
		if got := responseBytes(t, f, id); !bytes.Equal(got, rawFrame(result)) {
			t.Fatal("result was not written through original TLS connection")
		}
		if h.inspect(t, event, strings.Repeat("d", 32)).Valid {
			t.Fatal("retired connection regained authority")
		}
		h.shutdown(t)
	})
	for _, action := range []string{"withdraw", "rotate-own", "rotate-bundle", "remote close", "cancel"} {
		t.Run(action+" while awaiting a result", func(t *testing.T) {
			f := startFixture(t, binary)
			h := newBridge(t, f)
			raw := operationRequest(t, time.Now().Add(2800*time.Millisecond))
			id := f.request(t, h.boot.ListenAddress, rawFrame(raw))
			event := h.next(t, "request")
			if !h.inspect(t, event, strings.Repeat("b", 32)).Valid {
				t.Fatal("same-harness positive inspection failed")
			}
			switch action {
			case "remote close":
				f.send(t, map[string]any{"kind": "cancel", "id": id})
			case "cancel":
				h.send(t, "cancel", event, "", nil)
			default:
				f.change(t, action)
			}
			if action == "withdraw" || action == "rotate-bundle" {
				// Source withdrawal or a changed admitted bundle retires the whole
				// child, including its listener and native Workload API stream.
				select {
				case err := <-h.done:
					h.finished = true
					if err == nil {
						t.Fatal("invalid current source did not fail closed")
					}
				case <-time.After(2 * time.Second):
					t.Fatal("invalid current source retained the native child")
				}
				if len(responseBytes(t, f, id)) != 0 {
					t.Fatal("withdrawal disclosed bytes")
				}
				h.assertReleased(t)
				return
			}
			h.next(t, "closed")
			if wire := responseBytes(t, f, id); len(wire) != 0 {
				t.Fatal("revoked pending exchange disclosed response bytes")
			}
			if h.inspect(t, event, strings.Repeat("f", 32)).Valid {
				t.Fatal("withdrawn exchange inspection remained valid")
			}
			h.shutdown(t)
		})
	}
	for _, action := range []string{"withdraw", "rotate-bundle"} {
		t.Run(action+" retires idle source and listener", func(t *testing.T) {
			f := startFixture(t, binary)
			h := newBridge(t, f)
			f.change(t, action)
			select {
			case err := <-h.done:
				h.finished = true
				if err == nil {
					t.Fatal("idle invalid source did not fail closed")
				}
			case <-time.After(2 * time.Second):
				t.Fatal("idle invalid source retained native child")
			}
			h.assertReleased(t)
		})
	}
	t.Run("old result cannot select a new connection", func(t *testing.T) {
		f := startFixture(t, binary)
		h := newBridge(t, f)
		firstID := f.request(t, h.boot.ListenAddress, rawFrame(operationRequest(t, time.Now().Add(2*time.Second))))
		first := h.next(t, "request")
		h.send(t, "cancel", first, "", nil)
		h.next(t, "closed")
		if len(responseBytes(t, f, firstID)) != 0 {
			t.Fatal("cancel disclosed bytes")
		}
		secondID := f.request(t, h.boot.ListenAddress, rawFrame(operationRequest(t, time.Now().Add(2*time.Second))))
		second := h.next(t, "request")
		if second.ConnectionID == first.ConnectionID || second.ExchangeID == first.ExchangeID {
			t.Fatal("new exchange reused prior opaque identity")
		}
		h.send(t, "result", first, "", []byte(`{"old":"must-not-appear"}`))
		if !h.inspect(t, second, strings.Repeat("e", 32)).Valid {
			t.Fatal("old negative tombstone corrupted new exchange")
		}
		result := []byte(`{"schemaVersion":1,"result":"not-visible","reasonCode":"scope-hidden"}`)
		h.send(t, "result", second, "", result)
		h.next(t, "completed")
		h.next(t, "closed")
		if got := responseBytes(t, f, secondID); !bytes.Equal(got, rawFrame(result)) {
			t.Fatal("old result was replayed onto another TLS connection")
		}
		h.shutdown(t)
	})
	t.Run("original deadline expires without result renewal", func(t *testing.T) {
		f := startFixture(t, binary)
		h := newBridge(t, f)
		id := f.request(t, h.boot.ListenAddress, rawFrame(operationRequest(t, time.Now().Add(300*time.Millisecond))))
		event := h.next(t, "request")
		if !h.inspect(t, event, strings.Repeat("e", 32)).Valid {
			t.Fatal("initial short-deadline exchange was not live")
		}
		h.next(t, "closed")
		if len(responseBytes(t, f, id)) != 0 {
			t.Fatal("expired request disclosed bytes")
		}
		if h.inspect(t, event, strings.Repeat("f", 32)).Valid {
			t.Fatal("inspection renewed an expired deadline")
		}
		h.shutdown(t)
	})
}

func TestNativeRejectsMalformedExternalFramesAndControlReplay(t *testing.T) {
	binary := buildFixture(t)
	t.Run("external malformed frames never produce request events", func(t *testing.T) {
		f := startFixture(t, binary)
		h := newBridge(t, f)
		valid := operationRequest(t, time.Now().Add(2*time.Second))
		for _, wire := range [][]byte{
			rawFrame([]byte("{")), {0, 1, 0, 1},
			rawFrame(bytes.Replace(valid, []byte(`"method":"readOperation"`), []byte(`"method":"bind"`), 1)),
			rawFrame(bytes.Replace(valid, []byte(`"schemaVersion":1`), []byte(`"schemaVersion":1,"role":"lifecycle-authority"`), 1)),
			rawFrame(bytes.Replace(valid, []byte(`"schemaVersion":1`), []byte(`"schemaVersion":1,"schemaVersion":1`), 1)),
			rawFrame(operationRequest(t, time.Now().Add(-time.Second))),
		} {
			id := f.request(t, h.boot.ListenAddress, wire)
			if len(responseBytes(t, f, id)) != 0 {
				t.Fatal("malformed request received bytes")
			}
			select {
			case event := <-h.events:
				t.Fatalf("malformed request produced native %s event", event.Kind)
			default:
			}
		}
		h.shutdown(t)
	})
	for _, mutation := range []string{"old incarnation", "duplicate sequence", "foreign connection", "wrong digest"} {
		t.Run(mutation, func(t *testing.T) {
			f := startFixture(t, binary)
			h := newBridge(t, f)
			id := f.request(t, h.boot.ListenAddress, rawFrame(operationRequest(t, time.Now().Add(2*time.Second))))
			event := h.next(t, "request")
			command := servicebridge.Command{SchemaVersion: 1, Kind: "inspect", Incarnation: h.boot.Incarnation, Sequence: 2, ConnectionID: event.ConnectionID, ExchangeID: event.ExchangeID, RequestDigest: event.RequestDigest, Challenge: strings.Repeat("b", 32)}
			switch mutation {
			case "old incarnation":
				command.Incarnation = strings.Repeat("f", 32)
			case "duplicate sequence":
				command.Sequence = 1
			case "foreign connection":
				command.ConnectionID = strings.Repeat("f", 32)
			case "wrong digest":
				command.RequestDigest = "sha256:" + strings.Repeat("f", 64)
			}
			_ = servicebridge.WriteFrame(h.input, jsonBytes(t, command), servicebridge.MaxFrameBytes)
			select {
			case err := <-h.done:
				h.finished = true
				if err == nil {
					t.Fatal("invalid control command succeeded")
				}
			case <-time.After(4 * time.Second):
				t.Fatal("invalid control channel did not join")
			}
			if len(responseBytes(t, f, id)) != 0 {
				t.Fatal("forged control command disclosed bytes")
			}
		})
	}
}

func TestNativeJoinsCancelledIncompleteInputAndBlockedOutput(t *testing.T) {
	t.Run("incomplete bootstrap cancellation", func(t *testing.T) {
		input, writer := io.Pipe()
		reader, output := io.Pipe()
		defer reader.Close()
		defer writer.Close()
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		done := make(chan error, 1)
		go func() { done <- servicebridge.Run(ctx, input, output) }()
		if _, err := writer.Write([]byte{0, 0, 1}); err != nil {
			t.Fatal(err)
		}
		cancel()
		select {
		case err := <-done:
			if err == nil {
				t.Fatal("incomplete cancelled bootstrap succeeded")
			}
		case <-time.After(time.Second):
			t.Fatal("cancel did not close the owned input")
		}
	})
	t.Run("unread ready output", func(t *testing.T) {
		f := startFixture(t, buildFixture(t))
		boot := bootstrap(t, f)
		input, writer := io.Pipe()
		reader, output := io.Pipe()
		defer reader.Close()
		defer writer.Close()
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		done := make(chan error, 1)
		began := time.Now()
		go func() { done <- servicebridge.Run(ctx, input, output) }()
		wire := rawFrame(jsonBytes(t, boot))
		if _, err := writer.Write(wire[:1]); err != nil {
			t.Fatal(err)
		}
		// Consume part of the actual initial budget before completing bootstrap.
		// Restarting the budget for ready would retain the child for about 4.3s.
		time.Sleep(1300 * time.Millisecond)
		if _, err := writer.Write(wire[1:]); err != nil {
			t.Fatal(err)
		}
		// Never read ready. The original three-second monotonic budget includes
		// this blocked real Write, Source startup, and initial framing delay.
		select {
		case err := <-done:
			if err == nil {
				t.Fatal("blocked output unexpectedly succeeded")
			}
			elapsed := time.Since(began)
			if elapsed < 2800*time.Millisecond || elapsed >= 3800*time.Millisecond {
				t.Fatalf("startup completion escaped its original budget: %s", elapsed)
			}
		case <-time.After(2500 * time.Millisecond):
			t.Fatal("blocked native output renewed its initial resource budget")
		}
		listener, err := net.Listen("tcp", boot.ListenAddress)
		if err != nil {
			t.Fatal("blocked output retained listener")
		}
		listener.Close()
	})
}
