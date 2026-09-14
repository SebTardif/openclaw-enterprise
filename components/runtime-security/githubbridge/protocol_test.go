package githubbridge

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"io"
	"strings"
	"testing"
)

func encodedFrame(metadata, secret []byte) []byte {
	var out bytes.Buffer
	var header [8]byte
	binary.BigEndian.PutUint32(header[:4], uint32(len(metadata)))
	binary.BigEndian.PutUint32(header[4:], uint32(len(secret)))
	out.Write(header[:])
	out.Write(metadata)
	out.Write(secret)
	return out.Bytes()
}
func TestFrameCapsAndStrictGrammar(t *testing.T) {
	for _, raw := range []string{`{"version":1,"version":1}`, `{"k":1.0}`, `{"k":1e0}`, `{"k":9007199254740992}`, `{"k":1} {"k":2}`, `{"k":"` + string([]byte{0xff}) + `"}`} {
		if f, e := ReadFrame(bytes.NewReader(encodedFrame([]byte(raw), nil))); e == nil {
			f.Clear()
			t.Fatalf("ambiguous JSON accepted: %q", raw)
		}
	}
	// A maximal legal DS metadata value can be base64 wrapped by the private
	// control channel without increasing the external wire's allocation bound.
	metadata := []byte(`{"text":"` + strings.Repeat("x", MaxMetadata-11) + `"}`)
	if len(metadata) != MaxMetadata {
		t.Fatal(len(metadata))
	}
	var out bytes.Buffer
	must(t, WriteFrame(&out, &Frame{Metadata: metadata}))
	f, e := ReadFrame(&out)
	must(t, e)
	f.Clear()
	larger := append([]byte(`{"text":"`), []byte(strings.Repeat("x", 20000)+`"}`)...)
	if WriteFrame(io.Discard, &Frame{Metadata: larger}) == nil {
		t.Fatal("external cap widened")
	}
	must(t, WriteControlFrame(io.Discard, &Frame{Metadata: larger}))
	for _, header := range [][2]uint32{{0, 0}, {MaxMetadata + 1, 0}, {1, MaxSecret + 1}} {
		var raw [8]byte
		binary.BigEndian.PutUint32(raw[:4], header[0])
		binary.BigEndian.PutUint32(raw[4:], header[1])
		if _, e := ReadFrame(bytes.NewReader(raw[:])); e == nil {
			t.Fatal("bad prefix accepted")
		}
	}
}

type retainedReader struct {
	data   []byte
	secret []byte
	reads  int
}

