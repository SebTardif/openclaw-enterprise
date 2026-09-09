package servicebridge

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"strconv"
	"sync"
	"time"

	"github.com/openclaw/openclaw-enterprise/components/runtime-security/identity"
	"github.com/openclaw/openclaw-enterprise/components/runtime-security/servicepeer"
)

// Bootstrap is accepted exactly once on the owned parent pipe. ProfileBase64
// preserves the registry's canonical bytes; it is never read from a TLS peer.
type Bootstrap struct {
	SchemaVersion        int    `json:"schemaVersion"`
	Kind                 string `json:"kind"`
	Incarnation          string `json:"incarnation"`
	Sequence             int64  `json:"sequence"`
	ProfileBase64        string `json:"profileBase64"`
	ProfileDigest        string `json:"profileDigest"`
	ConfigurationVersion int64  `json:"configurationVersion"`
	ListenAddress        string `json:"listenAddress"`
}

// Command has one closed shape. Unused fields must be empty. Sequence counts
// all commands in a child incarnation, including negative and cancelled calls.
type Command struct {
	SchemaVersion int    `json:"schemaVersion"`
	Kind          string `json:"kind"`
	Incarnation   string `json:"incarnation"`
	Sequence      int64  `json:"sequence"`
	ConnectionID  string `json:"connectionId"`
	ExchangeID    string `json:"exchangeId"`
	RequestDigest string `json:"requestDigest"`
	Challenge     string `json:"challenge"`
	PayloadBase64 string `json:"payloadBase64"`
}

// Event is a closed channel message, not a transferable authority credential.
// Only the controller which spawned this child may consume its original pipe.
type Event struct {
	SchemaVersion        int    `json:"schemaVersion"`
	Kind                 string `json:"kind"`
	Incarnation          string `json:"incarnation"`
	Sequence             int64  `json:"sequence"`
	ConnectionID         string `json:"connectionId"`
	ExchangeID           string `json:"exchangeId"`
	RequestDigest        string `json:"requestDigest"`
	Challenge            string `json:"challenge"`
	PayloadBase64        string `json:"payloadBase64"`
	Deadline             string `json:"deadline"`
	ConfigurationVersion int64  `json:"configurationVersion"`
	ProfileDigest        string `json:"profileDigest"`
}

type Request struct {
	SchemaVersion int             `json:"schemaVersion"`
	Method        string          `json:"method"`
	Deadline      string          `json:"deadline"`
	Operation     json.RawMessage `json:"operation"`
}

// Observation operands carry no authority request reference. Their separate
// closed envelope binds it to the original TLS request without widening Request.
type observationRequest struct {
	SchemaVersion int             `json:"schemaVersion"`
	Method        string          `json:"method"`
	Deadline      string          `json:"deadline"`
	Operation     json.RawMessage `json:"operation"`
	RequestRef    string          `json:"requestRef"`
}

type Inspection struct {
	Valid                 bool   `json:"valid"`
	OwnSPIFFEID           string `json:"ownSPIFFEId"`
	PeerSPIFFEID          string `json:"peerSPIFFEId"`
	RecipientSPIFFEID     string `json:"recipientSPIFFEId"`
	AuthenticatedAt       string `json:"authenticatedAt"`
	ExpiresAt             string `json:"expiresAt"`
	PeerCertificateSHA256 string `json:"peerCertificateSha256"`
}

type exchange struct {
	connection                         *servicepeer.Connection
	connectionID, id, digest, deadline string
	cancel                             context.CancelFunc
	result                             chan []byte
	submitted                          bool
}

type bridge struct {
	ctx       context.Context
	cancel    context.CancelFunc
	input     io.ReadCloser
	output    io.WriteCloser
	boot      Bootstrap
	profile   Profile
	source    *identity.Source
	transport *servicepeer.Transport
	listener  net.Listener
	emitMu    sync.Mutex
	sequence  int64
	mu        sync.Mutex
	active    *exchange
	// Negative-only tombstones tolerate commands already queued when a connection
	// closes. Bounded retirement metadata never restores a connection or result.
	retired []exchange
	work    sync.WaitGroup
}

