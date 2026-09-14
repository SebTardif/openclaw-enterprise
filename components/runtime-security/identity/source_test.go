package identity_test

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"errors"
	"math/big"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	identity "github.com/openclaw/openclaw-enterprise/components/runtime-security/identity"
	"github.com/spiffe/go-spiffe/v2/proto/spiffe/workload"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
)

const ownID = "spiffe://test.example/occ/controller"
const otherID = "spiffe://test.example/occ/other"

type credentials struct {
	first, rotated, other *workload.X509SVID
	ca                    *x509.Certificate
	caKey                 *ecdsa.PrivateKey
}

func newCredentials(t *testing.T) credentials {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	must(t, err)
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "Disposable test CA"}, NotBefore: time.Now().Add(-24 * time.Hour), NotAfter: time.Now().Add(48 * time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	must(t, err)
	ca, err := x509.ParseCertificate(der)
	must(t, err)
	c := credentials{ca: ca, caKey: key}
	c.first = c.leaf(t, ownID, 2, time.Now().Add(-time.Minute), time.Now().Add(time.Hour), nil, nil)
	c.rotated = c.leaf(t, ownID, 3, time.Now().Add(-time.Minute), time.Now().Add(2*time.Hour), nil, nil)
	c.other = c.leaf(t, otherID, 4, time.Now().Add(-time.Minute), time.Now().Add(time.Hour), nil, nil)
	return c
}

