package servicebridge

import (
	"encoding/binary"
	"encoding/json"
	"io"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/spiffe/go-spiffe/v2/spiffeid"
)

const (
	MaterialMetadataBytes = 2048
	MaterialPayloadBytes  = 28672
	MaterialFrameBytes    = 32768
	materialPolicy        = "installation-channel-material-v1"
	materialTransport     = "owned-child-stdio-installation-channel-material-v1"
	materialPurpose       = "read-selected-channel-material"
	materialBootstrap     = byte(1)
	materialReady         = byte(2)
	materialConnected     = byte(3)
	materialRequest       = byte(4)
	materialInspect       = byte(5)
	materialInspected     = byte(6)
	materialResult        = byte(7)
	materialCompleted     = byte(8)
	materialClosed        = byte(9)
)

// The dedicated entrypoint selects the fixed side. Existing startup/readback
// validators never accept this profile or reinterpret its single purpose.
func ValidateChannelMaterialServerProfile(raw []byte) (Profile, error) {
	return validateMaterialProfile(raw, false)
}

func ValidateChannelMaterialClientProfile(raw []byte) (Profile, error) {
	return validateMaterialProfile(raw, true)
}

func validateMaterialProfile(raw []byte, client bool) (Profile, error) {
	var p Profile
	if len(raw) > MaterialMetadataBytes || decodeStrict(raw, &p) != nil {
		return Profile{}, errProtocol
	}
	own, ownErr := spiffeid.FromString(p.OwnSPIFFEID)
	peer, peerErr := spiffeid.FromString(p.PeerSPIFFEID)
	recipient := p.OwnSPIFFEID
	if client {
		recipient = p.PeerSPIFFEID
	}
	if p.SchemaVersion != 1 || p.OperationPolicy != materialPolicy || p.TransportProfileRef != materialTransport ||
		ownErr != nil || peerErr != nil || own.Path() == "" || peer.Path() == "" ||
		own.String() != p.OwnSPIFFEID || peer.String() != p.PeerSPIFFEID ||
		own.TrustDomain() != peer.TrustDomain() || own.TrustDomain().String() != p.TrustDomain ||
		p.RecipientSPIFFEID != recipient || len(p.OwnSPIFFEID) > 200 || len(p.PeerSPIFFEID) > 200 ||
		!filepath.IsAbs(p.WorkloadAPISocketPath) || filepath.Clean(p.WorkloadAPISocketPath) != p.WorkloadAPISocketPath ||
		p.WorkloadAPISocketPath == "/" || strings.ContainsRune(p.WorkloadAPISocketPath, 0) || len(p.WorkloadAPISocketPath) > 103 ||
		!regexp.MustCompile(`^/[A-Za-z0-9._/-]+$`).MatchString(p.WorkloadAPISocketPath) ||
		!refPattern.MatchString(p.SourceRef) || !refPattern.MatchString(p.RecipientRef) ||
		!refPattern.MatchString(p.TrustRootsRef) || !refPattern.MatchString(p.VerifierProfileRef) ||
		!digestPattern.MatchString(p.SourceConfigurationDigest) || !digestPattern.MatchString(p.TrustBundleSHA256) ||
		!digestPattern.MatchString(p.NativeExecutableSHA256) ||
		p.Limits != (Limits{HandshakeTimeoutMs: 3000, RecheckIntervalMs: 1000, MaxConnectionAgeMs: 5000, MaxConnections: 1, RequestTimeoutMs: 5000}) {
		return Profile{}, errProtocol
	}
	return p, nil
}

// One backing allocation owns both the nonsecret header and opaque payload.
// Each endpoint holds at most two application frame/payload allocations/64KiB;
// the four fixed endpoints have a conservative full-call cap of eight/256KiB.
// Native stream/TLS/OS internal buffers are separate and are not claimed erased.
type materialFrame struct {
	wire    []byte // Complete prefix/body view of the same sole backing.
	kind    byte
	header  []byte
	payload []byte
	owned   []byte
}

func (f *materialFrame) release() {
	clear(f.wire[:cap(f.wire)])
	f.wire, f.owned, f.header, f.payload = nil, nil, nil, nil
}