func digest(raw []byte) string {
	sum := sha256.Sum256(raw)
	return "sha256:" + hex.EncodeToString(sum[:])
}
func identifier() (string, error) {
	var bytes [16]byte
	_, err := rand.Read(bytes[:])
	return hex.EncodeToString(bytes[:]), err
}
func timestamp(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }
func parseTime(raw string) (time.Time, error) {
	t, e := time.Parse("2006-01-02T15:04:05.000Z", raw)
	if e != nil || timestamp(t) != raw {
		return time.Time{}, errProtocol
	}
	return t, nil
}
func encode(value any) string {
	raw, _ := json.Marshal(value)
	return base64.StdEncoding.EncodeToString(raw)
}
func decodeBase64(value string, max int) ([]byte, error) {
	if len(value) > base64.StdEncoding.EncodedLen(max) {
		return nil, errProtocol
	}
	raw, err := base64.StdEncoding.Strict().DecodeString(value)
	if err != nil || len(raw) > max || base64.StdEncoding.EncodeToString(raw) != value {
		return nil, errProtocol
	}
	return raw, nil
}

// Run owns both pipes and every resource it creates. Returning means its native
// source, listener, connection and worker have been closed and joined. The
// protected admitted profile bounds dispatch; it cannot establish bind eligibility.
func Run(parent context.Context, input io.ReadCloser, output io.WriteCloser) error {
	if parent == nil || input == nil || output == nil {
		return errProtocol
	}
	ctx, cancel := context.WithCancel(parent)
	b := &bridge{ctx: ctx, cancel: cancel, input: input, output: output}
	stopped := make(chan struct{})
	stopIO := context.AfterFunc(ctx, func() { input.Close(); output.Close(); close(stopped) })
	defer func() {
		cancel()
		if !stopIO() {
			<-stopped
		}
		input.Close()
		output.Close()
		if b.listener != nil {
			b.listener.Close()
		}
		if b.transport != nil {
			b.transport.Close()
		}
		if b.source != nil {
			b.source.Close()
		}
		b.work.Wait()
	}()
	initial := time.AfterFunc(3*time.Second, cancel)
	raw, err := ReadFrame(input, MaxFrameBytes)
	if err != nil || decodeStrict(raw, &b.boot) != nil || b.boot.SchemaVersion != 1 || b.boot.Kind != "bootstrap" || !idPattern.MatchString(b.boot.Incarnation) || b.boot.Sequence != 1 || b.boot.ConfigurationVersion < 1 || !digestPattern.MatchString(b.boot.ProfileDigest) {
		initial.Stop()
		return errProtocol
	}
	profileRaw, err := decodeBase64(b.boot.ProfileBase64, MaxRequestBytes)
	if err != nil || digest(profileRaw) != b.boot.ProfileDigest {
		initial.Stop()
		return errProtocol
	}
	b.profile, err = ValidateProfile(profileRaw)
	if err != nil {
		initial.Stop()
		return errProtocol
	}
	host, port, err := net.SplitHostPort(b.boot.ListenAddress)
	p, portErr := strconv.Atoi(port)
	if err != nil || portErr != nil || p < 1 || p > 65535 || strconv.Itoa(p) != port || net.ParseIP(host) == nil {
		initial.Stop()
		return errProtocol
	}
	b.source, err = identity.NewSource(identity.Options{SocketPath: b.profile.WorkloadAPISocketPath, ExpectedSPIFFEID: b.profile.OwnSPIFFEID, Timeout: 3 * time.Second})
	if err != nil {
		initial.Stop()
		return errProtocol
	}
	if err = b.source.Start(ctx); err != nil || !b.currentBundle() {
		initial.Stop()
		return errProtocol
	}
	b.transport, err = servicepeer.New(b.source, servicepeer.Config{Side: servicepeer.Server, OwnSPIFFEID: b.profile.OwnSPIFFEID, PeerSPIFFEID: b.profile.PeerSPIFFEID, RecipientSPIFFEID: b.profile.RecipientSPIFFEID, HandshakeTimeout: 3 * time.Second, RecheckInterval: time.Second, MaxConnectionAge: 30 * time.Second, MaxConnections: 1})
	if err != nil {
		initial.Stop()
		return errProtocol
	}
	b.listener, err = net.Listen("tcp", b.boot.ListenAddress)
	if err != nil {
		initial.Stop()
		return errProtocol
	}
	if ctx.Err() != nil {
		initial.Stop()
		return errProtocol
	}
	if err = b.emit("ready", nil, "", encode(struct {
		Address string `json:"address"`
	}{b.listener.Addr().String()})); err != nil {
		initial.Stop()
		return errProtocol
	}
	if !initial.Stop() || ctx.Err() != nil {
		return errProtocol
	}
	b.work.Add(2)
	go func() { defer b.work.Done(); b.accept() }()
	go func() {
		defer b.work.Done()
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if !b.currentBundle() {
					cancel()
					return
				}
			}
		}
	}()
	sequence := int64(1)
	for ctx.Err() == nil {
		raw, err = b.readCommand()
		if err != nil {
			return errProtocol
		}
		var command Command
		if decodeStrict(raw, &command) != nil || command.SchemaVersion != 1 || command.Incarnation != b.boot.Incarnation || command.Sequence != sequence+1 || command.Sequence > 9007199254740991 {
			return errProtocol
		}
		sequence = command.Sequence
		if command.Kind == "shutdown" {
			if command.ConnectionID != "" || command.ExchangeID != "" || command.RequestDigest != "" || command.Challenge != "" || command.PayloadBase64 != "" {
				return errProtocol
			}
			return nil
		}
		if err = b.command(command); err != nil {
			return errProtocol
		}
	}
	return errProtocol
}