func (c credentials) leaf(t *testing.T, id string, serial int64, from, until time.Time, dns []string, extraURI *url.URL) *workload.X509SVID {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	must(t, err)
	uri, err := url.Parse(id)
	must(t, err)
	uris := []*url.URL{uri}
	if extraURI != nil {
		uris = append(uris, extraURI)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(serial), Subject: pkix.Name{CommonName: "Disposable workload"}, NotBefore: from, NotAfter: until, URIs: uris, DNSNames: dns, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth, x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, template, c.ca, &key.PublicKey, c.caKey)
	must(t, err)
	pk, err := x509.MarshalPKCS8PrivateKey(key)
	must(t, err)
	return &workload.X509SVID{SpiffeId: id, X509Svid: append(der, c.ca.Raw...), X509SvidKey: pk, Bundle: bytes.Clone(c.ca.Raw)}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
func clone(s *workload.X509SVID) *workload.X509SVID { return proto.Clone(s).(*workload.X509SVID) }
func safeError(t *testing.T, err error, code string) {
	t.Helper()
	var e *identity.Error
	if !errors.As(err, &e) {
		t.Fatalf("expected safe identity error, got %T", err)
	}
	if code != "" && e.Code != code {
		t.Fatalf("error code=%s, want %s", e.Code, code)
	}
}
func unavailableTrustView(t *testing.T, source *identity.Source, code string) {
	t.Helper()
	view, err := source.TrustView()
	safeError(t, err, code)
	if view != (identity.TrustView{}) {
		t.Fatal("unavailable trust view retained historical fields")
	}
}

func expectedTrustView(t *testing.T, response *workload.X509SVIDResponse) identity.TrustView {
	t.Helper()
	selected := response.Svids[0]
	chain, err := x509.ParseCertificates(selected.X509Svid)
	must(t, err)
	expires := chain[0].NotAfter
	for _, certificate := range chain {
		if certificate.NotAfter.Before(expires) {
			expires = certificate.NotAfter
		}
	}
	digest := sha256.Sum256(selected.Bundle)
	return identity.TrustView{
		Metadata:     identity.Metadata{SPIFFEID: selected.SpiffeId, ExpiresAt: expires.UTC()},
		BundleSHA256: "sha256:" + hex.EncodeToString(digest[:]),
		CRLCount:     len(response.Crl),
	}
}

func eventually(t *testing.T, check func() bool) {
	t.Helper()
	until := time.Now().Add(3 * time.Second)
	for !check() {
		if time.Now().After(until) {
			t.Fatal("condition did not become true")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

type recordedRequest struct {
	method   string
	metadata []string
}
type wireEvent struct {
	response *workload.X509SVIDResponse
	end      bool
	err      error
}
type wireServer struct {
	workload.UnimplementedSpiffeWorkloadAPIServer
	initial  *workload.X509SVIDResponse
	events   chan wireEvent
	entered  chan context.Context
	mu       sync.Mutex
	requests []recordedRequest
}

func (w *wireServer) record(ctx context.Context, r recordedRequest) {
	md, _ := metadata.FromIncomingContext(ctx)
	r.metadata = append([]string(nil), md.Get("workload.spiffe.io")...)
	w.mu.Lock()
	defer w.mu.Unlock()
	w.requests = append(w.requests, r)
}
func (w *wireServer) records() []recordedRequest {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]recordedRequest(nil), w.requests...)
}
func (w *wireServer) FetchX509SVID(_ *workload.X509SVIDRequest, stream grpc.ServerStreamingServer[workload.X509SVIDResponse]) error {
	w.record(stream.Context(), recordedRequest{method: "x509"})
	w.entered <- stream.Context()
	if w.initial != nil {
		if err := stream.Send(w.initial); err != nil {
			return err
		}
	}
	for {
		select {
		case <-stream.Context().Done():
			return stream.Context().Err()
		case event := <-w.events:
			if event.end {
				return event.err
			}
			if err := stream.Send(event.response); err != nil {
				return err
			}
		}
	}
}

// These tests exercise the actual source, SDK, generated protocol, and Unix
// transport. The local server does not prove SPIRE attestation or signature
// verification: it represents the trusted endpoint's X.509 response.
type fixture struct {
	source *identity.Source
	wire   *wireServer
	path   string
	server *grpc.Server
	certs  credentials
}

func newFixture(t *testing.T, configure func(*wireServer, credentials)) fixture {
	t.Helper()
	c := newCredentials(t)
	w := &wireServer{initial: &workload.X509SVIDResponse{Svids: []*workload.X509SVID{c.first}}, events: make(chan wireEvent, 64), entered: make(chan context.Context, 64)}
	if configure != nil {
		configure(w, c)
	}
	// Keep the Unix pathname short even when the test's name is descriptive.
	dir, err := os.MkdirTemp("", "occ-wapi-")
	must(t, err)
	t.Cleanup(func() { os.RemoveAll(dir) })
	path := filepath.Join(dir, "api.sock")
	listener, err := net.Listen("unix", path)
	must(t, err)
	server := grpc.NewServer()
	workload.RegisterSpiffeWorkloadAPIServer(server, w)
	go server.Serve(listener)
	t.Cleanup(server.Stop)
	source, err := identity.NewSource(identity.Options{SocketPath: path, ExpectedSPIFFEID: ownID, Timeout: time.Second})
	must(t, err)
	t.Cleanup(func() { source.Close() })
	return fixture{source: source, wire: w, path: path, server: server, certs: c}
}
func (f fixture) start(t *testing.T) { t.Helper(); must(t, f.source.Start(context.Background())) }
func (f fixture) snapshot(t *testing.T) identity.Snapshot {
	t.Helper()
	s, err := f.source.Snapshot()
	must(t, err)
	return s
}
func (f fixture) update(s *workload.X509SVID) {
	f.wire.events <- wireEvent{response: &workload.X509SVIDResponse{Svids: []*workload.X509SVID{s}}}
}
func TestX509SelectionAndMetadata(t *testing.T) {
	f := newFixture(t, func(w *wireServer, c credentials) { w.initial.Svids = []*workload.X509SVID{c.other, c.first} })
	f.start(t)
	s := f.snapshot(t)
	chain, err := x509.ParseCertificates(f.certs.first.X509Svid)
	must(t, err)
	if s.SPIFFEID != ownID || len(s.CertificateChain) != 2 || !bytes.Equal(s.CertificateChain[0], chain[0].Raw) || !bytes.Equal(s.PrivateKey, f.certs.first.X509SvidKey) || !reflect.DeepEqual(s.Bundle, [][]byte{f.certs.ca.Raw}) {
		t.Fatal("selected credentials differ from expected identity")
	}
	m, err := f.source.Metadata()
	must(t, err)
	if m.SPIFFEID != ownID || !m.ExpiresAt.Equal(chain[0].NotAfter) {
		t.Fatal("incorrect safe metadata")
	}
	for _, r := range f.wire.records() {
		if !reflect.DeepEqual(r.metadata, []string{"true"}) {
			t.Fatal("required workload metadata missing")
		}
	}
}

func TestTrustViewOrderedBundleAndRenewal(t *testing.T) {
	other := newCredentials(t)
	f := newFixture(t, func(w *wireServer, c credentials) {
		selected := clone(c.first)
		selected.Bundle = append(bytes.Clone(c.ca.Raw), other.ca.Raw...)
		w.initial.Svids = []*workload.X509SVID{selected}
		w.initial.Crl = [][]byte{{0x30, 0x00}}
		w.initial.FederatedBundles = map[string][]byte{"spiffe://federated.example": other.ca.Raw}
	})
	unavailableTrustView(t, f.source, "UNAVAILABLE")
	f.start(t)
	want := expectedTrustView(t, f.wire.initial)
	view, err := f.source.TrustView()
	must(t, err)
	if view != want {
		t.Fatal("trust view does not describe the selected complete generation")
	}

	// Reordering the same two authorities changes the digest; removed auxiliary
	// context must disappear in the same generation as the new certificate expiry.
	selected := clone(f.certs.rotated)
	selected.Bundle = append(bytes.Clone(other.ca.Raw), f.certs.ca.Raw...)
	replacement := &workload.X509SVIDResponse{Svids: []*workload.X509SVID{selected}}
	rotated := expectedTrustView(t, replacement)
	if rotated.BundleSHA256 == want.BundleSHA256 {
		t.Fatal("fixture did not change ordered bundle bytes")
	}
	f.wire.events <- wireEvent{response: replacement}
	eventually(t, func() bool { v, err := f.source.TrustView(); return err == nil && v == rotated })

	// A later certificate with the same bundle has a fresh expiry and stable digest.
	renewed := clone(f.certs.first)
	renewed.Bundle = bytes.Clone(selected.Bundle)
	renewal := &workload.X509SVIDResponse{Svids: []*workload.X509SVID{renewed}}
	renewedView := expectedTrustView(t, renewal)
	if renewedView.BundleSHA256 != rotated.BundleSHA256 || renewedView.Metadata.ExpiresAt.Equal(rotated.Metadata.ExpiresAt) {
		t.Fatal("fixture did not preserve bundle while replacing the certificate")
	}
	f.wire.events <- wireEvent{response: renewal}
	eventually(t, func() bool { v, err := f.source.TrustView(); return err == nil && v == renewedView })
	must(t, f.source.Close())
	unavailableTrustView(t, f.source, "CLOSED")
}

func TestTrustViewConcurrentCompleteGenerations(t *testing.T) {
	other := newCredentials(t)
	f := newFixture(t, nil)
	ctx, cancel := context.WithCancel(context.Background())
	must(t, f.source.Start(ctx))
	first := f.wire.initial
	selected := clone(f.certs.rotated)
	selected.Bundle = append(bytes.Clone(f.certs.ca.Raw), other.ca.Raw...)
	second := &workload.X509SVIDResponse{
		Svids: []*workload.X509SVID{selected}, Crl: [][]byte{{0x30, 0x00}},
		FederatedBundles: map[string][]byte{"spiffe://federated.example": other.ca.Raw},
	}
	wantFirst, wantSecond := expectedTrustView(t, first), expectedTrustView(t, second)
	var readers sync.WaitGroup
	defer func() { cancel(); readers.Wait() }()
	for range 4 {
		readers.Go(func() {
			for ctx.Err() == nil {
				view, err := f.source.TrustView()
				if err == nil && view != wantFirst && view != wantSecond {
					t.Error("trust view mixed fields from different accepted generations")
					return
				}
				if err != nil && ctx.Err() == nil {
					t.Error("valid concurrent replacement made trust view unavailable")
					return
				}
			}
		})
	}
	for range 5 {
		for _, generation := range []struct {
			response *workload.X509SVIDResponse
			view     identity.TrustView
		}{{second, wantSecond}, {first, wantFirst}} {
			f.wire.events <- wireEvent{response: generation.response}
			eventually(t, func() bool { view, err := f.source.TrustView(); return err == nil && view == generation.view })
		}
	}
	cancel()
	readers.Wait()
	unavailableTrustView(t, f.source, "ABORTED")
}

func TestWatchStatusPreservesCancellationAndFailureCodes(t *testing.T) {
	for _, scenario := range []struct {
		name   string
		status codes.Code
		code   string
	}{
		{"cancelled", codes.Canceled, "ABORTED"},
		{"deadline", codes.DeadlineExceeded, "TIMEOUT"},
		{"unavailable", codes.Unavailable, "UNAVAILABLE"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			f := newFixture(t, nil)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			must(t, f.source.Start(ctx))
			// End the actual external stream while the caller stays live. This
			// forces the SDK watch-error path to classify a gRPC status without
			// the caller's cancellation callback winning the terminal-state race.
			f.wire.events <- wireEvent{end: true, err: status.Error(scenario.status, "fixture stream ended")}
			eventually(t, func() bool { _, err := f.source.TrustView(); return err != nil })
			if ctx.Err() != nil {
				t.Fatal("watch failure cancelled the caller's context")
			}
			unavailableTrustView(t, f.source, scenario.code)
			_, err := f.source.Metadata()
			safeError(t, err, scenario.code)
		})
	}
}

func TestX509ExactIdentityOverridesSharedHint(t *testing.T) {
	f := newFixture(t, func(w *wireServer, c credentials) {
		first, selected := clone(c.other), clone(c.first)
		first.Hint, selected.Hint = "shared", "shared"
		w.initial.Svids = []*workload.X509SVID{first, selected}
	})
	f.start(t)
	snapshot := f.snapshot(t)
	if snapshot.SPIFFEID != ownID || !bytes.Equal(snapshot.PrivateKey, f.certs.first.X509SvidKey) {
		t.Fatal("shared hint displaced the explicitly selected nonfirst identity")
	}
}

func TestX509RejectsInvalidEntriesHiddenByHints(t *testing.T) {
	for _, kind := range []string{"certificate", "key", "bundle", "invalid raw ID", "duplicate other identity", "oversized chain", "oversized bundle", "swapped envelopes"} {
		t.Run(kind, func(t *testing.T) {
			f := newFixture(t, func(w *wireServer, c credentials) {
				selected, hidden := clone(c.first), clone(c.other)
				selected.Hint, hidden.Hint = "shared", "shared"
				w.initial.Svids = []*workload.X509SVID{selected, hidden}
				// Hint filtering must never conceal an invalid raw entry. Each
				// fixture starts with a valid expected identity as the first entry.
				switch kind {
				case "certificate":
					hidden.X509Svid = []byte("invalid certificate")
				case "key":
					hidden.X509SvidKey = c.first.X509SvidKey
				case "bundle":
					hidden.Bundle = []byte("invalid bundle")
				case "invalid raw ID":
					hidden.SpiffeId = "not-a-spiffe-id"
				case "duplicate other identity":
					w.initial.Svids = append(w.initial.Svids, clone(hidden))
				case "oversized chain":
					chain, err := x509.ParseCertificates(hidden.X509Svid)
					must(t, err)
					hidden.X509Svid = append(bytes.Clone(chain[0].Raw), bytes.Repeat(c.ca.Raw, 64)...)
				case "oversized bundle":
					hidden.Bundle = bytes.Repeat(c.ca.Raw, 65)
				case "swapped envelopes":
					selected.SpiffeId, hidden.SpiffeId = hidden.SpiffeId, selected.SpiffeId
				}
			})
			safeError(t, f.source.Start(context.Background()), "")
			unavailableTrustView(t, f.source, "")
			_, err := f.source.Snapshot()
			safeError(t, err, "")
		})
	}
}

func TestX509RotationAndReplacement(t *testing.T) {
	f := newFixture(t, func(w *wireServer, c credentials) {
		w.initial.Crl = [][]byte{{0x30, 0x00}}
		w.initial.FederatedBundles = map[string][]byte{"spiffe://federated.example": c.ca.Raw}
	})
	f.start(t)
	s := f.snapshot(t)
	// CRLs are opaque in the source; this fixture does not prove revocation validation.
	if len(s.CRLs) != 1 {
		t.Fatal("auxiliary context missing")
	}
	f.update(f.certs.rotated)
	eventually(t, func() bool {
		s, err := f.source.Snapshot()
		return err == nil && bytes.Equal(s.PrivateKey, f.certs.rotated.X509SvidKey)
	})
	s = f.snapshot(t)
	if len(s.CRLs) != 0 {
		t.Fatal("replacement retained removed context")
	}
}

func TestX509InvalidResponses(t *testing.T) {
	for _, name := range []string{"missing", "duplicate", "URI mismatch", "multiple URI", "key mismatch", "malformed DER", "empty bundle", "expired", "future", "too many entries"} {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t, func(w *wireServer, c credentials) {
				s := clone(c.first)
				switch name {
				case "missing":
					w.initial.Svids = []*workload.X509SVID{c.other}
					return
				case "duplicate":
					w.initial.Svids = []*workload.X509SVID{c.first, c.rotated}
					return
				case "URI mismatch":
					s = clone(c.other)
					s.SpiffeId = ownID
				case "multiple URI":
					u, _ := url.Parse(otherID)
					s = c.leaf(t, ownID, 5, time.Now().Add(-time.Minute), time.Now().Add(time.Hour), nil, u)
				case "key mismatch":
					s.X509SvidKey = c.other.X509SvidKey
				case "malformed DER":
					s.X509Svid = []byte("bad DER")
				case "empty bundle":
					s.Bundle = nil
				case "expired":
					s = c.leaf(t, ownID, 6, time.Now().Add(-time.Hour), time.Now().Add(-time.Minute), nil, nil)
				case "future":
					s = c.leaf(t, ownID, 7, time.Now().Add(time.Hour), time.Now().Add(2*time.Hour), nil, nil)
				case "too many entries":
					w.initial.Svids = []*workload.X509SVID{c.first}
					for range 64 {
						w.initial.Svids = append(w.initial.Svids, c.other)
					}
					return
				}
				w.initial.Svids = []*workload.X509SVID{s}
			})
			safeError(t, f.source.Start(context.Background()), "")
			unavailableTrustView(t, f.source, "")
			_, err := f.source.Snapshot()
			safeError(t, err, "")
		})
	}
}

