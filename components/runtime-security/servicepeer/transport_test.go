package servicepeer_test

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/hex"
	"errors"
	"io"
	"math/big"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/openclaw/openclaw-enterprise/components/runtime-security/identity"
	"github.com/openclaw/openclaw-enterprise/components/runtime-security/servicepeer"
	"github.com/spiffe/go-spiffe/v2/bundle/x509bundle"
	"github.com/spiffe/go-spiffe/v2/proto/spiffe/workload"
	"github.com/spiffe/go-spiffe/v2/spiffeid"
	"github.com/spiffe/go-spiffe/v2/spiffetls/tlsconfig"
	"github.com/spiffe/go-spiffe/v2/svid/x509svid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"
	"google.golang.org/protobuf/proto"
)

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
	md, _ := metadata.FromIncomingContext(stream.Context())
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

func transfer(t *testing.T, from, to net.Conn, payload string) {
	t.Helper()
	must(t, from.SetWriteDeadline(time.Now().Add(2*time.Second)))
	must(t, to.SetReadDeadline(time.Now().Add(2*time.Second)))
	defer from.SetWriteDeadline(time.Time{})
	defer to.SetReadDeadline(time.Time{})
	written := make(chan error, 1)
	go func() {
		n, err := io.WriteString(from, payload)
		if err == nil && n != len(payload) {
			err = io.ErrShortWrite
		}
		written <- err
	}()
	buffer := make([]byte, len(payload))
	_, err := io.ReadFull(to, buffer)
	must(t, err)
	if string(buffer) != payload {
		t.Fatal("TLS application payload changed")
	}
	must(t, <-written)
}

func pendingRead(connection net.Conn) <-chan error {
	result := make(chan error, 1)
	go func() {
		var buffer [1]byte
		_, err := connection.Read(buffer[:])
		result <- err
	}()
	return result
}

