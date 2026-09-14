// Package servicepeer authenticates exact X.509-SVID peers on owned in-process
// TLS connections. It supplies no service roles, runtime authority, enrollment,
// remote proof forwarding, or application revocation registry.
package servicepeer

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"os"
	"sync"
	"time"

	"github.com/openclaw/openclaw-enterprise/components/runtime-security/identity"
	"github.com/spiffe/go-spiffe/v2/bundle/x509bundle"
	"github.com/spiffe/go-spiffe/v2/spiffeid"
	"github.com/spiffe/go-spiffe/v2/spiffetls/tlsconfig"
	"github.com/spiffe/go-spiffe/v2/svid/x509svid"
)

type Side string

const (
	Client Side = "client"
	Server Side = "server"
)

// Config requires explicit limits. RecipientSPIFFEID names the server, not a caller
// assertion or an arbitrary destination. Only one explicitly selected trust
// domain is supported; federation and CRL-bearing sources are not supported.
type Config struct {
	Side                Side
	OwnSPIFFEID         string
	PeerSPIFFEID        string
	RecipientSPIFFEID   string
	ApplicationProtocol string        // optional exact ALPN; when set, 1..255 visible ASCII bytes
	HandshakeTimeout    time.Duration // positive, at most three seconds
	RecheckInterval     time.Duration // positive, at most five seconds
	MaxConnectionAge    time.Duration // positive, explicitly chosen by the caller
	MaxConnections      int           // 1..64, including handshakes
}

// Error intentionally excludes certificate, provider, endpoint and key details.
type Error struct {
	Code      string
	timeout   bool
	temporary bool
	// Only well-known, detail-free sentinels may be retained here.
	sentinel error
}

func (e *Error) Error() string   { return "Service peer transport failed (" + e.Code + ")." }
func failure(code string) *Error { return &Error{Code: code} }

func (e *Error) Timeout() bool   { return e.timeout || e.Code == "TIMEOUT" }
func (e *Error) Temporary() bool { return e.temporary }
func (e *Error) Unwrap() error   { return e.sentinel }

// sanitizeIO preserves reader termination and useful network classifications,
// never the underlying error: net/tls errors can contain endpoints or peer data.
func sanitizeIO(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, io.EOF) {
		return io.EOF
	}
	if errors.Is(err, io.ErrUnexpectedEOF) {
		return io.ErrUnexpectedEOF
	}
	result := failure("IO_FAILED")
	var networkError net.Error
	if errors.As(err, &networkError) {
		result.timeout = networkError.Timeout()
		result.temporary = networkError.Temporary()
	}
	for _, sentinel := range []error{os.ErrDeadlineExceeded, context.DeadlineExceeded, context.Canceled, net.ErrClosed, io.ErrClosedPipe} {
		if errors.Is(err, sentinel) {
			result.sentinel = sentinel
			break
		}
	}
	switch {
	case result.timeout:
		result.Code = "TIMEOUT"
	case result.sentinel == context.Canceled:
		result.Code = "ABORTED"
	case result.sentinel == net.ErrClosed || result.sentinel == io.ErrClosedPipe:
		result.Code = "CONNECTION_ENDED"
	}
	return result
}

// Peer is diagnostic metadata, not an authenticated connection or permission.
type Peer struct {
	OwnSPIFFEID           string
	PeerSPIFFEID          string
	RecipientSPIFFEID     string
	AuthenticatedAt       time.Time
	ExpiresAt             time.Time
	PeerCertificateSHA256 string
}

// Transport borrows an initialized Source. Close never closes that source.
// An instance and its connection handles must not be copied after construction.
type Transport struct {
	self   *Transport
	source *identity.Source
	config Config
	own    spiffeid.ID
	peer   spiffeid.ID
	mu     sync.Mutex
	work   sync.WaitGroup
	closed bool
	conns  map[*Connection]struct{}
}