func readMaterialFrame(reader io.Reader) (*materialFrame, error) {
	var prefix [4]byte
	if _, err := io.ReadFull(reader, prefix[:]); err != nil {
		return nil, errProtocol
	}
	size := binary.BigEndian.Uint32(prefix[:])
	if size < 5 || size > MaterialFrameBytes-4 {
		return nil, errProtocol
	}
	wire := make([]byte, 4+size)
	copy(wire[:4], prefix[:])
	body := wire[4:]
	if _, err := io.ReadFull(reader, body); err != nil {
		clear(wire)
		return nil, errProtocol
	}
	headerLength := int(binary.BigEndian.Uint16(body[1:3]))
	payloadLength := len(body) - 3 - headerLength
	if body[0] < materialBootstrap || body[0] > materialClosed ||
		headerLength < 2 || headerLength > MaterialMetadataBytes || payloadLength < 0 ||
		payloadLength > MaterialPayloadBytes || (body[0] != materialResult && payloadLength != 0) {
		clear(wire)
		return nil, errProtocol
	}
	header := body[3 : 3+headerLength]
	if !validJSON(header) || header[0] != '{' {
		clear(wire)
		return nil, errProtocol
	}
	return &materialFrame{wire: wire, kind: body[0], header: header, payload: body[3+headerLength:], owned: body}, nil
}

// boundedMaterialJSON writes the closed metadata directly into its sole owned
// frame. It does not marshal an intermediate inner/envelope byte buffer or use
// an encoding/json scratch pool with an unknown retained backing capacity.
type boundedMaterialJSON struct {
	bytes       []byte
	used, nodes int
}