func requireReadClosed(t *testing.T, result <-chan error) {
	t.Helper()
	select {
	case err := <-result:
		requireError(t, err)
		var networkError net.Error
		if errors.As(err, &networkError) && networkError.Timeout() {
			t.Fatal("deadline expired instead of closing the revoked connection")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("revocation did not unblock an owned connection read")
	}
}

func requireDenied(t *testing.T, connection *servicepeer.Connection) {
	t.Helper()
	_, err := connection.Inspect()
	requireError(t, err)
	_, err = connection.Write([]byte("must not be sent"))
	requireError(t, err)
	var buffer [1]byte
	_, err = connection.Read(buffer[:])
	requireError(t, err)
}

func TestMutualTLSExactIdentityAndBidirectionalIO(t *testing.T) {
	f := newPairFixture(t, nil)
	before := time.Now()
	client, server := connectedPair(t, f, context.Background())
	for _, item := range []struct {
		connection *servicepeer.Connection
		own, peer  string
		peerSVID   *workload.X509SVID
	}{
		{client, clientID, serverID, f.server.svid}, {server, serverID, clientID, f.client.svid},
	} {
		peer, err := item.connection.Inspect()
		must(t, err)
		certificates, err := x509.ParseCertificates(item.peerSVID.X509Svid)
		must(t, err)
		digest := sha256.Sum256(certificates[0].Raw)
		if peer.OwnSPIFFEID != item.own || peer.PeerSPIFFEID != item.peer || peer.RecipientSPIFFEID != serverID ||
			peer.PeerCertificateSHA256 != hex.EncodeToString(digest[:]) || peer.AuthenticatedAt.Before(before) ||
			peer.AuthenticatedAt.After(time.Now()) || !peer.ExpiresAt.After(peer.AuthenticatedAt) ||
			peer.ExpiresAt.After(certificates[0].NotAfter) {
			t.Fatalf("unexpected peer diagnostics: %+v", peer)
		}
		// Diagnostics are detached values; changing one grants no connection authority.
		peer.PeerSPIFFEID = otherID
		next, err := item.connection.Inspect()
		must(t, err)
		if next.PeerSPIFFEID != item.peer {
			t.Fatal("caller changed authenticated connection identity")
		}
	}
	transfer(t, client, server, "client to exact server")
	transfer(t, server, client, "server to exact client")
}

func TestRejectsInvalidConfiguration(t *testing.T) {
	ca := newCA(t)
	f := newSource(t, ca.issue(t, clientID, time.Now().Add(time.Hour)))
	for _, test := range []struct {
		name   string
		change func(*servicepeer.Config)
	}{
		{"side", func(c *servicepeer.Config) { c.Side = servicepeer.Side("invalid") }},
		{"empty own", func(c *servicepeer.Config) { c.OwnSPIFFEID = "" }},
		{"malformed peer", func(c *servicepeer.Config) { c.PeerSPIFFEID = "https://test.example/service/server" }},
		{"pathless peer", func(c *servicepeer.Config) { c.PeerSPIFFEID = "spiffe://test.example" }},
		{"noncanonical peer", func(c *servicepeer.Config) { c.PeerSPIFFEID = "spiffe://test.example/service/../server" }},
		{"other trust domain", func(c *servicepeer.Config) {
			c.PeerSPIFFEID = "spiffe://other.example/service/server"
			c.RecipientSPIFFEID = c.PeerSPIFFEID
		}},
		{"wrong recipient", func(c *servicepeer.Config) { c.RecipientSPIFFEID = otherID }},
		{"missing recipient", func(c *servicepeer.Config) { c.RecipientSPIFFEID = "" }},
		{"long ALPN", func(c *servicepeer.Config) { c.ApplicationProtocol = strings.Repeat("a", 256) }},
		{"NUL ALPN", func(c *servicepeer.Config) { c.ApplicationProtocol = "oce\x00github" }},
		{"control ALPN", func(c *servicepeer.Config) { c.ApplicationProtocol = "oce\ngithub" }},
		{"space ALPN", func(c *servicepeer.Config) { c.ApplicationProtocol = "oce github" }},
		{"DEL ALPN", func(c *servicepeer.Config) { c.ApplicationProtocol = "oce\x7fgithub" }},
		{"non-ASCII ALPN", func(c *servicepeer.Config) { c.ApplicationProtocol = "océ-github" }},
		{"zero handshake timeout", func(c *servicepeer.Config) { c.HandshakeTimeout = 0 }},
		{"negative handshake timeout", func(c *servicepeer.Config) { c.HandshakeTimeout = -time.Second }},
		{"unbounded handshake timeout", func(c *servicepeer.Config) { c.HandshakeTimeout = 3*time.Second + 1 }},
		{"zero recheck interval", func(c *servicepeer.Config) { c.RecheckInterval = 0 }},
		{"negative recheck interval", func(c *servicepeer.Config) { c.RecheckInterval = -time.Second }},
		{"unbounded recheck interval", func(c *servicepeer.Config) { c.RecheckInterval = 5*time.Second + 1 }},
		{"zero connection age", func(c *servicepeer.Config) { c.MaxConnectionAge = 0 }},
		{"negative connection age", func(c *servicepeer.Config) { c.MaxConnectionAge = -time.Second }},
		{"zero connections", func(c *servicepeer.Config) { c.MaxConnections = 0 }},
		{"negative connections", func(c *servicepeer.Config) { c.MaxConnections = -1 }},
		{"too many connections", func(c *servicepeer.Config) { c.MaxConnections = 65 }},
	} {
		t.Run(test.name, func(t *testing.T) {
			config := defaultConfig(servicepeer.Client)
			test.change(&config)
			transport, err := servicepeer.New(f.source, config)
			if transport != nil {
				transport.Close()
			}
			requireError(t, err)
		})
	}
	_, err := servicepeer.New(nil, defaultConfig(servicepeer.Client))
	requireError(t, err)
	// The maximum supported limits remain valid explicit configuration.
	config := defaultConfig(servicepeer.Client)
	config.HandshakeTimeout, config.RecheckInterval, config.MaxConnections = 3*time.Second, 5*time.Second, 64
	newTransport(t, f, config)
	for _, protocol := range []string{"a", strings.Repeat("a", 255)} {
		config.ApplicationProtocol = protocol
		newTransport(t, f, config)
	}
}

func TestServerRecipientMustBeOwnIdentity(t *testing.T) {
	ca := newCA(t)
	f := newSource(t, ca.issue(t, serverID, time.Now().Add(time.Hour)))
	config := defaultConfig(servicepeer.Server)
	config.RecipientSPIFFEID = clientID
	transport, err := servicepeer.New(f.source, config)
	if transport != nil {
		transport.Close()
	}
	requireError(t, err)
}

func TestConfiguredOwnIdentityMustMatchActualSource(t *testing.T) {
	ca := newCA(t)
	f := newSource(t, ca.issue(t, clientID, time.Now().Add(time.Hour)))
	config := defaultConfig(servicepeer.Client)
	config.OwnSPIFFEID = otherID
	transport, err := servicepeer.New(f.source, config)
	if transport != nil {
		transport.Close()
	}
	requireError(t, err)
}

func TestExactPeerMismatchFailsTLS(t *testing.T) {
	for _, side := range []servicepeer.Side{servicepeer.Client, servicepeer.Server} {
		t.Run(string(side), func(t *testing.T) {
			f := newPairFixture(t, func(client, server *servicepeer.Config) {
				if side == servicepeer.Client {
					client.PeerSPIFFEID, client.RecipientSPIFFEID = serverID+"/suffix", serverID+"/suffix"
				} else {
					server.PeerSPIFFEID = clientID + "/suffix"
				}
			})
			client, server := handshakePair(t, f.clientSide, f.serverSide, context.Background())
			if side == servicepeer.Client {
				requireError(t, client.err)
			} else {
				requireError(t, server.err)
			}
			// TLS 1.3 peers can finish locally before receiving the rejection alert;
			// any locally completed opposite connection still cannot exchange data.
			if client.connection != nil {
				requireReadClosed(t, pendingRead(client.connection))
			}
			if server.connection != nil {
				requireReadClosed(t, pendingRead(server.connection))
			}
		})
	}
}

func TestWrongTrustFailsTLS(t *testing.T) {
	clientCA, serverCA := newCA(t), newCA(t)
	client := newSource(t, clientCA.issue(t, clientID, time.Now().Add(time.Hour)))
	server := newSource(t, serverCA.issue(t, serverID, time.Now().Add(time.Hour)))
	clientResult, serverResult := handshakePair(t,
		newTransport(t, client, defaultConfig(servicepeer.Client)),
		newTransport(t, server, defaultConfig(servicepeer.Server)), context.Background())
	requireError(t, clientResult.err)
	requireError(t, serverResult.err)
}

func TestSourceWithdrawalClosesIdleConnection(t *testing.T) {
	for _, action := range []string{"empty replacement", "stream unavailable", "source close"} {
		t.Run(action, func(t *testing.T) {
			f := newPairFixture(t, nil)
			client, server := connectedPair(t, f, context.Background())
			blocked := pendingRead(server)
			switch action {
			case "empty replacement":
				f.client.endpoint.updates <- &workload.X509SVIDResponse{}
			case "stream unavailable":
				f.client.server.Stop()
			case "source close":
				f.client.source.Close()
			}
			// Reading the opposite TLS endpoint cannot check the withdrawn client
			// source. Only the client's background recheck can revoke this idle channel.
			requireReadClosed(t, blocked)
			requireDenied(t, client)
		})
	}
}

func TestCurrentSourceIsCheckedAtEveryOperation(t *testing.T) {
	for _, operation := range []string{"inspect", "read", "write"} {
		t.Run(operation, func(t *testing.T) {
			f := newPairFixture(t, func(client, _ *servicepeer.Config) { client.RecheckInterval = 5 * time.Second })
			client, server := connectedPair(t, f, context.Background())
			must(t, client.SetDeadline(time.Now().Add(time.Second)))
			must(t, f.client.source.Close())
			// Revocation must be observed by this operation before the five-second
			// background interval; no earlier Inspect call performs the check.
			result := make(chan error, 1)
			go func() {
				var err error
				switch operation {
				case "inspect":
					_, err = client.Inspect()
				case "read":
					var buffer [1]byte
					_, err = client.Read(buffer[:])
				case "write":
					_, err = client.Write([]byte("must not be sent"))
				}
				result <- err
			}()
			select {
			case err := <-result:
				requireError(t, err)
			case <-time.After(500 * time.Millisecond):
				t.Fatal("operation did not check current source before I/O")
			}
			requireReadClosed(t, pendingRead(server))
		})
	}
}

func TestOwnCertificateRotationRevokesOldAndPermitsNewConnection(t *testing.T) {
	f := newPairFixture(t, nil)
	client, server := connectedPair(t, f, context.Background())
	blocked := pendingRead(server)
	rotated := f.ca.issue(t, clientID, time.Now().Add(2*time.Hour))
	f.client.replace(t, rotated)
	requireReadClosed(t, blocked)
	requireDenied(t, client)
	newClient, newServer := connectedPair(t, f, context.Background())
	transfer(t, newClient, newServer, "new TLS handshake uses the rotated local identity")
}

func TestTrustRotationRevokesPeerWithoutWithdrawingOwnIdentity(t *testing.T) {
	clientCA, serverCA := newCA(t), newCA(t)
	clientSVID := clientCA.issue(t, clientID, time.Now().Add(time.Hour))
	serverSVID := serverCA.issue(t, serverID, time.Now().Add(time.Hour))
	bothRoots := append(bytes.Clone(clientCA.certificate.Raw), serverCA.certificate.Raw...)
	clientSVID.Bundle, serverSVID.Bundle = bytes.Clone(bothRoots), bytes.Clone(bothRoots)
	clientSource, serverSource := newSource(t, clientSVID), newSource(t, serverSVID)
	f := pairFixture{clientSide: newTransport(t, clientSource, defaultConfig(servicepeer.Client)), serverSide: newTransport(t, serverSource, defaultConfig(servicepeer.Server))}
	client, server := connectedPair(t, f, context.Background())
	blocked := pendingRead(server)
	// Removing only the server's CA keeps the client's own SVID valid, so
	// revocation specifically proves that the established peer is reverified.
	next := cloneSVID(clientSVID)
	next.Bundle = bytes.Clone(clientCA.certificate.Raw)
	clientSource.replace(t, next)
	requireReadClosed(t, blocked)
	requireDenied(t, client)
	_, err := clientSource.source.Metadata()
	must(t, err)
}

func TestCRLContextFailsClosedAtAdmissionAndAfterReplacement(t *testing.T) {
	ca := newCA(t)
	svid := ca.issue(t, clientID, time.Now().Add(time.Hour))
	// identity.Source retains opaque CRLs. The transport explicitly does not
	// implement revocation-list validation and must refuse this unsupported state.
	crl := []byte("opaque Workload API CRL fixture")
	f := newSource(t, svid, crl)
	transport, err := servicepeer.New(f.source, defaultConfig(servicepeer.Client))
	if transport != nil {
		transport.Close()
	}
	requireError(t, err)
	pair := newPairFixture(t, nil)
	client, server := connectedPair(t, pair, context.Background())
	blocked := pendingRead(server)
	pair.client.replace(t, pair.client.svid, crl)
	requireReadClosed(t, blocked)
	requireDenied(t, client)
}

func copyOpaque[T any](original *T) *T {
	copy := reflect.New(reflect.TypeOf(original).Elem())
	copy.Elem().Set(reflect.ValueOf(original).Elem())
	return copy.Interface().(*T)
}

func TestCopiedAndZeroHandlesCannotAuthenticateOrCloseOriginal(t *testing.T) {
	// Keep periodic checks outside the copy operation: the deliberate value copy
	// exercises ownership rejection without concurrently copying a changing mutex.
	f := newPairFixture(t, func(client, server *servicepeer.Config) {
		client.RecheckInterval, server.RecheckInterval = 5*time.Second, 5*time.Second
	})
	client, server := connectedPair(t, f, context.Background())
	copy := copyOpaque(client)
	requireDenied(t, copy)
	copy.Close()
	var zero servicepeer.Connection
	requireDenied(t, &zero)
	zero.Close()
	transfer(t, client, server, "the original retains its private ownership")
	transportCopy := copyOpaque(f.clientSide)
	raw, peer := pipe(t)
	connection, err := transportCopy.Handshake(context.Background(), raw)
	requireError(t, err)
	if connection != nil {
		t.Fatal("copied transport returned an authenticated connection")
	}
	requireReadClosed(t, pendingRead(peer))
	transportCopy.Close()
	transfer(t, server, client, "copied transport cannot close original connections")
}

func TestHandshakeTimeoutCancellationAndOwnership(t *testing.T) {
	for _, action := range []string{"timeout", "cancel", "transport close"} {
		t.Run(action, func(t *testing.T) {
			f := newPairFixture(t, func(client, _ *servicepeer.Config) { client.HandshakeTimeout = 100 * time.Millisecond })
			raw, peer := pipe(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			result := make(chan handshakeResult, 1)
			go func() { c, err := f.clientSide.Handshake(ctx, raw); result <- handshakeResult{c, err} }()
			// Consuming a byte of the real ClientHello establishes that the
			// handshake is in flight while the peer deliberately stops responding.
			must(t, peer.SetReadDeadline(time.Now().Add(time.Second)))
			var hello [1]byte
			_, err := peer.Read(hello[:])
			must(t, err)
			must(t, peer.SetReadDeadline(time.Time{}))
			if action == "cancel" {
				cancel()
			}
			if action == "transport close" {
				f.clientSide.Close()
			}
			value := awaitHandshake(t, result)
			requireError(t, value.err)
			if value.connection != nil {
				t.Fatal("failed handshake retained an authenticated handle")
			}
			requireReadClosed(t, pendingRead(peer))
		})
	}
}

func TestOriginalContextCancellationRevokesEstablishedConnection(t *testing.T) {
	f := newPairFixture(t, nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	client, server := connectedPair(t, f, ctx)
	clientRead, serverRead := pendingRead(client), pendingRead(server)
	cancel()
	requireReadClosed(t, clientRead)
	requireReadClosed(t, serverRead)
	requireDenied(t, client)
	requireDenied(t, server)
}

func TestExplicitConnectionAgeRevokesIdleConnection(t *testing.T) {
	f := newPairFixture(t, func(client, _ *servicepeer.Config) { client.MaxConnectionAge = 200 * time.Millisecond })
	client, server := connectedPair(t, f, context.Background())
	peer, err := client.Inspect()
	must(t, err)
	if peer.ExpiresAt.After(peer.AuthenticatedAt.Add(200 * time.Millisecond)) {
		t.Fatal("diagnostic validity outlives the explicit connection age")
	}
	requireReadClosed(t, pendingRead(server))
	requireDenied(t, client)
}

func TestConnectionLimitAndReleasedCapacity(t *testing.T) {
	f := newPairFixture(t, func(client, server *servicepeer.Config) { client.MaxConnections, server.MaxConnections = 1, 1 })
	client, server := connectedPair(t, f, context.Background())
	raw, peer := pipe(t)
	connection, err := f.clientSide.Handshake(context.Background(), raw)
	requireError(t, err)
	if connection != nil {
		t.Fatal("connection limit was exceeded")
	}
	requireReadClosed(t, pendingRead(peer))
	client.Close()
	server.Close()
	nextClient, nextServer := connectedPair(t, f, context.Background())
	transfer(t, nextClient, nextServer, "closed connections release bounded capacity")
}

func TestPendingHandshakeConsumesConnectionCapacity(t *testing.T) {
	f := newPairFixture(t, func(client, _ *servicepeer.Config) { client.MaxConnections = 1 })
	raw, peer := pipe(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	pending := make(chan handshakeResult, 1)
	go func() {
		connection, err := f.clientSide.Handshake(ctx, raw)
		pending <- handshakeResult{connection, err}
	}()
	must(t, peer.SetReadDeadline(time.Now().Add(time.Second)))
	var hello [1]byte
	_, err := peer.Read(hello[:])
	must(t, err)
	second, secondPeer := pipe(t)
	connection, err := f.clientSide.Handshake(context.Background(), second)
	requireError(t, err)
	if connection != nil {
		t.Fatal("pending handshake did not consume connection capacity")
	}
	requireReadClosed(t, pendingRead(secondPeer))
	cancel()
	requireError(t, awaitHandshake(t, pending).err)
	client, server := connectedPair(t, f, context.Background())
	transfer(t, client, server, "cancelled handshakes release capacity")
}

func TestRevocationAndCloseUnblockOwnedWrite(t *testing.T) {
	for _, action := range []string{"source withdrawal", "context cancellation", "connection close", "transport close"} {
		t.Run(action, func(t *testing.T) {
			f := newPairFixture(t, nil)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			client, _ := connectedPair(t, f, ctx)
			written := make(chan error, 1)
			go func() { _, err := client.Write([]byte("peer deliberately does not read")); written <- err }()
			select {
			case err := <-written:
				t.Fatalf("write did not block against the unread pipe: %v", err)
			case <-time.After(20 * time.Millisecond):
			}
			finished := make(chan struct{})
			go func() {
				defer close(finished)
				switch action {
				case "source withdrawal":
					f.client.source.Close()
				case "context cancellation":
					cancel()
				case "connection close":
					client.Close()
				case "transport close":
					f.clientSide.Close()
				}
			}()
			requireReadClosed(t, written)
			select {
			case <-finished:
			case <-time.After(time.Second):
				t.Fatal("close did not join owned work within a bounded interval")
			}
			requireDenied(t, client)
		})
	}
}

func TestTransportClosePreservesBorrowedSourceAndOtherTransport(t *testing.T) {
	f := newPairFixture(t, nil)
	client, _ := connectedPair(t, f, context.Background())
	other := newTransport(t, f.client, defaultConfig(servicepeer.Client))
	left, right := handshakePair(t, other, f.serverSide, context.Background())
	must(t, left.err)
	must(t, right.err)
	blocked := pendingRead(client)
	f.clientSide.Close()
	f.clientSide.Close()
	requireReadClosed(t, blocked)
	_, err := f.client.source.Snapshot()
	must(t, err)
	transfer(t, left.connection, right.connection, "shared identity source remains alive")
	raw, peer := pipe(t)
	connection, err := f.clientSide.Handshake(context.Background(), raw)
	requireError(t, err)
	if connection != nil {
		t.Fatal("closed transport admitted a connection")
	}
	requireReadClosed(t, pendingRead(peer))
}

func TestReadDeadlineUnblocksOwnedIO(t *testing.T) {
	f := newPairFixture(t, nil)
	client, _ := connectedPair(t, f, context.Background())
	must(t, client.SetReadDeadline(time.Now().Add(30*time.Millisecond)))
	var buffer [1]byte
	_, err := client.Read(buffer[:])
	var networkError net.Error
	if !errors.As(err, &networkError) || !networkError.Timeout() {
		t.Fatalf("read deadline did not produce a timeout: %v", err)
	}
}

// externalTLSConfig uses maintained SPIFFE verification for the actual TLS
// counterparty. It is not a replacement implementation of servicepeer.
func externalTLSConfig(t *testing.T, svid *workload.X509SVID, server bool) *tls.Config {
	t.Helper()
	parsed, err := x509svid.ParseRaw(svid.X509Svid, svid.X509SvidKey)
	must(t, err)
	bundle, err := x509bundle.ParseRaw(spiffeid.RequireTrustDomainFromString("test.example"), svid.Bundle)
	must(t, err)
	if server {
		return tlsconfig.MTLSServerConfig(parsed, bundle, tlsconfig.AuthorizeID(spiffeid.RequireFromString(clientID)))
	}
	config := tlsconfig.MTLSClientConfig(parsed, bundle, tlsconfig.AuthorizeID(spiffeid.RequireFromString(serverID)))
	config.ServerName = "test.example"
	return config
}

type externalResult struct {
	connection *tls.Conn
	err        error
}

func handshakeExternal(t *testing.T, transport *servicepeer.Transport, config *tls.Config, externalServer bool) (handshakeResult, externalResult) {
	t.Helper()
	raw, otherRaw := pipe(t)
	var external *tls.Conn
	if externalServer {
		external = tls.Server(otherRaw, config)
	} else {
		external = tls.Client(otherRaw, config)
	}
	result, externalDone := make(chan handshakeResult, 1), make(chan error, 1)
	go func() { c, err := transport.Handshake(context.Background(), raw); result <- handshakeResult{c, err} }()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		err := external.HandshakeContext(ctx)
		if err != nil {
			otherRaw.Close()
		}
		externalDone <- err
	}()
	value := awaitHandshake(t, result)
	select {
	case err := <-externalDone:
		return value, externalResult{external, err}
	case <-time.After(3 * time.Second):
		t.Fatal("external TLS handshake did not complete")
		return value, externalResult{}
	}
}

func TestTLS13Only(t *testing.T) {
	for _, externalServer := range []bool{false, true} {
		for _, version := range []uint16{tls.VersionTLS12, tls.VersionTLS13} {
			name := "transport server/"
			if externalServer {
				name = "transport client/"
			}
			name += tls.VersionName(version)
			t.Run(name, func(t *testing.T) {
				f := newPairFixture(t, nil)
				transport, externalSVID := f.serverSide, f.client.svid
				if externalServer {
					transport, externalSVID = f.clientSide, f.server.svid
				}
				config := externalTLSConfig(t, externalSVID, externalServer)
				config.MinVersion, config.MaxVersion = version, version
				config.SessionTicketsDisabled = true
				result, external := handshakeExternal(t, transport, config, externalServer)
				if version == tls.VersionTLS12 {
					requireError(t, result.err)
					requireError(t, external.err)
					return
				}
				must(t, result.err)
				must(t, external.err)
				if state := external.connection.ConnectionState(); state.Version != tls.VersionTLS13 || state.DidResume {
					t.Fatal("connection did not negotiate a fresh TLS 1.3 session")
				}
				transfer(t, result.connection, external.connection, "TLS 1.3 application bytes")
			})
		}
	}
}

func TestExactApplicationProtocolALPN(t *testing.T) {
	const protocol = "oce-github-mediation-v2"
	for _, externalServer := range []bool{false, true} {
		for _, scenario := range []string{"exact", "offered with other protocol", "missing", "wrong"} {
			name := "transport server/"
			if externalServer {
				name = "transport client/"
			}
			t.Run(name+scenario, func(t *testing.T) {
				f := newPairFixture(t, func(client, server *servicepeer.Config) {
					client.ApplicationProtocol, server.ApplicationProtocol = protocol, protocol
				})
				transport, externalSVID := f.serverSide, f.client.svid
				if externalServer {
					transport, externalSVID = f.clientSide, f.server.svid
				}
				config := externalTLSConfig(t, externalSVID, externalServer)
				config.MinVersion, config.MaxVersion = tls.VersionTLS13, tls.VersionTLS13
				config.SessionTicketsDisabled = true
				switch scenario {
				case "exact":
					config.NextProtos = []string{protocol}
				case "offered with other protocol":
					config.NextProtos = []string{"oce-other-v1", protocol}
				case "wrong":
					config.NextProtos = []string{"oce-other-v1"}
				}
				result, external := handshakeExternal(t, transport, config, externalServer)
				if scenario == "missing" || scenario == "wrong" {
					// TLS permits a missing ALPN extension. The transport must
					// reject that successful TLS handshake before issuing a handle.
					requireError(t, result.err)
					if result.connection != nil {
						t.Fatal("ALPN mismatch returned an authenticated connection")
					}
					if external.err == nil {
						requireReadClosed(t, pendingRead(external.connection))
					}
					return
				}
				must(t, result.err)
				must(t, external.err)
				if external.connection.ConnectionState().NegotiatedProtocol != protocol {
					t.Fatal("TLS did not negotiate the exact application protocol")
				}
				transfer(t, result.connection, external.connection, "exact ALPN application bytes")
				transfer(t, external.connection, result.connection, "exact ALPN response")
			})
		}
	}
}

func TestServerRequiresClientCertificate(t *testing.T) {
	f := newPairFixture(t, nil)
	config := externalTLSConfig(t, f.client.svid, false)
	config.MinVersion, config.MaxVersion = tls.VersionTLS13, tls.VersionTLS13
	config.GetClientCertificate = nil
	result, external := handshakeExternal(t, f.serverSide, config, false)
	requireError(t, result.err)
	if result.connection != nil {
		t.Fatal("server authenticated a client without a certificate")
	}
	if external.err == nil {
		requireReadClosed(t, pendingRead(external.connection))
	}
}

func changeLeafProfile(scenario string, certificate *x509.Certificate) {
	switch scenario {
	case "missing digitalSignature":
		certificate.KeyUsage = x509.KeyUsageKeyEncipherment
	case "missing KeyUsage extension":
		certificate.KeyUsage = 0
	case "noncritical KeyUsage":
		// The DER BIT STRING encodes digitalSignature; only the extension's
		// critical flag differs from the valid generated certificate profile.
		certificate.ExtraExtensions = []pkix.Extension{{Id: asn1.ObjectIdentifier{2, 5, 29, 15}, Critical: false, Value: []byte{0x03, 0x02, 0x07, 0x80}}}
	case "missing clientAuth":
		certificate.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}
	case "missing serverAuth":
		certificate.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}
	case "emailProtection only":
		certificate.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageEmailProtection}
	case "any EKU only":
		certificate.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageAny}
	case "empty EKU extension":
		certificate.ExtKeyUsage = nil
		certificate.ExtraExtensions = []pkix.Extension{{Id: asn1.ObjectIdentifier{2, 5, 29, 37}, Value: []byte{0x30, 0x00}}}
	case "absent EKU":
		certificate.ExtKeyUsage = nil
	}
}