func TestAdditionalDNSSANSupportedBySDK(t *testing.T) {
	f := newFixture(t, func(w *wireServer, c credentials) {
		w.initial.Svids = []*workload.X509SVID{c.leaf(t, ownID, 8, time.Now().Add(-time.Minute), time.Now().Add(time.Hour), []string{"test.example"}, nil)}
	})
	f.start(t)
	if f.snapshot(t).SPIFFEID != ownID {
		t.Fatal("identity missing")
	}
}

func TestInvalidReplacementFailsClosed(t *testing.T) {
	f := newFixture(t, nil)
	f.start(t)
	f.update(f.certs.other)
	eventually(t, func() bool { _, err := f.source.Snapshot(); return err != nil })
	unavailableTrustView(t, f.source, "")
	_, err := f.source.Metadata()
	safeError(t, err, "")
}

func TestX509ReceiveLimit(t *testing.T) {
	f := newFixture(t, nil)
	f.start(t)
	s := clone(f.certs.first)
	s.Hint = strings.Repeat("x", 4*1024*1024)
	f.update(s)
	eventually(t, func() bool { _, err := f.source.Snapshot(); return err != nil })
}

func TestX509CollectionBoundary(t *testing.T) {
	f := newFixture(t, func(w *wireServer, c credentials) {
		for i := range 63 {
			w.initial.Svids = append(w.initial.Svids, c.leaf(t, otherID+"/"+strconv.Itoa(i), int64(100+i), time.Now().Add(-time.Minute), time.Now().Add(time.Hour), nil, nil))
		}
	})
	f.start(t)
	if f.snapshot(t).SPIFFEID != ownID {
		t.Fatal("valid 64-entry response was not selected")
	}
	response := proto.Clone(f.wire.initial).(*workload.X509SVIDResponse)
	response.Svids = append(response.Svids, f.certs.other)
	f.wire.events <- wireEvent{response: response}
	eventually(t, func() bool { _, err := f.source.Snapshot(); return err != nil })
}

