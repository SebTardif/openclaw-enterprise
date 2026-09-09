package servicebridge_test

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"io"
	"strings"
	"testing"

	"github.com/openclaw/openclaw-enterprise/components/runtime-security/servicebridge"
)

func profileValue() servicebridge.Profile {
	return servicebridge.Profile{
		SchemaVersion: 1, OperationPolicy: "read-operation-only-v1", SourceRef: "source/readback",
		SourceConfigurationDigest: "sha256:" + strings.Repeat("1", 64), WorkloadAPISocketPath: "/nonexistent-fixture/api.sock",
		OwnSPIFFEID: "spiffe://readback.test/controller/history", PeerSPIFFEID: "spiffe://readback.test/service/reader",
		RecipientRef: "recipient/history", RecipientSPIFFEID: "spiffe://readback.test/controller/history",
		TrustDomain: "readback.test", TrustRootsRef: "roots/readback", TrustBundleSHA256: "sha256:" + strings.Repeat("2", 64),
		VerifierProfileRef: "verifier/readback", NativeExecutableSHA256: "sha256:" + strings.Repeat("3", 64),
		TransportProfileRef: "owned-child-stdio-readback-v1",
		Limits:              servicebridge.Limits{HandshakeTimeoutMs: 3000, RecheckIntervalMs: 1000, MaxConnectionAgeMs: 30000, MaxConnections: 1, RequestTimeoutMs: 3000},
	}
}

func jsonBytes(t *testing.T, value any) []byte {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func rawFrame(raw []byte) []byte {
	frame := make([]byte, 4+len(raw))
	binary.BigEndian.PutUint32(frame, uint32(len(raw)))
	copy(frame[4:], raw)
	return frame
}

func TestProfileValidationIsPureAndPreservesExactInput(t *testing.T) {
	profile := profileValue()
	// A nonexistent socket is deliberate: this pre-admission parser must not
	// open a Workload API or confuse syntactic validity with registry admission.
	parsed, err := servicebridge.ValidateProfile(jsonBytes(t, profile))
	if err != nil {
		t.Fatal(err)
	}
	if parsed != profile {
		t.Fatal("profile parser changed exact configured values")
	}
}

func TestObservationProfileCannotBorrowOtherOperationPolicies(t *testing.T) {
	profile := profileValue()
	profile.OperationPolicy = "runtime-observation-read-v1"
	profile.TransportProfileRef = "owned-child-stdio-runtime-observation-v1"
	parsed, err := servicebridge.ValidateProfile(jsonBytes(t, profile))
	if err != nil || parsed != profile {
		t.Fatal("exact observation profile was not preserved")
	}
	for _, policy := range []string{"read-operation-only-v1", "initial-harness-bind-v1", "installation-gateway-startup-v1"} {
		changed := profile
		changed.OperationPolicy = policy
		if _, err := servicebridge.ValidateProfile(jsonBytes(t, changed)); err == nil {
			t.Fatalf("observation transport accepted policy %s", policy)
		}
	}
	if _, err := servicebridge.ValidateGatewayStartupClientProfile(jsonBytes(t, profile)); err == nil {
		t.Fatal("observation profile became a gateway startup client")
	}
}

func TestGatewayStartupProfileHasFixedClientAndServerSides(t *testing.T) {
	server := profileValue()
	server.OperationPolicy = "installation-gateway-startup-v1"
	server.TransportProfileRef = "owned-child-stdio-installation-gateway-startup-v1"
	client := server
	client.OwnSPIFFEID, client.PeerSPIFFEID = server.PeerSPIFFEID, server.OwnSPIFFEID
	for _, tc := range []struct {
		name    string
		profile servicebridge.Profile
		client  bool
		valid   bool
	}{
		{"server", server, false, true},
		{"client", client, true, true},
		{"client bytes in server entrypoint", client, false, false},
		{"server bytes in client entrypoint", server, true, false},
		{"readback is never a startup client", profileValue(), true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			parser := servicebridge.ValidateProfile
			if tc.client {
				parser = servicebridge.ValidateGatewayStartupClientProfile
			}
			parsed, err := parser(jsonBytes(t, tc.profile))
			if tc.valid && (err != nil || parsed != tc.profile) {
				t.Fatal("selected role changed or rejected")
			}
			if !tc.valid && err == nil {
				t.Fatal("unselected role admitted")
			}
		})
	}
	for _, policy := range []string{"read-operation-only-v1", "initial-harness-bind-v1"} {
		cross := server
		cross.OperationPolicy = policy
		if _, err := servicebridge.ValidateProfile(jsonBytes(t, cross)); err == nil {
			t.Fatal("cross-profile pair admitted")
		}
	}
}

