// Local fixture only: generated credentials enter the unchanged identity.Source
// through a local Workload API, then unchanged servicepeer owns both TLS peers.
// The CA/Workload API pattern follows the original runtime-authority-service
// fixture; this separate command channel is not a production native protocol.
// Registration supplied by the Node fixture is controlled input, not attestation.
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"github.com/openclaw/openclaw-enterprise/components/runtime-security/identity"
	"github.com/openclaw/openclaw-enterprise/components/runtime-security/servicepeer"
	"github.com/spiffe/go-spiffe/v2/proto/spiffe/workload"
	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"
)

const peerID = "spiffe://runtime-peer.test/runtime/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/harness"
const recipientID = "spiffe://runtime-peer.test/service/acceptor"
const canonicalTime = "2006-01-02T15:04:05.000Z"

type fixtureAPI struct {
	workload.UnimplementedSpiffeWorkloadAPIServer
	response *workload.X509SVIDResponse
}

func (api *fixtureAPI) FetchX509SVID(_ *workload.X509SVIDRequest, stream grpc.ServerStreamingServer[workload.X509SVIDResponse]) error {
	md, _ := metadata.FromIncomingContext(stream.Context())
	values := md.Get("workload.spiffe.io")
	if len(values) != 1 || values[0] != "true" {
		return errors.New("fixture metadata absent")
	}
	if err := stream.Send(api.response); err != nil {
		return err
	}
	<-stream.Context().Done()
	return stream.Context().Err()
}

func credentials(lifetime time.Duration) (*workload.X509SVIDResponse, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	ca := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "Disposable runtime peer fixture CA"},
		NotBefore: now.Add(-time.Minute), NotAfter: now.Add(time.Hour), IsCA: true, BasicConstraintsValid: true,
		KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign}
	caDER, err := x509.CreateCertificate(rand.Reader, ca, ca, &key.PublicKey, key)
	if err != nil {
		return nil, err
	}
	ca, err = x509.ParseCertificate(caDER)
	if err != nil {
		return nil, err
	}
	response := &workload.X509SVIDResponse{}
	for index, id := range []string{peerID, recipientID} {
		leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			return nil, err
		}
		uri, err := url.Parse(id)
		if err != nil {
			return nil, err
		}
		leaf := &x509.Certificate{SerialNumber: big.NewInt(int64(index + 2)), Subject: pkix.Name{CommonName: "Disposable runtime peer fixture"},
			NotBefore: now.Add(-time.Minute), NotAfter: now.Add(lifetime), URIs: []*url.URL{uri}, BasicConstraintsValid: true,
			KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth, x509.ExtKeyUsageServerAuth}}
		der, err := x509.CreateCertificate(rand.Reader, leaf, ca, &leafKey.PublicKey, key)
		if err != nil {
			return nil, err
		}
		privateKey, err := x509.MarshalPKCS8PrivateKey(leafKey)
		if err != nil {
			return nil, err
		}
		response.Svids = append(response.Svids, &workload.X509SVID{SpiffeId: id, X509Svid: append(der, caDER...),
			X509SvidKey: privateKey, Bundle: bytes.Clone(caDER)})
	}
	return response, nil
}

type command struct {
	ID string `json:"id"`
	Challenge string `json:"challenge"`
	Kind string `json:"kind"`
	Handle string `json:"handle,omitempty"`
}
type pair struct {
	acceptor, peer *servicepeer.Connection
	cancel context.CancelFunc
}
func (p pair) close() {
	p.cancel()
	p.acceptor.Close()
	p.peer.Close()
}

func connect(ctx context.Context, client, server *servicepeer.Transport) (pair, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return pair{}, err
	}
	defer listener.Close()
	connectionContext, cancel := context.WithCancel(ctx)
	type accepted struct { connection *servicepeer.Connection; err error }
	acceptedPeer := make(chan accepted, 1)
	go func() {
		raw, err := listener.Accept()
		if err != nil {
			acceptedPeer <- accepted{err: err}
			return
		}
		connection, err := server.Handshake(connectionContext, raw)
		acceptedPeer <- accepted{connection, err}
	}()
	raw, err := net.DialTimeout("tcp", listener.Addr().String(), time.Second)
	if err != nil {
		cancel()
		listener.Close()
		<-acceptedPeer
		return pair{}, err
	}
	peer, peerErr := client.Handshake(connectionContext, raw)
	acceptedResult := <-acceptedPeer
	if peerErr != nil || acceptedResult.err != nil {
		cancel()
		if peer != nil { peer.Close() }
		if acceptedResult.connection != nil { acceptedResult.connection.Close() }
		return pair{}, errors.New("fixture TLS failed")
	}
	return pair{acceptedResult.connection, peer, cancel}, nil
}

