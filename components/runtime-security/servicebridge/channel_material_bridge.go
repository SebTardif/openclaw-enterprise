package servicebridge

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"strconv"
	"sync"
	"time"

	"github.com/openclaw/openclaw-enterprise/components/runtime-security/identity"
	"github.com/openclaw/openclaw-enterprise/components/runtime-security/servicepeer"
)

type materialBoot struct {
	SchemaVersion        int             `json:"schemaVersion"`
	Incarnation          string          `json:"incarnation"`
	ConfigurationVersion int64           `json:"configurationVersion"`
	ProfileDigest        string          `json:"profileDigest"`
	Profile              json.RawMessage `json:"profile"`
	Address              string          `json:"address"`
	Deadline             string          `json:"deadline"`
}

// The same envelope is forwarded without copying its opaque result frame.
// One connection has one sequence/exchange; inspect challenges are fresh and
// local. None of these serialized fields is a transferable authority proof.
type materialEnvelope struct {
	SchemaVersion int             `json:"schemaVersion"`
	Sequence      int64           `json:"sequence"`
	ConnectionID  string          `json:"connectionId"`
	ExchangeID    string          `json:"exchangeId"`
	Challenge     string          `json:"challenge"`
	RequestDigest string          `json:"requestDigest"`
	Deadline      string          `json:"deadline"`
	Message       json.RawMessage `json:"message"`
}
type materialDeliveryHeader struct {
	SchemaVersion int    `json:"schemaVersion"`
	Purpose       string `json:"purpose"`
	Use           string `json:"use"`
	RequestRef    string `json:"requestRef"`
	Kind          string `json:"kind"`
}
type materialRequestBody struct {
	RequestRef string          `json:"requestRef"`
	Request    json.RawMessage `json:"request"`
}
type materialRead struct {
	frame *materialFrame
	err   error
}
type materialFirst struct {
	byte byte
	err  error
}

type materialChannel struct {
	ctx        context.Context
	cancel     context.CancelFunc
	input      io.ReadCloser
	output     io.WriteCloser
	boot       materialBoot
	base       *bridge
	connection *servicepeer.Connection
	listener   net.Listener
	deadline   time.Time
	workers    sync.WaitGroup
	interrupts []func()
}

func (m *materialChannel) interrupt(action func()) {
	done := make(chan struct{})
	stop := context.AfterFunc(m.ctx, func() { action(); close(done) })
	m.interrupts = append(m.interrupts, func() {
		if !stop() {
			<-done
		}
	})
}

func (m *materialChannel) current() bool {
	if m.ctx.Err() != nil || !time.Now().Before(m.deadline) || !m.base.currentBundle() {
		return false
	}
	if m.connection != nil {
		_, err := m.connection.Inspect()
		return err == nil
	}
	return true
}
func (m *materialChannel) closeIO() {
	m.input.Close()
	m.output.Close()
	if m.listener != nil {
		m.listener.Close()
	}
	if m.connection != nil {
		m.connection.Close()
	}
}
func (m *materialChannel) metadata(writer io.Writer, kind byte, value any) error {
	if !m.current() {
		return errProtocol
	}
	f, err := newMaterialMetadataFrame(kind, value)
	if err != nil {
		return errProtocol
	}
	defer f.release()
	return writeMaterialFrame(writer, f)
}
func (m *materialChannel) first(reader io.Reader) <-chan materialFirst {
	channel := make(chan materialFirst)
	m.workers.Add(1)
	go func() {
		defer m.workers.Done()
		var first [1]byte
		_, err := io.ReadFull(reader, first[:])
		if err != nil {
			m.cancel()
		}
		select {
		case channel <- materialFirst{first[0], err}:
		case <-m.ctx.Done():
		}
	}()
	return channel
}
func (m *materialChannel) parentFrame(metadataOnly bool) <-chan materialRead {
	channel := make(chan materialRead)
	m.workers.Add(1)
	go func() {
		defer m.workers.Done()
		reader := io.Reader(m.input)
		if metadataOnly {
			reader = io.LimitReader(reader, MaterialMetadataBytes+7)
		}
		frame, err := readMaterialFrame(reader)
		if err != nil {
			m.cancel()
			return
		}
		if metadataOnly && len(frame.payload) != 0 {
			frame.release()
			m.cancel()
			return
		}
		select {
		case channel <- materialRead{frame, nil}:
		case <-m.ctx.Done():
			frame.release()
		}
	}()
	return channel
}