func TestProfileRequiresExplicitInitialBindTransportPair(t *testing.T) {
	for _, test := range []struct {
		policy, transport string
		valid             bool
	}{
		{"read-operation-only-v1", "owned-child-stdio-readback-v1", true},
		{"initial-harness-bind-v1", "owned-child-stdio-initial-harness-bind-v1", true},
		{"initial-harness-bind-v1", "owned-child-stdio-readback-v1", false},
		{"read-operation-only-v1", "owned-child-stdio-initial-harness-bind-v1", false},
	} {
		t.Run(test.policy+"/"+test.transport, func(t *testing.T) {
			profile := profileValue()
			profile.OperationPolicy, profile.TransportProfileRef = test.policy, test.transport
			parsed, err := servicebridge.ValidateProfile(jsonBytes(t, profile))
			if test.valid {
				if err != nil || parsed != profile {
					t.Fatal("explicit supported profile changed or was rejected")
				}
			} else if err == nil {
				t.Fatal("cross-profile operation privilege was accepted")
			}
		})
	}
}

func TestProfileRejectsUnsupportedIdentitiesLimitsAndMappings(t *testing.T) {
	for _, test := range []struct {
		name   string
		change func(*servicebridge.Profile)
	}{
		{"schema version", func(p *servicebridge.Profile) { p.SchemaVersion = 2 }},
		{"mutation policy", func(p *servicebridge.Profile) { p.OperationPolicy = "bind" }},
		{"alternate transport", func(p *servicebridge.Profile) { p.TransportProfileRef = "forwarded-header" }},
		{"relative socket", func(p *servicebridge.Profile) { p.WorkloadAPISocketPath = "api.sock" }},
		{"unclean socket", func(p *servicebridge.Profile) { p.WorkloadAPISocketPath = "/tmp/../api.sock" }},
		{"nul socket", func(p *servicebridge.Profile) { p.WorkloadAPISocketPath = "/tmp/api\x00.sock" }},
		{"socket beyond actual Source limit", func(p *servicebridge.Profile) { p.WorkloadAPISocketPath = "/" + strings.Repeat("a", 103) }},
		{"socket outside canonical ASCII schema", func(p *servicebridge.Profile) { p.WorkloadAPISocketPath = "/tmp/λ.sock" }},
		{"wrong own scheme", func(p *servicebridge.Profile) { p.OwnSPIFFEID = "https://readback.test/controller/history" }},
		{"pathless own", func(p *servicebridge.Profile) {
			p.OwnSPIFFEID = "spiffe://readback.test"
			p.RecipientSPIFFEID = p.OwnSPIFFEID
		}},
		{"pathless peer", func(p *servicebridge.Profile) { p.PeerSPIFFEID = "spiffe://readback.test" }},
		{"cross trust domain", func(p *servicebridge.Profile) { p.PeerSPIFFEID = "spiffe://other.test/service/reader" }},
		{"peer beyond canonical schema limit", func(p *servicebridge.Profile) { p.PeerSPIFFEID = "spiffe://readback.test/" + strings.Repeat("a", 200) }},
		{"wrong trust domain", func(p *servicebridge.Profile) { p.TrustDomain = "other.test" }},
		{"wrong recipient", func(p *servicebridge.Profile) { p.RecipientSPIFFEID = p.PeerSPIFFEID }},
		{"malformed source digest", func(p *servicebridge.Profile) { p.SourceConfigurationDigest = strings.Repeat("1", 64) }},
		{"uppercase digest", func(p *servicebridge.Profile) { p.TrustBundleSHA256 = "sha256:" + strings.Repeat("A", 64) }},
		{"empty executable digest", func(p *servicebridge.Profile) { p.NativeExecutableSHA256 = "" }},
		{"empty recipient ref", func(p *servicebridge.Profile) { p.RecipientRef = "" }},
		{"unknown source ref", func(p *servicebridge.Profile) { p.SourceRef = "bad source" }},
		{"shorter handshake profile", func(p *servicebridge.Profile) { p.Limits.HandshakeTimeoutMs = 2999 }},
		{"longer request profile", func(p *servicebridge.Profile) { p.Limits.RequestTimeoutMs = 3001 }},
		{"zero poll", func(p *servicebridge.Profile) { p.Limits.RecheckIntervalMs = 0 }},
		{"longer connection age", func(p *servicebridge.Profile) { p.Limits.MaxConnectionAgeMs = 30001 }},
		{"additional connection", func(p *servicebridge.Profile) { p.Limits.MaxConnections = 2 }},
	} {
		t.Run(test.name, func(t *testing.T) {
			profile := profileValue()
			test.change(&profile)
			if _, err := servicebridge.ValidateProfile(jsonBytes(t, profile)); err == nil {
				t.Fatal("unsupported profile was accepted")
			}
		})
	}
}

