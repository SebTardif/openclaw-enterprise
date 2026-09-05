// Package openshell verifies gateway-owned Sandbox launch records over gRPC.
// It does not attest provider Pods or the supervisor's currently effective policy.
package openshell

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"net"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/openclaw/openclaw-enterprise/components/runtime-security/openshell/pb"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
)

const (
	CodeInvalidConfiguration = "invalid_configuration"
	CodeInvalidRequest       = "invalid_request"
	CodeGatewayRPC           = "gateway_rpc"
	CodeInvalidResponse      = "invalid_response"
	CodeLaunchMismatch       = "launch_mismatch"
	CodeOwnershipMismatch    = "ownership_mismatch"
	CodeIdentityMismatch     = "identity_mismatch"
	CodeSandboxDeleting      = "sandbox_deleting"
	CodeCredentialRead       = "credential_read"
	CodeCredentialInvalid    = "credential_invalid"
	CodeTLSConfiguration     = "tls_configuration"
	CodeCancelled            = "cancelled"
	CodeDeadlineExceeded     = "deadline_exceeded"
	CodeClosed               = "closed"
	CodeHealthUnavailable    = "health_unavailable"
	CodeDeletionUnconfirmed  = "deletion_unconfirmed"
	maxMessageBytes          = 4 << 20
)

// Error carries only fixed classifications. Remote details and local file errors
// are never retained as causes, metadata, or diagnostic strings.
type Error struct {
	Code     string     `json:"code"`
	GRPCCode codes.Code `json:"grpcCode,omitempty"`
}

func (e *Error) Error() string { return "OpenShell " + e.Code }

func (e *Error) Is(target error) bool {
	return (e.Code == CodeCancelled && target == context.Canceled) ||
		(e.Code == CodeDeadlineExceeded && target == context.DeadlineExceeded)
}

type Config struct {
	Endpoint              string
	AuthMode              string
	BearerTokenPath       string
	RootCertificatePath   string
	ClientCertificatePath string
	ClientPrivateKeyPath  string
	RequestTimeout        time.Duration
}

type Identity struct {
	Name      string `json:"name"`
	Workspace string `json:"workspace"`
}

type CreateRequest struct {
	Name        string            `json:"name"`
	Workspace   string            `json:"workspace"`
	Labels      map[string]string `json:"labels"`
	Annotations map[string]string `json:"annotations"`
	Spec        json.RawMessage   `json:"spec"`
}

type Sandbox struct {
	Name                string            `json:"name"`
	ID                  string            `json:"id"`
	Workspace           string            `json:"workspace"`
	Labels              map[string]string `json:"labels"`
	Annotations         map[string]string `json:"annotations"`
	Spec                json.RawMessage   `json:"spec"`
	DeletionTimestampMs string            `json:"deletionTimestampMs"`
	Phase               string            `json:"phase,omitempty"`
}

// Client snapshots its configuration. Each operation owns its channel and a
// single deadline that includes credentials, transport, and any readback.
type Client struct {
	config   Config
	target   string
	host     string
	secure   bool
	closed   atomic.Bool
	shutdown context.Context
	cancel   context.CancelFunc
}

func New(config Config) (*Client, error) {
	if config.RequestTimeout == 0 {
		config.RequestTimeout = 10 * time.Second
	}
	if config.RequestTimeout < time.Second || config.RequestTimeout > time.Minute {
		return nil, &Error{Code: CodeInvalidConfiguration}
	}
	if config.AuthMode == "" {
		config.AuthMode = "unauthenticated"
	}
	if config.AuthMode != "unauthenticated" && config.AuthMode != "bearerTokenFile" {
		return nil, &Error{Code: CodeInvalidConfiguration}
	}
	if (config.AuthMode == "bearerTokenFile") != (config.BearerTokenPath != "") {
		return nil, &Error{Code: CodeInvalidConfiguration}
	}
	if (config.ClientCertificatePath == "") != (config.ClientPrivateKeyPath == "") {
		return nil, &Error{Code: CodeInvalidConfiguration}
	}
	for _, path := range []string{config.BearerTokenPath, config.RootCertificatePath, config.ClientCertificatePath, config.ClientPrivateKeyPath} {
		if path != "" && !absolutePath(path) {
			return nil, &Error{Code: CodeInvalidConfiguration}
		}
	}
	target, host, secure, err := endpoint(config.Endpoint)
	if err != nil {
		return nil, err
	}
	if !secure && (config.BearerTokenPath != "" || config.RootCertificatePath != "" || config.ClientCertificatePath != "") {
		return nil, &Error{Code: CodeInvalidConfiguration}
	}
	shutdown, cancel := context.WithCancel(context.Background())
	return &Client{config: config, target: target, host: host, secure: secure, shutdown: shutdown, cancel: cancel}, nil
}

