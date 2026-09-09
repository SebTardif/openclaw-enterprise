package nodeobserver

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"github.com/openclaw/openclaw-enterprise/components/runtime-security/identity"
	"github.com/openclaw/openclaw-enterprise/components/runtime-security/servicepeer"
	"github.com/spiffe/go-spiffe/v2/proto/spiffe/workload"
	"google.golang.org/grpc"
	grpcmetadata "google.golang.org/grpc/metadata"
	"google.golang.org/protobuf/proto"
	"math/big"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Reuse the repository's real generated-SVID/Workload API fixture mechanics.
// They qualify owned TLS request custody, not production node enrollment.
const (
	clientID = "spiffe://test.example/service/client"
	serverID = "spiffe://test.example/service/server"
	otherID  = "spiffe://test.example/service/other"
)

// These tests exercise real TLS, the actual identity.Source, the pinned SPIFFE
// SDK, and the generated Workload API over a local Unix socket. The generated
// certificates and controlled endpoint do not prove production SPIRE attestation
// or an OCC service role, installation binding, or application authorization.
type testCA struct {
	certificate *x509.Certificate
	key         *ecdsa.PrivateKey
}

func newCA(t *testing.T) testCA {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	must(t, err)
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "Disposable service-peer test CA"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	must(t, err)
	certificate, err := x509.ParseCertificate(der)
	must(t, err)
	return testCA{certificate: certificate, key: key}
}

func (ca testCA) issue(t *testing.T, id string, until time.Time) *workload.X509SVID {
	t.Helper()
	return ca.issueWith(t, id, until, nil)
}

func (ca testCA) issueWith(t *testing.T, id string, until time.Time, configure func(*x509.Certificate)) *workload.X509SVID {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	must(t, err)
	uri, err := url.Parse(id)
	must(t, err)
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 120))
	must(t, err)
	template := &x509.Certificate{
		SerialNumber: serial, Subject: pkix.Name{CommonName: "Disposable service-peer workload"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: until, URIs: []*url.URL{uri},
		BasicConstraintsValid: true, KeyUsage: x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth, x509.ExtKeyUsageServerAuth},
	}
	if configure != nil {
		configure(template)
	}
	der, err := x509.CreateCertificate(rand.Reader, template, ca.certificate, &key.PublicKey, ca.key)
	must(t, err)
	privateKey, err := x509.MarshalPKCS8PrivateKey(key)
	must(t, err)
	return &workload.X509SVID{SpiffeId: id, X509Svid: append(der, ca.certificate.Raw...), X509SvidKey: privateKey, Bundle: bytes.Clone(ca.certificate.Raw)}
}

type workloadEndpoint struct {
	workload.UnimplementedSpiffeWorkloadAPIServer
	initial *workload.X509SVIDResponse
	updates chan *workload.X509SVIDResponse
}

func (w *workloadEndpoint) FetchX509SVID(_ *workload.X509SVIDRequest, stream grpc.ServerStreamingServer[workload.X509SVIDResponse]) error {
	md, _ := grpcmetadata.FromIncomingContext(stream.Context())
	if values := md.Get("workload.spiffe.io"); len(values) != 1 || values[0] != "true" {
		return errors.New("missing Workload API metadata")
	}
	if err := stream.Send(w.initial); err != nil {
		return err
	}
	for {
		select {
		case <-stream.Context().Done():
			return stream.Context().Err()
		case update := <-w.updates:
			if err := stream.Send(update); err != nil {
				return err
			}
		}
	}
}

type sourceFixture struct {
	source   *identity.Source
	endpoint *workloadEndpoint
	server   *grpc.Server
	svid     *workload.X509SVID
}

func newSource(t *testing.T, svid *workload.X509SVID, crls ...[]byte) sourceFixture {
	t.Helper()
	w := &workloadEndpoint{
		initial: &workload.X509SVIDResponse{Svids: []*workload.X509SVID{cloneSVID(svid)}, Crl: crls},
		updates: make(chan *workload.X509SVIDResponse, 8),
	}
	// The short pathname avoids Unix socket limits for descriptive subtest names.
	dir, err := os.MkdirTemp("", "occ-peer-wapi-")
	must(t, err)
	t.Cleanup(func() { os.RemoveAll(dir) })
	path := filepath.Join(dir, "api.sock")
	listener, err := net.Listen("unix", path)
	must(t, err)
	server := grpc.NewServer()
	workload.RegisterSpiffeWorkloadAPIServer(server, w)
	go server.Serve(listener)
	t.Cleanup(server.Stop)
	source, err := identity.NewSource(identity.Options{SocketPath: path, ExpectedSPIFFEID: svid.SpiffeId, Timeout: time.Second})
	must(t, err)
	t.Cleanup(func() { source.Close() })
	must(t, source.Start(context.Background()))
	return sourceFixture{source: source, endpoint: w, server: server, svid: cloneSVID(svid)}
}