func (r *retainedReader) Read(p []byte) (int, error) {
	r.reads++
	if r.reads == 3 {
		r.secret = p
	}
	if len(r.data) == 0 {
		return 0, io.EOF
	}
	n := copy(p, r.data)
	r.data = r.data[n:]
	return n, nil
}
func TestPartialAndOwnedSecretBuffersAreCleared(t *testing.T) {
	raw := encodedFrame([]byte(`{"ok":true}`), []byte("canary-secret"))
	r := &retainedReader{data: raw[:len(raw)-2]}
	if _, e := ReadFrame(r); e == nil {
		t.Fatal("partial secret accepted")
	}
	if len(r.secret) == 0 || !bytes.Equal(r.secret, make([]byte, len(r.secret))) {
		t.Fatal("partial allocation retained secret")
	}
	f, e := ReadFrame(bytes.NewReader(raw))
	must(t, e)
	owned := f.Secret
	f.Clear()
	if !bytes.Equal(owned, make([]byte, len(owned))) {
		t.Fatal("owned bytes not erased")
	}
	for _, secret := range [][]byte{nil, []byte("token\n"), []byte("token space"), {0x7f}, bytes.Repeat([]byte("x"), MaxSecret+1)} {
		if secretValid(secret) {
			t.Fatal("invalid secret accepted")
		}
	}
	if !secretValid(bytes.Repeat([]byte("~"), MaxSecret)) {
		t.Fatal("valid bounded token rejected")
	}
}
func TestProfileAndControlClosedFields(t *testing.T) {
	profile := Profile{Version: 1, WorkloadAPISocketPath: "/a/w", OwnSPIFFEID: serverID, PeerSPIFFEID: clientID, RecipientSPIFFEID: serverID, TrustBundleSHA256: "sha256:" + strings.Repeat("a", 64), ListenPath: "/a/b", PeerUID: 1000, TrustedAncestorUIDs: []uint32{0, 1000}, HandshakeTimeoutMs: 1000, RecheckIntervalMs: 25, MaxConnectionAgeMs: 10000, RequestTimeoutMs: 1000}
	_, e := ValidateProfile(marshal(t, profile))
	must(t, e)
	if _, e := ValidateProfile(append(bytes.Repeat([]byte(" "), MaxMetadata), marshal(t, profile)...)); e == nil {
		t.Fatal("overlong profile accepted")
	}
	for _, modify := range []func(map[string]any){func(v map[string]any) { v["unexpected"] = 1 }, func(v map[string]any) { delete(v, "peer_uid") }, func(v map[string]any) { v["peer_uid"] = nil }, func(v map[string]any) { v["version"] = 2 }, func(v map[string]any) { v["recipient_spiffe_id"] = clientID }, func(v map[string]any) { v["listen_path"] = "/a/../b" }, func(v map[string]any) { v["trusted_ancestor_uids"] = []int{1, 1} }, func(v map[string]any) { v["request_timeout_ms"] = 0 }} {
		var value map[string]any
		must(t, json.Unmarshal(marshal(t, profile), &value))
		modify(value)
		if _, e := ValidateProfile(marshal(t, value)); e == nil {
			t.Fatal("invalid profile accepted")
		}
	}
	c := Control{Version: 1, Kind: "bootstrap", Incarnation: strings.Repeat("a", 32), Sequence: 1}
	_, e = decodeControl(marshal(t, c))
	must(t, e)
	raw := bytes.Replace(marshal(t, c), []byte(`"challenge":""`), []byte(`"challenge":null`), 1)
	if _, e := decodeControl(raw); e == nil {
		t.Fatal("null control field accepted")
	}
}
func TestWireCorrespondenceCannotReplayOrReleaseOnAnotherPhase(t *testing.T) {
	state := wireState{}
	request, e := state.request(marshal(t, openRequest()))
	must(t, e)
	open := opened(t, openRequest())
	if state.reply(request, marshal(t, open), []byte("canary")) == nil {
		t.Fatal("opened carried token")
	}
	must(t, state.reply(request, marshal(t, open), nil))
	if _, e := state.request(marshal(t, openRequest())); e == nil {
		t.Fatal("request replay accepted")
	}
	complete := map[string]any{}
	for _, key := range strings.Fields(binding) {
		var val any
		must(t, json.Unmarshal(state.opened[key], &val))
		complete[key] = val
	}
	complete["sequence"] = 2
	complete["method"] = "complete-read"
	complete["release_ref"] = nil
	complete["outcome"] = "not-dispatched"
	complete["effect_ref"] = "other"
	if _, e := state.request(marshal(t, complete)); e == nil {
		t.Fatal("switched binding accepted")
	}
	complete["effect_ref"] = open["effect_ref"]
	end, e := state.request(marshal(t, complete))
	must(t, e)
	invalid := map[string]any{"version": 2, "sequence": 2, "request_ref": complete["request_ref"], "ok": nil, "code": "denied"}
	if state.reply(end, marshal(t, invalid), nil) == nil {
		t.Fatal("null boolean accepted")
	}
}

func TestDiscardedLateReplyClearsOriginalSecretBeforeReturning(t *testing.T) {
	original := []byte("abandoned-token-canary")
	frame := &Frame{Secret: original}
	o := &owner{}
	must(t, o.lateCommand(Control{Kind: "reply"}, frame))
	if !bytes.Equal(original, make([]byte, len(original))) || frame.Secret != nil {
		t.Fatal("retired reply retained original token allocation")
	}
}
