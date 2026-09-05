package openshell_test

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	openshell "github.com/openclaw/openclaw-enterprise/components/runtime-security/openshell"
	"github.com/openclaw/openclaw-enterprise/components/runtime-security/openshell/pb"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

// These tests exercise the real Go client, gRPC transport, and generated wire
// messages. The local server does not establish upstream OpenShell scheduling,
// authorization policy, or Kubernetes/provider behavior.
type gatewayServer struct {
	pb.UnimplementedOpenShellServer
	health func(context.Context, *pb.HealthRequest) (*pb.HealthResponse, error)
	create func(context.Context, *pb.CreateSandboxRequest) (*pb.SandboxResponse, error)
	get    func(context.Context, *pb.GetSandboxRequest) (*pb.SandboxResponse, error)
	delete func(context.Context, *pb.DeleteSandboxRequest) (*pb.DeleteSandboxResponse, error)
}

func (s *gatewayServer) Health(ctx context.Context, r *pb.HealthRequest) (*pb.HealthResponse, error) {
	if s.health != nil {
		return s.health(ctx, r)
	}
	return nil, status.Error(codes.Unimplemented, "unused")
}
func (s *gatewayServer) CreateSandbox(ctx context.Context, r *pb.CreateSandboxRequest) (*pb.SandboxResponse, error) {
	if s.create != nil {
		return s.create(ctx, r)
	}
	return nil, status.Error(codes.Unimplemented, "unused")
}
func (s *gatewayServer) GetSandbox(ctx context.Context, r *pb.GetSandboxRequest) (*pb.SandboxResponse, error) {
	if s.get != nil {
		return s.get(ctx, r)
	}
	return nil, status.Error(codes.Unimplemented, "unused")
}
func (s *gatewayServer) DeleteSandbox(ctx context.Context, r *pb.DeleteSandboxRequest) (*pb.DeleteSandboxResponse, error) {
	if s.delete != nil {
		return s.delete(ctx, r)
	}
	return nil, status.Error(codes.Unimplemented, "unused")
}

func serveGateway(t *testing.T, handler *gatewayServer, config *tls.Config) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var options []grpc.ServerOption
	if config != nil {
		options = append(options, grpc.Creds(credentials.NewTLS(config)))
	}
	server := grpc.NewServer(options...)
	pb.RegisterOpenShellServer(server, handler)
	t.Cleanup(func() { server.Stop(); _ = listener.Close() })
	go func() { _ = server.Serve(listener) }()
	if config != nil {
		return "https://" + listener.Addr().String()
	}
	return "http://" + listener.Addr().String()
}