func TestMalformedReplacementClearsIdentity(t *testing.T) {
	f := newFixture(t, nil)
	f.start(t)
	malformed := clone(f.certs.first)
	malformed.X509Svid = []byte("malformed replacement")
	f.update(malformed)
	eventually(t, func() bool { _, err := f.source.Snapshot(); return err != nil })
	unavailableTrustView(t, f.source, "")
}

func TestStreamTerminationAndRecreation(t *testing.T) {
	f := newFixture(t, nil)
	f.start(t)
	f.wire.events <- wireEvent{end: true}
	eventually(t, func() bool { _, err := f.source.Snapshot(); return err != nil })
	unavailableTrustView(t, f.source, "")
	safeError(t, f.source.Start(context.Background()), "")
	replacement, err := identity.NewSource(identity.Options{SocketPath: f.path, ExpectedSPIFFEID: ownID, Timeout: time.Second})
	must(t, err)
	t.Cleanup(func() { replacement.Close() })
	must(t, replacement.Start(context.Background()))
	_, err = replacement.Metadata()
	must(t, err)
	_, err = f.source.Snapshot()
	safeError(t, err, "")
}

func TestUnavailableServer(t *testing.T) {
	f := newFixture(t, nil)
	f.start(t)
	f.server.Stop()
	eventually(t, func() bool { _, err := f.source.Snapshot(); return err != nil })
}

