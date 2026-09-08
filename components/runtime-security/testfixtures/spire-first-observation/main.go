// Command spire-first-observation is a bounded test observer, not a production
// identity consumer. Its output contains metadata only; credentials stay in the
// normal SDK memory lifetime, without a deterministic zeroization claim.
package main

import (
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"net"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/spiffe/go-spiffe/v2/proto/spiffe/workload"
	"github.com/spiffe/go-spiffe/v2/spiffeid"
	"github.com/spiffe/go-spiffe/v2/svid/x509svid"
	"github.com/spiffe/go-spiffe/v2/workloadapi"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/grpclog"
	"google.golang.org/grpc/stats"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
)

const (
	overallLimit     = 120 * time.Second
	fetchLimit       = 10 * time.Second
	controlLimit     = 60 * time.Second
	closeLimit       = 10 * time.Second
	maxResponseBytes = 4 << 20
	maxEntries       = 4
	maxBundles       = 4
	maxAuthorities   = 16
	maxControlBytes  = 32
	fetchMethod      = "/SpiffeWorkloadAPI/FetchX509SVID"
)

// Reasons are a closed vocabulary. Never wrap or print library errors: a
// malformed response, transport error or flag can contain private input.
type reason string

func (r reason) Error() string { return string(r) }

func digest(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

type identityMetadata struct {
	SPIFFEID          string `json:"spiffeId"`
	CertificateSHA256 string `json:"certificateSHA256"`
	NotBefore         string `json:"notBefore"`
	NotAfter          string `json:"notAfter"`
}
type bundleMetadata struct {
	TrustDomain    string `json:"trustDomain"`
	AuthorityCount int    `json:"authorityCount"`
	SHA256         string `json:"sha256"`
}
type projection struct {
	EntryCount int                `json:"entryCount,omitempty"`
	Identities []identityMetadata `json:"identities,omitempty"`
	Bundles    []bundleMetadata   `json:"bundles,omitempty"`
}

func validID(value string) (spiffeid.ID, error) {
	if len(value) == 0 || len(value) > 2048 {
		return spiffeid.ID{}, reason("invalid-id")
	}
	id, err := spiffeid.FromString(value)
	if err != nil || id.String() != value || id.Path() == "" {
		return spiffeid.ID{}, reason("invalid-id")
	}
	return id, nil
}

// inspectResponse sees every actual entry before go-spiffe can select by hint.
// It neither modifies the protobuf nor filters it to the expected identity.
func inspectResponse(response *workload.X509SVIDResponse) (projection, error) {
	var out projection
	if response == nil || proto.Size(response) > maxResponseBytes || len(response.Svids) == 0 || len(response.Svids) > maxEntries {
		return out, reason("response-bounds")
	}
	if len(response.Svids)+len(response.FederatedBundles) > maxBundles || len(response.Crl) != 0 || len(response.ProtoReflect().GetUnknown()) != 0 {
		return out, reason("response-shape")
	}
	seen := make(map[string]bool)
	addBundle := func(td string, raw []byte) error {
		certs, err := x509.ParseCertificates(raw)
		if err != nil || len(certs) == 0 || len(certs) > maxAuthorities {
			return reason("bundle-invalid")
		}
		out.Bundles = append(out.Bundles, bundleMetadata{TrustDomain: td, AuthorityCount: len(certs), SHA256: digest(raw)})
		return nil
	}
	for _, entry := range response.Svids {
		if entry == nil || entry.Hint != "" || len(entry.ProtoReflect().GetUnknown()) != 0 {
			return projection{}, reason("entry-shape")
		}
		id, err := validID(entry.SpiffeId)
		if err != nil {
			return projection{}, reason("entry-id")
		}
		if seen[entry.SpiffeId] {
			return projection{}, reason("duplicate-id")
		}
		seen[entry.SpiffeId] = true
		svid, err := x509svid.ParseRaw(entry.X509Svid, entry.X509SvidKey)
		if err != nil || len(svid.Certificates) > maxAuthorities || svid.ID != id {
			return projection{}, reason("entry-invalid")
		}
		leaf := svid.Certificates[0]
		if !leaf.NotAfter.After(leaf.NotBefore) {
			return projection{}, reason("entry-validity")
		}
		out.Identities = append(out.Identities, identityMetadata{
			SPIFFEID: id.String(), CertificateSHA256: digest(leaf.Raw),
			NotBefore: leaf.NotBefore.UTC().Format(time.RFC3339), NotAfter: leaf.NotAfter.UTC().Format(time.RFC3339),
		})
		if err := addBundle(id.TrustDomain().String(), entry.Bundle); err != nil {
			return projection{}, err
		}
	}
	for domain, raw := range response.FederatedBundles {
		if len(domain) > 2048 {
			return projection{}, reason("bundle-domain")
		}
		td, err := spiffeid.TrustDomainFromString(domain)
		if err != nil || domain != td.ID().String() {
			return projection{}, reason("bundle-domain")
		}
		if err := addBundle(td.String(), raw); err != nil {
			return projection{}, err
		}
	}
	sort.Slice(out.Identities, func(i, j int) bool { return out.Identities[i].SPIFFEID < out.Identities[j].SPIFFEID })
	sort.Slice(out.Bundles, func(i, j int) bool {
		if out.Bundles[i].TrustDomain == out.Bundles[j].TrustDomain {
			return out.Bundles[i].SHA256 < out.Bundles[j].SHA256
		}
		return out.Bundles[i].TrustDomain < out.Bundles[j].TrustDomain
	})
	out.EntryCount = len(out.Identities)
	return out, nil
}

func exactSingleton(p projection, expected string) bool {
	return len(p.Identities) == 1 && p.Identities[0].SPIFFEID == expected
}

type connectionCounts struct {
	DialAttempts     int `json:"dialAttempts"`
	ConnectionBegins int `json:"connectionBegins"`
	ConnectionEnds   int `json:"connectionEnds"`
}
type rpcCounts struct {
	Phase     int    `json:"phase"`
	Begins    int    `json:"begins"`
	Ends      int    `json:"ends"`
	Responses int    `json:"responses"`
	EndCode   string `json:"endCode,omitempty"`
}
type phaseKey struct{}

type observer struct {
	mu            sync.Mutex
	connection    connectionCounts
	rpcs          [2]rpcCounts
	closing       bool
	dialsInFlight int
	socketsOpened int
	socketsClosed int
	failure       reason
	failed        chan struct{}
	changed       chan struct{}
	positive      projection
}

func newObserver() *observer {
	return &observer{failed: make(chan struct{}), changed: make(chan struct{}, 1), rpcs: [2]rpcCounts{{Phase: 1}, {Phase: 2}}}
}
func (o *observer) notifyLocked() {
	select {
	case o.changed <- struct{}{}:
	default:
	}
}
func (o *observer) failLocked(r reason) {
	if o.failure == "" {
		o.failure = r
		close(o.failed)
	}
	o.notifyLocked()
}
func (o *observer) snapshot() (connectionCounts, [2]rpcCounts, reason) {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.connection, o.rpcs, o.failure
}
func (o *observer) TagConn(ctx context.Context, _ *stats.ConnTagInfo) context.Context { return ctx }
func (o *observer) HandleConn(_ context.Context, event stats.ConnStats) {
	o.mu.Lock()
	defer o.mu.Unlock()
	switch event.(type) {
	case *stats.ConnBegin:
		o.connection.ConnectionBegins++
		if o.connection.ConnectionBegins != 1 || o.closing {
			o.failLocked("connection-extra")
		}
	case *stats.ConnEnd:
		o.connection.ConnectionEnds++
		if !o.closing || o.connection.ConnectionEnds > 1 {
			o.failLocked("connection-lost")
		}
	}
	o.notifyLocked()
}
func (o *observer) TagRPC(ctx context.Context, info *stats.RPCTagInfo) context.Context {
	if info.FullMethodName != fetchMethod {
		o.mu.Lock()
		o.failLocked("rpc-method")
		o.mu.Unlock()
	}
	return ctx
}
func (o *observer) HandleRPC(ctx context.Context, event stats.RPCStats) {
	o.mu.Lock()
	defer o.mu.Unlock()
	phase, ok := ctx.Value(phaseKey{}).(int)
	if !ok || phase < 1 || phase > 2 {
		o.failLocked("rpc-phase")
		return
	}
	rpc := &o.rpcs[phase-1]
	switch event := event.(type) {
	case *stats.Begin:
		rpc.Begins++
		if rpc.Begins != 1 || event.IsTransparentRetryAttempt || o.closing {
			o.failLocked("rpc-extra-attempt")
		}
	case *stats.End:
		rpc.Ends++
		rpc.EndCode = status.Code(event.Error).String()
		if rpc.Ends != 1 || rpc.Begins != 1 {
			o.failLocked("rpc-end-order")
		}
	}
	o.notifyLocked()
}
func (o *observer) dial(ctx context.Context, path string) (net.Conn, error) {
	o.mu.Lock()
	o.connection.DialAttempts++
	if o.connection.DialAttempts != 1 || o.closing {
		o.failLocked("dial-extra")
		o.mu.Unlock()
		return nil, reason("dial-extra")
	}
	o.dialsInFlight++
	o.notifyLocked()
	o.mu.Unlock()
	conn, err := (&net.Dialer{Timeout: fetchLimit}).DialContext(ctx, "unix", path)
	o.mu.Lock()
	defer o.mu.Unlock()
	o.dialsInFlight--
	if err == nil {
		o.socketsOpened++
	}
	o.notifyLocked()
	if err != nil {
		return nil, reason("dial-failed")
	}
	return &ownedConn{Conn: conn, owner: o}, nil
}

// A closed stats interval alone cannot settle a still-running dial. Count the
// owned socket close as well, including a successful late dial discarded by gRPC.
type ownedConn struct {
	net.Conn
	owner *observer
	once  sync.Once
	err   error
}

func (c *ownedConn) Close() error {
	c.once.Do(func() {
		c.err = c.Conn.Close()
		c.owner.mu.Lock()
		defer c.owner.mu.Unlock()
		c.owner.socketsClosed++
		if c.err != nil {
			c.owner.failLocked("socket-close-failed")
		}
		c.owner.notifyLocked()
	})
	return c.err
}
func (o *observer) settled() bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.dialsInFlight == 0 && o.socketsOpened == o.socketsClosed &&
		o.connection.ConnectionEnds == o.connection.ConnectionBegins &&
		o.rpcs[0].Ends == o.rpcs[0].Begins && o.rpcs[1].Ends == o.rpcs[1].Begins
}