// The first byte starts the partial-command deadline. Idle input does not keep
// an exchange alive; its independent request timer remains active throughout.
func (b *bridge) readCommand() ([]byte, error) {
	var first [1]byte
	if _, err := io.ReadFull(b.input, first[:]); err != nil {
		return nil, err
	}
	timer := time.AfterFunc(3*time.Second, b.cancel)
	defer timer.Stop()
	return ReadFrame(io.MultiReader(bytesReader(first[:]), b.input), MaxFrameBytes)
}

type sliceReader struct{ data []byte }

func bytesReader(data []byte) *sliceReader { return &sliceReader{data: data} }
func (r *sliceReader) Read(p []byte) (int, error) {
	if len(r.data) == 0 {
		return 0, io.EOF
	}
	n := copy(p, r.data)
	r.data = r.data[n:]
	return n, nil
}

func (b *bridge) currentBundle() bool {
	view, err := b.source.TrustView()
	return err == nil && view.Metadata.SPIFFEID == b.profile.OwnSPIFFEID &&
		view.CRLCount == 0 && view.BundleSHA256 == b.profile.TrustBundleSHA256
}

func (b *bridge) emit(kind string, x *exchange, challenge, payload string) error {
	b.emitMu.Lock()
	defer b.emitMu.Unlock()
	if b.ctx.Err() != nil {
		return errProtocol
	}
	b.sequence++
	if b.sequence > 9007199254740991 {
		b.cancel()
		return errProtocol
	}
	event := Event{SchemaVersion: 1, Kind: kind, Incarnation: b.boot.Incarnation, Sequence: b.sequence, Challenge: challenge, PayloadBase64: payload, ConfigurationVersion: b.boot.ConfigurationVersion, ProfileDigest: b.boot.ProfileDigest}
	if x != nil {
		event.ConnectionID = x.connectionID
		event.ExchangeID = x.id
		event.RequestDigest = x.digest
		event.Deadline = x.deadline
	}
	raw, err := json.Marshal(event)
	if err != nil {
		return errProtocol
	}
	timer := time.AfterFunc(3*time.Second, b.cancel)
	err = WriteFrame(b.output, raw, MaxFrameBytes)
	if !timer.Stop() || err != nil {
		b.cancel()
		return errProtocol
	}
	return nil
}

func (b *bridge) accept() {
	for b.ctx.Err() == nil {
		raw, err := b.listener.Accept()
		if err != nil {
			b.cancel()
			return
		}
		b.serve(raw)
	}
}

