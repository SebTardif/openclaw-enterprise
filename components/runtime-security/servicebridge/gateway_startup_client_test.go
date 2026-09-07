package servicebridge_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/openclaw/openclaw-enterprise/components/runtime-security/servicebridge"
)

type gatewayClientHarness struct {
	input    *io.PipeWriter
	output   *io.PipeReader
	events   chan servicebridge.Event
	done     chan error
	readDone chan struct{}
	cancel   context.CancelFunc
	boot     servicebridge.GatewayStartupClientBootstrap
	ready    servicebridge.Event
	sequence int64
}

func newGatewayClient(t *testing.T, server *bridgeHarness) *gatewayClientHarness {
	t.Helper()
	var profile servicebridge.Profile
	raw, err := base64.StdEncoding.DecodeString(server.boot.ProfileBase64)
	if err != nil || json.Unmarshal(raw, &profile) != nil {
		t.Fatal("test profile decode")
	}
	profile.OwnSPIFFEID, profile.PeerSPIFFEID = profile.PeerSPIFFEID, profile.OwnSPIFFEID
	raw = jsonBytes(t, profile)
	input, writer := io.Pipe()
	reader, output := io.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	c := &gatewayClientHarness{input: writer, output: reader, events: make(chan servicebridge.Event, 16), done: make(chan error, 1), readDone: make(chan struct{}), cancel: cancel, sequence: 1,
		boot: servicebridge.GatewayStartupClientBootstrap{SchemaVersion: 1, Kind: "bootstrap", Incarnation: strings.Repeat("b", 32), Sequence: 1, ProfileBase64: base64.StdEncoding.EncodeToString(raw), ProfileDigest: testDigest(raw), ConfigurationVersion: 1, ConnectAddress: server.boot.ListenAddress}}
	go func() { c.done <- servicebridge.RunGatewayStartupClient(ctx, input, output) }()
	go func() {
		defer close(c.readDone)
		defer close(c.events)
		for {
			raw, err := servicebridge.ReadFrame(reader, servicebridge.MaxFrameBytes)
			var event servicebridge.Event
			if err != nil || json.Unmarshal(raw, &event) != nil {
				return
			}
			c.events <- event
		}
	}()
	t.Cleanup(func() {
		cancel()
		writer.Close()
		reader.Close()
		select {
		case <-c.done:
		case <-time.After(4 * time.Second):
			t.Error("client did not join")
		}
		select {
		case <-c.readDone:
		case <-time.After(time.Second):
			t.Error("client reader did not join")
		}
	})
	if servicebridge.WriteFrame(writer, jsonBytes(t, c.boot), servicebridge.MaxFrameBytes) != nil {
		t.Fatal("client bootstrap write")
	}
	c.ready = c.next(t)
	if c.ready.Kind != "ready" || c.ready.Sequence != 1 || c.ready.Incarnation != c.boot.Incarnation || c.ready.ProfileDigest != c.boot.ProfileDigest || c.ready.ConnectionID == "" || c.ready.ExchangeID != "" {
		t.Fatal("client readiness lost original tuple")
	}
	return c
}

func (c *gatewayClientHarness) next(t *testing.T) servicebridge.Event {
	t.Helper()
	select {
	case event, ok := <-c.events:
		if !ok {
			t.Fatal("client ended before result")
		}
		return event
	case <-time.After(5 * time.Second):
		t.Fatal("client result deadline")
		return servicebridge.Event{}
	}
}

