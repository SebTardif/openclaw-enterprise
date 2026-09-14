package githubbridge

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math/big"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/openclaw/openclaw-enterprise/components/runtime-security/identity"
	"github.com/openclaw/openclaw-enterprise/components/runtime-security/servicepeer"
	"github.com/spiffe/go-spiffe/v2/proto/spiffe/workload"
	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"
)

const clientID = "spiffe://github-test.example/service/ds"
const serverID = "spiffe://github-test.example/service/broker"
const otherID = "spiffe://github-test.example/service/other"

func must(t *testing.T, e error) {
	t.Helper()
	if e != nil {
		t.Fatal(e)
	}
}

type certificateAuthority struct {
	cert *x509.Certificate
	key  *ecdsa.PrivateKey
}

func newCA(t *testing.T) certificateAuthority {
	t.Helper()
	key, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	must(t, e)
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "Disposable external test CA"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	raw, e := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	must(t, e)
	cert, e := x509.ParseCertificate(raw)
	must(t, e)
	return certificateAuthority{cert, key}
}
func (c certificateAuthority) issue(t *testing.T, id string) *workload.X509SVID {
	t.Helper()
	key, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	must(t, e)
	uri, e := url.Parse(id)
	must(t, e)
	serial, e := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 120))
	must(t, e)
	template := &x509.Certificate{SerialNumber: serial, NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour), URIs: []*url.URL{uri}, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth, x509.ExtKeyUsageServerAuth}}
	raw, e := x509.CreateCertificate(rand.Reader, template, c.cert, &key.PublicKey, c.key)
	must(t, e)
	private, e := x509.MarshalPKCS8PrivateKey(key)
	must(t, e)
	return &workload.X509SVID{SpiffeId: id, X509Svid: append(raw, c.cert.Raw...), X509SvidKey: private, Bundle: bytes.Clone(c.cert.Raw)}
}

// This is solely an external SPIFFE Workload API fixture. The production Source,
// maintained X.509 verifier, protected Unix listener and private bridge remain
// unchanged. Successful transport never represents current Work authorization.
type externalWorkloadAPI struct {
	workload.UnimplementedSpiffeWorkloadAPIServer
	svid *workload.X509SVID
}

func (a *externalWorkloadAPI) FetchX509SVID(_ *workload.X509SVIDRequest, s grpc.ServerStreamingServer[workload.X509SVIDResponse]) error {
	md, _ := metadata.FromIncomingContext(s.Context())
	if v := md.Get("workload.spiffe.io"); len(v) != 1 || v[0] != "true" {
		return errors.New("missing workload metadata")
	}
	if e := s.Send(&workload.X509SVIDResponse{Svids: []*workload.X509SVID{a.svid}}); e != nil {
		return e
	}
	<-s.Context().Done()
	return s.Context().Err()
}
func api(t *testing.T, dir, name string, svid *workload.X509SVID) (string, *grpc.Server) {
	t.Helper()
	path := filepath.Join(dir, name)
	listener, e := net.Listen("unix", path)
	must(t, e)
	server := grpc.NewServer()
	workload.RegisterSpiffeWorkloadAPIServer(server, &externalWorkloadAPI{svid: svid})
	go server.Serve(listener)
	t.Cleanup(server.Stop)
	return path, server
}
func protectedDirectory(t *testing.T) string {
	t.Helper()
	home, e := os.UserHomeDir()
	must(t, e)
	dir, e := os.MkdirTemp(home, ".gb-")
	must(t, e)
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}
func ancestorUIDs(t *testing.T, path string) []uint32 {
	t.Helper()
	seen := map[uint32]bool{}
	var uids []uint32
	for current := filepath.Dir(path); ; current = filepath.Dir(current) {
		info, e := os.Lstat(current)
		must(t, e)
		uid := info.Sys().(*syscall.Stat_t).Uid
		if !seen[uid] {
			seen[uid] = true
			uids = append(uids, uid)
		}
		if current == "/" {
			break
		}
	}
	return uids
}

type bridgeHarness struct {
	profile         Profile
	parent          net.Conn
	cancel          context.CancelFunc
	done            chan error
	sequence        int64
	eventSequence   int64
	incarnation     string
	clientSource    *identity.Source
	serverAPI       *grpc.Server
	clientTransport *servicepeer.Transport
}

