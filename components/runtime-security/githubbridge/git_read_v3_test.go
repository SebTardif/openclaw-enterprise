package githubbridge

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"testing"
	"time"

	"github.com/openclaw/openclaw-enterprise/components/runtime-security/servicepeer"
)

func gitVectors(t *testing.T) []map[string]any {
	t.Helper()
	raw, err := os.ReadFile("testdata/git-read-v3-vectors.json")
	must(t, err)
	var value struct {
		Vectors []struct {
			Open      map[string]any `json:"open_read"`
			Canonical string         `json:"canonical_request_utf8"`
			Body      string         `json:"body_utf8"`
		} `json:"vectors"`
	}
	must(t, json.Unmarshal(raw, &value))
	result := []map[string]any{}
	for _, v := range value.Vectors {
		if digest([]byte(v.Canonical)) != v.Open["request_sha256"] || digest([]byte(v.Body)) != v.Open["body_sha256"] || len(v.Body) != int(v.Open["body_bytes"].(float64)) {
			t.Fatal("frozen representation vector differs")
		}
		result = append(result, v.Open)
	}
	return result
}

func TestGitReadV3ClosedVectorsAndPinnedVersion(t *testing.T) {
	for _, v := range gitVectors(t) {
		state := wireState{version: 3}
		request, err := state.request(marshal(t, v))
		must(t, err)
		refusal := map[string]any{"version": 3, "sequence": 1, "request_ref": v["request_ref"], "ok": false, "code": "unavailable"}
		must(t, state.reply(request, marshal(t, refusal), nil))
		v2 := wireState{}
		if _, err := v2.request(marshal(t, v)); err == nil {
			t.Fatal("v2 accepted Git v3 open")
		}
	}
	base := gitVectors(t)[0]
	for _, modify := range []func(map[string]any){
		func(v map[string]any) { v["version"] = 2 },
		func(v map[string]any) { v["body_bytes"] = 1 },
		func(v map[string]any) { v["body_bytes"] = 4194305 },
		func(v map[string]any) { v["body_sha256"] = digest([]byte("different")) },
		func(v map[string]any) { v["request_sha256"] = digest([]byte("different")) },
		func(v map[string]any) { v["git_operation"] = "receive-pack" },
		func(v map[string]any) { v["git_protocol"] = "version=1" },
		func(v map[string]any) { v["repository_name"] = "project/other" },
		func(v map[string]any) { v["body"] = "not a wire field" },
		func(v map[string]any) { delete(v, "body_bytes") },
	} {
		v := map[string]any{}
		for k, x := range base {
			v[k] = x
		}
		modify(v)
		state := wireState{version: 3}
		if _, err := state.request(marshal(t, v)); err == nil {
			t.Fatal("invalid Git open accepted")
		}
	}
	// Representation-only opened data exercises native correspondence; it does
	// not supply original Work, a credential release, or repository authorization.
	state := wireState{version: 3}
	request, err := state.request(marshal(t, base))
	must(t, err)
	reply := opened(t, base)
	reply["version"] = 3
	wrong := map[string]any{"version": 2, "sequence": 1, "request_ref": base["request_ref"], "ok": false, "code": "unavailable"}
	if state.reply(request, marshal(t, wrong), nil) == nil {
		t.Fatal("cross-version reply accepted")
	}
	must(t, state.reply(request, marshal(t, reply), nil))
	dispatch := map[string]any{}
	for _, k := range []string{"version", "request_ref", "session_ref", "effect_ref", "work_binding_sha256", "request_sha256", "dns_binding_ref", "upstream_ipv4"} {
		dispatch[k] = reply[k]
	}
	dispatch["method"] = "dispatch-read"
	dispatch["sequence"] = 2
	dispatch["peer_certificate_sha256"] = digest([]byte("leaf"))
	dispatch["version"] = 2
	if _, err := state.request(marshal(t, dispatch)); err == nil {
		t.Fatal("later frame changed version")
	}
	dispatch["version"] = 3
	_, err = state.request(marshal(t, dispatch))
	must(t, err)
}