func TestSignedPeerCertificateVerificationThroughMutualTLS(t *testing.T) {
	for _, scenario := range []string{
		"valid", "absent EKU", "expired", "future", "multiple URI", "wrong identity", "wrong trust",
		"missing digitalSignature", "missing KeyUsage extension", "noncritical KeyUsage",
		"missing clientAuth", "missing serverAuth", "emailProtection only", "any EKU only", "empty EKU extension",
	} {
		t.Run(scenario, func(t *testing.T) {
			ca := newCA(t)
			clientSVID := ca.issue(t, clientID, time.Now().Add(time.Hour))
			client := newSource(t, clientSVID)
			until := time.Now().Add(time.Hour)
			id := serverID
			issuer := ca
			if scenario == "expired" {
				until = time.Now().Add(-time.Minute)
			}
			if scenario == "wrong identity" {
				id = otherID
			}
			if scenario == "wrong trust" {
				issuer = newCA(t)
			}
			peer := issuer.issueWith(t, id, until, func(c *x509.Certificate) {
				changeLeafProfile(scenario, c)
				if scenario == "future" {
					c.NotBefore = time.Now().Add(time.Minute)
				}
				if scenario == "multiple URI" {
					extra, _ := url.Parse(otherID)
					c.URIs = append(c.URIs, extra)
				}
			})
			// Present invalid signed peer bytes through ordinary TLS to exercise
			// the remote verifier independently of local-source admission.
			certificates, err := x509.ParseCertificates(peer.X509Svid)
			must(t, err)
			key, err := x509.ParsePKCS8PrivateKey(peer.X509SvidKey)
			must(t, err)
			chain := make([][]byte, len(certificates))
			for index, cert := range certificates {
				chain[index] = cert.Raw
			}
			clientRoots := x509.NewCertPool()
			clientRoots.AddCert(ca.certificate)
			config := &tls.Config{MinVersion: tls.VersionTLS13, MaxVersion: tls.VersionTLS13,
				Certificates: []tls.Certificate{{Certificate: chain, PrivateKey: key}}, SessionTicketsDisabled: true,
				ClientAuth: tls.RequireAndVerifyClientCert, ClientCAs: clientRoots}
			// Requiring the real client certificate prevents a missing-own-SVID
			// failure from masking an invalid remote certificate being accepted.
			// The valid case uses this exact harness as a positive control.
			result, external := handshakeExternal(t, newTransport(t, client, defaultConfig(servicepeer.Client)), config, true)
			if scenario == "valid" || scenario == "absent EKU" {
				must(t, result.err)
				must(t, external.err)
				transfer(t, result.connection, external.connection, "signed peer positive control")
				return
			}
			requireError(t, result.err)
			if result.connection != nil {
				t.Fatal("invalid peer certificate returned an authenticated connection")
			}
		})
	}
}