func New(source *identity.Source, config Config) (*Transport, error) {
	own, ownErr := spiffeid.FromString(config.OwnSPIFFEID)
	peer, peerErr := spiffeid.FromString(config.PeerSPIFFEID)
	if source == nil || ownErr != nil || peerErr != nil || own.Path() == "" || peer.Path() == "" ||
		own.String() != config.OwnSPIFFEID || peer.String() != config.PeerSPIFFEID ||
		len(config.OwnSPIFFEID) > 2048 || len(config.PeerSPIFFEID) > 2048 ||
		own.TrustDomain() != peer.TrustDomain() ||
		(config.Side != Client && config.Side != Server) ||
		(config.Side == Client && config.RecipientSPIFFEID != config.PeerSPIFFEID) ||
		(config.Side == Server && config.RecipientSPIFFEID != config.OwnSPIFFEID) ||
		!validApplicationProtocol(config.ApplicationProtocol) ||
		config.HandshakeTimeout <= 0 || config.HandshakeTimeout > 3*time.Second ||
		config.RecheckInterval <= 0 || config.RecheckInterval > 5*time.Second ||
		config.MaxConnectionAge <= 0 || config.MaxConnections < 1 || config.MaxConnections > 64 {
		return nil, failure("INVALID_CONFIGURATION")
	}
	t := &Transport{source: source, config: config, own: own, peer: peer, conns: make(map[*Connection]struct{})}
	t.self = t
	if _, err := t.material(); err != nil {
		return nil, err
	}
	return t, nil
}

func validApplicationProtocol(protocol string) bool {
	if len(protocol) > 255 {
		return false
	}
	for index := range len(protocol) {
		if protocol[index] < 0x21 || protocol[index] > 0x7e {
			return false
		}
	}
	return true
}

type material struct {
	svid   *x509svid.SVID
	bundle *x509bundle.Bundle
}

// The maintained verifier checks chain trust and the SPIFFE identity. Its
// ExtKeyUsageAny chain verification does not enforce the leaf usage profile.
// X.509-SVID sections 4.3 and 4.4 additionally require critical digitalSignature
// key usage, and both clientAuth and serverAuth when an EKU extension is present.
func validLeafUsage(cert *x509.Certificate) bool {
	if cert == nil || cert.KeyUsage&x509.KeyUsageDigitalSignature == 0 {
		return false
	}
	criticalKeyUsage, hasExtendedKeyUsage := false, false
	for _, extension := range cert.Extensions {
		if extension.Id.Equal([]int{2, 5, 29, 15}) {
			criticalKeyUsage = extension.Critical
		}
		if extension.Id.Equal([]int{2, 5, 29, 37}) {
			hasExtendedKeyUsage = true
		}
	}
	if !criticalKeyUsage {
		return false
	}
	if !hasExtendedKeyUsage {
		return true
	}
	client, server := false, false
	for _, usage := range cert.ExtKeyUsage {
		client = client || usage == x509.ExtKeyUsageClientAuth
		server = server || usage == x509.ExtKeyUsageServerAuth
	}
	return client && server
}

// A fresh snapshot is obtained on every check; the borrowed Source owns stream
// failure/expiry withdrawal. No retained snapshot can keep this adapter healthy.
func (t *Transport) material() (material, error) {
	if t == nil || t.self != t {
		return material{}, failure("INVALID_HANDLE")
	}
	t.mu.Lock()
	closed := t.closed
	t.mu.Unlock()
	if closed {
		return material{}, failure("CLOSED")
	}
	metadata, err := t.source.Metadata()
	if err != nil || metadata.SPIFFEID != t.config.OwnSPIFFEID {
		return material{}, failure("SOURCE_UNAVAILABLE")
	}
	snapshot, err := t.source.Snapshot()
	if err != nil {
		return material{}, failure("SOURCE_UNAVAILABLE")
	}
	defer clear(snapshot.PrivateKey)
	if snapshot.SPIFFEID != t.config.OwnSPIFFEID || len(snapshot.CRLs) != 0 {
		return material{}, failure("SOURCE_UNSUPPORTED")
	}
	svid, err := x509svid.ParseRaw(bytes.Join(snapshot.CertificateChain, nil), snapshot.PrivateKey)
	if err != nil || svid.ID != t.own || !validLeafUsage(svid.Certificates[0]) {
		return material{}, failure("SOURCE_UNAVAILABLE")
	}
	bundle, err := x509bundle.ParseRaw(t.own.TrustDomain(), bytes.Join(snapshot.Bundle, nil))
	if err != nil {
		return material{}, failure("SOURCE_UNAVAILABLE")
	}
	// Verify our acquired material as well as its parsed profile. The separate
	// remote handshake is what establishes possession of the peer's private key.
	if _, _, err = x509svid.Verify(svid.Certificates, bundle); err != nil {
		return material{}, failure("SOURCE_UNAVAILABLE")
	}
	return material{svid: svid, bundle: bundle}, nil
}

