// oce-runtime-security owns the native OpenShell and SPIFFE provider boundaries.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"reflect"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/openclaw/openclaw-enterprise/components/runtime-security/identity"
	"github.com/openclaw/openclaw-enterprise/components/runtime-security/openshell"
)

const maxWireBytes = 4 * 1024 * 1024

const help = `Usage:
  oce-runtime-security identity check --socket-path PATH --spiffe-id ID [--audience AUDIENCE] [--timeout-ms MILLISECONDS]
  oce-runtime-security openshell

identity check reads an operator-trusted local SPIFFE Workload API and prints
identity and expiry metadata only. It does not establish guest attestation,
remote mTLS, runtime authority, or deployment readiness.
openshell accepts one versioned JSON request on stdin (maximum 4 MiB).
`

type wireGateway struct {
	Endpoint              string    `json:"endpoint"`
	Auth                  *wireAuth `json:"auth,omitempty"`
	RequestTimeoutMs      *int64    `json:"requestTimeoutMs,omitempty"`
	RootCertificatePath   string    `json:"rootCertificatePath,omitempty"`
	ClientCertificatePath string    `json:"clientCertificatePath,omitempty"`
	ClientPrivateKeyPath  string    `json:"clientPrivateKeyPath,omitempty"`
}

type wireAuth struct {
	Mode string `json:"mode"`
	Path string `json:"path,omitempty"`
}

type wireRequest struct {
	SchemaVersion int             `json:"schemaVersion"`
	Operation     string          `json:"operation"`
	Gateway       *wireGateway    `json:"gateway"`
	Sandbox       json.RawMessage `json:"sandbox,omitempty"`
}

type wireError struct {
	Code     string `json:"code"`
	GRPCCode int    `json:"grpcCode,omitempty"`
}
type wireResponse struct {
	SchemaVersion int                `json:"schemaVersion"`
	OK            bool               `json:"ok"`
	Result        *openshell.Sandbox `json:"result,omitempty"`
	Error         *wireError         `json:"error,omitempty"`
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	code := run(ctx, os.Args[1:], os.Stdin, os.Stdout, os.Stderr)
	stop()
	os.Exit(code)
}

func run(ctx context.Context, args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) == 1 && (args[0] == "--help" || args[0] == "help") {
		_, err := io.WriteString(stdout, help)
		if err != nil {
			return 1
		}
		return 0
	}
	if len(args) == 1 && args[0] == "openshell" {
		return runOpenShell(ctx, stdin, stdout)
	}
	if len(args) >= 2 && args[0] == "identity" && args[1] == "check" {
		return runIdentity(ctx, args[2:], stdout, stderr)
	}
	_, _ = io.WriteString(stderr, "Invalid arguments. Use --help for supported commands.\n")
	return 2
}