func (o *observer) intercept(ctx context.Context, desc *grpc.StreamDesc, conn *grpc.ClientConn, method string, streamer grpc.Streamer, options ...grpc.CallOption) (grpc.ClientStream, error) {
	phase, ok := ctx.Value(phaseKey{}).(int)
	if !ok || phase < 1 || phase > 2 || method != fetchMethod {
		return nil, reason("rpc-phase")
	}
	stream, err := streamer(ctx, desc, conn, method, options...)
	if err != nil {
		return nil, err
	}
	return &observedStream{ClientStream: stream, owner: o, phase: phase}, nil
}

type observedStream struct {
	grpc.ClientStream
	owner *observer
	phase int
}

func (s *observedStream) RecvMsg(message any) error {
	if err := s.ClientStream.RecvMsg(message); err != nil {
		return err
	}
	o := s.owner
	o.mu.Lock()
	rpc := &o.rpcs[s.phase-1]
	rpc.Responses++
	if s.phase != 2 || rpc.Responses != 1 || o.failure != "" {
		o.failLocked("response-unexpected")
		o.mu.Unlock()
		return reason("response-unexpected")
	}
	o.mu.Unlock()
	response, ok := message.(*workload.X509SVIDResponse)
	if !ok {
		return reason("response-type")
	}
	p, err := inspectResponse(response)
	o.mu.Lock()
	defer o.mu.Unlock()
	if err != nil {
		o.failLocked("response-invalid")
		return reason("response-invalid")
	}
	o.positive = p
	o.notifyLocked()
	return nil
}