func TestRejectsUnsupportedOwnLeafProfileFromActualSource(t *testing.T) {
	for _, scenario := range []string{"noncritical KeyUsage", "missing clientAuth", "missing serverAuth", "emailProtection only", "any EKU only", "empty EKU extension"} {
		t.Run(scenario, func(t *testing.T) {
			ca := newCA(t)
			svid := ca.issueWith(t, clientID, time.Now().Add(time.Hour), func(c *x509.Certificate) { changeLeafProfile(scenario, c) })
			// The actual Source admits this material. The service-peer profile
			// guard therefore must reject it itself, before accepting a raw socket.
			f := newSource(t, svid)
			transport, err := servicepeer.New(f.source, defaultConfig(servicepeer.Client))
			if transport != nil {
				transport.Close()
			}
			requireError(t, err)
		})
	}
}

func TestAbsentEKUSupportedForOwnAndPeerSVIDs(t *testing.T) {
	ca := newCA(t)
	withoutEKU := func(c *x509.Certificate) { c.ExtKeyUsage = nil }
	client := newSource(t, ca.issueWith(t, clientID, time.Now().Add(time.Hour), withoutEKU))
	server := newSource(t, ca.issueWith(t, serverID, time.Now().Add(time.Hour), withoutEKU))
	f := pairFixture{clientSide: newTransport(t, client, defaultConfig(servicepeer.Client)), serverSide: newTransport(t, server, defaultConfig(servicepeer.Server))}
	left, right := connectedPair(t, f, context.Background())
	transfer(t, left, right, "absent EKU retains both valid TLS purposes")
	transfer(t, right, left, "both peers authenticate without an EKU restriction")
}