func newClient(t *testing.T, config openshell.Config) *openshell.Client {
	t.Helper()
	client, err := openshell.New(config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client
}

func request() openshell.CreateRequest {
	return openshell.CreateRequest{
		Name: "occ-protocol-sandbox", Workspace: "occ-protocol-workspace",
		Labels:      map[string]string{"occ.example/owner": "agent-protocol"},
		Annotations: map[string]string{"occ.example/revision": "revision-protocol"},
		Spec:        json.RawMessage(`{"template":{"image":"registry.example/runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","driver_config":{"kubernetes":{"containers":{"agent":{"volume_mounts":[{"name":"credentials","mount_path":"/run/credentials","read_only":true}]}}}}},"command":["/bin/sh","-c","sleep 60"],"environment":{"OCC_PROTOCOL_TEST":"true"},"policy":{"version":1,"filesystem":{"include_workdir":true,"read_only":["/app"],"read_write":["/home/node","/dev/null"]},"process":{"run_as_user":"1000","run_as_group":"1000"},"landlock":{"compatibility":"best_effort"},"network_policies":{"provider":{"name":"provider","endpoints":[{"host":"api.openai.com","ports":[443]}]}}}}`),
	}
}

func identity() openshell.Identity {
	r := request()
	return openshell.Identity{Name: r.Name, Workspace: r.Workspace}
}

func response(t *testing.T) *pb.SandboxResponse {
	t.Helper()
	r := request()
	spec := &pb.SandboxSpec{}
	if err := protojson.Unmarshal(r.Spec, spec); err != nil {
		t.Fatal(err)
	}
	return &pb.SandboxResponse{Sandbox: &pb.Sandbox{
		Metadata: &pb.ObjectMeta{Id: "provider-sandbox-id", Name: r.Name, Workspace: r.Workspace, Labels: r.Labels, Annotations: r.Annotations},
		Spec:     spec, Status: &pb.SandboxStatus{Phase: pb.SandboxPhase_SANDBOX_PHASE_READY},
	}}
}

func requireFailure(t *testing.T, err error) {
	t.Helper()
	if err == nil {
		t.Fatal("expected operation to fail")
	}
}

func TestWireVectors(t *testing.T) {
	for _, tc := range []struct {
		message proto.Message
		want    string
	}{
		{&pb.GetSandboxRequest{Name: "n", Workspace: "w"}, "\x0a\x01n\x12\x01w"},
		{&pb.NetworkBinary{Path: "x", Harness: true}, "\x0a\x01x\x10\x01"},
	} {
		// Independent known bytes pin field numbers and string/bool wire types.
		got, err := proto.Marshal(tc.message)
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != tc.want {
			t.Fatalf("wire bytes %x, want %x", got, tc.want)
		}
	}
}

func TestGetIdentityAndMetadata(t *testing.T) {
	want := response(t)
	endpoint := serveGateway(t, &gatewayServer{get: func(ctx context.Context, r *pb.GetSandboxRequest) (*pb.SandboxResponse, error) {
		if r.Name != identity().Name || r.Workspace != identity().Workspace {
			t.Error("identity changed on wire")
		}
		md, _ := metadata.FromIncomingContext(ctx)
		if len(md.Get("authorization")) != 0 {
			t.Error("unexpected authorization")
		}
		return want, nil
	}}, nil)
	got, err := newClient(t, openshell.Config{Endpoint: endpoint}).Get(context.Background(), identity())
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != "provider-sandbox-id" || got.Name != identity().Name || got.Workspace != identity().Workspace {
		t.Fatalf("wrong metadata: %+v", got)
	}
	if got.Labels["occ.example/owner"] != "agent-protocol" || got.Annotations["occ.example/revision"] != "revision-protocol" {
		t.Fatal("ownership metadata missing")
	}
	decoded := &pb.SandboxSpec{}
	if err := protojson.Unmarshal(got.Spec, decoded); err != nil {
		t.Fatal(err)
	}
	if !proto.Equal(decoded, want.Sandbox.Spec) {
		t.Fatal("returned spec changed")
	}
}

func TestGetRejectsUnknownWireFieldsBeforeJSONExport(t *testing.T) {
	for _, location := range []string{"spec", "endpoint", "Struct", "Struct-list-value"} {
		t.Run(location, func(t *testing.T) {
			observed := response(t)
			var message proto.Message
			switch location {
			case "spec":
				message = observed.Sandbox.Spec
			case "endpoint":
				message = observed.Sandbox.Spec.Policy.NetworkPolicies["provider"].Endpoints[0]
			case "Struct":
				message = observed.Sandbox.Spec.Template.DriverConfig.Fields["kubernetes"].GetStructValue()
			case "Struct-list-value":
				message = observed.Sandbox.Spec.Template.DriverConfig.Fields["kubernetes"].GetStructValue().Fields["containers"].GetStructValue().Fields["agent"].GetStructValue().Fields["volume_mounts"].GetListValue().Values[0]
			}
			// Field 127 is absent from these schemas. A standalone Get must reject
			// this unknown wire data before protojson can silently discard it.
			message.ProtoReflect().SetUnknown([]byte{0xf8, 0x07, 0x01})
			endpoint := serveGateway(t, &gatewayServer{
				get: func(context.Context, *pb.GetSandboxRequest) (*pb.SandboxResponse, error) {
					return observed, nil
				},
			}, nil)
			_, err := newClient(t, openshell.Config{Endpoint: endpoint}).Get(context.Background(), identity())
			var failure *openshell.Error
			if !errors.As(err, &failure) || failure.Code != openshell.CodeInvalidResponse {
				t.Fatalf("unknown %s data returned %v, want invalid response", location, err)
			}
		})
	}
}

func TestCreateAndReconciliation(t *testing.T) {
	for _, code := range []codes.Code{codes.OK, codes.AlreadyExists, codes.Unavailable, codes.DeadlineExceeded, codes.Unknown} {
		t.Run(code.String(), func(t *testing.T) {
			want := response(t)
			var creates, reads atomic.Int32
			endpoint := serveGateway(t, &gatewayServer{
				create: func(_ context.Context, r *pb.CreateSandboxRequest) (*pb.SandboxResponse, error) {
					creates.Add(1)
					if r.Name != request().Name || r.Workspace != request().Workspace || !proto.Equal(r.Spec, want.Sandbox.Spec) {
						t.Error("create changed launch intent on wire")
					}
					if r.Spec.Template.DriverConfig.AsMap()["kubernetes"] == nil {
						t.Error("natural JSON Struct did not reach wire")
					}
					if code != codes.OK {
						return nil, status.Error(code, "ambiguous provider result")
					}
					return want, nil
				},
				get: func(context.Context, *pb.GetSandboxRequest) (*pb.SandboxResponse, error) {
					reads.Add(1)
					return want, nil
				},
			}, nil)
			got, err := newClient(t, openshell.Config{Endpoint: endpoint}).Create(context.Background(), request())
			if err != nil {
				t.Fatal(err)
			}
			if got.ID != "provider-sandbox-id" || creates.Load() != 1 || reads.Load() != 1 {
				t.Fatal("create must read back exactly once")
			}
		})
	}
}

func TestCreateRejectsReadbackDrift(t *testing.T) {
	for _, field := range []string{"id", "owner", "annotation", "workspace", "command", "credentials", "unknown-wire-field"} {
		t.Run(field, func(t *testing.T) {
			created, observed := response(t), response(t)
			switch field {
			case "id":
				observed.Sandbox.Metadata.Id = "replacement"
			case "owner":
				observed.Sandbox.Metadata.Labels["occ.example/owner"] = "another-agent"
			case "annotation":
				observed.Sandbox.Metadata.Annotations = map[string]string{}
			case "workspace":
				observed.Sandbox.Metadata.Workspace = "another-workspace"
			case "command":
				observed.Sandbox.Spec.Command = []string{"unexpected-command"}
			case "credentials":
				observed.Sandbox.Spec.Policy.NetworkPolicies["provider"].Endpoints[0].AllowUninspectedCredentials = true
			case "unknown-wire-field":
				observed.Sandbox.Spec.ProtoReflect().SetUnknown([]byte{0xf8, 0x07, 0x01})
			}
			endpoint := serveGateway(t, &gatewayServer{
				create: func(context.Context, *pb.CreateSandboxRequest) (*pb.SandboxResponse, error) { return created, nil },
				get:    func(context.Context, *pb.GetSandboxRequest) (*pb.SandboxResponse, error) { return observed, nil },
			}, nil)
			_, err := newClient(t, openshell.Config{Endpoint: endpoint}).Create(context.Background(), request())
			requireFailure(t, err)
		})
	}
}

func TestDuplicateNeverDeletesMismatchingOrMissingSandbox(t *testing.T) {
	for _, outcome := range []string{"owner", "spec", "missing"} {
		t.Run(outcome, func(t *testing.T) {
			observed := response(t)
			var reads, deletes atomic.Int32
			if outcome == "owner" {
				observed.Sandbox.Metadata.Labels["occ.example/owner"] = "another-agent"
			}
			if outcome == "spec" {
				observed.Sandbox.Spec.Command = []string{"unexpected"}
			}
			endpoint := serveGateway(t, &gatewayServer{
				create: func(context.Context, *pb.CreateSandboxRequest) (*pb.SandboxResponse, error) {
					return nil, status.Error(codes.AlreadyExists, "duplicate")
				},
				get: func(context.Context, *pb.GetSandboxRequest) (*pb.SandboxResponse, error) {
					reads.Add(1)
					if outcome == "missing" {
						return nil, status.Error(codes.NotFound, "absent")
					}
					return observed, nil
				},
				delete: func(context.Context, *pb.DeleteSandboxRequest) (*pb.DeleteSandboxResponse, error) {
					deletes.Add(1)
					return &pb.DeleteSandboxResponse{Deleted: true}, nil
				},
			}, nil)
			_, err := newClient(t, openshell.Config{Endpoint: endpoint}).Create(context.Background(), request())
			requireFailure(t, err)
			if reads.Load() != 1 || deletes.Load() != 0 {
				t.Fatal("uncertain ownership must fail without deletion")
			}
		})
	}
}

func TestInvalidCreateEnvelopeDoesNotReadBack(t *testing.T) {
	for _, missing := range []string{"id", "spec", "metadata"} {
		t.Run(missing, func(t *testing.T) {
			invalid := response(t)
			var reads atomic.Int32
			switch missing {
			case "id":
				invalid.Sandbox.Metadata.Id = ""
			case "spec":
				invalid.Sandbox.Spec = nil
			case "metadata":
				invalid.Sandbox.Metadata = nil
			}
			endpoint := serveGateway(t, &gatewayServer{create: func(context.Context, *pb.CreateSandboxRequest) (*pb.SandboxResponse, error) { return invalid, nil }, get: func(context.Context, *pb.GetSandboxRequest) (*pb.SandboxResponse, error) {
				reads.Add(1)
				return response(t), nil
			}}, nil)
			_, err := newClient(t, openshell.Config{Endpoint: endpoint}).Create(context.Background(), request())
			requireFailure(t, err)
			if reads.Load() != 0 {
				t.Fatal("malformed create must fail before readback")
			}
		})
	}
}

func TestOptionalFalsePresence(t *testing.T) {
	for _, omitted := range []bool{false, true} {
		name := "explicit-false"
		if omitted {
			name = "omitted-readback"
		}
		t.Run(name, func(t *testing.T) {
			created, observed := response(t), response(t)
			value := false
			created.Sandbox.Spec.Template.UserNamespaces = &value
			if !omitted {
				observed.Sandbox.Spec.Template.UserNamespaces = &value
			}
			r := request()
			encoded, err := protojson.Marshal(created.Sandbox.Spec)
			if err != nil {
				t.Fatal(err)
			}
			r.Spec = encoded
			endpoint := serveGateway(t, &gatewayServer{create: func(context.Context, *pb.CreateSandboxRequest) (*pb.SandboxResponse, error) { return created, nil }, get: func(context.Context, *pb.GetSandboxRequest) (*pb.SandboxResponse, error) { return observed, nil }}, nil)
			_, err = newClient(t, openshell.Config{Endpoint: endpoint}).Create(context.Background(), r)
			if omitted {
				requireFailure(t, err)
			} else if err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestUnknownRequestFieldFailsBeforeRPC(t *testing.T) {
	var calls atomic.Int32
	endpoint := serveGateway(t, &gatewayServer{create: func(context.Context, *pb.CreateSandboxRequest) (*pb.SandboxResponse, error) {
		calls.Add(1)
		return response(t), nil
	}}, nil)
	r := request()
	r.Spec = json.RawMessage(`{"template":{"image":"image"},"unrecognized_launch_field":true}`)
	_, err := newClient(t, openshell.Config{Endpoint: endpoint}).Create(context.Background(), r)
	requireFailure(t, err)
	if calls.Load() != 0 {
		t.Fatal("unknown request field reached RPC")
	}
}

func TestDeleteRequiresAcknowledgment(t *testing.T) {
	for _, outcome := range []string{"deleted", "not-found", "false"} {
		t.Run(outcome, func(t *testing.T) {
			endpoint := serveGateway(t, &gatewayServer{delete: func(_ context.Context, r *pb.DeleteSandboxRequest) (*pb.DeleteSandboxResponse, error) {
				if r.Name != identity().Name || r.Workspace != identity().Workspace {
					t.Error("delete identity changed")
				}
				if outcome == "not-found" {
					return nil, status.Error(codes.NotFound, "gone")
				}
				return &pb.DeleteSandboxResponse{Deleted: outcome == "deleted"}, nil
			}}, nil)
			err := newClient(t, openshell.Config{Endpoint: endpoint}).Delete(context.Background(), identity())
			if outcome == "false" {
				requireFailure(t, err)
			} else if err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestCancellationAndDeadline(t *testing.T) {
	for _, kind := range []string{"pre-canceled", "pre-expired", "in-flight-canceled", "in-flight-deadline"} {
		t.Run(kind, func(t *testing.T) {
			var calls, reads atomic.Int32
			started := make(chan struct{})
			serverCanceled := make(chan struct{})
			endpoint := serveGateway(t, &gatewayServer{create: func(ctx context.Context, _ *pb.CreateSandboxRequest) (*pb.SandboxResponse, error) {
				calls.Add(1)
				close(started)
				<-ctx.Done()
				close(serverCanceled)
				return nil, ctx.Err()
			}, get: func(context.Context, *pb.GetSandboxRequest) (*pb.SandboxResponse, error) {
				reads.Add(1)
				return response(t), nil
			}}, nil)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			want := context.Canceled
			if kind == "pre-canceled" {
				cancel()
			}
			if kind == "pre-expired" {
				ctx, cancel = context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
				defer cancel()
				want = context.DeadlineExceeded
			}
			if kind == "in-flight-deadline" {
				ctx, cancel = context.WithTimeout(context.Background(), 100*time.Millisecond)
				defer cancel()
				want = context.DeadlineExceeded
			}
			client := newClient(t, openshell.Config{Endpoint: endpoint})
			result := make(chan error, 1)
			go func() { _, err := client.Create(ctx, request()); result <- err }()
			if strings.HasPrefix(kind, "in-flight") {
				select {
				case <-started:
				case <-time.After(3 * time.Second):
					t.Fatal("RPC did not begin")
				}
				if kind == "in-flight-canceled" {
					cancel()
				}
			}
			select {
			case err := <-result:
				if !errors.Is(err, want) {
					t.Fatalf("got %v, want %v", err, want)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("cancellation did not finish")
			}
			if strings.HasPrefix(kind, "pre-") && calls.Load() != 0 {
				t.Fatal("pre-canceled request reached server")
			}
			if strings.HasPrefix(kind, "in-flight") {
				select {
				case <-serverCanceled:
				case <-time.After(time.Second):
					t.Fatal("server RPC not canceled")
				}
			}
			if reads.Load() != 0 {
				t.Fatal("cancellation must not reconcile")
			}
		})
	}
}

func TestOperationDeadlineIncludesReadback(t *testing.T) {
	var reads atomic.Int32
	want := response(t)
	endpoint := serveGateway(t, &gatewayServer{
		create: func(ctx context.Context, _ *pb.CreateSandboxRequest) (*pb.SandboxResponse, error) {
			select {
			case <-time.After(75 * time.Millisecond):
				return want, nil
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		},
		get: func(ctx context.Context, _ *pb.GetSandboxRequest) (*pb.SandboxResponse, error) {
			reads.Add(1)
			<-ctx.Done()
			return nil, ctx.Err()
		},
	}, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer cancel()
	_, err := newClient(t, openshell.Config{Endpoint: endpoint, RequestTimeout: time.Second}).Create(ctx, request())
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("got %v, want operation deadline", err)
	}
	if reads.Load() != 1 {
		t.Fatal("deadline scenario did not reach readback")
	}
}

func TestCloseCancelsActiveOperationAndRejectsNewOperations(t *testing.T) {
	started := make(chan struct{})
	endpoint := serveGateway(t, &gatewayServer{health: func(ctx context.Context, _ *pb.HealthRequest) (*pb.HealthResponse, error) {
		close(started)
		<-ctx.Done()
		return nil, ctx.Err()
	}}, nil)
	client := newClient(t, openshell.Config{Endpoint: endpoint})
	result := make(chan error, 1)
	go func() { result <- client.Health(context.Background()) }()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("health RPC did not start")
	}
	if err := client.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("close returned %v, want cancellation", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("close did not cancel active RPC")
	}
	err := client.Health(context.Background())
	var gatewayError *openshell.Error
	if !errors.As(err, &gatewayError) || gatewayError.Code != openshell.CodeClosed {
		t.Fatalf("operation after close returned %v", err)
	}
}

type tlsFixture struct {
	config     openshell.Config
	server     *tls.Config
	dir, token string
}

func makeTLS(t *testing.T) tlsFixture {
	t.Helper()
	dir := t.TempDir()
	serial := int64(1)
	newCertificate := func(name string, parent *x509.Certificate, signer *ecdsa.PrivateKey, usage x509.ExtKeyUsage) ([]byte, []byte, *x509.Certificate, *ecdsa.PrivateKey) {
		key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		template := &x509.Certificate{SerialNumber: big.NewInt(serial), Subject: pkix.Name{CommonName: name}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, BasicConstraintsValid: true}
		serial++
		if parent == nil {
			template.IsCA = true
			template.KeyUsage |= x509.KeyUsageCertSign
			parent = template
			signer = key
		} else {
			template.ExtKeyUsage = []x509.ExtKeyUsage{usage}
			if usage == x509.ExtKeyUsageServerAuth {
				template.IPAddresses = []net.IP{net.ParseIP("127.0.0.1")}
			}
		}
		der, err := x509.CreateCertificate(rand.Reader, template, parent, &key.PublicKey, signer)
		if err != nil {
			t.Fatal(err)
		}
		certificate, err := x509.ParseCertificate(der)
		if err != nil {
			t.Fatal(err)
		}
		keyDER, err := x509.MarshalPKCS8PrivateKey(key)
		if err != nil {
			t.Fatal(err)
		}
		return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}), certificate, key
	}
	caPEM, _, ca, caKey := newCertificate("protocol-ca", nil, nil, 0)
	serverPEM, serverKey, _, _ := newCertificate("server", ca, caKey, x509.ExtKeyUsageServerAuth)
	clientPEM, clientKey, _, _ := newCertificate("client", ca, caKey, x509.ExtKeyUsageClientAuth)
	wrongCA, _, _, _ := newCertificate("untrusted-ca", nil, nil, 0)
	for name, data := range map[string][]byte{"ca.pem": caPEM, "wrong-ca.pem": wrongCA, "client.pem": clientPEM, "client.key": clientKey} {
		if err := os.WriteFile(filepath.Join(dir, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	cert, err := tls.X509KeyPair(serverPEM, serverKey)
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AppendCertsFromPEM(caPEM)
	token := "protocol-bearer-value-must-not-leak"
	tokenPath := filepath.Join(dir, "token")
	if err := os.WriteFile(tokenPath, []byte(token+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	return tlsFixture{dir: dir, token: token, server: &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{cert}, ClientCAs: roots, ClientAuth: tls.RequireAndVerifyClientCert}, config: openshell.Config{AuthMode: "bearerTokenFile", BearerTokenPath: tokenPath, RootCertificatePath: filepath.Join(dir, "ca.pem"), ClientCertificatePath: filepath.Join(dir, "client.pem"), ClientPrivateKeyPath: filepath.Join(dir, "client.key"), RequestTimeout: time.Second}}
}

func TestMTLSBearerAndSafeErrors(t *testing.T) {
	fixture := makeTLS(t)
	var calls atomic.Int32
	endpoint := serveGateway(t, &gatewayServer{
		health: func(ctx context.Context, _ *pb.HealthRequest) (*pb.HealthResponse, error) {
			calls.Add(1)
			md, _ := metadata.FromIncomingContext(ctx)
			if strings.Join(md.Get("authorization"), ",") != "Bearer "+fixture.token {
				t.Error("bearer header missing")
			}
			return &pb.HealthResponse{Status: pb.ServiceStatus_SERVICE_STATUS_HEALTHY}, nil
		},
		get: func(ctx context.Context, _ *pb.GetSandboxRequest) (*pb.SandboxResponse, error) {
			_ = grpc.SetTrailer(ctx, metadata.Pairs("secret-debug", fixture.token))
			return nil, status.Error(codes.PermissionDenied, fixture.token+" "+fixture.config.ClientPrivateKeyPath)
		},
	}, fixture.server)
	fixture.config.Endpoint = endpoint
	client := newClient(t, fixture.config)
	if err := client.Health(context.Background()); err != nil {
		t.Fatal(err)
	}
	_, err := client.Get(context.Background(), identity())
	requireFailure(t, err)
	if strings.Contains(err.Error(), fixture.token) || strings.Contains(err.Error(), fixture.dir) {
		t.Fatal("provider error leaked credential data")
	}
	var gatewayError *openshell.Error
	if !errors.As(err, &gatewayError) || gatewayError.GRPCCode != codes.PermissionDenied {
		t.Fatalf("missing sanitized grpc code: %v", err)
	}
	for _, kind := range []string{"canceled-setup", "expired-setup"} {
		t.Run(kind, func(t *testing.T) {
			config := fixture.config
			config.BearerTokenPath = filepath.Join(fixture.dir, "does-not-exist")
			ctx, cancel := context.WithCancel(context.Background())
			want := context.Canceled
			if kind == "expired-setup" {
				cancel()
				ctx, cancel = context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
				want = context.DeadlineExceeded
			} else {
				cancel()
			}
			defer cancel()
			// Context termination must take precedence over filesystem credential
			// failures, and prevent all setup from advancing to a transport RPC.
			err := newClient(t, config).Health(ctx)
			if !errors.Is(err, want) {
				t.Fatalf("got %v, want %v before credential setup", err, want)
			}
			if calls.Load() != 1 {
				t.Fatal("terminated setup reached RPC handler")
			}
		})
	}
	for _, kind := range []string{"missing-client-certificate", "wrong-ca", "unreadable-token", "newline-token", "NUL-token", "non-ASCII-token", "FIFO-token"} {
		t.Run(kind, func(t *testing.T) {
			config := fixture.config
			switch kind {
			case "missing-client-certificate":
				config.ClientCertificatePath = ""
				config.ClientPrivateKeyPath = ""
			case "wrong-ca":
				config.RootCertificatePath = filepath.Join(fixture.dir, "wrong-ca.pem")
			default:
				config.BearerTokenPath = filepath.Join(fixture.dir, kind)
				content := fixture.token
				switch kind {
				case "newline-token":
					content += "\nextra"
				case "NUL-token":
					content += "\x00"
				case "non-ASCII-token":
					content += "é"
				}
				if kind == "FIFO-token" {
					if err := syscall.Mkfifo(config.BearerTokenPath, 0600); err != nil {
						t.Fatal(err)
					}
					// Failure cleanup releases any accidentally opened FIFO reader;
					// a regression must fail this test rather than hang the test process.
					t.Cleanup(func() {
						fd, err := syscall.Open(config.BearerTokenPath, syscall.O_RDWR|syscall.O_NONBLOCK, 0)
						if err == nil {
							_, _ = syscall.Write(fd, []byte(fixture.token))
							_ = syscall.Close(fd)
						}
						_ = os.Remove(config.BearerTokenPath)
					})
				} else if kind != "unreadable-token" {
					if err := os.WriteFile(config.BearerTokenPath, []byte(content), 0600); err != nil {
						t.Fatal(err)
					}
				}
			}
			client := newClient(t, config)
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			result := make(chan error, 1)
			go func() { result <- client.Health(ctx) }()
			var err error
			select {
			case err = <-result:
			case <-time.After(3 * time.Second):
				t.Fatal("credential setup or TLS rejection exceeded deadline")
			}
			requireFailure(t, err)
			if kind == "FIFO-token" {
				var failure *openshell.Error
				if !errors.As(err, &failure) || failure.Code != openshell.CodeCredentialRead {
					t.Fatalf("FIFO must fail regular-file validation, got %v", err)
				}
			}
			if strings.Contains(err.Error(), fixture.token) || strings.Contains(err.Error(), fixture.dir) {
				t.Fatal("local credential error leaked file path or contents")
			}
			if calls.Load() != 1 {
				t.Fatal("invalid transport/credentials reached RPC handler")
			}
		})
	}
}

func TestConfigurationRejectsCleartextCredentialsAndInvalidTimeouts(t *testing.T) {
	for _, endpoint := range []string{"127.0.0.1:1", "http://127.0.0.1:1"} {
		_, err := openshell.New(openshell.Config{Endpoint: endpoint, AuthMode: "bearerTokenFile", BearerTokenPath: "/not-read/token"})
		requireFailure(t, err)
		_, err = openshell.New(openshell.Config{Endpoint: endpoint, ClientCertificatePath: "/not-read/cert", ClientPrivateKeyPath: "/not-read/key"})
		requireFailure(t, err)
	}
	for _, config := range []openshell.Config{{Endpoint: "https://127.0.0.1:1", ClientCertificatePath: "/not-read/cert"}, {Endpoint: "https://127.0.0.1:1", ClientPrivateKeyPath: "/not-read/key"}, {Endpoint: "http://127.0.0.1:1", RequestTimeout: time.Millisecond}, {Endpoint: "http://127.0.0.1:1", RequestTimeout: 61 * time.Second}} {
		_, err := openshell.New(config)
		requireFailure(t, err)
	}
}