func endpoint(value string) (string, string, bool, error) {
	invalid := func() (string, string, bool, error) { return "", "", false, &Error{Code: CodeInvalidConfiguration} }
	if value == "" || strings.TrimSpace(value) != value {
		return invalid()
	}
	secure := false
	target := value
	if strings.Contains(value, "://") {
		parsed, err := url.Parse(value)
		if err != nil || parsed.User != nil || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" ||
			(parsed.Path != "" && parsed.Path != "/") || (parsed.Scheme != "http" && parsed.Scheme != "https") {
			return invalid()
		}
		secure = parsed.Scheme == "https"
		port := parsed.Port()
		if port == "" {
			if secure {
				port = "443"
			} else {
				port = "80"
			}
		}
		target = net.JoinHostPort(parsed.Hostname(), port)
	}
	host, port, err := net.SplitHostPort(target)
	if err != nil || host == "" || strings.ContainsAny(host, "/@?#") {
		return invalid()
	}
	portNumber, err := strconv.Atoi(port)
	if err != nil || portNumber < 1 || portNumber > 65535 {
		return invalid()
	}
	return target, host, secure, nil
}

func (c *Client) Close() error { c.closed.Store(true); c.cancel(); return nil }

func (c *Client) operation(parent context.Context) (context.Context, func(), error) {
	if c.closed.Load() {
		return nil, nil, &Error{Code: CodeClosed}
	}
	ctx, cancel := context.WithTimeout(parent, c.config.RequestTimeout)
	stop := context.AfterFunc(c.shutdown, cancel)
	cleanup := func() { stop(); cancel() }
	if err := contextFailure(ctx); err != nil {
		cleanup()
		return nil, nil, err
	}
	return ctx, cleanup, nil
}

func contextFailure(ctx context.Context) error {
	switch ctx.Err() {
	case context.Canceled:
		return &Error{Code: CodeCancelled, GRPCCode: codes.Canceled}
	case context.DeadlineExceeded:
		return &Error{Code: CodeDeadlineExceeded, GRPCCode: codes.DeadlineExceeded}
	default:
		return nil
	}
}

func rpcFailure(ctx context.Context, err error) error {
	if canceled := contextFailure(ctx); canceled != nil {
		return canceled
	}
	return &Error{Code: CodeGatewayRPC, GRPCCode: status.Code(err)}
}

func (c *Client) connect(ctx context.Context) (*grpc.ClientConn, pb.OpenShellClient, error) {
	var transport credentials.TransportCredentials = insecure.NewCredentials()
	if c.secure {
		config := &tls.Config{MinVersion: tls.VersionTLS12, ServerName: c.host}
		if c.config.RootCertificatePath != "" {
			pem, err := readCredential(ctx, c.config.RootCertificatePath, 1<<20)
			if err != nil {
				return nil, nil, err
			}
			pool := x509.NewCertPool()
			if !pool.AppendCertsFromPEM(pem) {
				return nil, nil, &Error{Code: CodeTLSConfiguration}
			}
			config.RootCAs = pool
		}
		if c.config.ClientCertificatePath != "" {
			cert, err := readCredential(ctx, c.config.ClientCertificatePath, 1<<20)
			if err != nil {
				return nil, nil, err
			}
			key, err := readCredential(ctx, c.config.ClientPrivateKeyPath, 1<<20)
			if err != nil {
				return nil, nil, err
			}
			pair, err := tls.X509KeyPair(cert, key)
			if err != nil {
				return nil, nil, &Error{Code: CodeTLSConfiguration}
			}
			config.Certificates = []tls.Certificate{pair}
		}
		transport = credentials.NewTLS(config)
	}
	if err := contextFailure(ctx); err != nil {
		return nil, nil, err
	}
	conn, err := grpc.NewClient(c.target, grpc.WithTransportCredentials(transport), grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(maxMessageBytes), grpc.MaxCallSendMsgSize(maxMessageBytes)))
	if err != nil {
		return nil, nil, &Error{Code: CodeInvalidConfiguration}
	}
	return conn, pb.NewOpenShellClient(conn), nil
}

func (c *Client) headers(ctx context.Context) (context.Context, error) {
	if err := contextFailure(ctx); err != nil {
		return nil, err
	}
	md := metadata.MD{}
	if c.config.AuthMode == "bearerTokenFile" {
		content, err := readCredential(ctx, c.config.BearerTokenPath, 64<<10)
		if err != nil {
			return nil, err
		}
		token := strings.TrimSpace(string(content))
		if token == "" {
			return nil, &Error{Code: CodeCredentialInvalid}
		}
		for _, character := range token {
			if character < 0x21 || character > 0x7e {
				return nil, &Error{Code: CodeCredentialInvalid}
			}
		}
		md.Set("authorization", "Bearer "+token)
	}
	if err := contextFailure(ctx); err != nil {
		return nil, err
	}
	return metadata.NewOutgoingContext(ctx, md), nil
}