// Keeps the typed inner observation until the single bounded frame writer
// encodes it; there is no separate marshaled inner-message backing.
func materialMessage(e materialEnvelope, message any) any {
	return struct {
		SchemaVersion int    `json:"schemaVersion"`
		Sequence      int64  `json:"sequence"`
		ConnectionID  string `json:"connectionId"`
		ExchangeID    string `json:"exchangeId"`
		Challenge     string `json:"challenge"`
		RequestDigest string `json:"requestDigest"`
		Deadline      string `json:"deadline"`
		Message       any    `json:"message"`
	}{e.SchemaVersion, e.Sequence, e.ConnectionID, e.ExchangeID, e.Challenge, e.RequestDigest, e.Deadline, message}
}

func sameMaterialCall(a, b materialEnvelope) bool {
	return a.SchemaVersion == 1 && a.Sequence == 1 && a.ConnectionID == b.ConnectionID &&
		a.ExchangeID == b.ExchangeID && a.RequestDigest == b.RequestDigest && a.Deadline == b.Deadline
}
func materialCall(e materialEnvelope) bool {
	_, err := parseTime(e.Deadline)
	return e.SchemaVersion == 1 && e.Sequence == 1 && idPattern.MatchString(e.ConnectionID) &&
		idPattern.MatchString(e.ExchangeID) && idPattern.MatchString(e.Challenge) &&
		digestPattern.MatchString(e.RequestDigest) && err == nil
}
func materialRequestValue(e materialEnvelope) (materialRequestBody, string, error) {
	var body materialRequestBody
	var purpose struct {
		Purpose string `json:"purpose"`
		Use     string `json:"use"`
	}
	if decodeStrict(e.Message, &body) != nil || !refPattern.MatchString(body.RequestRef) ||
		len(body.Request) > MaterialMetadataBytes || !validJSON(body.Request) ||
		json.Unmarshal(body.Request, &purpose) != nil || purpose.Purpose != materialPurpose ||
		(purpose.Use != "startup-slack-pair" && purpose.Use != "teams-invocation-token") ||
		digest(body.Request) != e.RequestDigest {
		return materialRequestBody{}, "", errProtocol
	}
	body.Request = nil
	return body, purpose.Use, nil
}
func materialReply(f *materialFrame, e, request materialEnvelope, body materialRequestBody, use string) bool {
	var header materialDeliveryHeader
	if f.kind != materialResult || !sameMaterialCall(e, request) || e.Challenge != request.Challenge ||
		decodeStrict(e.Message, &header) != nil || header.SchemaVersion != 1 || header.Purpose != materialPurpose ||
		header.Use != use || header.RequestRef != body.RequestRef {
		return false
	}
	if header.Kind == "selected-bundle" {
		return len(f.payload) > 0
	}
	return len(f.payload) == 0 && (header.Kind == "denied" || header.Kind == "unavailable" || header.Kind == "recovery-required")
}

func (m *materialChannel) connected(e materialEnvelope) error {
	inspection, err := gatewayInspection(m.connection)
	if err != nil {
		return errProtocol
	}
	message := struct {
		Incarnation          string     `json:"incarnation"`
		ConfigurationVersion int64      `json:"configurationVersion"`
		ProfileDigest        string     `json:"profileDigest"`
		Inspection           Inspection `json:"inspection"`
		ExpiresAt            string     `json:"expiresAt"`
	}{m.boot.Incarnation, m.boot.ConfigurationVersion, m.boot.ProfileDigest, inspection, timestamp(m.deadline)}
	return m.metadata(m.output, materialConnected, materialMessage(e, message))
}

