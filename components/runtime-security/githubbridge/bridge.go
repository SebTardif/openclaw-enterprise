package githubbridge

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
	"sync"
	"time"

	"github.com/openclaw/openclaw-enterprise/components/runtime-security/identity"
	"github.com/openclaw/openclaw-enterprise/components/runtime-security/servicepeer"
)

type Inspection struct {
	Valid                 bool   `json:"valid"`
	OwnSPIFFEID           string `json:"own_spiffe_id"`
	PeerSPIFFEID          string `json:"peer_spiffe_id"`
	RecipientSPIFFEID     string `json:"recipient_spiffe_id"`
	AuthenticatedAtMs     int64  `json:"authenticated_at_ms"`
	ExpiresAtMs           int64  `json:"expires_at_ms"`
	PeerCertificateSHA256 string `json:"peer_certificate_sha256"`
}
type exchange struct {
	id, digest string
	deadline   time.Time
	reply      chan *Frame
	submitted  bool
}

// retiredExchange contains correlation only; it retains no connection, reply
// buffer, authority or way to restart an executable operation.
type retiredExchange struct {
	connectionID, exchangeID, digest string
	deadlineMs                       int64
}
type session struct {
	ctx        context.Context
	id         string
	connection *servicepeer.Connection
	current    *exchange
	cancel     context.CancelFunc
}
type owner struct {
	ctx              context.Context
	cancel           context.CancelFunc
	input            io.ReadCloser
	output           io.WriteCloser
	profile          Profile
	incarnation      string
	source           *identity.Source
	transport        *servicepeer.Transport
	endpoint         *unixEndpoint
	mu               sync.Mutex
	active           *session
	retired          []string
	retiredExchanges []retiredExchange
	emitMu           sync.Mutex
	sequence         int64
	workers          sync.WaitGroup
}

func identifier() (string, error) {
	var raw [16]byte
	if _, e := rand.Read(raw[:]); e != nil {
		return "", errRejected
	}
	return hex.EncodeToString(raw[:]), nil
}
func digest(raw []byte) string {
	sum := sha256.Sum256(raw)
	return "sha256:" + hex.EncodeToString(sum[:])
}
func (o *owner) current() bool {
	if o.ctx.Err() != nil {
		return false
	}
	view, e := o.source.TrustView()
	return e == nil && view.Metadata.SPIFFEID == o.profile.OwnSPIFFEID && view.CRLCount == 0 && view.BundleSHA256 == o.profile.TrustBundleSHA256
}
func (o *owner) emit(kind string, s *session, x *exchange, challenge string, data []byte) error {
	o.emitMu.Lock()
	defer o.emitMu.Unlock()
	if o.ctx.Err() != nil {
		return errRejected
	}
	o.sequence++
	if o.sequence > 9007199254740991 {
		return errRejected
	}
	c := Control{Version: 1, Kind: kind, Incarnation: o.incarnation, Sequence: o.sequence, Challenge: challenge, MetadataBase64: base64.StdEncoding.EncodeToString(data)}
	if s != nil {
		c.ConnectionID = s.id
	}
	if x != nil {
		c.ExchangeID = x.id
		c.RequestSHA256 = x.digest
		c.DeadlineMs = x.deadline.UnixMilli()
	}
	raw, e := json.Marshal(c)
	if e != nil {
		return errRejected
	}
	timer := time.AfterFunc(time.Duration(o.profile.RequestTimeoutMs)*time.Millisecond, o.cancel)
	defer timer.Stop()
	if WriteControlFrame(o.output, &Frame{Metadata: raw}) != nil {
		o.cancel()
		return errRejected
	}
	return nil
}