func (b *bridge) serve(raw net.Conn) {
	if b.profile.OperationPolicy == gatewayStartupPolicy {
		b.serveGatewayStartup(raw)
		return
	}
	life, cancel := context.WithCancel(b.ctx)
	defer cancel()
	connection, err := b.transport.Handshake(life, raw)
	if err != nil {
		return
	}
	defer connection.Close()
	deadline := time.Now().Add(3 * time.Second)
	// Install before reading any public prefix or payload byte.
	if err = connection.SetDeadline(deadline); err != nil {
		return
	}
	timer := time.AfterFunc(time.Until(deadline), cancel)
	defer timer.Stop()
	requestRaw, err := ReadFrame(connection, MaxRequestBytes)
	if err != nil {
		return
	}
	var request Request
	if b.profile.OperationPolicy == runtimeObservationPolicy {
		var observation observationRequest
		if decodeStrict(requestRaw, &observation) != nil || !refPattern.MatchString(observation.RequestRef) {
			return
		}
		request = Request{SchemaVersion: observation.SchemaVersion, Method: observation.Method, Deadline: observation.Deadline, Operation: observation.Operation}
	} else if decodeStrict(requestRaw, &request) != nil {
		return
	}
	if request.SchemaVersion != 1 || !b.operationAllowed(request) {
		return
	}
	requested, err := parseTime(request.Deadline)
	if err != nil {
		return
	}
	if requested.Before(deadline) {
		deadline = requested
	}
	peer, err := connection.Inspect()
	if err != nil {
		return
	}
	if peer.ExpiresAt.Before(deadline) {
		deadline = peer.ExpiresAt
	}
	// Millisecond precision is the common public contract; rounding never extends.
	deadline = deadline.Truncate(time.Millisecond)
	if !time.Now().Before(deadline) || !b.currentBundle() {
		return
	}
	// Keep the original monotonic timer armed. Parsed wall-clock values and
	// truncation lose monotonic metadata and must never renew that ingress cap.
	shorter := time.AfterFunc(time.Until(deadline), cancel)
	defer shorter.Stop()
	if connection.SetDeadline(deadline) != nil {
		return
	}
	connectionID, err := identifier()
	if err != nil {
		b.cancel()
		return
	}
	exchangeID, err := identifier()
	if err != nil {
		b.cancel()
		return
	}
	x := &exchange{connection: connection, connectionID: connectionID, id: exchangeID, digest: digest(requestRaw), deadline: timestamp(deadline), cancel: cancel, result: make(chan []byte, 1)}
	b.mu.Lock()
	b.active = x
	b.mu.Unlock()
	defer func() {
		cancel()
		connection.Close()
		b.mu.Lock()
		if b.active == x {
			b.active = nil
		}
		b.retired = append(b.retired, exchange{connectionID: x.connectionID, id: x.id, digest: x.digest, deadline: x.deadline})
		if len(b.retired) > 64 {
			b.retired = b.retired[1:]
		}
		b.mu.Unlock()
		b.emit("closed", x, "", "")
	}()
	if b.emit("request", x, "", base64.StdEncoding.EncodeToString(requestRaw)) != nil {
		return
	}
	// One request per connection. An EOF or any extra plaintext closes the live
	// exchange. This goroutine never interprets a second request or consumes proof.
	readDone := make(chan struct{})
	go func() { defer close(readDone); var byte [1]byte; connection.Read(byte[:]); cancel() }()
	defer func() { cancel(); connection.Close(); <-readDone }()
	select {
	case <-life.Done():
		return
	case result := <-x.result:
		if life.Err() != nil || !time.Now().Before(deadline) || !b.currentBundle() {
			return
		}
		if _, err = connection.Inspect(); err != nil {
			return
		}
		if WriteFrame(connection, result, MaxRequestBytes) != nil {
			return
		}
		b.emit("completed", x, "", "")
	}
}