func TestPeerCertificateExpiryRevokesIdleConnection(t *testing.T) {
	ca := newCA(t)
	clientSVID := ca.issue(t, clientID, time.Now().Add(time.Hour))
	serverSVID := ca.issue(t, serverID, time.Now().Add(2*time.Second))
	client := newSource(t, clientSVID)
	config := externalTLSConfig(t, serverSVID, true)
	config.MinVersion, config.SessionTicketsDisabled = tls.VersionTLS13, true
	result, external := handshakeExternal(t, newTransport(t, client, defaultConfig(servicepeer.Client)), config, true)
	must(t, result.err)
	must(t, external.err)
	// Only the external peer expires; the borrowed local source stays live.
	requireReadClosed(t, pendingRead(external.connection))
	requireDenied(t, result.connection)
	_, err := client.source.Metadata()
	must(t, err)
}

func TestSessionResumptionDisabledOnBothSides(t *testing.T) {
	t.Run("server does not issue session tickets", func(t *testing.T) {
		f := newPairFixture(t, nil)
		config := externalTLSConfig(t, f.client.svid, false)
		config.MinVersion, config.MaxVersion = tls.VersionTLS13, tls.VersionTLS13
		config.ClientSessionCache = tls.NewLRUClientSessionCache(1)
		for range 2 {
			result, external := handshakeExternal(t, f.serverSide, config, false)
			must(t, result.err)
			must(t, external.err)
			// Reading application bytes also processes any TLS 1.3 tickets sent
			// ahead of those bytes, making the actual client cache observable.
			transfer(t, result.connection, external.connection, "after any session ticket")
			if external.connection.ConnectionState().DidResume {
				t.Fatal("server accepted a resumed TLS session")
			}
			if _, ok := config.ClientSessionCache.Get(config.ServerName); ok {
				t.Fatal("server issued a usable session ticket")
			}
			result.connection.Close()
			external.connection.Close()
		}
	})
	t.Run("client never resumes with ticket-issuing server", func(t *testing.T) {
		f := newPairFixture(t, nil)
		config := externalTLSConfig(t, f.server.svid, true)
		config.MinVersion, config.MaxVersion = tls.VersionTLS13, tls.VersionTLS13
		for range 2 {
			result, external := handshakeExternal(t, f.clientSide, config, true)
			must(t, result.err)
			must(t, external.err)
			transfer(t, external.connection, result.connection, "server with normal session tickets")
			if external.connection.ConnectionState().DidResume {
				t.Fatal("client resumed a previous TLS session")
			}
			result.connection.Close()
			external.connection.Close()
		}
	})
}