// Run owns the actual Workload API Source, protected Unix endpoint, TLS transport
// and original parent pipes. Return follows cancellation and joined native work.
// Each fresh socket receives a fresh session; reconnect has no resume operation.
func Run(parent context.Context, input io.ReadCloser, output io.WriteCloser) error {
	if parent == nil || input == nil || output == nil {
		return errRejected
	}
	ctx, cancel := context.WithCancel(parent)
	o := &owner{ctx: ctx, cancel: cancel, input: input, output: output}
	stopped := make(chan struct{})
	stop := context.AfterFunc(ctx, func() { input.Close(); output.Close(); close(stopped) })
	defer func() {
		cancel()
		if !stop() {
			<-stopped
		}
		input.Close()
		output.Close()
		if o.endpoint != nil {
			o.endpoint.close()
		}
		if o.transport != nil {
			o.transport.Close()
		}
		if o.source != nil {
			o.source.Close()
		}
		o.workers.Wait()
	}()
	timer := time.AfterFunc(3*time.Second, cancel)
	defer timer.Stop()
	boot, e := ReadControlFrame(input)
	if e != nil {
		return errRejected
	}
	defer boot.Clear()
	c, e := decodeControl(boot.Metadata)
	if e != nil || len(boot.Secret) != 0 || c.Kind != "bootstrap" || c.Sequence != 1 || c.ConnectionID != "" || c.ExchangeID != "" || c.RequestSHA256 != "" || c.Challenge != "" || c.DeadlineMs != 0 {
		return errRejected
	}
	p, e := payload(c)
	if e != nil {
		return errRejected
	}
	o.profile, e = ValidateProfile(p)
	if e != nil {
		return errRejected
	}
	o.incarnation = c.Incarnation
	o.source, e = identity.NewSource(identity.Options{SocketPath: o.profile.WorkloadAPISocketPath, ExpectedSPIFFEID: o.profile.OwnSPIFFEID, Timeout: 3 * time.Second})
	if e != nil {
		return errRejected
	}
	if o.source.Start(ctx) != nil || !o.current() {
		return errRejected
	}
	o.transport, e = servicepeer.New(o.source, servicepeer.Config{Side: servicepeer.Server, OwnSPIFFEID: o.profile.OwnSPIFFEID, PeerSPIFFEID: o.profile.PeerSPIFFEID, RecipientSPIFFEID: o.profile.RecipientSPIFFEID, ApplicationProtocol: o.profile.applicationProtocol(), HandshakeTimeout: time.Duration(o.profile.HandshakeTimeoutMs) * time.Millisecond, RecheckInterval: time.Duration(o.profile.RecheckIntervalMs) * time.Millisecond, MaxConnectionAge: time.Duration(o.profile.MaxConnectionAgeMs) * time.Millisecond, MaxConnections: 1})
	if e != nil {
		return errRejected
	}
	o.endpoint, e = listenProtected(o.profile)
	if e != nil {
		return errRejected
	}
	endpointStop := context.AfterFunc(ctx, func() { o.endpoint.listener.Close() })
	defer endpointStop()
	if o.emit("ready", nil, nil, "", nil) != nil || !timer.Stop() || ctx.Err() != nil {
		return errRejected
	}
	o.workers.Add(2)
	go func() { defer o.workers.Done(); o.accept() }()
	go func() {
		defer o.workers.Done()
		t := time.NewTicker(time.Duration(o.profile.RecheckIntervalMs) * time.Millisecond)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if !o.current() {
					cancel()
					return
				}
			}
		}
	}()
	sequence := int64(1)
	for ctx.Err() == nil {
		var first [1]byte
		if _, e := io.ReadFull(input, first[:]); e != nil {
			return errRejected
		}
		partial := time.AfterFunc(time.Duration(o.profile.RequestTimeoutMs)*time.Millisecond, cancel)
		f, e := ReadControlFrame(io.MultiReader(bytes.NewReader(first[:]), input))
		settled := partial.Stop()
		if e != nil || !settled {
			if f != nil {
				f.Clear()
			}
			return errRejected
		}
		c, e := decodeControl(f.Metadata)
		if e != nil || c.Incarnation != o.incarnation || c.Sequence != sequence+1 {
			f.Clear()
			return errRejected
		}
		sequence = c.Sequence
		if c.Kind == "shutdown" {
			hasSecret := len(f.Secret) != 0
			f.Clear()
			if hasSecret || c.ConnectionID != "" || c.ExchangeID != "" || c.RequestSHA256 != "" || c.Challenge != "" || c.MetadataBase64 != "" || c.DeadlineMs != 0 {
				return errRejected
			}
			return nil
		}
		e = o.command(c, f)
		f.Clear()
		if e != nil {
			return errRejected
		}
	}
	return errRejected
}