func cloneSVID(svid *workload.X509SVID) *workload.X509SVID {
	return proto.Clone(svid).(*workload.X509SVID)
}

func (f sourceFixture) replace(t *testing.T, svid *workload.X509SVID, crls ...[]byte) {
	t.Helper()
	f.endpoint.updates <- &workload.X509SVIDResponse{Svids: []*workload.X509SVID{cloneSVID(svid)}, Crl: crls}
	eventually(t, func() bool {
		s, err := f.source.Snapshot()
		return err == nil && bytes.Equal(bytes.Join(s.CertificateChain, nil), svid.X509Svid) &&
			bytes.Equal(bytes.Join(s.Bundle, nil), svid.Bundle) && len(s.CRLs) == len(crls) && bytes.Equal(bytes.Join(s.CRLs, nil), bytes.Join(crls, nil))
	})
}

func defaultConfig(side servicepeer.Side) servicepeer.Config {
	config := servicepeer.Config{
		Side: side, OwnSPIFFEID: clientID, PeerSPIFFEID: serverID, RecipientSPIFFEID: serverID,
		HandshakeTimeout: time.Second, RecheckInterval: 25 * time.Millisecond,
		MaxConnectionAge: time.Minute, MaxConnections: 4,
	}
	if side == servicepeer.Server {
		config.OwnSPIFFEID, config.PeerSPIFFEID = serverID, clientID
	}
	return config
}

func newTransport(t *testing.T, f sourceFixture, config servicepeer.Config) *servicepeer.Transport {
	t.Helper()
	transport, err := servicepeer.New(f.source, config)
	must(t, err)
	t.Cleanup(func() { transport.Close() })
	return transport
}

type pairFixture struct {
	ca             testCA
	client, server sourceFixture
	clientSide     *servicepeer.Transport
	serverSide     *servicepeer.Transport
}

func newPairFixture(t *testing.T, configure func(*servicepeer.Config, *servicepeer.Config)) pairFixture {
	t.Helper()
	ca := newCA(t)
	client := newSource(t, ca.issue(t, clientID, time.Now().Add(time.Hour)))
	server := newSource(t, ca.issue(t, serverID, time.Now().Add(time.Hour)))
	clientConfig, serverConfig := defaultConfig(servicepeer.Client), defaultConfig(servicepeer.Server)
	if configure != nil {
		configure(&clientConfig, &serverConfig)
	}
	return pairFixture{ca: ca, client: client, server: server,
		clientSide: newTransport(t, client, clientConfig), serverSide: newTransport(t, server, serverConfig)}
}

type handshakeResult struct {
	connection *servicepeer.Connection
	err        error
}

func pipe(t *testing.T) (net.Conn, net.Conn) {
	t.Helper()
	left, right := net.Pipe()
	t.Cleanup(func() { left.Close(); right.Close() })
	return left, right
}

func handshakePair(t *testing.T, client, server *servicepeer.Transport, ctx context.Context) (handshakeResult, handshakeResult) {
	t.Helper()
	left, right := pipe(t)
	clientResult, serverResult := make(chan handshakeResult, 1), make(chan handshakeResult, 1)
	go func() {
		connection, err := client.Handshake(ctx, left)
		clientResult <- handshakeResult{connection, err}
	}()
	go func() {
		connection, err := server.Handshake(ctx, right)
		serverResult <- handshakeResult{connection, err}
	}()
	return awaitHandshake(t, clientResult), awaitHandshake(t, serverResult)
}

func connectedPair(t *testing.T, fixture pairFixture, ctx context.Context) (*servicepeer.Connection, *servicepeer.Connection) {
	t.Helper()
	client, server := handshakePair(t, fixture.clientSide, fixture.serverSide, ctx)
	must(t, client.err)
	must(t, server.err)
	if client.connection == nil || server.connection == nil {
		t.Fatal("successful handshake returned a nil connection")
	}
	return client.connection, server.connection
}

func awaitHandshake(t *testing.T, result <-chan handshakeResult) handshakeResult {
	t.Helper()
	select {
	case value := <-result:
		return value
	case <-time.After(4 * time.Second):
		t.Fatal("handshake did not return within its configured bound")
		return handshakeResult{}
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func requireError(t *testing.T, err error) {
	t.Helper()
	if err == nil {
		t.Fatal("operation unexpectedly succeeded")
	}
}

func eventually(t *testing.T, condition func() bool) {
	t.Helper()
	until := time.Now().Add(3 * time.Second)
	for !condition() {
		if time.Now().After(until) {
			t.Fatal("condition did not become true")
		}
		time.Sleep(5 * time.Millisecond)
	}
}