func (o *observer) awaitRPC(ctx context.Context, phase int) error {
	for {
		_, rpcs, failure := o.snapshot()
		if failure != "" {
			return failure
		}
		if rpcs[phase-1].Ends == 1 {
			return nil
		}
		select {
		case <-ctx.Done():
			return reason("rpc-settlement-timeout")
		case <-o.changed:
		}
	}
}
func (o *observer) live(phase int) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	c, rpcs, failure := o.connection, o.rpcs, o.failure
	if o.dialsInFlight != 0 || o.socketsOpened != 1 || o.socketsClosed != 0 || o.closing {
		return false
	}
	if failure != "" || c != (connectionCounts{DialAttempts: 1, ConnectionBegins: 1}) {
		return false
	}
	if rpcs[0] != (rpcCounts{Phase: 1, Begins: 1, Ends: 1, EndCode: "PermissionDenied"}) {
		return false
	}
	if phase == 1 {
		return rpcs[1] == (rpcCounts{Phase: 2})
	}
	return rpcs[1] == (rpcCounts{Phase: 2, Begins: 1, Ends: 1, Responses: 1, EndCode: "Canceled"})
}

// Cancellation closes the owned reader and joins its read before settlement can
// be claimed. EOF is required after the one line, so buffered extra input cannot
// be silently accepted. A stalled noninterruptible input leaves custody unsettled.
func readControl(ctx context.Context, input io.ReadCloser) (bool, error) {
	defer input.Close()
	type result struct {
		data []byte
		err  error
	}
	done := make(chan result, 1)
	go func() { data, err := io.ReadAll(io.LimitReader(input, maxControlBytes+1)); done <- result{data, err} }()
	select {
	case value := <-done:
		if value.err != nil || string(value.data) != "continue\n" {
			return true, reason("control-invalid")
		}
		return true, nil
	case <-ctx.Done():
		_ = input.Close()
		select {
		case <-done:
			return true, reason("control-timeout")
		case <-time.After(time.Second):
			return false, reason("control-unsettled")
		}
	}
}