// The native side independently enforces the admitted operation ceiling before
// emitting a request. OCC's canonical closed method schema then parses the full
// original payload before any context is constructed; these discriminators do
// not replace that parser or the service's current registry/policy checks.
func (b *bridge) operationAllowed(request Request) bool {
	if b.profile.OperationPolicy == runtimeObservationPolicy {
		if request.Method != "discover" && request.Method != "observe" {
			return false
		}
		var operation, effect, target map[string]json.RawMessage
		if json.Unmarshal(request.Operation, &operation) != nil || operation == nil {
			return false
		}
		if request.Method == "discover" {
			if json.Unmarshal(operation["effect"], &effect) != nil || effect == nil {
				return false
			}
		} else {
			if !bytes.Equal(bytes.TrimSpace(operation["kind"]), []byte(`"preallocated-candidate"`)) {
				return false
			}
			effect = operation
		}
		return json.Unmarshal(effect["target"], &target) == nil &&
			bytes.Equal(bytes.TrimSpace(target["component"]), []byte(`"harness"`))
	}
	if request.Method == "readOperation" {
		return b.profile.OperationPolicy == "read-operation-only-v1" || b.profile.OperationPolicy == "initial-harness-bind-v1"
	}
	if request.Method != "bind" || b.profile.OperationPolicy != "initial-harness-bind-v1" {
		return false
	}
	var operation, target, binding map[string]json.RawMessage
	if json.Unmarshal(request.Operation, &operation) != nil ||
		json.Unmarshal(operation["target"], &target) != nil ||
		json.Unmarshal(operation["binding"], &binding) != nil {
		return false
	}
	// Map lookup is case-sensitive; encoding/json struct matching would admit
	// differently spelled discriminator names before the canonical TS parser.
	equal := func(raw json.RawMessage, expected string) bool {
		return bytes.Equal(bytes.TrimSpace(raw), []byte(expected))
	}
	return equal(operation["kind"], `"bind"`) && equal(operation["expectedBindingVersion"], "null") &&
		equal(target["component"], `"harness"`) && equal(binding["component"], `"harness"`) &&
		equal(binding["provider"], `"occ/kubernetes-gvisor"`)
}

func (b *bridge) command(command Command) error {
	if !idPattern.MatchString(command.ConnectionID) || !idPattern.MatchString(command.ExchangeID) || !digestPattern.MatchString(command.RequestDigest) {
		return errProtocol
	}
	if command.Kind != "inspect" && command.Kind != "result" && command.Kind != "cancel" {
		return errProtocol
	}
	if (command.Kind == "inspect" && (!idPattern.MatchString(command.Challenge) || command.PayloadBase64 != "")) || (command.Kind != "inspect" && command.Challenge != "") || (command.Kind == "cancel" && command.PayloadBase64 != "") {
		return errProtocol
	}
	b.mu.Lock()
	x := b.active
	match := func(v *exchange) bool {
		return v != nil && v.connectionID == command.ConnectionID && v.id == command.ExchangeID && v.digest == command.RequestDigest
	}
	if !match(x) {
		var retired *exchange
		for i := range b.retired {
			if match(&b.retired[i]) {
				copy := b.retired[i]
				retired = &copy
				break
			}
		}
		b.mu.Unlock()
		if retired == nil {
			return errProtocol
		}
		if command.Kind == "inspect" {
			return b.emit("inspected", retired, command.Challenge, encode(Inspection{}))
		}
		// A late result/cancel is a negative-only acknowledgement of an expired
		// exchange. It cannot write to a new connection, even if IDs are replayed.
		return nil
	}
	if command.Kind == "cancel" {
		x.cancel()
		b.mu.Unlock()
		return nil
	}
	if command.Kind == "result" {
		result, err := decodeBase64(command.PayloadBase64, MaxRequestBytes)
		if err != nil || !validJSON(result) || x.submitted {
			b.mu.Unlock()
			return errProtocol
		}
		x.submitted = true
		x.result <- result
		b.mu.Unlock()
		return nil
	}
	b.mu.Unlock()
	inspection := Inspection{}
	deadline, err := parseTime(x.deadline)
	if err == nil && time.Now().Before(deadline) && b.currentBundle() {
		if peer, err := x.connection.Inspect(); err == nil {
			inspection = Inspection{Valid: true, OwnSPIFFEID: peer.OwnSPIFFEID, PeerSPIFFEID: peer.PeerSPIFFEID, RecipientSPIFFEID: peer.RecipientSPIFFEID, AuthenticatedAt: timestamp(peer.AuthenticatedAt), ExpiresAt: timestamp(peer.ExpiresAt), PeerCertificateSHA256: "sha256:" + peer.PeerCertificateSHA256}
		}
	}
	return b.emit("inspected", x, command.Challenge, encode(inspection))
}