func (c *gatewayClientHarness) send(t *testing.T, method string) (servicebridge.Command, []byte) {
	t.Helper()
	c.sequence++
	request := servicebridge.Request{SchemaVersion: 1, Method: method, Deadline: time.Now().Add(2500 * time.Millisecond).UTC().Format("2006-01-02T15:04:05.000Z"), Operation: json.RawMessage(`{"schemaVersion":1,"kind":"` + method + `"}`)}
	raw := jsonBytes(t, request)
	command := servicebridge.Command{SchemaVersion: 1, Kind: "call", Incarnation: c.boot.Incarnation, Sequence: c.sequence, ConnectionID: c.ready.ConnectionID, ExchangeID: strings.Repeat("c", 32), RequestDigest: testDigest(raw), Challenge: strings.Repeat("d", 32), PayloadBase64: base64.StdEncoding.EncodeToString(raw)}
	if servicebridge.WriteFrame(c.input, jsonBytes(t, command), servicebridge.MaxFrameBytes) != nil {
		t.Fatal("client request write")
	}
	return command, raw
}

// These are actual native Source/TLS/pipe tests. The controller returns only a
// negative application result; transport success never claims registry admission.
func TestGatewayStartupActualSequentialConnectionAndTerminalLoss(t *testing.T) {
	binary := buildFixture(t)
	t.Run("same connection and fresh parent exchange", func(t *testing.T) {
		f := startFixture(t, binary)
		h := newBridgeWithPolicy(t, f, "installation-gateway-startup-v1")
		c := newGatewayClient(t, h)
		connected := h.next(t, "connected")
		if connected.ConnectionID != c.ready.ConnectionID {
			t.Fatal("client/server connection mismatch")
		}
		var previous servicebridge.Event
		for _, method := range []string{"consume-startup", "read-current", "read-operation"} {
			command, raw := c.send(t, method)
			request := h.next(t, "request")
			payload, _ := base64.StdEncoding.DecodeString(request.PayloadBase64)
			if string(payload) != string(raw) || request.RequestDigest != command.RequestDigest || request.ConnectionID != connected.ConnectionID || request.ExchangeID == previous.ExchangeID {
				t.Fatal("request lost original bytes or fresh server custody")
			}
			if !h.inspect(t, request, strings.Repeat("e", 32)).Valid {
				t.Fatal("actual peer inspection unavailable")
			}
			if previous.ExchangeID != "" && h.inspect(t, previous, strings.Repeat("f", 32)).Valid {
				t.Fatal("retired exchange revived")
			}
			h.send(t, "result", request, "", []byte(`{"kind":"unavailable"}`))
			result := c.next(t)
			if result.Kind != "result" || result.ConnectionID != command.ConnectionID || result.ExchangeID != command.ExchangeID || result.RequestDigest != command.RequestDigest || result.Challenge != command.Challenge {
				t.Fatal("response tuple changed")
			}
			h.next(t, "completed")
			previous = request
		}
		f.change(t, "withdraw")
		select {
		case _, ok := <-c.events:
			if ok {
				t.Fatal("unexpected event after source loss")
			}
		case <-time.After(3 * time.Second):
			t.Fatal("source loss did not terminate client")
		}
	})
	t.Run("second consume cannot dispatch", func(t *testing.T) {
		f := startFixture(t, binary)
		h := newBridgeWithPolicy(t, f, "installation-gateway-startup-v1")
		c := newGatewayClient(t, h)
		h.next(t, "connected")
		c.send(t, "consume-startup")
		request := h.next(t, "request")
		h.send(t, "result", request, "", []byte(`{"kind":"unavailable"}`))
		c.next(t)
		h.next(t, "completed")
		c.send(t, "consume-startup")
		select {
		case _, ok := <-c.events:
			if ok {
				t.Fatal("second consume produced a result")
			}
		case <-time.After(time.Second):
			t.Fatal("second consume not terminal")
		}
	})
	t.Run("unlisted method cannot dispatch", func(t *testing.T) {
		f := startFixture(t, binary)
		h := newBridgeWithPolicy(t, f, "installation-gateway-startup-v1")
		c := newGatewayClient(t, h)
		h.next(t, "connected")
		c.send(t, "bind")
		select {
		case _, ok := <-c.events:
			if ok {
				t.Fatal("wrong purpose produced a result")
			}
		case <-time.After(time.Second):
			t.Fatal("wrong purpose not terminal")
		}
	})
}