// Called with o.mu held, exactly when the original exchange is retired.
func (o *owner) retireExchange(s *session, x *exchange) {
	if x == nil {
		return
	}
	o.retiredExchanges = append(o.retiredExchanges, retiredExchange{s.id, x.id, x.digest, x.deadline.UnixMilli()})
	if len(o.retiredExchanges) > 64 {
		o.retiredExchanges = o.retiredExchanges[len(o.retiredExchanges)-64:]
	}
}
func (o *owner) lateCommand(c Control, f *Frame) error {
	// Even a queued token-bearing reply has no live destination now. Erase its
	// original buffer before returning; never acknowledge a socket write.
	f.Clear()
	if c.Kind == "reply" {
		return nil
	}
	raw, _ := json.Marshal(Inspection{})
	return o.emit("inspection", &session{id: c.ConnectionID}, &exchange{id: c.ExchangeID, digest: c.RequestSHA256, deadline: time.UnixMilli(c.DeadlineMs)}, c.Challenge, raw)
}
func (o *owner) command(c Control, f *Frame) error {
	if c.Kind == "close-session" {
		if !noncePattern.MatchString(c.ConnectionID) || c.ExchangeID != "" || c.RequestSHA256 != "" || c.Challenge != "" || c.MetadataBase64 != "" || c.DeadlineMs != 0 || len(f.Secret) != 0 {
			return errRejected
		}
		o.mu.Lock()
		defer o.mu.Unlock()
		if o.active != nil && o.active.id == c.ConnectionID {
			o.active.cancel()
			return nil
		}
		for _, id := range o.retired {
			if id == c.ConnectionID {
				return nil
			}
		}
		return errRejected
	}
	if !noncePattern.MatchString(c.ConnectionID) || !noncePattern.MatchString(c.ExchangeID) || !hashPattern.MatchString(c.RequestSHA256) {
		return errRejected
	}
	if c.Kind != "inspect" && c.Kind != "reply" {
		return errRejected
	}
	if c.Kind == "inspect" && (len(f.Secret) != 0 || !noncePattern.MatchString(c.Challenge) || c.MetadataBase64 != "") {
		return errRejected
	}
	var replyMetadata []byte
	if c.Kind == "reply" {
		if c.Challenge != "" {
			return errRejected
		}
		var err error
		replyMetadata, err = payload(c)
		if err != nil || !validJSON(replyMetadata) {
			return errRejected
		}
	}
	o.mu.Lock()
	s := o.active
	if s == nil || s.id != c.ConnectionID || s.current == nil || s.current.id != c.ExchangeID || s.current.digest != c.RequestSHA256 || s.current.deadline.UnixMilli() != c.DeadlineMs {
		known := false
		for _, old := range o.retiredExchanges {
			if old.connectionID == c.ConnectionID && old.exchangeID == c.ExchangeID && old.digest == c.RequestSHA256 && old.deadlineMs == c.DeadlineMs {
				known = true
				break
			}
		}
		o.mu.Unlock()
		if known {
			return o.lateCommand(c, f)
		}
		return errRejected
	}
	x := s.current
	// Native EOF or the original timer can win before the serve goroutine has
	// published retirement. This is the same terminal exchange, not bad framing.
	if s.ctx.Err() != nil || !time.Now().Before(x.deadline) {
		s.cancel()
		o.mu.Unlock()
		return o.lateCommand(c, f)
	}
	if c.Kind == "reply" {
		if x.submitted {
			o.mu.Unlock()
			return errRejected
		}
		x.submitted = true
		x.reply <- &Frame{Metadata: replyMetadata, Secret: f.Secret}
		f.Secret = nil
		o.mu.Unlock()
		return nil
	}
	o.mu.Unlock()
	observation := Inspection{}
	if time.Now().Before(x.deadline) && o.current() {
		if peer, e := s.connection.Inspect(); e == nil {
			observation = Inspection{Valid: true, OwnSPIFFEID: peer.OwnSPIFFEID, PeerSPIFFEID: peer.PeerSPIFFEID, RecipientSPIFFEID: peer.RecipientSPIFFEID, AuthenticatedAtMs: peer.AuthenticatedAt.UnixMilli(), ExpiresAtMs: peer.ExpiresAt.UnixMilli(), PeerCertificateSHA256: "sha256:" + peer.PeerCertificateSHA256}
		}
	}
	o.mu.Lock()
	still := o.active == s && s.current == x
	o.mu.Unlock()
	if !still || !time.Now().Before(x.deadline) {
		observation = Inspection{}
	}
	raw, _ := json.Marshal(observation)
	return o.emit("inspection", s, x, c.Challenge, raw)
}
func (o *owner) accept() {
	for o.ctx.Err() == nil {
		raw, e := o.endpoint.listener.AcceptUnix()
		if e != nil {
			o.cancel()
			return
		}
		if peerUID(raw, o.profile.PeerUID) != nil {
			raw.Close()
			continue
		}
		o.serve(raw)
	}
}

