package servicebridge

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"strconv"
	"time"

	"github.com/openclaw/openclaw-enterprise/components/runtime-security/identity"
	"github.com/openclaw/openclaw-enterprise/components/runtime-security/servicepeer"
)

// GatewayStartupClientBootstrap is accepted only by the fixed client entrypoint
// on its original parent pipe. The endpoint is never selected by a remote peer.
type GatewayStartupClientBootstrap struct {
	SchemaVersion        int    `json:"schemaVersion"`
	Kind                 string `json:"kind"`
	Incarnation          string `json:"incarnation"`
	Sequence             int64  `json:"sequence"`
	ProfileBase64        string `json:"profileBase64"`
	ProfileDigest        string `json:"profileDigest"`
	ConfigurationVersion int64  `json:"configurationVersion"`
	ConnectAddress       string `json:"connectAddress"`
}

type gatewayFrame struct {
	raw      []byte
	deadline time.Time
	timer    *time.Timer
}

type gatewayClientCommand struct {
	command  Command
	deadline time.Time
	timer    *time.Timer
}

// A single reader remains attached while an owner operation is awaiting its
// result. EOF, Source loss and partial-frame expiry therefore end that lifetime.
// The unbuffered handoff and one bounded frame allow no application request queue.
// Each original ingress timer stays armed until its receiver finishes disclosure.
func readGatewayFrames(life context.Context, cancel context.CancelFunc, connection *servicepeer.Connection, expiry time.Time, frames chan<- gatewayFrame, done chan<- struct{}) {
	defer close(done)
	defer cancel()
	for life.Err() == nil {
		if connection.SetReadDeadline(expiry) != nil {
			return
		}
		var first [1]byte
		if _, err := io.ReadFull(connection, first[:]); err != nil {
			return
		}
		deadline := time.Now().Add(3 * time.Second)
		if expiry.Before(deadline) {
			deadline = expiry
		}
		timer := time.AfterFunc(time.Until(deadline), cancel)
		if connection.SetReadDeadline(deadline) != nil {
			timer.Stop()
			return
		}
		raw, err := ReadFrame(io.MultiReader(bytesReader(first[:]), connection), MaxFrameBytes)
		if err != nil {
			timer.Stop()
			return
		}
		select {
		case <-life.Done():
			timer.Stop()
			return
		case frames <- gatewayFrame{raw: raw, deadline: deadline, timer: timer}:
		}
	}
}

func gatewayInspection(connection *servicepeer.Connection) (Inspection, error) {
	peer, err := connection.Inspect()
	if err != nil {
		return Inspection{}, err
	}
	return Inspection{Valid: true, OwnSPIFFEID: peer.OwnSPIFFEID, PeerSPIFFEID: peer.PeerSPIFFEID, RecipientSPIFFEID: peer.RecipientSPIFFEID, AuthenticatedAt: timestamp(peer.AuthenticatedAt), ExpiresAt: timestamp(peer.ExpiresAt), PeerCertificateSHA256: "sha256:" + peer.PeerCertificateSHA256}, nil
}

// This branch is deliberately separate from the original one-request profiles.
// Once an authentic third-profile connection exists its loss ends the child;
// another connection cannot restore that incarnation or any local enrollment.
func (b *bridge) serveGatewayStartup(raw net.Conn) {
	life, cancel := context.WithCancel(b.ctx)
	defer cancel()
	connection, err := b.transport.Handshake(life, raw)
	if err != nil {
		return
	}
	defer b.cancel()
	defer connection.Close()
	peer, err := connection.Inspect()
	if err != nil || !b.currentBundle() {
		return
	}
	connectionID, err := identifier()
	if err != nil {
		return
	}
	identity := &exchange{connection: connection, connectionID: connectionID, deadline: timestamp(peer.ExpiresAt)}
	defer b.emit("closed", identity, "", "")
	inspection, err := gatewayInspection(connection)
	if err != nil || b.emit("connected", identity, "", encode(inspection)) != nil {
		return
	}
	hello, _ := json.Marshal(gatewayStartupHello{SchemaVersion: 1, Kind: "connected", ConnectionID: connectionID, ExpiresAt: timestamp(peer.ExpiresAt)})
	if connection.SetWriteDeadline(time.Now().Add(3*time.Second)) != nil || WriteFrame(connection, hello, MaxFrameBytes) != nil {
		return
	}
	frames, done := make(chan gatewayFrame), make(chan struct{})
	go readGatewayFrames(life, cancel, connection, peer.ExpiresAt, frames, done)
	defer func() { cancel(); connection.Close(); <-done }()
	consumed := false
	for sequence := int64(1); sequence <= 9007199254740991; sequence++ {
		var frame gatewayFrame
		select {
		case <-life.Done():
			return
		case frame = <-frames:
		}
		ok := b.gatewayExchange(life, cancel, connection, connectionID, sequence, frame, frames, &consumed)
		frame.timer.Stop()
		if !ok {
			return
		}
	}
}