func TestSocketGuards(t *testing.T) {
	for _, kind := range []string{"missing", "file", "symlink"} {
		t.Run(kind, func(t *testing.T) {
			f := newFixture(t, nil)
			path := f.path + ".candidate"
			switch kind {
			case "file":
				must(t, os.WriteFile(path, []byte("not a socket"), 0600))
			case "symlink":
				must(t, os.Symlink(f.path, path))
			}
			s, err := identity.NewSource(identity.Options{SocketPath: path, ExpectedSPIFFEID: ownID, Timeout: time.Second})
			must(t, err)
			t.Cleanup(func() { s.Close() })
			safeError(t, s.Start(context.Background()), "UNAVAILABLE")
			if len(f.wire.records()) != 0 {
				t.Fatal("guarded path issued an RPC")
			}
		})
	}
}

func TestStartingTimeoutCancelAndClose(t *testing.T) {
	for _, action := range []string{"timeout", "cancel", "close"} {
		t.Run(action, func(t *testing.T) {
			f := newFixture(t, func(w *wireServer, _ credentials) { w.initial = nil })
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			result := make(chan error, 1)
			go func() { result <- f.source.Start(ctx) }()
			var streamCtx context.Context
			select {
			case streamCtx = <-f.wire.entered:
			case <-time.After(3 * time.Second):
				t.Fatal("stream did not start")
			}
			code := "TIMEOUT"
			switch action {
			case "cancel":
				cancel()
				code = "ABORTED"
			case "close":
				f.source.Close()
				code = "CLOSED"
			}
			select {
			case err := <-result:
				safeError(t, err, code)
			case <-time.After(3 * time.Second):
				t.Fatal("start did not finish")
			}
			eventually(t, func() bool { return streamCtx.Err() != nil })
			unavailableTrustView(t, f.source, code)
			_, err := f.source.Metadata()
			safeError(t, err, "")
		})
	}
}

