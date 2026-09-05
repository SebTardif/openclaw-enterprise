// Package identity obtains credentials for a locally attested SPIRE workload.
// It provides no OCC authorization binding or X.509 peer authentication.
package identity

import (
	"bytes"
	"context"
	"crypto/x509"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/spiffe/go-spiffe/v2/bundle/x509bundle"
	"github.com/spiffe/go-spiffe/v2/logger"
	"github.com/spiffe/go-spiffe/v2/spiffeid"
	"github.com/spiffe/go-spiffe/v2/svid/jwtsvid"
	"github.com/spiffe/go-spiffe/v2/svid/x509svid"
	"github.com/spiffe/go-spiffe/v2/workloadapi"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	maxMessageBytes         = 4 << 20
	maxTokenBytes           = 64 << 10
	maxEntries              = 64
	maxConcurrentOperations = 16
)

// Error contains a fixed diagnostic code, without provider errors or secrets.
type Error struct{ Code string }

func (e *Error) Error() string   { return "SPIFFE Workload API operation failed (" + e.Code + ")." }
func failure(code string) *Error { return &Error{Code: code} }

type Options struct {
	SocketPath       string
	ExpectedSPIFFEID string
	// Timeout bounds initial readiness and each entire JWT operation; 1s..60s.
	Timeout time.Duration
}

type Metadata struct {
	SPIFFEID               string    `json:"spiffeId"`
	ExpiresAt              time.Time `json:"expiresAt"`
	CertificateCount       int       `json:"certificateCount"`
	BundleCertificateCount int       `json:"bundleCertificateCount"`
}

// Snapshot contains independent DER copies. Credential material is excluded
// from JSON; callers must also avoid logging these buffers with other formats.
type Snapshot struct {
	Metadata
	CertificateChain [][]byte            `json:"-"`
	PrivateKey       []byte              `json:"-"`
	Bundle           [][]byte            `json:"-"`
	CRLs             [][]byte            `json:"-"`
	FederatedBundles map[string][][]byte `json:"-"`
}

type JWTIdentity struct {
	SPIFFEID  string    `json:"spiffeId"`
	ExpiresAt time.Time `json:"expiresAt"`
}

type JWTSVID struct {
	JWTIdentity
	Token string `json:"-"`
}

// Source is a single-use, concurrency-safe source. Every watch error is
// terminal; recovery requires constructing a new source at the protected socket.
type Source struct {
	options      Options
	expected     spiffeid.ID
	mu           sync.Mutex
	started      bool
	root         context.Context
	cancel       context.CancelFunc
	client       *workloadapi.Client
	ready        chan struct{}
	readyClosed  bool
	done         chan struct{}
	terminal     *Error
	snapshot     *Snapshot
	pending      *wireSnapshot
	startupTimer *time.Timer
	expiryTimer  *time.Timer
	stopLifetime func() bool
	operations   chan struct{}
}

func NewSource(options Options) (*Source, error) {
	if options.Timeout == 0 {
		options.Timeout = 10 * time.Second
	}
	id, err := workloadID(options.ExpectedSPIFFEID)
	if err != nil || !filepath.IsAbs(options.SocketPath) || filepath.Clean(options.SocketPath) != options.SocketPath || len(options.SocketPath) > 103 || invalidText(options.SocketPath) || strings.ContainsAny(options.SocketPath, "?#") || options.Timeout < time.Second || options.Timeout > time.Minute {
		return nil, failure("INVALID_CONFIGURATION")
	}
	return &Source{options: options, expected: id, ready: make(chan struct{}), done: make(chan struct{}), operations: make(chan struct{}, maxConcurrentOperations)}, nil
}

func workloadID(value string) (spiffeid.ID, error) {
	id, err := spiffeid.FromString(value)
	if err != nil || len(value) > 2048 || id.Path() == "" || id.String() != value {
		return spiffeid.ID{}, failure("INVALID_CONFIGURATION")
	}
	return id, nil
}

func invalidText(value string) bool {
	if value == "" {
		return true
	}
	for _, r := range value {
		if r <= ' ' || r == 127 {
			return true
		}
	}
	return false
}

// Start waits for the first complete valid snapshot. The first call's context
// controls the source lifetime, including after Start returns successfully.
func (s *Source) Start(ctx context.Context) error {
	if ctx == nil {
		return failure("INVALID_CONFIGURATION")
	}
	if ctx.Err() != nil {
		return contextFailure(ctx.Err())
	}
	s.mu.Lock()
	if s.terminal != nil {
		err := s.terminal
		s.mu.Unlock()
		return err
	}
	if !s.started {
		s.started = true
		s.root, s.cancel = context.WithCancel(ctx)
		s.startupTimer = time.AfterFunc(s.options.Timeout, func() {
			s.mu.Lock()
			defer s.mu.Unlock()
			if s.snapshot == nil {
				s.terminateLocked(failure("TIMEOUT"))
			}
		})
		s.stopLifetime = context.AfterFunc(s.root, func() { s.terminate(contextFailure(s.root.Err())) })
		go s.run()
	}
	s.mu.Unlock()
	select {
	case <-s.ready:
		_, err := s.Metadata()
		return err
	case <-ctx.Done():
		return contextFailure(ctx.Err())
	}
}