func (w *boundedMaterialJSON) put(b byte) error {
	if w.used == len(w.bytes) {
		return errProtocol
	}
	w.bytes[w.used] = b
	w.used++
	return nil
}
func (w *boundedMaterialJSON) literal(s string) error {
	if len(s) > len(w.bytes)-w.used {
		return errProtocol
	}
	copy(w.bytes[w.used:], s)
	w.used += len(s)
	return nil
}
func (w *boundedMaterialJSON) quoted(s string) error {
	if !utf8.ValidString(s) || w.put('"') != nil {
		return errProtocol
	}
	const digits = "0123456789abcdef"
	for _, r := range s {
		switch {
		case r == '"' || r == '\\':
			if w.put('\\') != nil || w.put(byte(r)) != nil {
				return errProtocol
			}
		case r == '\n':
			if w.literal(`\n`) != nil {
				return errProtocol
			}
		case r == '\r':
			if w.literal(`\r`) != nil {
				return errProtocol
			}
		case r == '\t':
			if w.literal(`\t`) != nil {
				return errProtocol
			}
		case r == '\b':
			if w.literal(`\b`) != nil {
				return errProtocol
			}
		case r == '\f':
			if w.literal(`\f`) != nil {
				return errProtocol
			}
		case r < 0x20 || r == '<' || r == '>' || r == '&' || r == 0x2028 || r == 0x2029:
			if w.literal(`\u`) != nil {
				return errProtocol
			}
			for shift := 12; shift >= 0; shift -= 4 {
				if w.put(digits[(r>>shift)&15]) != nil {
					return errProtocol
				}
			}
		default:
			if len(w.bytes)-w.used < utf8.RuneLen(r) {
				return errProtocol
			}
			w.used += utf8.EncodeRune(w.bytes[w.used:], r)
		}
	}
	return w.put('"')
}
func (w *boundedMaterialJSON) integer(n uint64, negative bool) error {
	if n > 9007199254740991 {
		return errProtocol
	}
	if negative && w.put('-') != nil {
		return errProtocol
	}
	start := w.used
	for {
		if w.put(byte(n%10)+'0') != nil {
			return errProtocol
		}
		n /= 10
		if n == 0 {
			break
		}
	}
	for a, b := start, w.used-1; a < b; a, b = a+1, b-1 {
		w.bytes[a], w.bytes[b] = w.bytes[b], w.bytes[a]
	}
	return nil
}
func (w *boundedMaterialJSON) value(v reflect.Value, depth int) error {
	w.nodes++
	if depth > 12 || w.nodes > 256 {
		return errProtocol
	}
	if !v.IsValid() {
		return w.literal("null")
	}
	if v.Kind() == reflect.Interface || v.Kind() == reflect.Pointer {
		if v.IsNil() {
			return w.literal("null")
		}
		return w.value(v.Elem(), depth+1)
	}
	if v.Type() == reflect.TypeOf(json.RawMessage{}) {
		raw := v.Bytes()
		if len(raw) == 0 {
			return w.literal("null")
		}
		if !json.Valid(raw) || len(raw) > len(w.bytes)-w.used {
			return errProtocol
		}
		copy(w.bytes[w.used:], raw)
		w.used += len(raw)
		return nil
	}
	switch v.Kind() {
	case reflect.String:
		return w.quoted(v.String())
	case reflect.Bool:
		if v.Bool() {
			return w.literal("true")
		}
		return w.literal("false")
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		n := v.Int()
		if n < 0 {
			return w.integer(uint64(-(n+1))+1, true)
		}
		return w.integer(uint64(n), false)
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return w.integer(v.Uint(), false)
	case reflect.Struct:
		if w.put('{') != nil {
			return errProtocol
		}
		fields := v.Type()
		written := false
		for i := 0; i < v.NumField(); i++ {
			field := fields.Field(i)
			key := field.Tag.Get("json")
			if field.PkgPath != "" || key == "-" {
				continue
			}
			if key == "" || strings.Contains(key, ",") {
				return errProtocol
			}
			if written && w.put(',') != nil {
				return errProtocol
			}
			written = true
			if w.quoted(key) != nil || w.put(':') != nil || w.value(v.Field(i), depth+1) != nil {
				return errProtocol
			}
		}
		return w.put('}')
	case reflect.Map:
		if v.Type().Key().Kind() != reflect.String {
			return errProtocol
		}
		if v.IsNil() {
			return w.literal("null")
		}
		if w.put('{') != nil {
			return errProtocol
		}
		iterator := v.MapRange()
		written := false
		for iterator.Next() {
			if written && w.put(',') != nil {
				return errProtocol
			}
			written = true
			if w.quoted(iterator.Key().String()) != nil || w.put(':') != nil || w.value(iterator.Value(), depth+1) != nil {
				return errProtocol
			}
		}
		return w.put('}')
	case reflect.Slice, reflect.Array:
		if v.Kind() == reflect.Slice && v.IsNil() {
			return w.literal("null")
		}
		if w.put('[') != nil {
			return errProtocol
		}
		for i := 0; i < v.Len(); i++ {
			if i > 0 && w.put(',') != nil {
				return errProtocol
			}
			if w.value(v.Index(i), depth+1) != nil {
				return errProtocol
			}
		}
		return w.put(']')
	default:
		return errProtocol
	}
}
func newMaterialMetadataFrame(kind byte, value any) (*materialFrame, error) {
	if kind < materialBootstrap || kind > materialClosed {
		return nil, errProtocol
	}
	backing := make([]byte, 7+MaterialMetadataBytes)
	writer := boundedMaterialJSON{bytes: backing[7:]}
	if writer.value(reflect.ValueOf(value), 0) != nil || writer.used < 2 || backing[7] != '{' {
		clear(backing)
		return nil, errProtocol
	}
	wire := backing[:7+writer.used]
	body := wire[4:]
	body[0] = kind
	binary.BigEndian.PutUint16(body[1:3], uint16(writer.used))
	binary.BigEndian.PutUint32(wire[:4], uint32(len(body)))
	return &materialFrame{wire: wire, kind: kind, header: body[3:], payload: body[len(body):], owned: body}, nil
}

func writeMaterialFrame(writer io.Writer, frame *materialFrame) error {
	if frame == nil || len(frame.owned) < 5 || len(frame.owned)+4 > MaterialFrameBytes ||
		len(frame.header) > MaterialMetadataBytes || len(frame.payload) > MaterialPayloadBytes ||
		frame.kind < materialBootstrap || frame.kind > materialClosed ||
		(frame.kind != materialResult && len(frame.payload) != 0) {
		return errProtocol
	}
	if len(frame.wire) != len(frame.owned)+4 || len(frame.wire) > MaterialFrameBytes ||
		&frame.wire[4] != &frame.owned[0] || binary.BigEndian.Uint32(frame.wire[:4]) != uint32(len(frame.owned)) {
		return errProtocol
	}
	bytes := frame.wire
	for len(bytes) > 0 {
		n, err := writer.Write(bytes)
		if err != nil || n < 1 || n > len(bytes) {
			return errProtocol
		}
		bytes = bytes[n:]
	}
	return nil
}
