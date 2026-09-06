// This local fixture supplies generated Workload API credentials and drives real
// servicepeer TLS connections. It grants no OCC role, registry admission, runtime
// authority, or production SPIRE attestation. All private keys remain in memory.
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/binary"
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
	"runtime"
	"sync"
	"syscall"
	"time"

	"github.com/openclaw/openclaw-enterprise/components/runtime-security/identity"
	"github.com/openclaw/openclaw-enterprise/components/runtime-security/servicepeer"
	"github.com/spiffe/go-spiffe/v2/proto/spiffe/workload"
	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"
	"google.golang.org/protobuf/proto"
)

const (
	ownID  = "spiffe://readback.test/controller/history"
	peerID = "spiffe://readback.test/service/reader"
)

type authority struct {
	certificate *x509.Certificate
	key         *ecdsa.PrivateKey
}

func generateCA() (authority, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return authority{}, err
	}
	now := time.Now()
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "Disposable authenticated readback fixture"},
		NotBefore: now.Add(-time.Hour), NotAfter: now.Add(time.Hour), IsCA: true, BasicConstraintsValid: true,
		KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return authority{}, err
	}
	certificate, err := x509.ParseCertificate(der)
	return authority{certificate, key}, err
}

func (ca authority) issue(id string) (*workload.X509SVID, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	uri, err := url.Parse(id)
	if err != nil {
		return nil, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 120))
	if err != nil {
		return nil, err
	}
	now := time.Now()
	template := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "Disposable readback workload"},
		NotBefore: now.Add(-time.Minute), NotAfter: now.Add(30 * time.Minute), URIs: []*url.URL{uri}, BasicConstraintsValid: true,
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth, x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, template, ca.certificate, &key.PublicKey, ca.key)
	if err != nil {
		return nil, err
	}
	privateKey, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, err
	}
	return &workload.X509SVID{SpiffeId: id, X509Svid: append(der, ca.certificate.Raw...), X509SvidKey: privateKey, Bundle: bytes.Clone(ca.certificate.Raw)}, nil
}

type endpoint struct {
	workload.UnimplementedSpiffeWorkloadAPIServer
	mu       sync.Mutex
	current  *workload.X509SVIDResponse
	watchers map[chan *workload.X509SVIDResponse]struct{}
}

func (e *endpoint) FetchX509SVID(_ *workload.X509SVIDRequest, stream grpc.ServerStreamingServer[workload.X509SVIDResponse]) error {
	md, _ := metadata.FromIncomingContext(stream.Context())
	if values := md.Get("workload.spiffe.io"); len(values) != 1 || values[0] != "true" {
		return errors.New("missing workload metadata")
	}
	updates := make(chan *workload.X509SVIDResponse, 8)
	e.mu.Lock()
	e.watchers[updates] = struct{}{}
	initial := proto.Clone(e.current).(*workload.X509SVIDResponse)
	e.mu.Unlock()
	defer func() { e.mu.Lock(); delete(e.watchers, updates); e.mu.Unlock() }()
	if err := stream.Send(initial); err != nil {
		return err
	}
	for {
		select {
		case <-stream.Context().Done():
			return stream.Context().Err()
		case update := <-updates:
			if err := stream.Send(update); err != nil {
				return err
			}
		}
	}
}

func (e *endpoint) publish(response *workload.X509SVIDResponse) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.current = proto.Clone(response).(*workload.X509SVIDResponse)
	for watcher := range e.watchers {
		select {
		case watcher <- proto.Clone(response).(*workload.X509SVIDResponse):
		default:
			return errors.New("fixture update capacity exceeded")
		}
	}
	return nil
}

type command struct {
	ID         string `json:"id"`
	Kind       string `json:"kind"`
	Address    string `json:"address,omitempty"`
	WireBase64 string `json:"wireBase64,omitempty"`
	TimeoutMS  int    `json:"timeoutMs,omitempty"`
}

type fixture struct {
	ca                     authority
	serverSVID, clientSVID *workload.X509SVID
	endpoint               *endpoint
	grpc                   *grpc.Server
	source                 *identity.Source
	transport              *servicepeer.Transport
	outputMu               sync.Mutex
	requestsMu             sync.Mutex
	requests               map[string]context.CancelFunc
	work                   sync.WaitGroup
}

func (f *fixture) emit(value any) {
	f.outputMu.Lock()
	defer f.outputMu.Unlock()
	_ = json.NewEncoder(os.Stdout).Encode(value)
}