func (b *bridge) gatewayExchange(life context.Context, cancel context.CancelFunc, connection *servicepeer.Connection, connectionID string, sequence int64, frame gatewayFrame, frames <-chan gatewayFrame, consumed *bool) bool {
	var envelope gatewayStartupEnvelope
	if decodeStrict(frame.raw, &envelope) != nil || !validGatewayStartupEnvelope(envelope, "request", connectionID, sequence) {
		return false
	}
	raw, err := decodeBase64(envelope.PayloadBase64, MaxRequestBytes)
	var request Request
	if err != nil || digest(raw) != envelope.RequestDigest || decodeStrict(raw, &request) != nil || !gatewayStartupRequestAllowed(request) {
		return false
	}
	if request.Method == "consume-startup" {
		if *consumed {
			return false
		}
		// A send/ACK failure never permits a second consume on this connection.
		*consumed = true
	}
	requested, err := parseTime(request.Deadline)
	if err != nil {
		return false
	}
	deadline := frame.deadline
	if requested.Before(deadline) {
		deadline = requested
	}
	deadline = deadline.Truncate(time.Millisecond)
	if !time.Now().Before(deadline) || life.Err() != nil || !b.currentBundle() {
		return false
	}
	shorter := time.AfterFunc(time.Until(deadline), cancel)
	defer shorter.Stop()
	exchangeID, err := identifier()
	if err != nil {
		return false
	}
	// Parent-pipe correlation is freshly owned here, independent of any peer's
	// reused public exchange ID. A retired command can never match a later call.
	x := &exchange{connection: connection, connectionID: connectionID, id: exchangeID, digest: envelope.RequestDigest, deadline: timestamp(deadline), cancel: cancel, result: make(chan []byte, 1)}
	b.mu.Lock()
	b.active = x
	b.mu.Unlock()
	defer func() {
		b.mu.Lock()
		if b.active == x {
			b.active = nil
		}
		b.retired = append(b.retired, exchange{connectionID: x.connectionID, id: x.id, digest: x.digest, deadline: x.deadline})
		if len(b.retired) > 64 {
			b.retired = b.retired[1:]
		}
		b.mu.Unlock()
	}()
	if b.emit("request", x, "", base64.StdEncoding.EncodeToString(raw)) != nil {
		return false
	}
	select {
	case <-life.Done():
		return false
	case extra := <-frames:
		extra.timer.Stop()
		return false
	case result := <-x.result:
		if life.Err() != nil || !time.Now().Before(deadline) || !b.currentBundle() {
			return false
		}
		if _, err := connection.Inspect(); err != nil {
			return false
		}
		envelope.Kind = "result"
		envelope.PayloadBase64 = base64.StdEncoding.EncodeToString(result)
		response, _ := json.Marshal(envelope)
		if connection.SetWriteDeadline(deadline) != nil || WriteFrame(connection, response, MaxFrameBytes) != nil || life.Err() != nil {
			return false
		}
		return b.emit("completed", x, "", "") == nil
	}
}