type handshakeSource struct {
	transport      *Transport
	mu             sync.Mutex
	ownCertificate []byte
}

func (s *handshakeSource) GetX509SVID() (*x509svid.SVID, error) {
	m, err := s.transport.material()
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	s.ownCertificate = bytes.Clone(m.svid.Certificates[0].Raw)
	s.mu.Unlock()
	return m.svid, nil
}

func (s *handshakeSource) GetX509BundleForTrustDomain(domain spiffeid.TrustDomain) (*x509bundle.Bundle, error) {
	if domain != s.transport.own.TrustDomain() {
		return nil, failure("PEER_REJECTED")
	}
	m, err := s.transport.material()
	if err != nil {
		return nil, err
	}
	return m.bundle, nil
}

// Connection keeps the real TLS transport private. Copying the exported value
// does not copy its ownership; only the originally returned pointer is usable.
type Connection struct {
	self             *Connection
	owner            *Transport
	raw              net.Conn
	tls              *tls.Conn
	ctx              context.Context
	checkMu          sync.Mutex
	mu               sync.Mutex
	closed           bool
	cause            error
	done             chan struct{}
	finished         chan struct{}
	peer             Peer
	peerCertificates []*x509.Certificate
	ownCertificate   []byte
}

// Handshake takes ownership of raw even when authentication fails. The caller's
// context controls the returned connection lifetime, not just the handshake.
func (t *Transport) Handshake(ctx context.Context, raw net.Conn) (*Connection, error) {
	if raw == nil {
		return nil, failure("INVALID_CONFIGURATION")
	}
	if t == nil || t.self != t || ctx == nil {
		raw.Close()
		return nil, failure("INVALID_CONFIGURATION")
	}
	c := &Connection{owner: t, raw: raw, ctx: ctx, done: make(chan struct{}), finished: make(chan struct{})}
	c.self = c
	t.mu.Lock()
	if t.closed || len(t.conns) >= t.config.MaxConnections {
		t.mu.Unlock()
		raw.Close()
		return nil, failure("CLOSED_OR_LIMIT")
	}
	t.conns[c] = struct{}{}
	t.work.Add(1)
	t.mu.Unlock()
	watching := false
	defer func() {
		if !watching {
			close(c.finished)
			t.work.Done()
		}
	}()
	source := &handshakeSource{transport: t}
	var config *tls.Config
	if t.config.Side == Client {
		config = tlsconfig.MTLSClientConfig(source, source, tlsconfig.AuthorizeID(t.peer))
	} else {
		config = tlsconfig.MTLSServerConfig(source, source, tlsconfig.AuthorizeID(t.peer))
	}
	config.MinVersion = tls.VersionTLS13
	config.MaxVersion = tls.VersionTLS13
	if t.config.ApplicationProtocol != "" {
		config.NextProtos = []string{t.config.ApplicationProtocol}
	}
	verifyPeer := config.VerifyPeerCertificate
	config.VerifyPeerCertificate = func(raw [][]byte, chains [][]*x509.Certificate) error {
		if len(raw) == 0 || len(raw) > 64 {
			return failure("PEER_REJECTED")
		}
		bytes := 0
		for _, cert := range raw {
			bytes += len(cert)
			if bytes > 4<<20 {
				return failure("PEER_REJECTED")
			}
		}
		if err := verifyPeer(raw, chains); err != nil {
			return err
		}
		leaf, err := x509.ParseCertificate(raw[0])
		if err != nil || !validLeafUsage(leaf) {
			return failure("PEER_REJECTED")
		}
		return nil
	}
	// Resumption skips certificate callbacks on some paths. This component
	// deliberately supports fresh handshakes only, with no ticket/cache reuse.
	config.SessionTicketsDisabled = true
	config.ClientSessionCache = nil
	if t.config.Side == Client {
		c.tls = tls.Client(raw, config)
	} else {
		c.tls = tls.Server(raw, config)
	}
	operation, cancel := context.WithTimeout(ctx, t.config.HandshakeTimeout)
	stop := context.AfterFunc(operation, func() { c.closeWithError(contextError(operation.Err())) })
	deadline, _ := operation.Deadline()
	err := raw.SetDeadline(deadline)
	if err == nil {
		err = c.tls.HandshakeContext(operation)
	}
	stopped := stop()
	if err != nil || operation.Err() != nil || !stopped {
		cause := failure("HANDSHAKE_FAILED")
		if operation.Err() != nil {
			cause = contextError(operation.Err())
		}
		cancel()
		c.closeWithError(cause)
		return nil, cause
	}
	cancel()
	if err = raw.SetDeadline(time.Time{}); err != nil {
		c.closeWithError(failure("HANDSHAKE_FAILED"))
		return nil, failure("HANDSHAKE_FAILED")
	}
	state := c.tls.ConnectionState()
	source.mu.Lock()
	c.ownCertificate = bytes.Clone(source.ownCertificate)
	source.mu.Unlock()
	if !state.HandshakeComplete || state.DidResume || len(state.PeerCertificates) == 0 || len(c.ownCertificate) == 0 ||
		(t.config.ApplicationProtocol != "" && state.NegotiatedProtocol != t.config.ApplicationProtocol) {
		c.closeWithError(failure("PEER_REJECTED"))
		return nil, failure("PEER_REJECTED")
	}
	c.peerCertificates = state.PeerCertificates
	now := time.Now()
	expires := now.Add(t.config.MaxConnectionAge)
	for _, cert := range state.PeerCertificates {
		if cert.NotAfter.Before(expires) {
			expires = cert.NotAfter
		}
	}
	ownCert, parseErr := x509.ParseCertificate(c.ownCertificate)
	if parseErr != nil {
		c.closeWithError(failure("PEER_REJECTED"))
		return nil, failure("PEER_REJECTED")
	}
	if ownCert.NotAfter.Before(expires) {
		expires = ownCert.NotAfter
	}
	digest := sha256.Sum256(state.PeerCertificates[0].Raw)
	c.peer = Peer{OwnSPIFFEID: t.config.OwnSPIFFEID, PeerSPIFFEID: t.config.PeerSPIFFEID,
		RecipientSPIFFEID: t.config.RecipientSPIFFEID, AuthenticatedAt: now.UTC(), ExpiresAt: expires.UTC(), PeerCertificateSHA256: hex.EncodeToString(digest[:])}
	if _, err = c.Inspect(); err != nil {
		return nil, err
	}
	watching = true
	go c.watch()
	return c, nil
}