func (f *fixture) request(ctx context.Context, request command) {
	duration := request.TimeoutMS
	if duration == 0 {
		duration = 6000
	}
	address, err := net.ResolveTCPAddr("tcp", request.Address)
	wire, decodeErr := base64.StdEncoding.DecodeString(request.WireBase64)
	if err != nil || address.IP == nil || !address.IP.IsLoopback() || address.Port < 1 || decodeErr != nil || len(wire) > 131072 || duration < 1 || duration > 10000 {
		f.emit(map[string]any{"kind": "result", "id": request.ID, "error": "invalid_fixture_request"})
		return
	}
	requestContext, cancel := context.WithTimeout(ctx, time.Duration(duration)*time.Millisecond)
	f.requestsMu.Lock()
	_, duplicate := f.requests[request.ID]
	if request.ID == "" || duplicate || len(f.requests) >= 4 {
		f.requestsMu.Unlock()
		cancel()
		f.emit(map[string]any{"kind": "result", "id": request.ID, "error": "fixture_request_capacity"})
		return
	}
	f.requests[request.ID] = cancel
	f.requestsMu.Unlock()
	f.work.Add(1)
	go func() {
		defer f.work.Done()
		defer cancel()
		defer func() { f.requestsMu.Lock(); delete(f.requests, request.ID); f.requestsMu.Unlock() }()
		result := map[string]any{"kind": "result", "id": request.ID}
		defer func() { f.emit(result) }()
		raw, err := (&net.Dialer{}).DialContext(requestContext, "tcp", request.Address)
		if err != nil {
			result["error"] = "dial"
			return
		}
		connection, err := f.transport.Handshake(requestContext, raw)
		if err != nil {
			result["error"] = "tls"
			return
		}
		defer connection.Close()
		if deadline, ok := requestContext.Deadline(); ok {
			_ = connection.SetDeadline(deadline)
		}
		if _, err := io.Copy(connection, bytes.NewReader(wire)); err != nil {
			result["error"] = "write"
			return
		}
		f.emit(map[string]any{"kind": "sent", "id": request.ID})
		response, readErr := io.ReadAll(io.LimitReader(connection, 131073))
		if len(response) > 131072 {
			result["error"] = "response_limit"
			return
		}
		result["wireBase64"] = base64.StdEncoding.EncodeToString(response)
		if readErr != nil {
			result["error"] = "read"
		}
	}()
}

func (f *fixture) change(request command) error {
	switch request.Kind {
	case "withdraw":
		return f.endpoint.publish(&workload.X509SVIDResponse{Svids: []*workload.X509SVID{f.clientSVID}})
	case "rotate-own":
		next, err := f.ca.issue(ownID)
		if err != nil {
			return err
		}
		f.serverSVID = next
	case "rotate-bundle":
		additional, err := generateCA()
		if err != nil {
			return err
		}
		f.serverSVID = proto.Clone(f.serverSVID).(*workload.X509SVID)
		f.serverSVID.Bundle = append(bytes.Clone(f.serverSVID.Bundle), additional.certificate.Raw...)
	case "stop-workload-api":
		f.grpc.Stop()
		return nil
	default:
		return errors.New("unknown fixture command")
	}
	return f.endpoint.publish(&workload.X509SVIDResponse{Svids: []*workload.X509SVID{f.serverSVID, f.clientSVID}})
}