// RunGatewayStartupClient owns one Source, one authenticated connection and its
// original parent pipes. It never enrolls a service or interprets a consume ACK.
// Returning means all owned workers/resources have been interrupted and joined.
func RunGatewayStartupClient(parent context.Context, input io.ReadCloser, output io.WriteCloser) error {
	if parent == nil || input == nil || output == nil {
		return errProtocol
	}
	life, cancel := context.WithCancel(parent)
	b := &bridge{ctx: life, cancel: cancel, input: input, output: output}
	stopped := make(chan struct{})
	stopIO := context.AfterFunc(life, func() { input.Close(); output.Close(); close(stopped) })
	defer func() {
		cancel()
		if !stopIO() {
			<-stopped
		}
		input.Close()
		output.Close()
		if b.transport != nil {
			b.transport.Close()
		}
		if b.source != nil {
			b.source.Close()
		}
		b.work.Wait()
	}()
	initial := time.AfterFunc(3*time.Second, cancel)
	defer initial.Stop()
	raw, err := ReadFrame(input, MaxFrameBytes)
	var boot GatewayStartupClientBootstrap
	if err != nil || decodeStrict(raw, &boot) != nil || boot.SchemaVersion != 1 || boot.Kind != "bootstrap" || !idPattern.MatchString(boot.Incarnation) || boot.Sequence != 1 || boot.ConfigurationVersion < 1 || !digestPattern.MatchString(boot.ProfileDigest) {
		return errProtocol
	}
	b.boot = Bootstrap{SchemaVersion: 1, Incarnation: boot.Incarnation, ConfigurationVersion: boot.ConfigurationVersion, ProfileDigest: boot.ProfileDigest}
	profileRaw, err := decodeBase64(boot.ProfileBase64, MaxRequestBytes)
	if err != nil || digest(profileRaw) != boot.ProfileDigest {
		return errProtocol
	}
	b.profile, err = ValidateGatewayStartupClientProfile(profileRaw)
	if err != nil {
		return errProtocol
	}
	host, port, err := net.SplitHostPort(boot.ConnectAddress)
	p, portErr := strconv.Atoi(port)
	if err != nil || portErr != nil || p < 1 || p > 65535 || strconv.Itoa(p) != port || net.ParseIP(host) == nil {
		return errProtocol
	}
	b.source, err = identity.NewSource(identity.Options{SocketPath: b.profile.WorkloadAPISocketPath, ExpectedSPIFFEID: b.profile.OwnSPIFFEID, Timeout: 3 * time.Second})
	if err != nil || b.source.Start(life) != nil || !b.currentBundle() {
		return errProtocol
	}
	b.transport, err = servicepeer.New(b.source, servicepeer.Config{Side: servicepeer.Client, OwnSPIFFEID: b.profile.OwnSPIFFEID, PeerSPIFFEID: b.profile.PeerSPIFFEID, RecipientSPIFFEID: b.profile.RecipientSPIFFEID, HandshakeTimeout: 3 * time.Second, RecheckInterval: time.Second, MaxConnectionAge: 30 * time.Second, MaxConnections: 1})
	if err != nil {
		return errProtocol
	}
	dialer := net.Dialer{Timeout: 3 * time.Second}
	tcp, err := dialer.DialContext(life, "tcp", boot.ConnectAddress)
	if err != nil {
		return errProtocol
	}
	connection, err := b.transport.Handshake(life, tcp)
	if err != nil {
		return errProtocol
	}
	defer connection.Close()
	if connection.SetReadDeadline(time.Now().Add(3*time.Second)) != nil {
		return errProtocol
	}
	raw, err = ReadFrame(connection, MaxFrameBytes)
	var hello gatewayStartupHello
	if err != nil || decodeStrict(raw, &hello) != nil || hello.SchemaVersion != 1 || hello.Kind != "connected" || !idPattern.MatchString(hello.ConnectionID) {
		return errProtocol
	}
	expiry, err := parseTime(hello.ExpiresAt)
	peer, peerErr := connection.Inspect()
	if err != nil || peerErr != nil || !time.Now().Before(expiry) || !b.currentBundle() {
		return errProtocol
	}
	if peer.ExpiresAt.Before(expiry) {
		expiry = peer.ExpiresAt
	}
	// The peer hello may only shorten the native connection's absolute lifetime.
	absolute := time.AfterFunc(time.Until(expiry), cancel)
	defer absolute.Stop()
	identity := &exchange{connection: connection, connectionID: hello.ConnectionID, deadline: timestamp(expiry)}
	inspection, err := gatewayInspection(connection)
	if err != nil || b.emit("ready", identity, "", encode(inspection)) != nil || !initial.Stop() || life.Err() != nil {
		return errProtocol
	}
	frames, readDone := make(chan gatewayFrame), make(chan struct{})
	go readGatewayFrames(life, cancel, connection, expiry, frames, readDone)
	defer func() { cancel(); connection.Close(); <-readDone }()
	commands := make(chan gatewayClientCommand)
	b.work.Add(2)
	go func() {
		defer b.work.Done()
		defer cancel()
		for sequence := int64(2); sequence <= 9007199254740991; sequence++ {
			var first [1]byte
			if _, err := io.ReadFull(input, first[:]); err != nil {
				return
			}
			deadline := time.Now().Add(3 * time.Second)
			timer := time.AfterFunc(time.Until(deadline), cancel)
			raw, err := ReadFrame(io.MultiReader(bytesReader(first[:]), input), MaxFrameBytes)
			var command Command
			if err != nil || decodeStrict(raw, &command) != nil || command.SchemaVersion != 1 || command.Incarnation != boot.Incarnation || command.Sequence != sequence {
				timer.Stop()
				return
			}
			select {
			case <-life.Done():
				timer.Stop()
				return
			case commands <- gatewayClientCommand{command: command, deadline: deadline, timer: timer}:
			}
		}
	}()
	go func() {
		defer b.work.Done()
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-life.Done():
				return
			case <-ticker.C:
				if !b.currentBundle() {
					cancel()
					return
				}
			}
		}
	}()
	consumed := false
	for sequence := int64(1); sequence <= 9007199254740991; sequence++ {
		select {
		case <-life.Done():
			return errProtocol
		case frame := <-frames:
			frame.timer.Stop()
			return errProtocol // No response exists without an outstanding request.
		case incoming := <-commands:
			command := incoming.command
			if command.Kind == "shutdown" && command.ConnectionID == "" && command.ExchangeID == "" && command.RequestDigest == "" && command.Challenge == "" && command.PayloadBase64 == "" {
				incoming.timer.Stop()
				return nil
			}
			ok := b.gatewayClientExchange(life, cancel, connection, identity, incoming, sequence, frames, commands, &consumed)
			incoming.timer.Stop()
			if !ok {
				return errProtocol
			}
		}
	}
	return errProtocol
}