func TestProfileRequiresClosedCaseSensitiveCompleteObjects(t *testing.T) {
	raw := jsonBytes(t, profileValue())
	for _, candidate := range [][]byte{
		[]byte("null"), []byte("[]"), []byte("{}"), append(bytes.Clone(raw), []byte(" {}")...),
		bytes.Replace(raw, []byte(`"schemaVersion":1`), []byte(`"schemaVersion":1,"schemaVersion":1`), 1),
		bytes.Replace(raw, []byte(`"schemaVersion":1`), []byte(`"schemaVersion":1,"\u0073chemaVersion":1`), 1),
		bytes.Replace(raw, []byte(`"schemaVersion":1`), []byte(`"SchemaVersion":1`), 1),
		bytes.Replace(raw, []byte(`"schemaVersion":1`), []byte(`"schemaVersion":null`), 1),
		bytes.Replace(raw, []byte(`"schemaVersion":1,`), nil, 1),
		bytes.Replace(raw, []byte(`"schemaVersion":1`), []byte(`"schemaVersion":1,"actorId":"caller-controlled"`), 1),
		bytes.Replace(raw, []byte(`"maxConnections":1`), []byte(`"MaxConnections":1`), 1),
		bytes.Replace(raw, []byte(`"maxConnections":1`), []byte(`"maxConnections":1,"extra":false`), 1),
		bytes.Replace(raw, []byte(`"maxConnections":1`), []byte(`"maxConnections":1.0`), 1),
		bytes.Replace(raw, []byte(`"maxConnections":1`), []byte(`"maxConnections":1e0`), 1),
	} {
		if bytes.Equal(raw, candidate) {
			t.Fatal("negative fixture did not change the valid profile")
		}
		if _, err := servicebridge.ValidateProfile(candidate); err == nil {
			t.Fatalf("ambiguous profile accepted: %s", candidate)
		}
	}
}

func TestFrameRoundTripPreservesOriginalBytesAndBoundaries(t *testing.T) {
	for _, raw := range [][]byte{
		[]byte(` { "operation" : {"requestRef":"original/request"} } `),
		[]byte(`{"integer":9007199254740991,"negative":-9007199254740991,"unicode":"λ"}`),
		[]byte(strings.Repeat("[", 32) + "0" + strings.Repeat("]", 32)),
		[]byte(`"` + strings.Repeat("a", servicebridge.MaxRequestBytes-2) + `"`),
	} {
		var output bytes.Buffer
		if err := servicebridge.WriteFrame(&output, raw, servicebridge.MaxRequestBytes); err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(output.Bytes(), rawFrame(raw)) {
			t.Fatal("writer reserialized original bytes or changed framing")
		}
		reader := bytes.NewReader(append(output.Bytes(), rawFrame([]byte(`{"next":1}`))...))
		got, err := servicebridge.ReadFrame(reader, servicebridge.MaxRequestBytes)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(got, raw) {
			t.Fatal("reader changed original request bytes")
		}
		next, err := servicebridge.ReadFrame(reader, servicebridge.MaxRequestBytes)
		if err != nil || string(next) != `{"next":1}` || reader.Len() != 0 {
			t.Fatal("frame reader consumed a following message")
		}
	}
}