func contextError(err error) *Error {
	if errors.Is(err, context.DeadlineExceeded) {
		return failure("TIMEOUT")
	}
	return failure("ABORTED")
}

func (c *Connection) current() error {
	if c == nil || c.self != c {
		return failure("INVALID_HANDLE")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return c.cause
	}
	return nil
}

// Inspect rechecks the actual source, current trust and both certificates.
// It authenticates no service role or runtime operation. Source observations
// lack a policy/bundle monotonic ledger; application revocation remains separate.
func (c *Connection) Inspect() (Peer, error) {
	if c == nil || c.self != c {
		return Peer{}, failure("INVALID_HANDLE")
	}
	c.checkMu.Lock()
	defer c.checkMu.Unlock()
	if err := c.current(); err != nil {
		return Peer{}, err
	}
	var err error
	if c.ctx.Err() != nil {
		err = contextError(c.ctx.Err())
	} else if !time.Now().Before(c.peer.ExpiresAt) {
		err = failure("EXPIRED")
	}
	if err == nil {
		var m material
		m, err = c.owner.material()
		if err == nil && !bytes.Equal(c.ownCertificate, m.svid.Certificates[0].Raw) {
			err = failure("SOURCE_CHANGED")
		}
		if err == nil {
			id, _, verificationErr := x509svid.Verify(c.peerCertificates, m.bundle)
			if verificationErr != nil || id != c.owner.peer || !validLeafUsage(c.peerCertificates[0]) {
				err = failure("PEER_REJECTED")
			}
		}
	}
	if err != nil {
		c.closeWithError(err)
		return Peer{}, err
	}
	if err = c.current(); err != nil {
		return Peer{}, err
	}
	return c.peer, nil
}