func (s *Source) run() {
	defer close(s.done)
	info, err := os.Lstat(s.options.SocketPath)
	if err != nil || info.Mode()&os.ModeSocket == 0 {
		s.terminate(failure("UNAVAILABLE"))
		return
	}
	client, err := workloadapi.New(s.root,
		workloadapi.WithAddr("unix://"+s.options.SocketPath),
		workloadapi.WithLogger(logger.Null),
		workloadapi.WithDialOptions(
			grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(maxMessageBytes), grpc.MaxCallSendMsgSize(maxTokenBytes+8192)),
			grpc.WithDisableRetry(),
			grpc.WithStreamInterceptor(s.streamInterceptor),
			grpc.WithUnaryInterceptor(s.unaryInterceptor),
		),
	)
	if err != nil {
		s.terminate(safeError(err))
		return
	}
	defer client.Close()
	s.mu.Lock()
	if s.terminal != nil {
		s.mu.Unlock()
		return
	}
	s.client = client
	s.mu.Unlock()
	err = client.WatchX509Context(s.root, s)
	s.terminate(safeError(err))
}

func (s *Source) Metadata() (Metadata, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.currentLocked(); err != nil {
		return Metadata{}, err
	}
	return s.snapshot.Metadata, nil
}

func (s *Source) Snapshot() (Snapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.currentLocked(); err != nil {
		return Snapshot{}, err
	}
	result := *s.snapshot
	result.CertificateChain = cloneBytes(s.snapshot.CertificateChain)
	result.PrivateKey = bytes.Clone(s.snapshot.PrivateKey)
	result.Bundle = cloneBytes(s.snapshot.Bundle)
	result.CRLs = cloneBytes(s.snapshot.CRLs)
	result.FederatedBundles = make(map[string][][]byte, len(s.snapshot.FederatedBundles))
	for id, bundle := range s.snapshot.FederatedBundles {
		result.FederatedBundles[id] = cloneBytes(bundle)
	}
	return result, nil
}

// Close cancels in-flight calls and waits for the watch goroutine to exit.
// Watch callbacks only invalidate and cancel; they never wait on themselves.
func (s *Source) Close() error {
	s.terminate(failure("CLOSED"))
	s.mu.Lock()
	started := s.started
	s.mu.Unlock()
	if started {
		<-s.done
	}
	return nil
}

func (s *Source) currentLocked() error {
	if s.terminal != nil {
		return s.terminal
	}
	if s.root != nil && s.root.Err() != nil {
		s.terminateLocked(contextFailure(s.root.Err()))
		return s.terminal
	}
	if s.snapshot == nil {
		return failure("UNAVAILABLE")
	}
	if !time.Now().Before(s.snapshot.ExpiresAt) {
		s.terminateLocked(failure("EXPIRED"))
		return s.terminal
	}
	return nil
}

func (s *Source) terminate(err *Error) { s.mu.Lock(); defer s.mu.Unlock(); s.terminateLocked(err) }
func (s *Source) terminateLocked(err *Error) {
	if s.terminal != nil {
		return
	}
	s.terminal = err
	if s.snapshot != nil {
		clear(s.snapshot.PrivateKey)
	}
	s.snapshot = nil
	if s.pending != nil {
		clear(s.pending.key)
	}
	s.pending = nil
	if s.startupTimer != nil {
		s.startupTimer.Stop()
	}
	if s.expiryTimer != nil {
		s.expiryTimer.Stop()
	}
	if s.stopLifetime != nil {
		s.stopLifetime()
	}
	if s.cancel != nil {
		s.cancel()
	}
	s.signalReadyLocked()
}

func (s *Source) signalReadyLocked() {
	if !s.readyClosed {
		close(s.ready)
		s.readyClosed = true
	}
}

// OnX509ContextWatchError terminates even for SDK parse errors and EOF. This
// deliberately disables the SDK's usual retry and retained-cache behavior.
func (s *Source) OnX509ContextWatchError(err error) { s.terminate(safeError(err)) }