func TestFrameRejectsMalformedOrAmbiguousJSON(t *testing.T) {
	for _, raw := range [][]byte{
		nil, []byte("{"), []byte("{} {}"), []byte(`{"x":1,"x":2}`), []byte(`{"x":1,"\u0078":2}`),
		[]byte(`{"nested":{"a":1,"a":1}}`), []byte(`{"n":1.0}`), []byte(`{"n":1e0}`), []byte(`{"n":-0}`),
		[]byte(`{"n":9007199254740992}`), []byte(`{"n":-9007199254740992}`),
		[]byte(strings.Repeat("[", 33) + "0" + strings.Repeat("]", 33)),
		{'"', 0xff, '"'},
	} {
		if _, err := servicebridge.ReadFrame(bytes.NewReader(rawFrame(raw)), servicebridge.MaxRequestBytes); err == nil {
			t.Fatalf("reader accepted invalid JSON: %q", raw)
		}
		var output bytes.Buffer
		if err := servicebridge.WriteFrame(&output, raw, servicebridge.MaxRequestBytes); err == nil {
			t.Fatalf("writer accepted invalid JSON: %q", raw)
		}
		if output.Len() != 0 {
			t.Fatal("invalid frame wrote bytes before rejection")
		}
	}
}

func TestReadFrameRejectsOversizeLengthBeforeReadingBody(t *testing.T) {
	for _, length := range []uint32{0, servicebridge.MaxRequestBytes + 1, ^uint32(0)} {
		var header [4]byte
		binary.BigEndian.PutUint32(header[:], length)
		reader := bytes.NewReader(append(header[:], []byte("body must remain unread")...))
		if _, err := servicebridge.ReadFrame(reader, servicebridge.MaxRequestBytes); err == nil {
			t.Fatal("invalid frame length accepted")
		}
		if reader.Len() != len("body must remain unread") {
			t.Fatal("reader consumed oversized body")
		}
	}
	for _, input := range [][]byte{{}, {0}, {0, 0, 0}, {0, 0, 0, 8, '{', '}'}} {
		if _, err := servicebridge.ReadFrame(bytes.NewReader(input), servicebridge.MaxRequestBytes); err == nil {
			t.Fatal("truncated frame accepted")
		}
	}
}

type shortWriter struct{ bytes.Buffer }

func (w *shortWriter) Write(raw []byte) (int, error) {
	if len(raw) > 2 {
		raw = raw[:2]
	}
	return w.Buffer.Write(raw)
}

type stalledWriter struct{}

func (stalledWriter) Write([]byte) (int, error) { return 0, nil }

func TestFrameWriterHandlesPartialWritesAndRejectsNoProgress(t *testing.T) {
	raw := []byte(`{"result":"bounded"}`)
	var output shortWriter
	if err := servicebridge.WriteFrame(&output, raw, servicebridge.MaxFrameBytes); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(output.Bytes(), rawFrame(raw)) {
		t.Fatal("partial writes corrupted the frame")
	}
	if err := servicebridge.WriteFrame(stalledWriter{}, raw, servicebridge.MaxFrameBytes); err != io.ErrShortWrite {
		t.Fatal("zero-progress writer did not stop")
	}
	var rejected bytes.Buffer
	if err := servicebridge.WriteFrame(&rejected, []byte(`"`+strings.Repeat("x", servicebridge.MaxRequestBytes)+`"`), servicebridge.MaxRequestBytes); err == nil || rejected.Len() != 0 {
		t.Fatal("writer emitted an oversized frame")
	}
}
