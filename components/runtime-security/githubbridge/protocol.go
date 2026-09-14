// Package githubbridge owns the native GitHub mediation connection and protected
// parent pipes. It authenticates transport only; original Work and effect
// authorization remain with the accepting parent and its original owners.
package githubbridge

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"path/filepath"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/spiffe/go-spiffe/v2/spiffeid"
)

const MaxMetadata = 16384
const MaxSecret = 16384
const MaxControlMetadata = 32768
const ApplicationProtocol = "oce-github-mediation-v2"
const GitReadApplicationProtocol = "oce-github-git-read-v3"

var errRejected = errors.New("GitHub mediation transport unavailable")
var noncePattern = regexp.MustCompile(`^[0-9a-f]{32}$`)
var hashPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
var referencePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$`)

// Frame exclusively owns Secret. Clear it after use, including rejected frames.
// No token is represented in JSON or converted to a Go string.
type Frame struct {
	Metadata []byte
	Secret   []byte
}

func (f *Frame) Clear() {
	if f != nil {
		clear(f.Secret)
		f.Secret = nil
	}
}
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
			return err == nil && v >= -9007199254740991 && v <= 9007199254740991 && n.String() == strconv.FormatInt(v, 10)
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

func ReadFrame(r io.Reader) (*Frame, error)        { return readFrame(r, MaxMetadata) }
func ReadControlFrame(r io.Reader) (*Frame, error) { return readFrame(r, MaxControlMetadata) }
func readFrame(r io.Reader, maximum uint32) (*Frame, error) {
	var header [8]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return nil, errRejected
	}
	m, s := binary.BigEndian.Uint32(header[:4]), binary.BigEndian.Uint32(header[4:])
	if m == 0 || m > maximum || s > MaxSecret {
		return nil, errRejected
	}
	f := &Frame{Metadata: make([]byte, int(m)), Secret: make([]byte, int(s))}
	if _, err := io.ReadFull(r, f.Metadata); err != nil {
		f.Clear()
		return nil, errRejected
	}
	if !validJSON(f.Metadata) {
		f.Clear()
		return nil, errRejected
	}
	if _, err := io.ReadFull(r, f.Secret); err != nil {
		f.Clear()
		return nil, errRejected
	}
	return f, nil
}
func WriteFrame(w io.Writer, f *Frame) error        { return writeFrame(w, f, MaxMetadata) }
func WriteControlFrame(w io.Writer, f *Frame) error { return writeFrame(w, f, MaxControlMetadata) }
func writeFrame(w io.Writer, f *Frame, maximum int) error {
	if f == nil || len(f.Metadata) == 0 || len(f.Metadata) > maximum || len(f.Secret) > MaxSecret || !validJSON(f.Metadata) {
		return errRejected
	}
	var header [8]byte
	binary.BigEndian.PutUint32(header[:4], uint32(len(f.Metadata)))
	binary.BigEndian.PutUint32(header[4:], uint32(len(f.Secret)))
	for _, part := range [][]byte{header[:], f.Metadata, f.Secret} {
		for len(part) > 0 {
			n, e := w.Write(part)
			if e != nil || n <= 0 || n > len(part) {
				return errRejected
			}
			part = part[n:]
		}
	}
	return nil
}
func strict(raw []byte, out any) error {
	if !validJSON(raw) {
		return errRejected
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || fields == nil {
		return errRejected
	}
	typ := reflect.TypeOf(out).Elem()
	known := make(map[string]bool, typ.NumField())
	for i := 0; i < typ.NumField(); i++ {
		tag := strings.Split(typ.Field(i).Tag.Get("json"), ",")
		known[tag[0]] = true
		v, ok := fields[tag[0]]
		optional := len(tag) == 2 && tag[1] == "omitempty"
		if (!ok && !optional) || (ok && bytes.Equal(bytes.TrimSpace(v), []byte("null"))) {
			return errRejected
		}
	}
	for key := range fields {
		if !known[key] {
			return errRejected
		}
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if dec.Decode(out) != nil {
		return errRejected
	}
	return nil
}

// Profile is received only on the original spawning parent's pipe. Its exact
// bytes must be bound to the parent's admitted source configuration.
type Profile struct {
	// Omission is V2. Only explicit 3 selects the separately admitted Git profile.
	ProtocolVersion       int      `json:"protocol_version,omitempty"`
	Version               int      `json:"version"`
	WorkloadAPISocketPath string   `json:"workload_api_socket_path"`
	OwnSPIFFEID           string   `json:"own_spiffe_id"`
	PeerSPIFFEID          string   `json:"peer_spiffe_id"`
	RecipientSPIFFEID     string   `json:"recipient_spiffe_id"`
	TrustBundleSHA256     string   `json:"trust_bundle_sha256"`
	ListenPath            string   `json:"listen_path"`
	PeerUID               uint32   `json:"peer_uid"`
	TrustedAncestorUIDs   []uint32 `json:"trusted_ancestor_uids"`
	HandshakeTimeoutMs    int      `json:"handshake_timeout_ms"`
	RecheckIntervalMs     int      `json:"recheck_interval_ms"`
	MaxConnectionAgeMs    int      `json:"max_connection_age_ms"`
	RequestTimeoutMs      int      `json:"request_timeout_ms"`
}

func (p Profile) wireVersion() int64 {
	if p.ProtocolVersion == 3 {
		return 3
	}
	return 2
}
func (p Profile) applicationProtocol() string {
	if p.ProtocolVersion == 3 {
		return GitReadApplicationProtocol
	}
	return ApplicationProtocol
}

func pathValid(path string) bool {
	return filepath.IsAbs(path) && filepath.Clean(path) == path && path != "/" && len(path) <= 103 && !strings.ContainsAny(path, "\x00\r\n")
}
func ValidateProfile(raw []byte) (Profile, error) {
	var p Profile
	if len(raw) == 0 || len(raw) > MaxMetadata {
		return p, errRejected
	}
	if strict(raw, &p) != nil {
		return p, errRejected
	}
	values, _ := decodeObject(raw)
	if _, present := values["protocol_version"]; present && p.ProtocolVersion != 3 {
		return Profile{}, errRejected
	}
	own, e := spiffeid.FromString(p.OwnSPIFFEID)
	peer, pe := spiffeid.FromString(p.PeerSPIFFEID)
	if p.Version != 1 || e != nil || pe != nil || own.Path() == "" || peer.Path() == "" || own.String() != p.OwnSPIFFEID || peer.String() != p.PeerSPIFFEID || own.TrustDomain() != peer.TrustDomain() || p.RecipientSPIFFEID != p.OwnSPIFFEID || len(p.OwnSPIFFEID) > 200 || len(p.PeerSPIFFEID) > 200 || !hashPattern.MatchString(p.TrustBundleSHA256) || !pathValid(p.ListenPath) || !pathValid(p.WorkloadAPISocketPath) || p.ListenPath == p.WorkloadAPISocketPath || len(p.TrustedAncestorUIDs) < 1 || len(p.TrustedAncestorUIDs) > 8 || p.HandshakeTimeoutMs < 1 || p.HandshakeTimeoutMs > 3000 || p.RecheckIntervalMs < 1 || p.RecheckIntervalMs > 1000 || p.MaxConnectionAgeMs < 1 || p.MaxConnectionAgeMs > 30000 || p.RequestTimeoutMs < 1 || p.RequestTimeoutMs > 3000 {
		return Profile{}, errRejected
	}
	seen := map[uint32]bool{}
	for _, uid := range p.TrustedAncestorUIDs {
		if seen[uid] {
			return Profile{}, errRejected
		}
		seen[uid] = true
	}
	return p, nil
}

// Control is deliberately closed, including fields unused by a particular kind.
// Native and parent sequences are independent, increasing for the incarnation.
type Control struct {
	Version        int    `json:"version"`
	Kind           string `json:"kind"`
	Incarnation    string `json:"incarnation"`
	Sequence       int64  `json:"sequence"`
	ConnectionID   string `json:"connection_id"`
	ExchangeID     string `json:"exchange_id"`
	RequestSHA256  string `json:"request_sha256"`
	Challenge      string `json:"challenge"`
	MetadataBase64 string `json:"metadata_base64"`
	DeadlineMs     int64  `json:"deadline_ms"`
}

func decodeControl(raw []byte) (Control, error) {
	var c Control
	if strict(raw, &c) != nil || c.Version != 1 || !noncePattern.MatchString(c.Incarnation) || c.Sequence < 1 || c.Sequence > 9007199254740991 || c.DeadlineMs < 0 || c.DeadlineMs > 253402300799999 {
		return c, errRejected
	}
	return c, nil
}
func payload(c Control) ([]byte, error) {
	if len(c.MetadataBase64) > base64.StdEncoding.EncodedLen(MaxMetadata) {
		return nil, errRejected
	}
	raw, e := base64.StdEncoding.Strict().DecodeString(c.MetadataBase64)
	if e != nil || base64.StdEncoding.EncodeToString(raw) != c.MetadataBase64 || len(raw) > MaxMetadata {
		return nil, errRejected
	}
	return raw, nil
}
func secretValid(secret []byte) bool {
	if len(secret) < 1 || len(secret) > MaxSecret {
		return false
	}
	for _, b := range secret {
		if b < 0x21 || b > 0x7e {
			return false
		}
	}
	return true
}

func decodeObject(raw []byte) (map[string]json.RawMessage, error) {
	var v map[string]json.RawMessage
	if !validJSON(raw) || json.Unmarshal(raw, &v) != nil || v == nil {
		return nil, errRejected
	}
	return v, nil
}
func stringAt(v map[string]json.RawMessage, k string) string {
	var s string
	if json.Unmarshal(v[k], &s) != nil {
		return ""
	}
	return s
}
func intAt(v map[string]json.RawMessage, k string) int64 {
	var n int64
	if json.Unmarshal(v[k], &n) != nil {
		return -1
	}
	return n
}
func fields(v map[string]json.RawMessage, keys string) bool {
	ks := strings.Fields(keys)
	if len(v) != len(ks) {
		return false
	}
	for _, k := range ks {
		if _, ok := v[k]; !ok {
			return false
		}
	}
	return true
}

const common = "version sequence request_ref"
const binding = common + " session_ref effect_ref work_binding_sha256 request_sha256"

func sameField(a, b map[string]json.RawMessage, k string) bool {
	var left, right any
	if json.Unmarshal(a[k], &left) != nil || json.Unmarshal(b[k], &right) != nil {
		return false
	}
	return reflect.DeepEqual(left, right)
}

// wireState tracks only transport correspondence and dispatch-once. It neither
// resolves an attachment nor grants the operation described by these values.
type wireState struct {
	version  int64
	sequence int64
	original map[string]json.RawMessage
	opened   map[string]json.RawMessage
	dispatch map[string]json.RawMessage
	terminal bool
}

func (s *wireState) wireVersion() int64 {
	if s.version == 0 {
		return 2
	}
	return s.version
}

// gitReadDigest binds closed metadata to the final body retained by DS. The
// bridge never receives the Git body and cannot attest to its contents.
func gitReadDigest(v map[string]json.RawMessage) string {
	op, count, hash := stringAt(v, "git_operation"), intAt(v, "body_bytes"), stringAt(v, "body_sha256")
	if stringAt(v, "git_protocol") != "version=2" || !hashPattern.MatchString(hash) || count < 0 || count > 4194304 {
		return ""
	}
	method, target, accept, content := "POST", "git-upload-pack", "result", "application/x-git-upload-pack-request"
	switch op {
	case "discovery":
		if count != 0 || hash != digest(nil) {
			return ""
		}
		method, target, accept, content = "GET", "info/refs?service=git-upload-pack", "advertisement", ""
	case "upload-pack":
		if count == 0 {
			return ""
		}
	default:
		return ""
	}
	canonical := strings.Join([]string{
		"oce.github.git-read.v3", op, method, "https", "github.com", "443",
		"/" + stringAt(v, "repository_owner") + "/" + stringAt(v, "repository_name") + ".git/" + target,
		"accept:application/x-git-upload-pack-" + accept, "accept-encoding:identity", "content-type:" + content,
		"git-protocol:version=2", "user-agent:oce-github-git-read", "connection:close",
		"body-bytes:" + strconv.FormatInt(count, 10), "body-sha256:" + hash[7:], "",
	}, "\n")
	return digest([]byte(canonical))
}

func (s *wireState) request(raw []byte) (map[string]json.RawMessage, error) {
	v, e := decodeObject(raw)
	if e != nil || s.terminal || intAt(v, "version") != s.wireVersion() || intAt(v, "sequence") != s.sequence+1 || intAt(v, "sequence") > 4294967295 || !noncePattern.MatchString(stringAt(v, "request_ref")) {
		return nil, errRejected
	}
	method := stringAt(v, "method")
	if s.sequence == 0 {
		keys := common + " method attachment_ref repository_owner repository_name request_sha256"
		if s.wireVersion() == 3 {
			keys += " git_operation git_protocol body_bytes body_sha256"
		}
		if method != "open-read" || !fields(v, keys) || !referencePattern.MatchString(stringAt(v, "attachment_ref")) || !hashPattern.MatchString(stringAt(v, "request_sha256")) {
			return nil, errRejected
		}
		componentLimit := 100
		if s.wireVersion() == 3 {
			componentLimit = 255
		}
		for _, key := range []string{"repository_owner", "repository_name"} {
			val := stringAt(v, key)
			if len(val) < 1 || len(val) > componentLimit || !regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]*$`).MatchString(val) {
				return nil, errRejected
			}
		}
		if s.wireVersion() == 3 && gitReadDigest(v) != stringAt(v, "request_sha256") {
			return nil, errRejected
		}
		s.original = v
	} else {
		if s.opened == nil {
			return nil, errRejected
		}
		for _, key := range strings.Fields(binding) {
			if key == "version" || key == "sequence" {
				continue
			}
			if !sameField(v, s.opened, key) {
				return nil, errRejected
			}
		}
		switch method {
		case "dispatch-read":
			if s.sequence != 1 || s.dispatch != nil || !fields(v, binding+" method dns_binding_ref upstream_ipv4 peer_certificate_sha256") || !sameField(v, s.opened, "dns_binding_ref") || !sameField(v, s.opened, "upstream_ipv4") || !hashPattern.MatchString(stringAt(v, "peer_certificate_sha256")) {
				return nil, errRejected
			}
		case "check-read":
			if s.dispatch == nil || !fields(v, binding+" method release_ref") || !sameField(v, s.dispatch, "release_ref") {
				return nil, errRejected
			}
		case "complete-read":
			if !fields(v, binding+" method release_ref outcome") {
				return nil, errRejected
			}
			outcome := stringAt(v, "outcome")
			if outcome != "not-dispatched" && outcome != "completed" && outcome != "unknown" {
				return nil, errRejected
			}
			if s.dispatch == nil {
				if !bytes.Equal(v["release_ref"], []byte("null")) || outcome == "completed" {
					return nil, errRejected
				}
			} else if !sameField(v, s.dispatch, "release_ref") && !(bytes.Equal(v["release_ref"], []byte("null")) && outcome == "unknown") {
				return nil, errRejected
			}
		default:
			return nil, errRejected
		}
	}
	s.sequence++
	return v, nil
}
func (s *wireState) reply(request map[string]json.RawMessage, raw []byte, secret []byte) error {
	v, e := decodeObject(raw)
	if e != nil || intAt(v, "version") != s.wireVersion() || !sameField(v, request, "sequence") || !sameField(v, request, "request_ref") {
		return errRejected
	}
	var ok bool
	if (!bytes.Equal(v["ok"], []byte("true")) && !bytes.Equal(v["ok"], []byte("false"))) || json.Unmarshal(v["ok"], &ok) != nil {
		return errRejected
	}
	if !ok {
		if !fields(v, common+" ok code") || len(secret) != 0 {
			return errRejected
		}
		switch stringAt(v, "code") {
		case "denied", "unavailable", "expired", "invalid":
		default:
			return errRejected
		}
		s.terminal = true
		return nil
	}
	phase := stringAt(v, "phase")
	method := stringAt(request, "method")
	if phase == "recorded" {
		if method != "complete-read" || len(secret) != 0 || !fields(v, binding+" ok phase release_ref") {
			return errRejected
		}
	} else {
		now, until, operation := intAt(v, "server_time_ms"), intAt(v, "valid_until_ms"), intAt(v, "operation_until_ms")
		if now < 0 || now >= until || until > operation || operation > 253402300799999 || until <= time.Now().UnixMilli() {
			return errRejected
		}
		if s.opened != nil && !sameField(v, s.opened, "operation_until_ms") {
			return errRejected
		}
	}
	if method == "open-read" {
		if phase != "opened" || len(secret) != 0 || !fields(v, binding+" ok phase server_time_ms valid_until_ms operation_until_ms dns_binding_ref upstream_ipv4") || !sameField(v, request, "request_sha256") || !noncePattern.MatchString(stringAt(v, "session_ref")) || !referencePattern.MatchString(stringAt(v, "effect_ref")) || !hashPattern.MatchString(stringAt(v, "work_binding_sha256")) || !referencePattern.MatchString(stringAt(v, "dns_binding_ref")) {
			return errRejected
		}
		ip := net.ParseIP(stringAt(v, "upstream_ipv4"))
		if ip == nil || ip.To4() == nil || ip.String() != stringAt(v, "upstream_ipv4") {
			return errRejected
		}
		s.opened = v
	} else {
		for _, key := range strings.Fields(binding) {
			if key == "sequence" {
				continue
			}
			if !sameField(v, request, key) {
				return errRejected
			}
		}
		switch method {
		case "dispatch-read":
			if phase != "dispatch-once" || s.dispatch != nil || !secretValid(secret) || !fields(v, binding+" ok phase server_time_ms valid_until_ms operation_until_ms dns_binding_ref upstream_ipv4 peer_certificate_sha256 release_ref") || !referencePattern.MatchString(stringAt(v, "release_ref")) {
				return errRejected
			}
			for _, key := range []string{"dns_binding_ref", "upstream_ipv4", "peer_certificate_sha256"} {
				if !sameField(v, request, key) {
					return errRejected
				}
			}
			s.dispatch = v
		case "check-read":
			if phase != "current" || len(secret) != 0 || !fields(v, binding+" ok phase server_time_ms valid_until_ms operation_until_ms release_ref") || !sameField(v, request, "release_ref") {
				return errRejected
			}
		case "complete-read":
			if phase != "recorded" || !sameField(v, request, "release_ref") {
				return errRejected
			}
			s.terminal = true
		default:
			return errRejected
		}
	}
	return nil
}