func marshal(t *testing.T, v any) []byte {
	t.Helper()
	raw, e := json.Marshal(v)
	must(t, e)
	return raw
}
func harness(t *testing.T, configure func(*Profile)) *bridgeHarness {
	t.Helper()
	dir := protectedDirectory(t)
	ca := newCA(t)
	serverSVID := ca.issue(t, serverID)
	serverPath, serverAPI := api(t, dir, "bapi", serverSVID)
	clientPath, _ := api(t, dir, "capi", ca.issue(t, clientID))
	p := Profile{Version: 1, WorkloadAPISocketPath: serverPath, OwnSPIFFEID: serverID, PeerSPIFFEID: clientID, RecipientSPIFFEID: serverID, TrustBundleSHA256: digest(serverSVID.Bundle), ListenPath: filepath.Join(dir, "broker"), PeerUID: uint32(os.Getuid()), HandshakeTimeoutMs: 1000, RecheckIntervalMs: 25, MaxConnectionAgeMs: 10000, RequestTimeoutMs: 2000}
	p.TrustedAncestorUIDs = ancestorUIDs(t, p.ListenPath)
	if configure != nil {
		configure(&p)
	}
	child, parent := net.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	h := &bridgeHarness{profile: p, parent: parent, cancel: cancel, done: make(chan error, 1), sequence: 1, incarnation: "0123456789abcdef0123456789abcdef", serverAPI: serverAPI}
	go func() { h.done <- Run(ctx, child, child) }()
	t.Cleanup(func() {
		cancel()
		parent.Close()
		select {
		case <-h.done:
		case <-time.After(4 * time.Second):
			t.Error("native bridge did not join")
		}
	})
	c := Control{Version: 1, Kind: "bootstrap", Incarnation: h.incarnation, Sequence: 1, MetadataBase64: base64.StdEncoding.EncodeToString(marshal(t, p))}
	must(t, parent.SetDeadline(time.Now().Add(4*time.Second)))
	must(t, WriteControlFrame(parent, &Frame{Metadata: marshal(t, c)}))
	ready := h.next(t)
	if ready.Kind != "ready" || ready.Sequence != 1 || ready.DeadlineMs != 0 || ready.MetadataBase64 != "" {
		t.Fatal("invalid ready event")
	}
	must(t, parent.SetDeadline(time.Time{}))
	source, e := identity.NewSource(identity.Options{SocketPath: clientPath, ExpectedSPIFFEID: clientID, Timeout: time.Second})
	must(t, e)
	must(t, source.Start(context.Background()))
	h.clientSource = source
	t.Cleanup(func() { source.Close() })
	tr, e := servicepeer.New(source, servicepeer.Config{Side: servicepeer.Client, OwnSPIFFEID: clientID, PeerSPIFFEID: serverID, RecipientSPIFFEID: serverID, ApplicationProtocol: p.applicationProtocol(), HandshakeTimeout: time.Second, RecheckInterval: 25 * time.Millisecond, MaxConnectionAge: 10 * time.Second, MaxConnections: 2})
	must(t, e)
	h.clientTransport = tr
	t.Cleanup(func() { tr.Close() })
	return h
}
func (h *bridgeHarness) connect(t *testing.T) *servicepeer.Connection {
	t.Helper()
	raw, e := net.Dial("unix", h.profile.ListenPath)
	must(t, e)
	c, e := h.clientTransport.Handshake(context.Background(), raw)
	must(t, e)
	t.Cleanup(func() { c.Close() })
	must(t, c.SetDeadline(time.Now().Add(4*time.Second)))
	return c
}
func (h *bridgeHarness) next(t *testing.T) Control {
	t.Helper()
	must(t, h.parent.SetReadDeadline(time.Now().Add(4*time.Second)))
	f, e := ReadControlFrame(h.parent)
	must(t, e)
	defer f.Clear()
	if len(f.Secret) != 0 {
		t.Fatal("secret emitted on parent metadata channel")
	}
	c, e := decodeControl(f.Metadata)
	must(t, e)
	h.eventSequence++
	if c.Incarnation != h.incarnation || c.Sequence != h.eventSequence {
		t.Fatal("invalid event sequence")
	}
	return c
}
func (h *bridgeHarness) command(t *testing.T, event Control, kind, challenge string, raw, secret []byte) {
	t.Helper()
	h.sequence++
	c := Control{Version: 1, Kind: kind, Incarnation: h.incarnation, Sequence: h.sequence, ConnectionID: event.ConnectionID, ExchangeID: event.ExchangeID, RequestSHA256: event.RequestSHA256, Challenge: challenge, MetadataBase64: base64.StdEncoding.EncodeToString(raw), DeadlineMs: event.DeadlineMs}
	must(t, h.parent.SetWriteDeadline(time.Now().Add(3*time.Second)))
	must(t, WriteControlFrame(h.parent, &Frame{Metadata: marshal(t, c), Secret: secret}))
}
func (h *bridgeHarness) inspect(t *testing.T, event Control) Inspection {
	t.Helper()
	challenge := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	h.command(t, event, "inspect", challenge, nil, nil)
	reply := h.next(t)
	if reply.Kind != "inspection" || reply.Challenge != challenge || reply.ConnectionID != event.ConnectionID || reply.ExchangeID != event.ExchangeID || reply.RequestSHA256 != event.RequestSHA256 || reply.DeadlineMs != event.DeadlineMs {
		t.Fatal("inspection correspondence lost")
	}
	raw, e := payload(reply)
	must(t, e)
	var view Inspection
	must(t, strict(raw, &view))
	return view
}
func opened(t *testing.T, request map[string]any) map[string]any {
	t.Helper()
	now := time.Now().UnixMilli()
	return map[string]any{"version": 2, "sequence": request["sequence"], "request_ref": request["request_ref"], "session_ref": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "effect_ref": "effect/1", "work_binding_sha256": "sha256:" + string(bytes.Repeat([]byte("c"), 64)), "request_sha256": request["request_sha256"], "ok": true, "phase": "opened", "server_time_ms": now, "valid_until_ms": now + 1000, "operation_until_ms": now + 8000, "dns_binding_ref": "dns/1", "upstream_ipv4": "93.184.216.34"}
}
func openRequest() map[string]any {
	return map[string]any{"version": 2, "sequence": 1, "request_ref": "dddddddddddddddddddddddddddddddd", "method": "open-read", "attachment_ref": "attachment/1", "repository_owner": "openclaw", "repository_name": "example", "request_sha256": "sha256:" + string(bytes.Repeat([]byte("e"), 64))}
}