func (s *Source) OnX509ContextUpdate(value *workloadapi.X509Context) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.terminal != nil {
		return
	}
	next, err := s.buildSnapshot(value)
	if err != nil {
		s.terminateLocked(err)
		return
	}
	if s.snapshot != nil {
		clear(s.snapshot.PrivateKey)
	}
	if s.pending != nil {
		clear(s.pending.key)
	}
	s.pending = nil
	s.snapshot = next
	if s.expiryTimer != nil {
		s.expiryTimer.Stop()
	}
	s.expiryTimer = time.AfterFunc(time.Until(next.ExpiresAt), func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.snapshot != nil && !time.Now().Before(s.snapshot.ExpiresAt) {
			s.terminateLocked(failure("EXPIRED"))
		}
	})
	if s.startupTimer != nil {
		s.startupTimer.Stop()
	}
	s.signalReadyLocked()
}

func (s *Source) buildSnapshot(value *workloadapi.X509Context) (*Snapshot, *Error) {
	if value == nil || s.pending == nil || len(value.SVIDs) > maxEntries {
		return nil, failure("INVALID_RESPONSE")
	}
	if value.Bundles == nil {
		return nil, failure("INVALID_RESPONSE")
	}
	for _, bundle := range value.Bundles.Bundles() {
		if len(bundle.X509Authorities()) == 0 || len(bundle.X509Authorities()) > maxEntries {
			return nil, failure("INVALID_RESPONSE")
		}
	}
	var selected *x509svid.SVID
	for _, candidate := range value.SVIDs {
		if candidate == nil || len(candidate.Certificates) == 0 || len(candidate.Certificates) > maxEntries {
			return nil, failure("INVALID_RESPONSE")
		}
		if candidate.ID == s.expected {
			if selected != nil {
				return nil, failure("IDENTITY_MISMATCH")
			}
			selected = candidate
		}
	}
	if selected == nil {
		return nil, failure("IDENTITY_MISMATCH")
	}
	chain := rawCertificates(selected.Certificates)
	// The maintained parser's identity must belong to the exact selected wire
	// entry, preventing a conflicting envelope or SDK hint de-duplication fallback.
	if !bytes.Equal(bytes.Join(chain, nil), s.pending.certificates) {
		return nil, failure("IDENTITY_MISMATCH")
	}
	if s.root.Err() != nil {
		return nil, contextFailure(s.root.Err())
	}
	now := time.Now()
	expires := selected.Certificates[0].NotAfter
	for _, certificate := range selected.Certificates {
		if now.Before(certificate.NotBefore) {
			return nil, failure("INVALID_RESPONSE")
		}
		if !now.Before(certificate.NotAfter) {
			return nil, failure("EXPIRED")
		}
		if certificate.NotAfter.Before(expires) {
			expires = certificate.NotAfter
		}
	}
	bundle, err := parseBundle(s.expected.TrustDomain(), s.pending.bundle)
	if err != nil {
		return nil, err
	}
	federated := make(map[string][][]byte, len(s.pending.federated))
	for id, raw := range s.pending.federated {
		td, parseErr := spiffeid.TrustDomainFromString(id)
		if parseErr != nil || td.ID().String() != id || len(id) > 2048 {
			return nil, failure("INVALID_RESPONSE")
		}
		parsed, bundleErr := parseBundle(td, raw)
		if bundleErr != nil {
			return nil, bundleErr
		}
		federated[id] = parsed
	}
	return &Snapshot{Metadata: Metadata{SPIFFEID: s.expected.String(), ExpiresAt: expires.UTC(), CertificateCount: len(chain), BundleCertificateCount: len(bundle)}, CertificateChain: chain, PrivateKey: bytes.Clone(s.pending.key), Bundle: bundle, CRLs: cloneBytes(s.pending.crls), FederatedBundles: federated}, nil
}

func parseBundle(td spiffeid.TrustDomain, raw []byte) ([][]byte, *Error) {
	// The SDK bundle de-duplicates authorities. Apply the resource bound to
	// every decoded raw certificate before that de-duplication can shrink it.
	certificates, err := x509.ParseCertificates(raw)
	if err != nil || len(certificates) == 0 || len(certificates) > maxEntries {
		return nil, failure("INVALID_RESPONSE")
	}
	bundle, err := x509bundle.ParseRaw(td, raw)
	if err != nil || len(bundle.X509Authorities()) == 0 || len(bundle.X509Authorities()) > maxEntries {
		return nil, failure("INVALID_RESPONSE")
	}
	return rawCertificates(bundle.X509Authorities()), nil
}
func rawCertificates(certificates []*x509.Certificate) [][]byte {
	result := make([][]byte, len(certificates))
	for i, certificate := range certificates {
		result[i] = bytes.Clone(certificate.Raw)
	}
	return result
}
func cloneBytes(values [][]byte) [][]byte {
	result := make([][]byte, len(values))
	for i, value := range values {
		result[i] = bytes.Clone(value)
	}
	return result
}