type readResult struct {
	frame   *Frame
	err     error
	started time.Time
}

func (o *owner) serve(raw net.Conn) {
	life, cancel := context.WithCancel(o.ctx)
	defer cancel()
	connection, e := o.transport.Handshake(life, raw)
	if e != nil {
		return
	}
	defer connection.Close()
	id, e := identifier()
	if e != nil {
		o.cancel()
		return
	}
	s := &session{ctx: life, id: id, connection: connection, cancel: cancel}
	o.mu.Lock()
	o.active = s
	o.mu.Unlock()
	defer func() {
		cancel()
		connection.Close()
		o.mu.Lock()
		x := s.current
		o.retireExchange(s, x)
		s.current = nil
		if o.active == s {
			o.active = nil
		}
		o.retired = append(o.retired, s.id)
		if len(o.retired) > 64 {
			o.retired = o.retired[len(o.retired)-64:]
		}
		o.mu.Unlock()
		if x != nil {
			select {
			case f := <-x.reply:
				f.Clear()
			default:
			}
		}
		_ = o.emit("closed", s, nil, "", nil)
	}()
	frames := make(chan readResult)
	readDone := make(chan struct{})
	go func() {
		defer cancel()
		defer close(readDone)
		for {
			// A partial frame has its own deadline. Waiting for the first byte remains
			// bounded by the actual connection's independent Source/expiry watcher.
			var first [1]byte
			_, err := io.ReadFull(connection, first[:])
			started := time.Now()
			var f *Frame
			if err == nil {
				if connection.SetReadDeadline(time.Now().Add(time.Duration(o.profile.RequestTimeoutMs)*time.Millisecond)) != nil {
					return
				}
				f, err = ReadFrame(io.MultiReader(bytes.NewReader(first[:]), connection))
				_ = connection.SetReadDeadline(time.Time{})
			}
			if err == nil && len(f.Secret) != 0 {
				f.Clear()
				err = errRejected
			}
			select {
			case frames <- readResult{frame: f, err: err, started: started}:
			case <-life.Done():
				if f != nil {
					f.Clear()
				}
				return
			}
			if err != nil {
				return
			}
		}
	}()
	defer func() { cancel(); connection.Close(); <-readDone }()
	state := wireState{version: o.profile.wireVersion()}
	var leaseTimer *time.Timer
	defer func() {
		if leaseTimer != nil {
			leaseTimer.Stop()
		}
	}()
	for life.Err() == nil {
		var read readResult
		select {
		case <-life.Done():
			return
		case read = <-frames:
		}
		if read.err != nil || read.frame == nil {
			return
		}
		request, e := state.request(read.frame.Metadata)
		if e != nil {
			read.frame.Clear()
			return
		}
		peer, e := connection.Inspect()
		if e != nil || !o.current() {
			return
		}
		started := read.started
		deadline := started.Add(time.Duration(o.profile.RequestTimeoutMs) * time.Millisecond)
		if peer.ExpiresAt.Before(deadline) {
			deadline = peer.ExpiresAt
		}
		if state.opened != nil {
			horizon := time.UnixMilli(intAt(state.opened, "operation_until_ms"))
			if horizon.Before(deadline) {
				deadline = horizon
			}
		}
		// Preserve the monotonic request timer while exposing only its shorter
		// integral-millisecond value to the parent.
		remaining := time.Until(deadline)
		deadline = deadline.Truncate(time.Millisecond)
		if remaining <= 0 || !time.Now().Before(deadline) {
			return
		}
		exchangeID, e := identifier()
		if e != nil {
			o.cancel()
			return
		}
		x := &exchange{id: exchangeID, digest: digest(read.frame.Metadata), deadline: deadline, reply: make(chan *Frame, 1)}
		o.mu.Lock()
		s.current = x
		o.mu.Unlock()
		timer := time.AfterFunc(remaining, cancel)
		if o.emit("request", s, x, "", read.frame.Metadata) != nil {
			timer.Stop()
			return
		}
		var reply *Frame
		select {
		case <-life.Done():
			timer.Stop()
			return
		case extra := <-frames:
			if extra.frame != nil {
				extra.frame.Clear()
			}
			timer.Stop()
			return
		case reply = <-x.reply:
		}
		if state.reply(request, reply.Metadata, reply.Secret) != nil || life.Err() != nil || !time.Now().Before(deadline) || !o.current() {
			reply.Clear()
			timer.Stop()
			return
		}
		if _, e := connection.Inspect(); e != nil {
			reply.Clear()
			timer.Stop()
			return
		}
		// Lease time is anchored at this native exchange's original start, never
		// when the parent reply arrived. It can only shorten the independently owned
		// session and cannot resurrect an expired predecessor lease.
		replyValue, _ := decodeObject(reply.Metadata)
		if stringAt(replyValue, "phase") != "recorded" && bytes.Equal(replyValue["ok"], []byte("true")) {
			interval := intAt(replyValue, "valid_until_ms") - intAt(replyValue, "server_time_ms")
			if interval > int64(o.profile.MaxConnectionAgeMs) {
				interval = int64(o.profile.MaxConnectionAgeMs)
			}
			leaseDeadline := started.Add(time.Duration(interval) * time.Millisecond)
			if deadline.Before(leaseDeadline) {
				leaseDeadline = deadline
			}
			operationDeadline := time.UnixMilli(intAt(replyValue, "operation_until_ms"))
			if operationDeadline.Before(leaseDeadline) {
				leaseDeadline = operationDeadline
			}
			if peer.ExpiresAt.Before(leaseDeadline) {
				leaseDeadline = peer.ExpiresAt
			}
			if interval <= 0 || !time.Now().Before(leaseDeadline) || (leaseTimer != nil && !leaseTimer.Stop()) || life.Err() != nil {
				reply.Clear()
				timer.Stop()
				return
			}
			leaseTimer = time.AfterFunc(time.Until(leaseDeadline), cancel)
		}
		if connection.SetWriteDeadline(deadline) != nil {
			reply.Clear()
			timer.Stop()
			return
		}
		e = WriteFrame(connection, reply)
		reply.Clear()
		if e != nil || !timer.Stop() || life.Err() != nil {
			return
		}
		if connection.SetWriteDeadline(time.Time{}) != nil {
			return
		}
		// This acknowledges this socket write only. It does not establish DS
		// consumption, GitHub submission, effect completion or safe replay.
		if o.emit("written", s, x, "", nil) != nil {
			return
		}
		o.mu.Lock()
		if s.current == x {
			o.retireExchange(s, x)
			s.current = nil
		}
		o.mu.Unlock()
		if state.terminal {
			return
		}
	}
}