func (m *materialChannel) serve() error {
	connectionID, err := identifier()
	if err != nil {
		return errProtocol
	}
	exchangeID, err := identifier()
	if err != nil {
		return errProtocol
	}
	challenge, err := identifier()
	if err != nil {
		return errProtocol
	}
	hello := materialEnvelope{SchemaVersion: 1, Sequence: 1, ConnectionID: connectionID, ExchangeID: exchangeID, Challenge: challenge, Message: json.RawMessage(`{}`)}
	if m.connected(hello) != nil || m.metadata(m.connection, materialConnected, hello) != nil {
		return errProtocol
	}
	f, err := readMaterialFrame(io.LimitReader(m.connection, MaterialMetadataBytes+7))
	if err != nil {
		return errProtocol
	}
	var request materialEnvelope
	valid := f.kind == materialRequest && decodeStrict(f.header, &request) == nil && materialCall(request) &&
		request.ConnectionID == connectionID && request.ExchangeID == exchangeID && request.Challenge == challenge
	f.release()
	if !valid {
		return errProtocol
	}
	body, use, err := materialRequestValue(request)
	if err != nil {
		return errProtocol
	}
	originalDeadline, _ := parseTime(request.Deadline)
	callDeadline := m.deadline
	if originalDeadline.Before(callDeadline) {
		callDeadline = originalDeadline
	}
	if !m.current() || !time.Now().Before(callDeadline) || m.connection.SetDeadline(callDeadline) != nil {
		return errProtocol
	}
	timer := time.AfterFunc(time.Until(callDeadline), m.cancel)
	defer timer.Stop()
	first := m.first(m.connection)
	if m.metadata(m.output, materialRequest, request) != nil {
		return errProtocol
	}
	request.Message = nil
	parents := m.parentFrame(false)
	for {
		select {
		case <-m.ctx.Done():
			return errProtocol
		case <-first:
			return errProtocol // Early input/EOF is never a queued call or acknowledgement.
		case value := <-parents:
			frame := value.frame
			var command materialEnvelope
			if decodeStrict(frame.header, &command) != nil || !sameMaterialCall(command, request) {
				frame.release()
				return errProtocol
			}
			if frame.kind == materialInspect {
				frame.release()
				if !idPattern.MatchString(command.Challenge) || string(command.Message) != "{}" {
					return errProtocol
				}
				inspection, err := gatewayInspection(m.connection)
				if err != nil {
					return errProtocol
				}
				command.Message = nil
				if m.metadata(m.output, materialInspected, materialMessage(command, inspection)) != nil {
					return errProtocol
				}
				parents = m.parentFrame(false)
				continue
			}
			if !materialReply(frame, command, request, body, use) || !m.current() {
				frame.release()
				return errProtocol
			}
			if writeMaterialFrame(m.connection, frame) != nil || !m.current() {
				frame.release()
				return errProtocol
			}
			frame.release()
			// The fixed recipient retires its bounded original borrow before acknowledgement.
			// This is transport settlement only, not provider use or new authority.
			var beginning materialFirst
			select {
			case <-m.ctx.Done():
				return errProtocol
			case beginning = <-first:
			}
			if beginning.err != nil {
				return errProtocol
			}
			ack, err := readMaterialFrame(io.LimitReader(io.MultiReader(bytesReader([]byte{beginning.byte}), m.connection), MaterialMetadataBytes+7))
			if err != nil {
				return errProtocol
			}
			var complete materialEnvelope
			ok := ack.kind == materialCompleted && decodeStrict(ack.header, &complete) == nil && sameMaterialCall(complete, request) && complete.Challenge == request.Challenge && string(complete.Message) == "{}"
			ack.release()
			if !ok || !m.current() {
				return errProtocol
			}
			if m.metadata(m.output, materialCompleted, complete) != nil {
				return errProtocol
			}
			// The recipient still performs its final currentness check after its
			// payload borrow retires. Keep this same bounded connection until that
			// original recipient closes it; an acknowledgement never renews it.
			var retired [1]byte
			if _, err := io.ReadFull(m.connection, retired[:]); err != io.EOF {
				return errProtocol
			}
			return nil
		}
	}
}