// Reject duplicate keys and excessive nesting before decoding typed fields;
// ambiguous JSON must never select a different security intent across parsers.
func validJSON(data []byte) bool {
	if !utf8.Valid(data) {
		return false
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var value func(int) bool
	value = func(depth int) bool {
		if depth > 128 {
			return false
		}
		token, err := decoder.Token()
		if err != nil {
			return false
		}
		delimiter, ok := token.(json.Delim)
		if !ok {
			return true
		}
		switch delimiter {
		case '{':
			keys := map[string]bool{}
			for decoder.More() {
				keyToken, err := decoder.Token()
				if err != nil {
					return false
				}
				key, ok := keyToken.(string)
				if !ok || keys[key] {
					return false
				}
				keys[key] = true
				if !value(depth + 1) {
					return false
				}
			}
			end, err := decoder.Token()
			return err == nil && end == json.Delim('}')
		case '[':
			for decoder.More() {
				if !value(depth + 1) {
					return false
				}
			}
			end, err := decoder.Token()
			return err == nil && end == json.Delim(']')
		default:
			return false
		}
	}
	if !value(0) {
		return false
	}
	_, err := decoder.Token()
	return errors.Is(err, io.EOF)
}

func decodeStrict(data []byte, destination any) error {
	if !validJSON(data) || !validShape(data, reflect.TypeOf(destination).Elem()) {
		return errors.New("invalid JSON")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	return decoder.Decode(destination)
}

// encoding/json accepts case-insensitive field aliases and null primitives.
// The subprocess contract accepts only the declared spelling and field types.
func validShape(data []byte, kind reflect.Type) bool {
	if kind == reflect.TypeOf(json.RawMessage{}) {
		return true
	}
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return false
	}
	if kind.Kind() == reflect.Pointer {
		return validShape(data, kind.Elem())
	}
	if kind.Kind() == reflect.Struct {
		var fields map[string]json.RawMessage
		if json.Unmarshal(data, &fields) != nil || fields == nil {
			return false
		}
		for key, value := range fields {
			found := false
			for index := 0; index < kind.NumField(); index++ {
				field := kind.Field(index)
				name, _, _ := strings.Cut(field.Tag.Get("json"), ",")
				if name == key {
					found = validShape(value, field.Type)
					break
				}
			}
			if !found {
				return false
			}
		}
	}
	if kind.Kind() == reflect.Map {
		var fields map[string]json.RawMessage
		if json.Unmarshal(data, &fields) != nil || fields == nil {
			return false
		}
		for _, value := range fields {
			if !validShape(value, kind.Elem()) {
				return false
			}
		}
	}
	return true
}

func runOpenShell(ctx context.Context, stdin io.Reader, stdout io.Writer) int {
	fail := func(code string) int {
		return writeResponse(stdout, wireResponse{SchemaVersion: 1, Error: &wireError{Code: code}})
	}
	// The process must finish even when a caller leaves stdin open without EOF.
	// Main exits on this deadline; the bounded reader never holds the process alive.
	type inputResult struct {
		data []byte
		err  error
	}
	input := make(chan inputResult, 1)
	go func() {
		data, err := io.ReadAll(io.LimitReader(stdin, maxWireBytes+1))
		input <- inputResult{data, err}
	}()
	inputContext, cancelInput := context.WithTimeout(ctx, 5*time.Second)
	defer cancelInput()
	var data []byte
	var err error
	select {
	case value := <-input:
		data, err = value.data, value.err
	case <-inputContext.Done():
		if ctx.Err() != nil {
			return fail("cancelled")
		}
		return fail("deadline_exceeded")
	}
	if err != nil || len(data) > maxWireBytes {
		return fail("invalid_wire_request")
	}
	var request wireRequest
	if decodeStrict(data, &request) != nil || request.SchemaVersion != 1 || request.Gateway == nil {
		return fail("invalid_wire_request")
	}
	var create openshell.CreateRequest
	var target openshell.Identity
	switch request.Operation {
	case "health":
		if len(request.Sandbox) != 0 {
			return fail("invalid_wire_request")
		}
	case "create":
		if len(request.Sandbox) == 0 || bytes.Equal(request.Sandbox, []byte("null")) || decodeStrict(request.Sandbox, &create) != nil {
			return fail("invalid_wire_request")
		}
	case "get", "delete":
		if len(request.Sandbox) == 0 || bytes.Equal(request.Sandbox, []byte("null")) || decodeStrict(request.Sandbox, &target) != nil {
			return fail("invalid_wire_request")
		}
	default:
		return fail("invalid_wire_request")
	}
	gateway := request.Gateway
	config := openshell.Config{Endpoint: gateway.Endpoint, RootCertificatePath: gateway.RootCertificatePath,
		ClientCertificatePath: gateway.ClientCertificatePath, ClientPrivateKeyPath: gateway.ClientPrivateKeyPath}
	if gateway.RequestTimeoutMs != nil {
		if *gateway.RequestTimeoutMs < 1000 || *gateway.RequestTimeoutMs > 60000 {
			return fail("invalid_configuration")
		}
		config.RequestTimeout = time.Duration(*gateway.RequestTimeoutMs) * time.Millisecond
	}
	if gateway.Auth != nil {
		if gateway.Auth.Mode != "unauthenticated" && gateway.Auth.Mode != "bearerTokenFile" {
			return fail("invalid_configuration")
		}
		if gateway.Auth.Mode == "unauthenticated" && gateway.Auth.Path != "" {
			return fail("invalid_configuration")
		}
		config.AuthMode, config.BearerTokenPath = gateway.Auth.Mode, gateway.Auth.Path
	}
	client, err := openshell.New(config)
	if err != nil {
		return writeResponse(stdout, errorResponse(err))
	}
	defer client.Close()
	var result *openshell.Sandbox
	switch request.Operation {
	case "health":
		err = client.Health(ctx)
	case "create":
		var value openshell.Sandbox
		value, err = client.Create(ctx, create)
		result = &value
	case "get":
		var value openshell.Sandbox
		value, err = client.Get(ctx, target)
		result = &value
	case "delete":
		err = client.Delete(ctx, target)
	}
	if err != nil {
		return writeResponse(stdout, errorResponse(err))
	}
	return writeResponse(stdout, wireResponse{SchemaVersion: 1, OK: true, Result: result})
}

func errorResponse(err error) wireResponse {
	result := wireError{Code: "internal_error"}
	var failure *openshell.Error
	if errors.As(err, &failure) {
		switch failure.Code {
		case "invalid_configuration", "invalid_request", "gateway_rpc", "invalid_response",
			"launch_mismatch", "ownership_mismatch", "identity_mismatch", "sandbox_deleting",
			"credential_read", "credential_invalid", "tls_configuration", "cancelled",
			"deadline_exceeded", "closed", "health_unavailable", "deletion_unconfirmed":
			result.Code = failure.Code
		}
		if failure.GRPCCode > 0 && failure.GRPCCode <= 16 {
			result.GRPCCode = int(failure.GRPCCode)
		}
	}
	return wireResponse{SchemaVersion: 1, Error: &result}
}

func writeResponse(stdout io.Writer, response wireResponse) int {
	data, err := json.Marshal(response)
	if err != nil {
		data = []byte(`{"schemaVersion":1,"ok":false,"error":{"code":"internal_error"}}`)
		response.OK = false
	}
	if len(data)+1 > maxWireBytes {
		data = []byte(`{"schemaVersion":1,"ok":false,"error":{"code":"response_too_large"}}`)
		response.OK = false
	}
	if _, err := stdout.Write(append(data, '\n')); err != nil {
		return 1
	}
	if !response.OK {
		return 1
	}
	return 0
}

func runIdentity(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	if len(args) == 1 && args[0] == "--help" {
		_, _ = io.WriteString(stdout, help)
		return 0
	}
	values := map[string]string{}
	valid := len(args)%2 == 0
	for index := 0; valid && index < len(args); index += 2 {
		key, value := args[index], args[index+1]
		switch key {
		case "--socket-path", "--spiffe-id", "--audience", "--timeout-ms":
		default:
			valid = false
		}
		if _, exists := values[key]; exists || value == "" {
			valid = false
		}
		values[key] = value
	}
	timeoutMs := int64(10000)
	var err error
	if value, exists := values["--timeout-ms"]; exists {
		timeoutMs, err = strconv.ParseInt(value, 10, 64)
	}
	if !valid || err != nil || timeoutMs < 1000 || timeoutMs > 60000 || values["--socket-path"] == "" || values["--spiffe-id"] == "" {
		_, _ = io.WriteString(stderr, "Invalid identity arguments. Use --help for supported options.\n")
		return 2
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()
	unavailable := func() int {
		reason := "workload-identity-check-failed"
		if ctx.Err() != nil {
			reason = "cancelled-or-timed-out"
		}
		_, _ = fmt.Fprintf(stderr, "{\"schemaVersion\":1,\"status\":\"unavailable\",\"reason\":%q,\"scope\":\"local-workload-api\"}\n", reason)
		return 1
	}
	source, err := identity.NewSource(identity.Options{SocketPath: values["--socket-path"], ExpectedSPIFFEID: values["--spiffe-id"], Timeout: time.Duration(timeoutMs) * time.Millisecond})
	if err != nil {
		return unavailable()
	}
	defer source.Close()
	if err := source.Start(ctx); err != nil {
		return unavailable()
	}
	var jwt any
	if audience, exists := values["--audience"]; exists {
		fetched, err := source.FetchJWTSVID(ctx, audience)
		if err != nil {
			return unavailable()
		}
		verified, err := source.ValidateJWTSVID(ctx, fetched.Token, audience, values["--spiffe-id"])
		if err != nil {
			return unavailable()
		}
		jwt = struct {
			Status    string    `json:"status"`
			ExpiresAt time.Time `json:"expiresAt"`
		}{"validated", verified.ExpiresAt}
	}
	metadata, err := source.Metadata()
	if err != nil {
		return unavailable()
	}
	response := struct {
		SchemaVersion int       `json:"schemaVersion"`
		Status        string    `json:"status"`
		SPIFFEID      string    `json:"spiffeId"`
		X509ExpiresAt time.Time `json:"x509ExpiresAt"`
		JWT           any       `json:"jwt,omitempty"`
		Scope         string    `json:"scope"`
	}{1, "available", metadata.SPIFFEID, metadata.ExpiresAt, jwt, "local-workload-api"}
	if err := json.NewEncoder(stdout).Encode(response); err != nil {
		return 1
	}
	return 0
}
