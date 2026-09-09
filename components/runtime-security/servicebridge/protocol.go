// Package servicebridge owns the bounded native side of the controller's
// authenticated service channel. Admission and runtime effects remain OCC-owned.
package servicebridge

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/spiffe/go-spiffe/v2/spiffeid"
)

const (
	MaxFrameBytes               = 131072
	MaxRequestBytes             = 65536
	gatewayStartupPolicy        = "installation-gateway-startup-v1"
	gatewayStartupTransport     = "owned-child-stdio-installation-gateway-startup-v1"
	runtimeObservationPolicy    = "runtime-observation-read-v1"
	runtimeObservationTransport = "owned-child-stdio-runtime-observation-v1"
)

var (
	errProtocol   = errors.New("native readback protocol rejected")
	refPattern    = regexp.MustCompile(`^[A-Za-z0-9._:/-]{1,200}$`)
	digestPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	idPattern     = regexp.MustCompile(`^[0-9a-f]{32}$`)
)

// Profile is the wire projection of the canonical OCC service-trust profile.
// A valid shape is not admission; only the controller's protected registry can
// select these bytes. The native process additionally verifies actual TLS.
type Profile struct {
	SchemaVersion             int    `json:"schemaVersion"`
	OperationPolicy           string `json:"operationPolicy"`
	SourceRef                 string `json:"sourceRef"`
	SourceConfigurationDigest string `json:"sourceConfigurationDigest"`
	WorkloadAPISocketPath     string `json:"workloadApiSocketPath"`
	OwnSPIFFEID               string `json:"ownSPIFFEId"`
	PeerSPIFFEID              string `json:"peerSPIFFEId"`
	RecipientRef              string `json:"recipientRef"`
	RecipientSPIFFEID         string `json:"recipientSPIFFEId"`
	TrustDomain               string `json:"trustDomain"`
	TrustRootsRef             string `json:"trustRootsRef"`
	TrustBundleSHA256         string `json:"trustBundleSha256"`
	VerifierProfileRef        string `json:"verifierProfileRef"`
	NativeExecutableSHA256    string `json:"nativeExecutableSha256"`
	TransportProfileRef       string `json:"transportProfileRef"`
	Limits                    Limits `json:"limits"`
}

type Limits struct {
	HandshakeTimeoutMs int `json:"handshakeTimeoutMs"`
	RecheckIntervalMs  int `json:"recheckIntervalMs"`
	MaxConnectionAgeMs int `json:"maxConnectionAgeMs"`
	MaxConnections     int `json:"maxConnections"`
	RequestTimeoutMs   int `json:"requestTimeoutMs"`
}

// ValidateProfile performs maintained SPIFFE parsing and the selected closed
// transport-profile checks. It opens no source, listener or other network path.
func ValidateProfile(raw []byte) (Profile, error) {
	return validateProfile(raw, false)
}

// ValidateGatewayStartupClientProfile selects the client role by its fixed
// entrypoint. The recipient is the Controller peer, not the local Gateway.
func ValidateGatewayStartupClientProfile(raw []byte) (Profile, error) {
	return validateProfile(raw, true)
}

func validateProfile(raw []byte, client bool) (Profile, error) {
	var p Profile
	if len(raw) > MaxRequestBytes || decodeStrict(raw, &p) != nil {
		return Profile{}, errProtocol
	}
	own, ownErr := spiffeid.FromString(p.OwnSPIFFEID)
	peer, peerErr := spiffeid.FromString(p.PeerSPIFFEID)
	readback := p.OperationPolicy == "read-operation-only-v1" && p.TransportProfileRef == "owned-child-stdio-readback-v1"
	initialBind := p.OperationPolicy == "initial-harness-bind-v1" && p.TransportProfileRef == "owned-child-stdio-initial-harness-bind-v1"
	observation := p.OperationPolicy == runtimeObservationPolicy && p.TransportProfileRef == runtimeObservationTransport
	gatewayStartup := p.OperationPolicy == gatewayStartupPolicy && p.TransportProfileRef == gatewayStartupTransport
	recipient := p.OwnSPIFFEID
	if client {
		recipient = p.PeerSPIFFEID
	}
	if p.SchemaVersion != 1 || (!readback && !initialBind && !gatewayStartup && !observation) || (client && !gatewayStartup) ||
		ownErr != nil || peerErr != nil || own.Path() == "" || peer.Path() == "" ||
		own.String() != p.OwnSPIFFEID || peer.String() != p.PeerSPIFFEID ||
		own.TrustDomain() != peer.TrustDomain() || own.TrustDomain().String() != p.TrustDomain ||
		p.RecipientSPIFFEID != recipient || len(p.OwnSPIFFEID) > 200 || len(p.PeerSPIFFEID) > 200 ||
		!filepath.IsAbs(p.WorkloadAPISocketPath) || filepath.Clean(p.WorkloadAPISocketPath) != p.WorkloadAPISocketPath ||
		p.WorkloadAPISocketPath == "/" || strings.ContainsRune(p.WorkloadAPISocketPath, 0) || len(p.WorkloadAPISocketPath) > 103 || !regexp.MustCompile(`^/[A-Za-z0-9._/-]+$`).MatchString(p.WorkloadAPISocketPath) ||
		!refPattern.MatchString(p.SourceRef) || !refPattern.MatchString(p.RecipientRef) ||
		!refPattern.MatchString(p.TrustRootsRef) || !refPattern.MatchString(p.VerifierProfileRef) ||
		!digestPattern.MatchString(p.SourceConfigurationDigest) || !digestPattern.MatchString(p.TrustBundleSHA256) ||
		!digestPattern.MatchString(p.NativeExecutableSHA256) ||
		p.Limits != (Limits{HandshakeTimeoutMs: 3000, RecheckIntervalMs: 1000, MaxConnectionAgeMs: 30000, MaxConnections: 1, RequestTimeoutMs: 3000}) {
		return Profile{}, errProtocol
	}
	return p, nil
}

