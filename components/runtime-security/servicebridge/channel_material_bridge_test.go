package servicebridge

import (
	"encoding/json"
	"strings"
	"testing"
)

func materialSyntheticProfile() Profile {
	d := "sha256:" + strings.Repeat("a", 64)
	return Profile{SchemaVersion: 1, OperationPolicy: materialPolicy, TransportProfileRef: materialTransport,
		SourceRef: "synthetic/source", SourceConfigurationDigest: d, WorkloadAPISocketPath: "/nonexistent-material-fixture/api.sock",
		OwnSPIFFEID: "spiffe://material.test/controller", PeerSPIFFEID: "spiffe://material.test/gateway",
		RecipientSPIFFEID: "spiffe://material.test/controller", RecipientRef: "synthetic/controller", TrustDomain: "material.test",
		TrustRootsRef: "synthetic/roots", TrustBundleSHA256: d, VerifierProfileRef: "synthetic/verifier", NativeExecutableSHA256: d,
		Limits: Limits{HandshakeTimeoutMs: 3000, RecheckIntervalMs: 1000, MaxConnectionAgeMs: 5000, MaxConnections: 1, RequestTimeoutMs: 5000}}
}
func materialJSON(t *testing.T, value any) []byte {
	t.Helper()
	b, e := json.Marshal(value)
	if e != nil {
		t.Fatal(e)
	}
	return b
}

func TestMaterialProfilesUseDedicatedFixedSidesWithoutOpeningSource(t *testing.T) {
	server := materialSyntheticProfile()
	client := server
	client.OwnSPIFFEID, client.PeerSPIFFEID = server.PeerSPIFFEID, server.OwnSPIFFEID
	for _, entry := range []struct {
		profile Profile
		client  bool
		valid   bool
	}{{server, false, true}, {client, true, true}, {server, true, false}, {client, false, false}} {
		p, e := validateMaterialProfile(materialJSON(t, entry.profile), entry.client)
		if entry.valid && (e != nil || p != entry.profile) {
			t.Fatal("fixed selected side rejected or changed")
		}
		if !entry.valid && e == nil {
			t.Fatal("wrong side accepted")
		}
	}
	if _, e := ValidateProfile(materialJSON(t, server)); e == nil {
		t.Fatal("old profile parser accepted material")
	}
	if _, e := ValidateGatewayStartupClientProfile(materialJSON(t, client)); e == nil {
		t.Fatal("old startup client accepted material")
	}
	for _, policy := range []string{"read-operation-only-v1", "initial-harness-bind-v1", gatewayStartupPolicy} {
		p := server
		p.OperationPolicy = policy
		if _, e := ValidateChannelMaterialServerProfile(materialJSON(t, p)); e == nil {
			t.Fatal("cross-profile accepted")
		}
	}
	p := server
	p.Limits.MaxConnectionAgeMs = 30000
	if _, e := ValidateChannelMaterialServerProfile(materialJSON(t, p)); e == nil {
		t.Fatal("lifetime renewed")
	}
}

func TestMaterialEnvelopeAndReplyAreExactDataCorrespondenceOnly(t *testing.T) {
	request := json.RawMessage(`{"purpose":"read-selected-channel-material","use":"startup-slack-pair"}`)
	body := materialRequestBody{RequestRef: "synthetic/request", Request: request}
	e := materialEnvelope{SchemaVersion: 1, Sequence: 1, ConnectionID: strings.Repeat("1", 32), ExchangeID: strings.Repeat("2", 32), Challenge: strings.Repeat("3", 32), RequestDigest: digest(request), Deadline: "2026-09-07T00:00:00.000Z", Message: materialJSON(t, body)}
	if !materialCall(e) {
		t.Fatal("transport envelope")
	}
	b, use, err := materialRequestValue(e)
	if err != nil || b.RequestRef != body.RequestRef || use != "startup-slack-pair" {
		t.Fatal("transport-only discriminator")
	}
	header := materialDeliveryHeader{SchemaVersion: 1, Purpose: materialPurpose, Use: use, RequestRef: body.RequestRef, Kind: "selected-bundle"}
	reply := e
	reply.Message = materialJSON(t, header)
	f := &materialFrame{kind: materialResult, payload: []byte{7}}
	if !materialReply(f, reply, e, body, use) {
		t.Fatal("matching synthetic response")
	}
	for _, mutate := range []func(*materialEnvelope){func(x *materialEnvelope) { x.Sequence++ }, func(x *materialEnvelope) { x.ConnectionID = strings.Repeat("4", 32) }, func(x *materialEnvelope) { x.RequestDigest = "sha256:" + strings.Repeat("b", 64) }, func(x *materialEnvelope) { x.Deadline = "2026-09-07T00:00:01.000Z" }, func(x *materialEnvelope) { x.Challenge = strings.Repeat("5", 32) }} {
		x := reply
		mutate(&x)
		if materialReply(f, x, e, body, use) {
			t.Fatal("changed original envelope accepted")
		}
	}
	header.Kind = "denied"
	reply.Message = materialJSON(t, header)
	if materialReply(f, reply, e, body, use) {
		t.Fatal("denial carried material")
	}
	f.payload = nil
	if !materialReply(f, reply, e, body, use) {
		t.Fatal("empty fixed denial")
	}
}

func TestMaterialEntrypointsRejectAbsentOriginalOwnedPipes(t *testing.T) {
	if RunChannelMaterialServer(nil, nil, nil) == nil || RunChannelMaterialClient(nil, nil, nil) == nil {
		t.Fatal("absent owner accepted")
	}
}