func (s *Source) beginOperation(ctx context.Context) (context.Context, *workloadapi.Client, func(), error) {
	if ctx == nil {
		return nil, nil, nil, failure("INVALID_CONFIGURATION")
	}
	if ctx.Err() != nil {
		return nil, nil, nil, contextFailure(ctx.Err())
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.currentLocked(); err != nil {
		return nil, nil, nil, err
	}
	select {
	case s.operations <- struct{}{}:
	default:
		return nil, nil, nil, failure("BUSY")
	}
	opCtx, cancel := context.WithTimeout(ctx, s.options.Timeout)
	stop := context.AfterFunc(s.root, cancel)
	return opCtx, s.client, func() { stop(); cancel(); <-s.operations }, nil
}

func (s *Source) completeOperation(ctx context.Context, err error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if current := s.currentLocked(); current != nil {
		return current
	}
	if ctx.Err() != nil {
		return contextFailure(ctx.Err())
	}
	if err != nil {
		return safeError(err)
	}
	return nil
}

func (s *Source) FetchJWTSVID(ctx context.Context, audience string) (JWTSVID, error) {
	if len(audience) > 2048 || invalidText(audience) {
		return JWTSVID{}, failure("INVALID_CONFIGURATION")
	}
	opCtx, client, finish, err := s.beginOperation(ctx)
	if err != nil {
		return JWTSVID{}, err
	}
	defer finish()
	selection := &fetchSelection{}
	opCtx = context.WithValue(opCtx, fetchSelectionKey{}, selection)
	svids, err := client.FetchJWTSVIDs(opCtx, jwtsvid.Params{Audience: audience, Subject: s.expected})
	if err = s.completeOperation(opCtx, err); err != nil {
		return JWTSVID{}, err
	}
	var selected *jwtsvid.SVID
	for _, candidate := range svids {
		if candidate.ID == s.expected {
			if selected != nil {
				return JWTSVID{}, failure("IDENTITY_MISMATCH")
			}
			selected = candidate
		}
	}
	if selected == nil {
		return JWTSVID{}, failure("IDENTITY_MISMATCH")
	}
	token := selected.Marshal()
	if token != selection.token {
		return JWTSVID{}, failure("IDENTITY_MISMATCH")
	}
	identity, err := s.validate(opCtx, client, token, audience, s.expected)
	if err != nil {
		return JWTSVID{}, err
	}
	return JWTSVID{JWTIdentity: identity, Token: token}, nil
}

func (s *Source) ValidateJWTSVID(ctx context.Context, token, audience, expectedPeerID string) (JWTIdentity, error) {
	id, err := workloadID(expectedPeerID)
	if err != nil || len(audience) > 2048 || invalidText(audience) || len(token) == 0 || len(token) > maxTokenBytes {
		return JWTIdentity{}, failure("INVALID_CONFIGURATION")
	}
	opCtx, client, finish, err := s.beginOperation(ctx)
	if err != nil {
		return JWTIdentity{}, err
	}
	defer finish()
	return s.validate(opCtx, client, token, audience, id)
}

func (s *Source) validate(ctx context.Context, client *workloadapi.Client, token, audience string, expected spiffeid.ID) (JWTIdentity, error) {
	if len(token) == 0 || len(token) > maxTokenBytes {
		return JWTIdentity{}, failure("INVALID_RESPONSE")
	}
	ctx = context.WithValue(ctx, validationKey{}, validationExpectation{expected.String(), audience})
	// The SDK parses the token only after the local Agent accepted its signature
	// and audience. The interceptor also checks the provider's validated claims.
	svid, err := client.ValidateJWTSVID(ctx, token, audience)
	if err = s.completeOperation(ctx, err); err != nil {
		return JWTIdentity{}, err
	}
	if svid.ID != expected {
		return JWTIdentity{}, failure("IDENTITY_MISMATCH")
	}
	if !time.Now().Before(svid.Expiry) {
		return JWTIdentity{}, failure("EXPIRED")
	}
	return JWTIdentity{SPIFFEID: expected.String(), ExpiresAt: svid.Expiry}, nil
}

func contextFailure(err error) *Error {
	if errors.Is(err, context.DeadlineExceeded) {
		return failure("TIMEOUT")
	}
	return failure("ABORTED")
}
func safeError(err error) *Error {
	var fixed *Error
	if errors.As(err, &fixed) {
		return fixed
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return contextFailure(err)
	}
	if status.Code(err) == codes.DeadlineExceeded {
		return failure("TIMEOUT")
	}
	if errors.Is(err, io.EOF) || status.Code(err) != codes.Unknown {
		return failure("UNAVAILABLE")
	}
	return failure("INVALID_RESPONSE")
}