func TestSnapshotDefensiveCopies(t *testing.T) {
	f := newFixture(t, nil)
	f.start(t)
	s := f.snapshot(t)
	clear(s.PrivateKey)
	clear(s.CertificateChain[0])
	clear(s.Bundle[0])
	next := f.snapshot(t)
	if !bytes.Equal(next.PrivateKey, f.certs.first.X509SvidKey) || !bytes.Equal(next.Bundle[0], f.certs.ca.Raw) {
		t.Fatal("caller mutated retained snapshot")
	}
	certs, err := x509.ParseCertificates(f.certs.first.X509Svid)
	must(t, err)
	if !bytes.Equal(next.CertificateChain[0], certs[0].Raw) {
		t.Fatal("caller mutated retained certificate")
	}
}

func TestX509ExpiryTimerRevokesIdentity(t *testing.T) {
	f := newFixture(t, func(w *wireServer, c credentials) {
		w.initial.Svids = []*workload.X509SVID{c.leaf(t, ownID, 9, time.Now().Add(-time.Minute), time.Now().Add(2*time.Second), nil, nil)}
	})
	f.start(t)
	stream := <-f.wire.entered
	// Wait for transport cancellation without calling a getter: this proves
	// passage of time triggers revocation independently of lazy access checks.
	select {
	case <-stream.Done():
	case <-time.After(3 * time.Second):
		t.Fatal("expiry timer did not cancel the identity stream")
	}
	unavailableTrustView(t, f.source, "EXPIRED")
	_, err := f.source.Snapshot()
	safeError(t, err, "EXPIRED")
	_, err = f.source.Metadata()
	safeError(t, err, "EXPIRED")
}