func (m *materialChannel) client() error {
	helloFrame, err := readMaterialFrame(io.LimitReader(m.connection, MaterialMetadataBytes+7))
	if err != nil {
		return errProtocol
	}
	var hello materialEnvelope
	ok := helloFrame.kind == materialConnected && decodeStrict(helloFrame.header, &hello) == nil &&
		hello.SchemaVersion == 1 && hello.Sequence == 1 && idPattern.MatchString(hello.ConnectionID) &&
		idPattern.MatchString(hello.ExchangeID) && idPattern.MatchString(hello.Challenge) &&
		hello.RequestDigest == "" && hello.Deadline == "" && string(hello.Message) == "{}"
	helloFrame.release()
	if !ok || m.connected(hello) != nil {
		return errProtocol
	}
	parents := m.parentFrame(true)
	var input materialRead
	select {
	case <-m.ctx.Done():
		return errProtocol
	case input = <-parents:
	}
	var request materialEnvelope
	ok = input.frame.kind == materialRequest && decodeStrict(input.frame.header, &request) == nil && materialCall(request) &&
		request.ConnectionID == hello.ConnectionID && request.ExchangeID == hello.ExchangeID && request.Challenge == hello.Challenge
	input.frame.release()
	if !ok {
		return errProtocol
	}
	body, use, err := materialRequestValue(request)
	if err != nil {
		return errProtocol
	}
	originalDeadline, _ := parseTime(request.Deadline)
	callDeadline := m.deadline
	if originalDeadline.Before(callDeadline) {
		callDeadline = originalDeadline
	}
	if !m.current() || !time.Now().Before(callDeadline) || m.connection.SetDeadline(callDeadline) != nil {
		return errProtocol
	}
	timer := time.AfterFunc(time.Until(callDeadline), m.cancel)
	defer timer.Stop()
	if m.metadata(m.connection, materialRequest, request) != nil {
		return errProtocol
	}
	request.Message = nil
	parentFirst := m.first(m.input)
	responses := make(chan materialRead)
	m.workers.Add(1)
	go func() {
		defer m.workers.Done()
		f, e := readMaterialFrame(m.connection)
		select {
		case responses <- materialRead{f, e}:
		case <-m.ctx.Done():
			if f != nil {
				f.release()
			}
		}
	}()
	var response materialRead
	select {
	case <-m.ctx.Done():
		return errProtocol
	case <-parentFirst:
		return errProtocol
	case response = <-responses:
	}
	if response.err != nil {
		return errProtocol
	}
	var result materialEnvelope
	ok = decodeStrict(response.frame.header, &result) == nil && materialReply(response.frame, result, request, body, use) && m.current()
	if !ok {
		response.frame.release()
		return errProtocol
	}
	loss := m.first(m.connection)
	if writeMaterialFrame(m.output, response.frame) != nil || !m.current() {
		response.frame.release()
		return errProtocol
	}
	response.frame.release()
	var beginning materialFirst
	select {
	case <-m.ctx.Done():
		return errProtocol
	case <-loss:
		return errProtocol
	case beginning = <-parentFirst:
	}
	if beginning.err != nil {
		return errProtocol
	}
	ackFrame, err := readMaterialFrame(io.LimitReader(io.MultiReader(bytesReader([]byte{beginning.byte}), m.input), MaterialMetadataBytes+7))
	if err != nil {
		return errProtocol
	}
	ack := materialRead{frame: ackFrame}
	var completed materialEnvelope
	ok = ack.frame.kind == materialCompleted && decodeStrict(ack.frame.header, &completed) == nil && sameMaterialCall(completed, request) && completed.Challenge == request.Challenge && string(completed.Message) == "{}"
	ack.frame.release()
	if !ok || !m.current() {
		return errProtocol
	}
	if m.metadata(m.connection, materialCompleted, completed) != nil {
		return errProtocol
	}
	// Only the original parent may retire this connection after its final
	// currentness check. Source/peer loss and the existing absolute deadline
	// still interrupt this wait; no second frame or call is accepted.
	var retired [1]byte
	if _, err := io.ReadFull(m.input, retired[:]); err != io.EOF {
		return errProtocol
	}
	return nil
}

// Dedicated modes own a separate one-call connection and both original pipes.
// The trusted parent must derive bootstrap deadline/cancellation from its real
// consumed startup lifetime. Native TLS never supplies that accepting policy.
func RunChannelMaterialServer(ctx context.Context, input io.ReadCloser, output io.WriteCloser) error {
	return runMaterial(ctx, input, output, false)
}
func RunChannelMaterialClient(ctx context.Context, input io.ReadCloser, output io.WriteCloser) error {
	return runMaterial(ctx, input, output, true)
}

