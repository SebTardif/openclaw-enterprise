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
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
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
	"google.golang.org/protobuf/types/known/structpb"
)

const ownID = "spiffe://test.example/occ/controller"
const otherID = "spiffe://test.example/occ/other"
const audience = "occ-test-service"

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
	bundle, err := x509.ParseCertificates(selected.Bundle)
	must(t, err)
	expires := chain[0].NotAfter
	for _, certificate := range chain {
		if certificate.NotAfter.Before(expires) {
			expires = certificate.NotAfter
		}
	}
	digest := sha256.Sum256(selected.Bundle)
	return identity.TrustView{
		Metadata:     identity.Metadata{SPIFFEID: selected.SpiffeId, ExpiresAt: expires.UTC(), CertificateCount: len(chain), BundleCertificateCount: len(bundle)},
		BundleSHA256: "sha256:" + hex.EncodeToString(digest[:]),
		CRLCount:     len(response.Crl), FederatedBundleCount: len(response.FederatedBundles),
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
	method    string
	metadata  []string
	audience  []string
	id, token string
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
	fetch    func(context.Context, *workload.JWTSVIDRequest) (*workload.JWTSVIDResponse, error)
	validate func(context.Context, *workload.ValidateJWTSVIDRequest) (*workload.ValidateJWTSVIDResponse, error)
	issued   string
	claims   *workload.ValidateJWTSVIDResponse
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
func (w *wireServer) FetchJWTSVID(ctx context.Context, r *workload.JWTSVIDRequest) (*workload.JWTSVIDResponse, error) {
	w.record(ctx, recordedRequest{method: "fetch", audience: append([]string(nil), r.Audience...), id: r.SpiffeId})
	if w.fetch != nil {
		return w.fetch(ctx, r)
	}
	return &workload.JWTSVIDResponse{Svids: []*workload.JWTSVID{{SpiffeId: ownID, Svid: w.issued}}}, nil
}
func (w *wireServer) ValidateJWTSVID(ctx context.Context, r *workload.ValidateJWTSVIDRequest) (*workload.ValidateJWTSVIDResponse, error) {
	w.record(ctx, recordedRequest{method: "validate", audience: []string{r.Audience}, token: r.Svid})
	if w.validate != nil {
		return w.validate(ctx, r)
	}
	return w.claims, nil
}

// These tests exercise the actual source, SDK, generated protocol, and Unix
// transport. The local server does not prove SPIRE attestation or signature
// verification: it represents the trusted endpoint's validation response.
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
	issued := signedToken(t, ownID, audience, time.Now().Add(10*time.Minute))
	w := &wireServer{initial: &workload.X509SVIDResponse{Svids: []*workload.X509SVID{c.first}}, events: make(chan wireEvent, 64), entered: make(chan context.Context, 64), issued: issued, claims: claims(t, ownID, ownID, audience, time.Now().Add(10*time.Minute).Unix())}
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
func claims(t *testing.T, id, subject, aud string, exp int64) *workload.ValidateJWTSVIDResponse {
	t.Helper()
	v, err := structpb.NewStruct(map[string]any{"sub": subject, "aud": []any{aud}, "exp": float64(exp)})
	must(t, err)
	return &workload.ValidateJWTSVIDResponse{SpiffeId: id, Claims: v}
}
func signedToken(t *testing.T, id, aud string, exp time.Time) string {
	t.Helper()
	return signedClaimsToken(t, map[string]any{"sub": id, "aud": []string{aud}, "exp": exp.Unix()})
}
func signedClaimsToken(t *testing.T, claims map[string]any) string {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	must(t, err)
	header, _ := json.Marshal(map[string]any{"alg": "ES256", "typ": "JWT", "kid": "disposable-fixture"})
	payload, _ := json.Marshal(claims)
	input := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(payload)
	digest := sha256.Sum256([]byte(input))
	r, s, err := ecdsa.Sign(rand.Reader, key, digest[:])
	must(t, err)
	signature := make([]byte, 64)
	r.FillBytes(signature[:32])
	s.FillBytes(signature[32:])
	return input + "." + base64.RawURLEncoding.EncodeToString(signature)
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
	if m.SPIFFEID != ownID || !m.ExpiresAt.Equal(chain[0].NotAfter) || m.CertificateCount != 2 || m.BundleCertificateCount != 1 {
		t.Fatal("incorrect safe metadata")
	}
	for _, r := range f.wire.records() {
		if !reflect.DeepEqual(r.metadata, []string{"true"}) {
			t.Fatal("required workload metadata missing")
		}
	}
}

func TestTrustViewOrderedBundleAndValueIsolation(t *testing.T) {
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
	view.Metadata.SPIFFEID = otherID
	view.Metadata.ExpiresAt = time.Time{}
	view.Metadata.CertificateCount = 0
	view.Metadata.BundleCertificateCount = 0
	view.BundleSHA256 = "changed"
	view.CRLCount = 0
	view.FederatedBundleCount = 0
	next, err := f.source.TrustView()
	must(t, err)
	if next != want {
		t.Fatal("returned value mutation changed the source")
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
	if next != want {
		t.Fatal("a historical returned value changed after replacement or close")
	}
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
	if len(s.CRLs) != 1 || len(s.FederatedBundles) != 1 {
		t.Fatal("auxiliary context missing")
	}
	f.update(f.certs.rotated)
	eventually(t, func() bool {
		s, err := f.source.Snapshot()
		return err == nil && bytes.Equal(s.PrivateKey, f.certs.rotated.X509SvidKey)
	})
	s = f.snapshot(t)
	if len(s.CRLs) != 0 || len(s.FederatedBundles) != 0 {
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
	_, err = f.source.FetchJWTSVID(context.Background(), audience)
	safeError(t, err, "")
	for _, r := range f.wire.records() {
		if r.method == "fetch" {
			t.Fatal("JWT RPC issued after terminal replacement")
		}
	}
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
	_, err := f.source.FetchJWTSVID(context.Background(), audience)
	safeError(t, err, "")
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

func TestJWTRequiresLiveSource(t *testing.T) {
	f := newFixture(t, nil)
	_, err := f.source.FetchJWTSVID(context.Background(), audience)
	safeError(t, err, "")
	_, err = f.source.ValidateJWTSVID(context.Background(), f.wire.issued, audience, ownID)
	safeError(t, err, "")
	if len(f.wire.records()) != 0 {
		t.Fatal("unstarted source issued RPC")
	}
	f.start(t)
	f.source.Close()
	_, err = f.source.FetchJWTSVID(context.Background(), audience)
	safeError(t, err, "CLOSED")
}

func TestJWTWireRequests(t *testing.T) {
	f := newFixture(t, nil)
	f.start(t)
	jwt, err := f.source.FetchJWTSVID(context.Background(), audience)
	must(t, err)
	if jwt.SPIFFEID != ownID || jwt.Token != f.wire.issued || !jwt.ExpiresAt.After(time.Now()) {
		t.Fatal("unexpected JWT result")
	}
	validated, err := f.source.ValidateJWTSVID(context.Background(), jwt.Token, audience, ownID)
	must(t, err)
	if validated.SPIFFEID != ownID {
		t.Fatal("unexpected validated identity")
	}
	fetches, validations := 0, 0
	for _, r := range f.wire.records() {
		if !reflect.DeepEqual(r.metadata, []string{"true"}) {
			t.Fatal("missing workload metadata")
		}
		switch r.method {
		case "fetch":
			fetches++
			if !reflect.DeepEqual(r.audience, []string{audience}) || r.id != ownID {
				t.Fatal("incorrect fetch request")
			}
		case "validate":
			validations++
			if !reflect.DeepEqual(r.audience, []string{audience}) || r.token != jwt.Token {
				t.Fatal("incorrect validation request")
			}
		}
	}
	if fetches != 1 || validations != 2 {
		t.Fatalf("fetch/validate RPC counts %d/%d, want 1/2", fetches, validations)
	}
}

func TestJWTExactIdentityOverridesSharedHint(t *testing.T) {
	f := newFixture(t, func(w *wireServer, _ credentials) {
		other := signedToken(t, otherID, audience, time.Now().Add(time.Hour))
		w.fetch = func(context.Context, *workload.JWTSVIDRequest) (*workload.JWTSVIDResponse, error) {
			return &workload.JWTSVIDResponse{Svids: []*workload.JWTSVID{
				{SpiffeId: otherID, Svid: other, Hint: "shared"},
				{SpiffeId: ownID, Svid: w.issued, Hint: "shared"},
			}}, nil
		}
	})
	f.start(t)
	jwt, err := f.source.FetchJWTSVID(context.Background(), audience)
	must(t, err)
	if jwt.SPIFFEID != ownID || jwt.Token != f.wire.issued {
		t.Fatal("hint displaced explicitly selected JWT")
	}
	validations := 0
	for _, request := range f.wire.records() {
		if request.method == "validate" {
			validations++
			if request.token != jwt.Token {
				t.Fatal("selected JWT was not sent for trusted validation")
			}
		}
	}
	if validations != 1 {
		t.Fatal("fetch did not require trusted validation of selected token")
	}
}

func TestJWTRejectsInvalidEntriesHiddenByHints(t *testing.T) {
	for _, kind := range []string{"duplicate expected identity", "duplicate other identity", "invalid raw ID", "malformed token", "oversized token", "envelope mismatch", "wrong audience"} {
		t.Run(kind, func(t *testing.T) {
			f := newFixture(t, func(w *wireServer, _ credentials) {
				selected := &workload.JWTSVID{SpiffeId: ownID, Svid: w.issued, Hint: "shared"}
				hidden := &workload.JWTSVID{SpiffeId: otherID, Svid: signedToken(t, otherID, audience, time.Now().Add(time.Hour)), Hint: "shared"}
				entries := []*workload.JWTSVID{selected, hidden}
				switch kind {
				case "duplicate expected identity":
					entries = append(entries, proto.Clone(selected).(*workload.JWTSVID))
				case "duplicate other identity":
					entries = append(entries, proto.Clone(hidden).(*workload.JWTSVID))
				case "invalid raw ID":
					hidden.SpiffeId = "not-a-spiffe-id"
				case "malformed token":
					hidden.Svid = "not-a-JWT"
				case "oversized token":
					// This is otherwise parseable and signed, so the size limit is
					// tested independently of malformed compact serialization.
					hidden.Svid = signedClaimsToken(t, map[string]any{"sub": otherID, "aud": []string{audience}, "exp": time.Now().Add(time.Hour).Unix(), "padding": strings.Repeat("x", 64*1024)})
				case "envelope mismatch":
					hidden.Svid = w.issued
				case "wrong audience":
					hidden.Svid = signedToken(t, otherID, "other-audience", time.Now().Add(time.Hour))
				}
				w.fetch = func(context.Context, *workload.JWTSVIDRequest) (*workload.JWTSVIDResponse, error) {
					return &workload.JWTSVIDResponse{Svids: entries}, nil
				}
			})
			f.start(t)
			_, err := f.source.FetchJWTSVID(context.Background(), audience)
			safeError(t, err, "")
			for _, request := range f.wire.records() {
				if request.method == "validate" {
					t.Fatal("invalid complete fetch response reached selected-token validation")
				}
			}
		})
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
	_, err = f.source.FetchJWTSVID(context.Background(), audience)
	safeError(t, err, "EXPIRED")
	for _, request := range f.wire.records() {
		if request.method == "fetch" {
			t.Fatal("expired source issued a JWT RPC")
		}
	}
}

func TestJWTConcurrentOperationBoundary(t *testing.T) {
	entered := make(chan context.Context, 16)
	f := newFixture(t, func(w *wireServer, _ credentials) {
		w.fetch = func(ctx context.Context, _ *workload.JWTSVIDRequest) (*workload.JWTSVIDResponse, error) {
			entered <- ctx
			<-ctx.Done()
			return nil, ctx.Err()
		}
	})
	f.start(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	results := make(chan error, 16)
	for range 16 {
		go func() { _, err := f.source.FetchJWTSVID(ctx, audience); results <- err }()
	}
	for range 16 {
		select {
		case <-entered:
		case <-time.After(3 * time.Second):
			t.Fatal("16 concurrent operations were not admitted")
		}
	}
	_, err := f.source.FetchJWTSVID(context.Background(), audience)
	safeError(t, err, "BUSY")
	cancel()
	for range 16 {
		select {
		case err := <-results:
			safeError(t, err, "ABORTED")
		case <-time.After(3 * time.Second):
			t.Fatal("pending JWT operation was not cancelled")
		}
	}
	fetches := 0
	for _, request := range f.wire.records() {
		if request.method == "fetch" {
			fetches++
		}
	}
	if fetches != 16 {
		t.Fatalf("admitted %d RPCs, want 16", fetches)
	}
}

func TestJWTResponseRejections(t *testing.T) {
	for _, operation := range []string{"fetch", "validate"} {
		for _, kind := range []string{"identity", "subject", "audience", "expiry"} {
			t.Run(operation+"/"+kind, func(t *testing.T) {
				f := newFixture(t, func(w *wireServer, _ credentials) {
					id, sub, aud, exp := ownID, ownID, audience, time.Now().Add(time.Hour).Unix()
					switch kind {
					case "identity":
						id = otherID
					case "subject":
						sub = otherID
					case "audience":
						aud = "other-service"
					case "expiry":
						exp = 1
					}
					w.claims = claims(t, id, sub, aud, exp)
				})
				f.start(t)
				var err error
				if operation == "fetch" {
					_, err = f.source.FetchJWTSVID(context.Background(), audience)
				} else {
					_, err = f.source.ValidateJWTSVID(context.Background(), f.wire.issued, audience, ownID)
				}
				safeError(t, err, "")
			})
		}
	}
}

func TestJWTErrorSanitization(t *testing.T) {
	const secret = "fixture-secret-must-not-escape"
	f := newFixture(t, func(w *wireServer, _ credentials) {
		w.validate = func(context.Context, *workload.ValidateJWTSVIDRequest) (*workload.ValidateJWTSVIDResponse, error) {
			return nil, status.Error(codes.PermissionDenied, secret)
		}
	})
	f.start(t)
	_, err := f.source.ValidateJWTSVID(context.Background(), f.wire.issued, audience, ownID)
	safeError(t, err, "")
	encoded, _ := json.Marshal(err)
	if strings.Contains(err.Error(), secret) || strings.Contains(string(encoded), secret) || errors.Unwrap(err) != nil {
		t.Fatal("raw provider error escaped")
	}
}

func TestJWTTimeoutAndCancellation(t *testing.T) {
	for _, action := range []string{"timeout", "cancel", "lifetime cancel", "close"} {
		t.Run(action, func(t *testing.T) {
			entered := make(chan context.Context, 1)
			f := newFixture(t, func(w *wireServer, _ credentials) {
				w.fetch = func(ctx context.Context, _ *workload.JWTSVIDRequest) (*workload.JWTSVIDResponse, error) {
					entered <- ctx
					<-ctx.Done()
					return nil, ctx.Err()
				}
			})
			lifetime, stop := context.WithCancel(context.Background())
			defer stop()
			must(t, f.source.Start(lifetime))
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			result := make(chan error, 1)
			go func() { _, err := f.source.FetchJWTSVID(ctx, audience); result <- err }()
			var serverCtx context.Context
			select {
			case serverCtx = <-entered:
			case <-time.After(3 * time.Second):
				t.Fatal("unary RPC did not start")
			}
			switch action {
			case "cancel":
				cancel()
			case "lifetime cancel":
				stop()
			case "close":
				f.source.Close()
			}
			select {
			case err := <-result:
				safeError(t, err, "")
			case <-time.After(3 * time.Second):
				t.Fatal("unary RPC did not finish")
			}
			eventually(t, func() bool { return serverCtx.Err() != nil })
			if action == "lifetime cancel" || action == "close" {
				_, err := f.source.Metadata()
				safeError(t, err, "")
			}
		})
	}
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