func (b *bridge) gatewayClientExchange(life context.Context, cancel context.CancelFunc, connection *servicepeer.Connection, identity *exchange, incoming gatewayClientCommand, sequence int64, frames <-chan gatewayFrame, commands <-chan gatewayClientCommand, consumed *bool) bool {
	command := incoming.command
	if command.Kind != "call" || command.ConnectionID != identity.connectionID || !idPattern.MatchString(command.ExchangeID) || !idPattern.MatchString(command.Challenge) || !digestPattern.MatchString(command.RequestDigest) {
		return false
	}
	raw, err := decodeBase64(command.PayloadBase64, MaxRequestBytes)
	var request Request
	if err != nil || digest(raw) != command.RequestDigest || decodeStrict(raw, &request) != nil || !gatewayStartupRequestAllowed(request) {
		return false
	}
	if request.Method == "consume-startup" {
		if *consumed {
			return false
		}
		*consumed = true
	}
	deadline := incoming.deadline
	requested, err := parseTime(request.Deadline)
	if err != nil {
		return false
	}
	if requested.Before(deadline) {
		deadline = requested
	}
	peerExpiry, _ := parseTime(identity.deadline)
	if peerExpiry.Before(deadline) {
		deadline = peerExpiry
	}
	deadline = deadline.Truncate(time.Millisecond)
	if !time.Now().Before(deadline) || !b.currentBundle() {
		return false
	}
	shorter := time.AfterFunc(time.Until(deadline), cancel)
	defer shorter.Stop()
	if _, err := connection.Inspect(); err != nil {
		return false
	}
	envelope := gatewayStartupEnvelope{SchemaVersion: 1, Kind: "request", ConnectionID: command.ConnectionID, ExchangeID: command.ExchangeID, Sequence: sequence, Challenge: command.Challenge, RequestDigest: command.RequestDigest, PayloadBase64: command.PayloadBase64}
	wire, _ := json.Marshal(envelope)
	if connection.SetWriteDeadline(deadline) != nil || WriteFrame(connection, wire, MaxFrameBytes) != nil {
		return false
	}
	select {
	case <-life.Done():
		return false
	case extra := <-commands:
		extra.timer.Stop()
		return false // A queued call/cancel/shutdown terminates; no concurrent calls.
	case frame := <-frames:
		defer frame.timer.Stop()
		var response gatewayStartupEnvelope
		if decodeStrict(frame.raw, &response) != nil || !validGatewayStartupEnvelope(response, "result", command.ConnectionID, sequence) || response.ExchangeID != command.ExchangeID || response.Challenge != command.Challenge || response.RequestDigest != command.RequestDigest {
			return false
		}
		result, err := decodeBase64(response.PayloadBase64, MaxRequestBytes)
		if err != nil || !validJSON(result) || life.Err() != nil || !time.Now().Before(deadline) || !b.currentBundle() {
			return false
		}
		if _, err = connection.Inspect(); err != nil {
			return false
		}
		x := &exchange{connectionID: command.ConnectionID, id: command.ExchangeID, digest: command.RequestDigest, deadline: timestamp(deadline)}
		return b.emit("result", x, command.Challenge, response.PayloadBase64) == nil
	}
}