func runMaterial(parent context.Context, input io.ReadCloser, output io.WriteCloser, client bool) error {
	if parent == nil || input == nil || output == nil {
		return errProtocol
	}
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	m := &materialChannel{ctx: ctx, cancel: cancel, input: input, output: output, deadline: time.Now().Add(5 * time.Second)}
	m.base = &bridge{ctx: ctx, cancel: cancel, input: input, output: output}
	stopped := make(chan struct{})
	stop := context.AfterFunc(ctx, func() { input.Close(); output.Close(); close(stopped) })
	defer func() {
		cancel()
		if !stop() {
			<-stopped
		}
		m.closeIO()
		for _, join := range m.interrupts {
			join()
		}
		if m.base.transport != nil {
			m.base.transport.Close()
		}
		if m.base.source != nil {
			m.base.source.Close()
		}
		m.workers.Wait()
	}()
	f, err := readMaterialFrame(io.LimitReader(input, MaterialMetadataBytes+7))
	if err != nil {
		return errProtocol
	}
	ok := f.kind == materialBootstrap && decodeStrict(f.header, &m.boot) == nil
	f.release()
	if !ok || m.boot.SchemaVersion != 1 || !idPattern.MatchString(m.boot.Incarnation) ||
		m.boot.ConfigurationVersion < 1 || m.boot.ConfigurationVersion > 9007199254740991 || digest(m.boot.Profile) != m.boot.ProfileDigest {
		return errProtocol
	}
	m.base.profile, err = validateMaterialProfile(m.boot.Profile, client)
	if err != nil {
		return errProtocol
	}
	deadline, err := parseTime(m.boot.Deadline)
	if err != nil || !time.Now().Before(deadline) {
		return errProtocol
	}
	if deadline.Before(m.deadline) {
		m.deadline = deadline
	}
	timer := time.AfterFunc(time.Until(m.deadline), cancel)
	defer timer.Stop()
	host, port, err := net.SplitHostPort(m.boot.Address)
	number, numberErr := strconv.Atoi(port)
	if err != nil || numberErr != nil || number < 1 || number > 65535 || strconv.Itoa(number) != port || net.ParseIP(host) == nil {
		return errProtocol
	}
	p := m.base.profile
	m.base.source, err = identity.NewSource(identity.Options{SocketPath: p.WorkloadAPISocketPath, ExpectedSPIFFEID: p.OwnSPIFFEID, Timeout: 3 * time.Second})
	if err != nil || m.base.source.Start(ctx) != nil || !m.current() {
		return errProtocol
	}
	side := servicepeer.Server
	if client {
		side = servicepeer.Client
	}
	m.base.transport, err = servicepeer.New(m.base.source, servicepeer.Config{Side: side, OwnSPIFFEID: p.OwnSPIFFEID, PeerSPIFFEID: p.PeerSPIFFEID, RecipientSPIFFEID: p.RecipientSPIFFEID, HandshakeTimeout: 3 * time.Second, RecheckInterval: time.Second, MaxConnectionAge: 5 * time.Second, MaxConnections: 1})
	if err != nil {
		return errProtocol
	}
	var raw net.Conn
	if client {
		raw, err = (&net.Dialer{Timeout: 3 * time.Second}).DialContext(ctx, "tcp", m.boot.Address)
	} else {
		m.listener, err = net.Listen("tcp", m.boot.Address)
		if err == nil {
			listener := m.listener
			m.interrupt(func() { listener.Close() })
		}
		if err == nil {
			err = m.metadata(output, materialReady, struct {
				SchemaVersion        int    `json:"schemaVersion"`
				Incarnation          string `json:"incarnation"`
				ConfigurationVersion int64  `json:"configurationVersion"`
				ProfileDigest        string `json:"profileDigest"`
				Address              string `json:"address"`
			}{1, m.boot.Incarnation, m.boot.ConfigurationVersion, m.boot.ProfileDigest, m.listener.Addr().String()})
		}
		if err == nil {
			raw, err = m.listener.Accept()
			m.listener.Close()
		}
	}
	if err != nil {
		return errProtocol
	}
	m.connection, err = m.base.transport.Handshake(ctx, raw)
	if err != nil {
		raw.Close()
		return errProtocol
	}
	connection := m.connection
	m.interrupt(func() { connection.Close() })
	if m.connection.SetDeadline(m.deadline) != nil || !m.current() {
		return errProtocol
	}
	m.workers.Add(1)
	go func() {
		defer m.workers.Done()
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if !m.current() {
					cancel()
					return
				}
			}
		}
	}()
	if client {
		return m.client()
	}
	return m.serve()
}