// Only the Installation profile uses this sequential, original-connection
// envelope. IDs are correlation, never registration or process evidence.
type gatewayStartupEnvelope struct {
	SchemaVersion int    `json:"schemaVersion"`
	Kind          string `json:"kind"`
	ConnectionID  string `json:"connectionId"`
	ExchangeID    string `json:"exchangeId"`
	Sequence      int64  `json:"sequence"`
	Challenge     string `json:"challenge"`
	RequestDigest string `json:"requestDigest"`
	PayloadBase64 string `json:"payloadBase64"`
}

type gatewayStartupHello struct {
	SchemaVersion int    `json:"schemaVersion"`
	Kind          string `json:"kind"`
	ConnectionID  string `json:"connectionId"`
	ExpiresAt     string `json:"expiresAt"`
}

func gatewayStartupMethod(method string) bool {
	return method == "consume-startup" || method == "read-current" || method == "read-operation"
}

// The canonical owner parser still validates the complete command before any
// local invocation exists. Native dispatch independently binds its exact kind.
func gatewayStartupRequestAllowed(request Request) bool {
	if request.SchemaVersion != 1 || !gatewayStartupMethod(request.Method) {
		return false
	}
	var operation map[string]json.RawMessage
	if json.Unmarshal(request.Operation, &operation) != nil || operation == nil {
		return false
	}
	expected, _ := json.Marshal(request.Method)
	return bytes.Equal(bytes.TrimSpace(operation["kind"]), expected)
}

func validGatewayStartupEnvelope(value gatewayStartupEnvelope, kind, connectionID string, sequence int64) bool {
	return value.SchemaVersion == 1 && value.Kind == kind &&
		idPattern.MatchString(value.ConnectionID) && value.ConnectionID == connectionID &&
		idPattern.MatchString(value.ExchangeID) && idPattern.MatchString(value.Challenge) &&
		value.Sequence == sequence && sequence > 0 && sequence <= 9007199254740991 &&
		digestPattern.MatchString(value.RequestDigest)
}

// ReadFrame rejects the length before allocating or reading the body. Its caller
// owns the underlying stream and installs the deadline before the first byte.
func ReadFrame(reader io.Reader, maximum uint32) ([]byte, error) {
	var length [4]byte
	if _, err := io.ReadFull(reader, length[:]); err != nil {
		return nil, err
	}
	size := binary.BigEndian.Uint32(length[:])
	if size == 0 || size > maximum {
		return nil, errProtocol
	}
	data := make([]byte, size)
	if _, err := io.ReadFull(reader, data); err != nil {
		return nil, err
	}
	if !validJSON(data) {
		return nil, errProtocol
	}
	return data, nil
}

func WriteFrame(writer io.Writer, data []byte, maximum uint32) error {
	if len(data) == 0 || len(data) > int(maximum) || !validJSON(data) {
		return errProtocol
	}
	var length [4]byte
	binary.BigEndian.PutUint32(length[:], uint32(len(data)))
	for _, part := range [][]byte{length[:], data} {
		for len(part) > 0 {
			n, err := writer.Write(part)
			if err != nil {
				return err
			}
			if n <= 0 {
				return io.ErrShortWrite
			}
			part = part[n:]
		}
	}
	return nil
}

func decodeStrict(raw []byte, destination any) error {
	if !validJSON(raw) || !validShape(raw, reflect.TypeOf(destination).Elem()) {
		return errProtocol
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(destination); err != nil {
		return errProtocol
	}
	return nil
}

// Decode by exact field spelling and required presence, rejecting null scalar
// values. encoding/json alone accepts case aliases and silently ignores null.
func validShape(raw []byte, kind reflect.Type) bool {
	if kind == reflect.TypeOf(json.RawMessage{}) {
		return true
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return false
	}
	if kind.Kind() != reflect.Struct {
		return true
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || fields == nil || len(fields) != kind.NumField() {
		return false
	}
	for i := 0; i < kind.NumField(); i++ {
		field := kind.Field(i)
		name := field.Tag.Get("json")
		value, exists := fields[name]
		if !exists || !validShape(value, field.Type) {
			return false
		}
	}
	return true
}

// Duplicate decoded names, noncanonical numbers, trailing values and excessive
// depth cannot acquire different meanings on the Go and TypeScript sides.
func validJSON(data []byte) bool {
	if !utf8.Valid(data) {
		return false
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	var value func(int) bool
	value = func(depth int) bool {
		if depth > 32 {
			return false
		}
		token, err := d.Token()
		if err != nil {
			return false
		}
		if n, ok := token.(json.Number); ok {
			v, err := n.Int64()
			return err == nil && v >= -9007199254740991 && v <= 9007199254740991 && n.String() == jsonNumber(v)
		}
		delimiter, ok := token.(json.Delim)
		if !ok {
			return true
		}
		switch delimiter {
		case '{':
			keys := map[string]bool{}
			for d.More() {
				t, err := d.Token()
				if err != nil {
					return false
				}
				key, ok := t.(string)
				if !ok || keys[key] || !value(depth+1) {
					return false
				}
				keys[key] = true
			}
			end, err := d.Token()
			return err == nil && end == json.Delim('}')
		case '[':
			for d.More() {
				if !value(depth + 1) {
					return false
				}
			}
			end, err := d.Token()
			return err == nil && end == json.Delim(']')
		default:
			return false
		}
	}
	if !value(0) {
		return false
	}
	_, err := d.Token()
	return errors.Is(err, io.EOF)
}

func jsonNumber(value int64) string { raw, _ := json.Marshal(value); return string(raw) }