func (c *Connection) watch() {
	defer c.owner.work.Done()
	defer close(c.finished)
	ticker := time.NewTicker(c.owner.config.RecheckInterval)
	defer ticker.Stop()
	expiry := time.NewTimer(time.Until(c.peer.ExpiresAt))
	defer expiry.Stop()
	for {
		select {
		case <-c.done:
			return
		case <-c.ctx.Done():
			c.closeWithError(contextError(c.ctx.Err()))
			return
		case <-expiry.C:
			c.closeWithError(failure("EXPIRED"))
			return
		case <-ticker.C:
			if _, err := c.Inspect(); err != nil {
				return
			}
		}
	}
}

func (c *Connection) closeWithError(err error) error {
	if c == nil || c.self != c {
		return failure("INVALID_HANDLE")
	}
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil
	}
	c.closed = true
	c.cause = err
	close(c.done)
	c.mu.Unlock()
	// Close the owned raw transport directly, interrupting blocked TLS I/O
	// without waiting for peer close-notify or its willingness to read.
	closeErr := c.raw.Close()
	c.owner.mu.Lock()
	delete(c.owner.conns, c)
	c.owner.mu.Unlock()
	return sanitizeIO(closeErr)
}

func (c *Connection) Close() error {
	if c == nil || c.self != c {
		return failure("INVALID_HANDLE")
	}
	err := c.closeWithError(failure("CLOSED"))
	<-c.finished
	return err
}
func (c *Connection) Read(buffer []byte) (int, error) {
	if _, err := c.Inspect(); err != nil {
		return 0, err
	}
	n, err := c.tls.Read(buffer)
	err = sanitizeIO(err)
	if err != nil {
		c.closeWithError(failure("CONNECTION_ENDED"))
	}
	return n, err
}
func (c *Connection) Write(buffer []byte) (int, error) {
	if _, err := c.Inspect(); err != nil {
		return 0, err
	}
	n, err := c.tls.Write(buffer)
	err = sanitizeIO(err)
	if err != nil {
		c.closeWithError(failure("CONNECTION_ENDED"))
	}
	return n, err
}
func (c *Connection) LocalAddr() net.Addr {
	if c == nil || c.self != c {
		return nil
	}
	return c.raw.LocalAddr()
}
func (c *Connection) RemoteAddr() net.Addr {
	if c == nil || c.self != c {
		return nil
	}
	return c.raw.RemoteAddr()
}
func (c *Connection) SetDeadline(deadline time.Time) error {
	if err := c.current(); err != nil {
		return err
	}
	return sanitizeIO(c.tls.SetDeadline(deadline))
}
func (c *Connection) SetReadDeadline(deadline time.Time) error {
	if err := c.current(); err != nil {
		return err
	}
	return sanitizeIO(c.tls.SetReadDeadline(deadline))
}
func (c *Connection) SetWriteDeadline(deadline time.Time) error {
	if err := c.current(); err != nil {
		return err
	}
	return sanitizeIO(c.tls.SetWriteDeadline(deadline))
}

func (t *Transport) Close() error {
	if t == nil || t.self != t {
		return failure("INVALID_HANDLE")
	}
	t.mu.Lock()
	t.closed = true
	connections := make([]*Connection, 0, len(t.conns))
	for c := range t.conns {
		connections = append(connections, c)
	}
	t.mu.Unlock()
	for _, c := range connections {
		c.closeWithError(failure("CLOSED"))
	}
	t.work.Wait()
	return nil
}