func TestGitReadV3ProtectedProfileSelection(t *testing.T) {
	p := Profile{Version: 1, WorkloadAPISocketPath: "/protected/api", OwnSPIFFEID: serverID, PeerSPIFFEID: clientID, RecipientSPIFFEID: serverID, TrustBundleSHA256: digest(nil), ListenPath: "/protected/broker", TrustedAncestorUIDs: []uint32{0}, HandshakeTimeoutMs: 1000, RecheckIntervalMs: 100, MaxConnectionAgeMs: 10000, RequestTimeoutMs: 1000}
	raw := marshal(t, p)
	selected, err := ValidateProfile(raw)
	must(t, err)
	if selected.wireVersion() != 2 || selected.applicationProtocol() != ApplicationProtocol {
		t.Fatal("default changed")
	}
	for _, key := range []string{"Protocol_version", "PROTOCOL_VERSION", "application_protocol"} {
		var v map[string]any
		must(t, json.Unmarshal(raw, &v))
		v[key] = 3
		if _, err := ValidateProfile(marshal(t, v)); err == nil {
			t.Fatal("profile accepted an alternate selector field")
		}
	}
	for _, value := range []any{3, 2, 0, 4, nil, "3", true} {
		var v map[string]any
		must(t, json.Unmarshal(raw, &v))
		v["protocol_version"] = value
		selected, err = ValidateProfile(marshal(t, v))
		if value == 3 {
			must(t, err)
			if selected.wireVersion() != 3 || selected.applicationProtocol() != GitReadApplicationProtocol {
				t.Fatal("v3 selection changed")
			}
		} else if err == nil {
			t.Fatal("noncanonical protocol selector accepted")
		}
	}
}

func TestActualGitReadV3MutualTLSRefusalAndCurrentness(t *testing.T) {
	for _, request := range gitVectors(t) {
		t.Run(request["git_operation"].(string), func(t *testing.T) {
			h := harness(t, func(p *Profile) { p.ProtocolVersion = 3 })
			c := h.connect(t)
			event := sendRequest(t, h, c, request)
			view := h.inspect(t, event)
			if !view.Valid || view.OwnSPIFFEID != serverID || view.PeerSPIFFEID != clientID {
				t.Fatal("v3 actual Source/TLS not current")
			}
			// A parent refusal exercises transport submission only; no operation owner
			// or positive Work/State authority is substituted by this fixture.
			raw := marshal(t, map[string]any{"version": 3, "sequence": 1, "request_ref": request["request_ref"], "ok": false, "code": "unavailable"})
			h.command(t, event, "reply", "", raw, nil)
			readReply(t, c, raw, nil)
			ackWritten(t, h, event)
			if h.next(t).Kind != "closed" {
				t.Fatal("refused session remained open")
			}
			next := h.connect(t)
			fresh := sendRequest(t, h, next, request)
			if fresh.ConnectionID == event.ConnectionID || !h.inspect(t, fresh).Valid {
				t.Fatal("new v3 session did not authenticate independently")
			}
			h.serverAPI.Stop()
			var b [1]byte
			if _, err := next.Read(b[:]); err == nil {
				t.Fatal("withdrawn identity stayed usable")
			}
		})
	}
}

func TestActualGitReadV3RejectsCrossedALPNAndWire(t *testing.T) {
	for _, selected := range []int{0, 3} {
		t.Run(map[int]string{0: "v2", 3: "v3"}[selected], func(t *testing.T) {
			h := harness(t, func(p *Profile) { p.ProtocolVersion = selected })
			other := GitReadApplicationProtocol
			if selected == 3 {
				other = ApplicationProtocol
			}
			tr, err := servicepeer.New(h.clientSource, servicepeer.Config{Side: servicepeer.Client, OwnSPIFFEID: clientID, PeerSPIFFEID: serverID, RecipientSPIFFEID: serverID, ApplicationProtocol: other, HandshakeTimeout: time.Second, RecheckInterval: 25 * time.Millisecond, MaxConnectionAge: 10 * time.Second, MaxConnections: 1})
			must(t, err)
			defer tr.Close()
			raw, err := net.Dial("unix", h.profile.ListenPath)
			must(t, err)
			c, err := tr.Handshake(context.Background(), raw)
			if c != nil {
				c.Close()
			}
			if err == nil {
				t.Fatal("crossed ALPN accepted")
			}
			// Exact admitted ALPN cannot be relabeled by caller metadata.
			good := h.connect(t)
			request := gitVectors(t)[0]
			if selected == 3 {
				request = openRequest()
			}
			must(t, WriteFrame(good, &Frame{Metadata: marshal(t, request)}))
			var b [1]byte
			if _, err = good.Read(b[:]); err == nil {
				t.Fatal("crossed wire version accepted")
			}
			event := h.next(t)
			if event.Kind != "closed" {
				t.Fatal("crossed wire reached parent request handling")
			}
		})
	}
}