func run(ctx context.Context, input, output *os.File) error {
	lifetimeMS, err := strconv.Atoi(os.Getenv("OCE_RUNTIME_PEER_FIXTURE_LIFETIME_MS"))
	if err != nil || lifetimeMS < 1500 || lifetimeMS > 30000 {
		return errors.New("fixture lifetime invalid")
	}
	response, err := credentials(time.Duration(lifetimeMS) * time.Millisecond)
	if err != nil { return err }
	directory, err := os.MkdirTemp("", "occ-runtime-peer-")
	if err != nil { return err }
	defer os.RemoveAll(directory)
	socket := filepath.Join(directory, "api.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil { return err }
	api := grpc.NewServer()
	workload.RegisterSpiffeWorkloadAPIServer(api, &fixtureAPI{response: response})
	go api.Serve(listener)
	defer api.Stop()
	var transports []*servicepeer.Transport
	var sources []*identity.Source
	defer func() {
		for _, transport := range transports { transport.Close() }
		for _, source := range sources { source.Close() }
	}()
	for _, side := range []servicepeer.Side{servicepeer.Client, servicepeer.Server} {
		own, remote := peerID, recipientID
		if side == servicepeer.Server { own, remote = recipientID, peerID }
		source, err := identity.NewSource(identity.Options{SocketPath: socket, ExpectedSPIFFEID: own, Timeout: time.Second})
		if err != nil { return err }
		sources = append(sources, source)
		if err = source.Start(ctx); err != nil { return err }
		transport, err := servicepeer.New(source, servicepeer.Config{Side: side, OwnSPIFFEID: own,
			PeerSPIFFEID: remote, RecipientSPIFFEID: recipientID, HandshakeTimeout: time.Second,
			RecheckInterval: 25 * time.Millisecond, MaxConnectionAge: 30 * time.Second, MaxConnections: 4})
		if err != nil { return err }
		transports = append(transports, transport)
	}
	connections := make(map[string]pair)
	defer func() { for _, connection := range connections { connection.close() } }()
	encoder := json.NewEncoder(output)
	if err := encoder.Encode(map[string]any{"kind": "ready"}); err != nil { return err }
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), 16384)
	for scanner.Scan() {
		var request command
		decoder := json.NewDecoder(bytes.NewReader(scanner.Bytes()))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&request) != nil || decoder.Decode(new(any)) != io.EOF || request.ID == "" || len(request.ID) > 32 || len(request.Challenge) != 36 {
			return errors.New("fixture command invalid")
		}
		result := map[string]any{"id": request.ID, "challenge": request.Challenge, "kind": "result"}
		switch request.Kind {
		case "connect":
			if len(connections) >= 4 { result["error"] = "fixture_capacity"; break }
			connection, err := connect(ctx, transports[0], transports[1])
			if err != nil { result["error"] = "fixture_tls"; break }
			var token [16]byte
			if _, err := rand.Read(token[:]); err != nil { connection.close(); return err }
			handle := hex.EncodeToString(token[:])
			connections[handle] = connection
			result["handle"] = handle
		case "inspect":
			connection, ok := connections[request.Handle]
			if !ok { result["error"] = "fixture_foreign_connection"; break }
			peer, err := connection.acceptor.Inspect()
			if err != nil { result["error"] = "fixture_connection_unavailable"; break }
			result["peerSPIFFEId"] = peer.PeerSPIFFEID
			result["recipientSPIFFEId"] = peer.RecipientSPIFFEID
			result["peerEvidenceRef"] = "certificate/" + peer.PeerCertificateSHA256
			result["authenticatedAt"] = peer.AuthenticatedAt.UTC().Format(canonicalTime)
			result["inspectedAt"] = time.Now().UTC().Format(canonicalTime)
			result["expiresAt"] = peer.ExpiresAt.UTC().Format(canonicalTime)
		case "disconnect":
			if connection, ok := connections[request.Handle]; ok { connection.close(); delete(connections, request.Handle) }
		case "shutdown":
			return encoder.Encode(result)
		default:
			return errors.New("fixture command unsupported")
		}
		if err := encoder.Encode(result); err != nil { return err }
	}
	return scanner.Err()
}

// This is the retained oce-runtime-authority ownedPipe lifecycle pattern.
// Register only duplicated inherited pipe descriptors with Go's poller so Close
// interrupts a blocked Scanner/Write; do not adopt caller-supplied descriptors.
func ownedPipe(original *os.File) (*os.File, error) {
	info, err := original.Stat()
	if err != nil || info.Mode()&(os.ModeNamedPipe|os.ModeSocket) == 0 {
		return nil, os.ErrInvalid
	}
	fd, err := syscall.Dup(int(original.Fd()))
	if err != nil {
		return nil, err
	}
	if err = syscall.SetNonblock(fd, true); err != nil {
		syscall.Close(fd)
		return nil, err
	}
	pipe := os.NewFile(uintptr(fd), "owned-runtime-peer-fixture-channel")
	if pipe == nil {
		syscall.Close(fd)
		return nil, os.ErrInvalid
	}
	if err = pipe.SetDeadline(time.Time{}); err != nil {
		pipe.Close()
		return nil, err
	}
	original.Close()
	return pipe, nil
}

func runMain() int {
	input, err := ownedPipe(os.Stdin)
	if err != nil {
		return 1
	}
	defer input.Close()
	output, err := ownedPipe(os.Stdout)
	if err != nil {
		return 1
	}
	defer output.Close()
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	interrupted := context.AfterFunc(ctx, func() { input.Close(); output.Close() })
	defer interrupted()
	if run(ctx, input, output) != nil {
		// No private key, certificate body, path, subject or raw provider error.
		_ = json.NewEncoder(output).Encode(map[string]any{"kind": "fatal", "error": "fixture_failed"})
		return 1
	}
	return 0
}

func main() { os.Exit(runMain()) }