func TestConcurrentRotationSnapshotsAndCancellation(t *testing.T) {
	f := newFixture(t, nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	must(t, f.source.Start(ctx))
	var readers sync.WaitGroup
	for range 8 {
		readers.Go(func() {
			for ctx.Err() == nil {
				snapshot, err := f.source.Snapshot()
				if err == nil {
					if snapshot.SPIFFEID != ownID || len(snapshot.CertificateChain) != 2 {
						t.Error("inconsistent concurrent snapshot")
					}
					clear(snapshot.PrivateKey)
				}
				f.source.Metadata()
			}
		})
	}
	// Observe both credentials repeatedly while readers copy and mutate their
	// snapshots, so the race detector sees actual updates rather than queued work.
	for range 5 {
		f.update(f.certs.rotated)
		eventually(t, func() bool {
			s, err := f.source.Snapshot()
			return err == nil && bytes.Equal(s.PrivateKey, f.certs.rotated.X509SvidKey)
		})
		f.update(f.certs.first)
		eventually(t, func() bool {
			s, err := f.source.Snapshot()
			return err == nil && bytes.Equal(s.PrivateKey, f.certs.first.X509SvidKey)
		})
	}
	cancel()
	readers.Wait()
	eventually(t, func() bool { _, err := f.source.Snapshot(); return err != nil })
}