func run(ctx context.Context) error {
	ca, err := generateCA()
	if err != nil {
		return err
	}
	serverSVID, err := ca.issue(ownID)
	if err != nil {
		return err
	}
	clientSVID, err := ca.issue(peerID)
	if err != nil {
		return err
	}
	directory, err := os.MkdirTemp("", "occ-readback-wapi-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(directory)
	path := filepath.Join(directory, "api.sock")
	listener, err := net.Listen("unix", path)
	if err != nil {
		return err
	}
	api := &endpoint{current: &workload.X509SVIDResponse{Svids: []*workload.X509SVID{serverSVID, clientSVID}}, watchers: make(map[chan *workload.X509SVIDResponse]struct{})}
	server := grpc.NewServer()
	workload.RegisterSpiffeWorkloadAPIServer(server, api)
	go server.Serve(listener)
	defer server.Stop()
	source, err := identity.NewSource(identity.Options{SocketPath: path, ExpectedSPIFFEID: peerID, Timeout: time.Second})
	if err != nil {
		return err
	}
	defer source.Close()
	if err := source.Start(ctx); err != nil {
		return err
	}
	transport, err := servicepeer.New(source, servicepeer.Config{Side: servicepeer.Client, OwnSPIFFEID: peerID, PeerSPIFFEID: ownID, RecipientSPIFFEID: ownID,
		HandshakeTimeout: 3 * time.Second, RecheckInterval: 25 * time.Millisecond, MaxConnectionAge: 30 * time.Second, MaxConnections: 4})
	if err != nil {
		return err
	}
	f := &fixture{ca: ca, serverSVID: serverSVID, clientSVID: clientSVID, endpoint: api, grpc: server, source: source, transport: transport, requests: make(map[string]context.CancelFunc)}
	defer func() {
		f.requestsMu.Lock()
		for _, cancel := range f.requests {
			cancel()
		}
		f.requestsMu.Unlock()
		transport.Close()
		f.work.Wait()
	}()
	digest := sha256.Sum256(ca.certificate.Raw)
	f.emit(map[string]any{"kind": "ready", "workloadApiSocketPath": path, "ownSPIFFEId": ownID, "peerSPIFFEId": peerID,
		"trustDomain": "readback.test", "trustBundleSha256": "sha256:" + hex.EncodeToString(digest[:]), "goVersion": runtime.Version()})
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), 262144)
	for scanner.Scan() {
		var request command
		decoder := json.NewDecoder(bytes.NewReader(scanner.Bytes()))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&request); err != nil {
			return err
		}
		if decoder.Decode(new(any)) != io.EOF {
			return errors.New("trailing fixture input")
		}
		switch request.Kind {
		case "request":
			f.request(ctx, request)
		case "status":
			f.endpoint.mu.Lock()
			watchers := len(f.endpoint.watchers)
			f.endpoint.mu.Unlock()
			f.emit(map[string]any{"kind": "status", "id": request.ID, "watchers": watchers})
		case "cancel":
			f.requestsMu.Lock()
			cancel := f.requests[request.ID]
			f.requestsMu.Unlock()
			if cancel != nil {
				cancel()
			}
		case "shutdown":
			return nil
		default:
			if err := f.change(request); err != nil {
				return err
			}
			f.emit(map[string]any{"kind": "changed", "id": request.ID})
		}
	}
	return scanner.Err()
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "validate-profile" {
		os.Exit(adversarialValidatorOutput(filepath.Base(os.Args[0])))
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	go func() { <-ctx.Done(); os.Stdin.Close() }()
	if err := run(ctx); err != nil {
		// Report only fixed native diagnostic classes. Provider errors, paths and
		// generated credential material are never part of fixture output.
		code := "fixture_failed"
		var sourceError *identity.Error
		var peerError *servicepeer.Error
		switch {
		case errors.As(err, &sourceError):
			code = "source/" + sourceError.Code
		case errors.As(err, &peerError):
			code = "peer/" + peerError.Code
		case errors.Is(err, syscall.EPERM), errors.Is(err, syscall.EACCES):
			code = "local-permission-denied"
		}
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"kind": "fatal", "error": code})
		os.Exit(1)
	}
}

// These explicitly named executable copies are protocol-negative subprocesses.
// Every branch corrupts output after a valid-looking first frame; none supplies
// a usable validator, Source, registry admission, or authenticated context.
func adversarialValidatorOutput(name string) int {
	var tail []byte
	switch name {
	case "invalid-validator-partial-prefix":
		tail = []byte{0, 0}
	case "invalid-validator-partial-body":
		tail = []byte{0, 0, 0, 5, '{'}
	case "invalid-validator-json":
		tail = []byte{0, 0, 0, 1, '{'}
	case "invalid-validator-oversized":
		tail = []byte{0xff, 0xff, 0xff, 0xff}
	case "invalid-validator-duplicate":
	default:
		return 1
	}
	if _, err := io.Copy(io.Discard, io.LimitReader(os.Stdin, 131077)); err != nil {
		return 1
	}
	valid := []byte(`{"schemaVersion":1,"result":"valid"}`)
	frame := make([]byte, 4+len(valid))
	binary.BigEndian.PutUint32(frame, uint32(len(valid)))
	copy(frame[4:], valid)
	if name == "invalid-validator-duplicate" {
		tail = frame
	}
	if _, err := os.Stdout.Write(append(frame, tail...)); err != nil {
		return 1
	}
	return 0
}