type record struct {
	Event                   string           `json:"event"`
	OffsetMS                int64            `json:"offsetMs"`
	Connection              connectionCounts `json:"connection"`
	RPC                     [2]rpcCounts     `json:"rpc"`
	GRPCCode                string           `json:"grpcCode,omitempty"`
	FetchReturned           bool             `json:"fetchReturned,omitempty"`
	StreamEndCode           string           `json:"streamEndCode,omitempty"`
	LocalStreamCancellation bool             `json:"localStreamCancellation,omitempty"`
	Outcome                 string           `json:"outcome,omitempty"`
	ReasonCode              string           `json:"reasonCode,omitempty"`
	projection
}

func emit(output io.Writer, started time.Time, o *observer, r record) error {
	r.OffsetMS = time.Since(started).Milliseconds()
	r.Connection, r.RPC, _ = o.snapshot()
	return json.NewEncoder(output).Encode(r)
}

type config struct{ socket, expected string }

func parseFlags(args []string) (config, error) {
	var c config
	flags := flag.NewFlagSet("spire-first-observation", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.StringVar(&c.socket, "socket-path", "", "explicit absolute Unix socket path")
	flags.StringVar(&c.expected, "expected-id", "", "complete expected singleton SPIFFE ID")
	if flags.Parse(args) != nil || flags.NArg() != 0 {
		return config{}, reason("flags-invalid")
	}
	if !filepath.IsAbs(c.socket) || filepath.Clean(c.socket) != c.socket || len(c.socket) > 107 || strings.ContainsAny(c.socket, "\x00\r\n") {
		return config{}, reason("socket-invalid")
	}
	if _, err := validID(c.expected); err != nil {
		return config{}, reason("expected-id-invalid")
	}
	return c, nil
}

func execute(ctx context.Context, lifetime context.Context, c config, input io.ReadCloser, output io.Writer) (result error) {
	started := time.Now()
	o := newObserver()
	inputSettled := true
	// A violation interrupts a blocked fetch/control gate, while cleanup keeps
	// the independent absolute lifetime budget. Join this owned goroutine too.
	opCtx, cancelOperations := context.WithCancel(ctx)
	watchDone := make(chan struct{})
	go func() {
		defer close(watchDone)
		select {
		case <-o.failed:
			cancelOperations()
		case <-opCtx.Done():
		}
	}()
	defer func() { cancelOperations(); <-watchDone }()
	client, err := workloadapi.New(opCtx, workloadapi.WithAddr((&url.URL{Scheme: "unix", Path: c.socket}).String()), workloadapi.WithDialOptions(
		grpc.WithContextDialer(func(dialCtx context.Context, _ string) (net.Conn, error) { return o.dial(dialCtx, c.socket) }),
		grpc.WithDisableRetry(), grpc.WithDisableServiceConfig(), grpc.WithStatsHandler(o),
		grpc.WithStreamInterceptor(o.intercept), grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(maxResponseBytes)),
	))
	if err != nil {
		return reason("client-create")
	}
	defer func() {
		cancelOperations()
		o.mu.Lock()
		o.closing = true
		o.mu.Unlock()
		closeErr := client.Close()
		closeCtx, cancel := context.WithTimeout(lifetime, closeLimit)
		defer cancel()
		settled := false
		for {
			if o.settled() {
				settled = true
				break
			}
			select {
			case <-closeCtx.Done():
				goto finished
			case <-o.changed:
			}
		}
	finished:
		if closeErr != nil || !settled || !inputSettled {
			result = reason("close-unsettled")
			return
		}
		_, _, violation := o.snapshot()
		if violation != "" {
			result = violation
		}
		outcome := "passed"
		if result != nil {
			outcome = "failed"
		}
		if emit(output, started, o, record{Event: "closed", Outcome: outcome}) != nil {
			result = reason("output-failed")
		}
	}()
	fetch := func(phase int) error {
		fetchCtx, cancel := context.WithTimeout(context.WithValue(opCtx, phaseKey{}, phase), fetchLimit)
		defer cancel()
		_, err := client.FetchX509Context(fetchCtx)
		if phase == 1 && status.Code(err) != codes.PermissionDenied {
			return reason("denial-not-observed")
		}
		if phase == 2 && err != nil {
			return reason("fetch-failed")
		}
		if err := o.awaitRPC(fetchCtx, phase); err != nil {
			return err
		}
		if !o.live(phase) {
			return reason("correlation-invalid")
		}
		return nil
	}
	if err := fetch(1); err != nil {
		return err
	}
	if emit(output, started, o, record{Event: "denied", GRPCCode: "PermissionDenied"}) != nil {
		return reason("output-failed")
	}
	gateCtx, gateCancel := context.WithTimeout(opCtx, controlLimit)
	inputSettled, err = readControl(gateCtx, input)
	gateCancel()
	if err != nil {
		return err
	}
	if !o.live(1) {
		return reason("correlation-invalid")
	}
	if err := fetch(2); err != nil {
		return err
	}
	o.mu.Lock()
	p := o.positive
	o.mu.Unlock()
	if !exactSingleton(p, c.expected) {
		return reason("identity-set-mismatch")
	}
	if emit(output, started, o, record{Event: "delivered", FetchReturned: true, StreamEndCode: "Canceled", LocalStreamCancellation: true, projection: p}) != nil {
		return reason("output-failed")
	}
	return nil
}

func main() {
	// This fixture owns its process. Suppress arbitrary library diagnostics on
	// every gRPC path; the only retained failures are the codes emitted below.
	grpclog.SetLoggerV2(grpclog.NewLoggerV2(io.Discard, io.Discard, io.Discard))
	// Also bound blocked output or an unexpectedly noninterruptible dependency.
	// Forced exit emits no closed record and must remain unsettled externally.
	timer := time.AfterFunc(overallLimit, func() { os.Exit(1) })
	defer timer.Stop()
	lifetime, cancel := context.WithTimeout(context.Background(), overallLimit)
	defer cancel()
	ctx, stop := signal.NotifyContext(lifetime, os.Interrupt, syscall.SIGTERM)
	defer stop()
	c, err := parseFlags(os.Args[1:])
	if err == nil {
		err = execute(ctx, lifetime, c, os.Stdin, os.Stdout)
	}
	if err != nil {
		var code reason
		if !errors.As(err, &code) {
			code = reason("observer-failed")
		}
		_ = json.NewEncoder(os.Stdout).Encode(struct {
			Event      string `json:"event"`
			ReasonCode reason `json:"reasonCode"`
		}{"failed", code})
		os.Exit(1)
	}
}