func (c *Client) Health(parent context.Context) error {
	ctx, done, err := c.operation(parent)
	if err != nil {
		return err
	}
	defer done()
	conn, gateway, err := c.connect(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	headers, err := c.headers(ctx)
	if err != nil {
		return err
	}
	response, err := gateway.Health(headers, &pb.HealthRequest{})
	if err != nil {
		return rpcFailure(ctx, err)
	}
	if err := contextFailure(ctx); err != nil {
		return err
	}
	if response.GetStatus() != pb.ServiceStatus_SERVICE_STATUS_HEALTHY {
		return &Error{Code: CodeHealthUnavailable}
	}
	return nil
}

func (c *Client) Create(parent context.Context, request CreateRequest) (Sandbox, error) {
	ctx, done, err := c.operation(parent)
	if err != nil {
		return Sandbox{}, err
	}
	defer done()
	if !validIdentity(Identity{Name: request.Name, Workspace: request.Workspace}) || len(request.Spec) == 0 || len(request.Spec) > maxMessageBytes {
		return Sandbox{}, &Error{Code: CodeInvalidRequest}
	}
	expected := &pb.CreateSandboxRequest{Name: request.Name, Workspace: request.Workspace, Labels: cloneMap(request.Labels), Annotations: cloneMap(request.Annotations), Spec: &pb.SandboxSpec{}}
	// Strict proto JSON rejects unknown fields. Structs use their natural JSON form.
	if err := (protojson.UnmarshalOptions{DiscardUnknown: false}).Unmarshal(request.Spec, expected.Spec); err != nil {
		return Sandbox{}, &Error{Code: CodeInvalidRequest}
	}
	conn, gateway, err := c.connect(ctx)
	if err != nil {
		return Sandbox{}, err
	}
	defer conn.Close()
	headers, err := c.headers(ctx)
	if err != nil {
		return Sandbox{}, err
	}
	created, createErr := gateway.CreateSandbox(headers, expected)
	if err := contextFailure(ctx); err != nil {
		return Sandbox{}, err
	}
	if createErr != nil {
		switch status.Code(createErr) {
		case codes.AlreadyExists, codes.Unavailable, codes.DeadlineExceeded, codes.Unknown:
			// NOT_FOUND during readback remains failure: a missing gateway record
			// does not establish the absence of a provider-side effect.
			observed, err := c.lookup(ctx, gateway, Identity{Name: request.Name, Workspace: request.Workspace})
			if err != nil {
				return Sandbox{}, err
			}
			if err := validateLaunch(observed, expected); err != nil {
				return Sandbox{}, err
			}
			return sandboxJSON(observed)
		default:
			return Sandbox{}, rpcFailure(ctx, createErr)
		}
	}
	if err := validateLaunch(created.GetSandbox(), expected); err != nil {
		return Sandbox{}, err
	}
	observed, err := c.lookup(ctx, gateway, Identity{Name: request.Name, Workspace: request.Workspace})
	if err != nil {
		return Sandbox{}, err
	}
	if err := validateLaunch(observed, expected); err != nil {
		return Sandbox{}, err
	}
	if observed.GetMetadata().GetId() != created.GetSandbox().GetMetadata().GetId() {
		return Sandbox{}, &Error{Code: CodeIdentityMismatch}
	}
	return sandboxJSON(observed)
}

func (c *Client) Get(parent context.Context, identity Identity) (Sandbox, error) {
	ctx, done, err := c.operation(parent)
	if err != nil {
		return Sandbox{}, err
	}
	defer done()
	if !validIdentity(identity) {
		return Sandbox{}, &Error{Code: CodeInvalidRequest}
	}
	conn, gateway, err := c.connect(ctx)
	if err != nil {
		return Sandbox{}, err
	}
	defer conn.Close()
	response, err := c.lookup(ctx, gateway, identity)
	if err != nil {
		return Sandbox{}, err
	}
	return sandboxJSON(response)
}

func (c *Client) lookup(ctx context.Context, gateway pb.OpenShellClient, identity Identity) (*pb.Sandbox, error) {
	headers, err := c.headers(ctx)
	if err != nil {
		return nil, err
	}
	response, err := gateway.GetSandbox(headers, &pb.GetSandboxRequest{Name: identity.Name, Workspace: identity.Workspace})
	if err != nil {
		return nil, rpcFailure(ctx, err)
	}
	if err := contextFailure(ctx); err != nil {
		return nil, err
	}
	sandbox := response.GetSandbox()
	if err := validSandbox(sandbox); err != nil {
		return nil, err
	}
	if sandbox.GetMetadata().GetName() != identity.Name || sandbox.GetMetadata().GetWorkspace() != identity.Workspace {
		return nil, &Error{Code: CodeIdentityMismatch}
	}
	return sandbox, nil
}

func (c *Client) Delete(parent context.Context, identity Identity) error {
	ctx, done, err := c.operation(parent)
	if err != nil {
		return err
	}
	defer done()
	if !validIdentity(identity) {
		return &Error{Code: CodeInvalidRequest}
	}
	conn, gateway, err := c.connect(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	headers, err := c.headers(ctx)
	if err != nil {
		return err
	}
	response, err := gateway.DeleteSandbox(headers, &pb.DeleteSandboxRequest{Name: identity.Name, Workspace: identity.Workspace})
	if canceled := contextFailure(ctx); canceled != nil {
		return canceled
	}
	if err != nil {
		if status.Code(err) == codes.NotFound {
			return nil
		}
		return rpcFailure(ctx, err)
	}
	if !response.GetDeleted() {
		return &Error{Code: CodeDeletionUnconfirmed}
	}
	return nil
}

func validIdentity(identity Identity) bool {
	return strings.TrimSpace(identity.Name) != "" && strings.TrimSpace(identity.Workspace) != ""
}

func validSandbox(sandbox *pb.Sandbox) error {
	meta := sandbox.GetMetadata()
	if meta == nil || sandbox.GetSpec() == nil || strings.TrimSpace(meta.GetId()) == "" || !validIdentity(Identity{Name: meta.GetName(), Workspace: meta.GetWorkspace()}) || meta.GetDeletionTimestampMs() < 0 {
		return &Error{Code: CodeInvalidResponse}
	}
	// JSON has no representation for protobuf unknown fields. Reject an
	// unsupported launch schema before Get could silently return a partial spec.
	if hasUnknownFields(sandbox.Spec.ProtoReflect()) {
		return &Error{Code: CodeInvalidResponse}
	}
	return nil
}

func hasUnknownFields(message protoreflect.Message) bool {
	if len(message.GetUnknown()) != 0 {
		return true
	}
	unknown := false
	message.Range(func(field protoreflect.FieldDescriptor, value protoreflect.Value) bool {
		switch {
		case field.IsMap() && field.MapValue().Message() != nil:
			value.Map().Range(func(_ protoreflect.MapKey, entry protoreflect.Value) bool {
				unknown = hasUnknownFields(entry.Message())
				return !unknown
			})
		case field.IsList() && field.Message() != nil:
			for i := 0; i < value.List().Len() && !unknown; i++ {
				unknown = hasUnknownFields(value.List().Get(i).Message())
			}
		case !field.IsMap() && !field.IsList() && field.Message() != nil:
			unknown = hasUnknownFields(value.Message())
		}
		return !unknown
	})
	return unknown
}

func validateLaunch(observed *pb.Sandbox, expected *pb.CreateSandboxRequest) error {
	if err := validSandbox(observed); err != nil {
		return err
	}
	meta := observed.GetMetadata()
	if meta.GetName() != expected.Name || meta.GetWorkspace() != expected.Workspace {
		return &Error{Code: CodeIdentityMismatch}
	}
	for key, value := range expected.Labels {
		if actual, exists := meta.Labels[key]; !exists || actual != value {
			return &Error{Code: CodeOwnershipMismatch}
		}
	}
	for key, value := range expected.Annotations {
		if actual, exists := meta.Annotations[key]; !exists || actual != value {
			return &Error{Code: CodeOwnershipMismatch}
		}
	}
	if meta.DeletionTimestampMs != 0 || observed.GetStatus().GetPhase() == pb.SandboxPhase_SANDBOX_PHASE_DELETING {
		return &Error{Code: CodeSandboxDeleting}
	}
	// proto.Equal preserves optional presence and unknown response fields while
	// normalizing ordinary protobuf defaults, maps, and nested Struct messages.
	if !proto.Equal(observed.GetSpec(), expected.Spec) {
		return &Error{Code: CodeLaunchMismatch}
	}
	return nil
}

func cloneMap(values map[string]string) map[string]string {
	result := make(map[string]string, len(values))
	for key, value := range values {
		result[key] = value
	}
	return result
}

func sandboxJSON(value *pb.Sandbox) (Sandbox, error) {
	if err := validSandbox(value); err != nil {
		return Sandbox{}, err
	}
	spec, err := (protojson.MarshalOptions{UseProtoNames: true}).Marshal(value.Spec)
	if err != nil {
		return Sandbox{}, &Error{Code: CodeInvalidResponse}
	}
	meta := value.Metadata
	return Sandbox{Name: meta.Name, ID: meta.Id, Workspace: meta.Workspace, Labels: cloneMap(meta.Labels), Annotations: cloneMap(meta.Annotations), Spec: spec, DeletionTimestampMs: strconv.FormatInt(meta.DeletionTimestampMs, 10), Phase: value.GetStatus().GetPhase().String()}, nil
}
