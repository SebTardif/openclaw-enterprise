package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"io"
	"math/big"
	"net"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/spiffe/go-spiffe/v2/proto/spiffe/workload"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/stats"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
)

// These generated certificates and injected protobuf/stat events are synthetic
// unit inputs. No test in this file establishes SPIRE issuance or real peer facts.
func syntheticEntry(t *testing.T, id string) *workload.X509SVID {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal("synthetic key generation failed")
	}
	uri, err := url.Parse(id)
	if err != nil {
		t.Fatal("synthetic URI invalid")
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1), URIs: []*url.URL{uri},
		NotBefore: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), NotAfter: time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC),
		KeyUsage: x509.KeyUsageDigitalSignature,
	}
	cert, err := x509.CreateCertificate(rand.Reader, template, template, public, private)
	if err != nil {
		t.Fatal("synthetic certificate generation failed")
	}
	key, err := x509.MarshalPKCS8PrivateKey(private)
	if err != nil {
		t.Fatal("synthetic key encoding failed")
	}
	return &workload.X509SVID{SpiffeId: id, X509Svid: cert, X509SvidKey: key, Bundle: cert}
}

func TestCompleteProjectionAndExactSet(t *testing.T) {
	a := syntheticEntry(t, "spiffe://fixture.test/a")
	b := syntheticEntry(t, "spiffe://fixture.test/b")
	response := &workload.X509SVIDResponse{Svids: []*workload.X509SVID{b, a}}
	original := proto.Clone(response)
	p, err := inspectResponse(response)
	if err != nil {
		t.Fatal("valid synthetic response rejected")
	}
	if p.EntryCount != 2 || len(p.Identities) != 2 || p.Identities[0].SPIFFEID != a.SpiffeId || p.Identities[1].SPIFFEID != b.SpiffeId {
		t.Fatal("full sorted identity set lost")
	}
	if exactSingleton(p, a.SpiffeId) {
		t.Fatal("extra valid identity was filtered into a match")
	}
	if !proto.Equal(original, response) {
		t.Fatal("observer mutated the actual response")
	}
	one, err := inspectResponse(&workload.X509SVIDResponse{Svids: []*workload.X509SVID{a}})
	if err != nil || !exactSingleton(one, a.SpiffeId) || exactSingleton(one, b.SpiffeId) {
		t.Fatal("exact singleton comparison failed")
	}
	if one.Identities[0].CertificateSHA256 != digest(a.X509Svid) || one.Identities[0].NotBefore != "2026-01-01T00:00:00Z" {
		t.Fatal("public certificate projection incorrect")
	}
	var output bytes.Buffer
	if err := emit(&output, time.Now(), newObserver(), record{Event: "delivered", projection: one}); err != nil {
		t.Fatal("metadata encode failed")
	}
	var data map[string]json.RawMessage
	if json.Unmarshal(output.Bytes(), &data) != nil || data["identities"] == nil {
		t.Fatal("identity metadata missing from output")
	}
	for _, forbidden := range []string{"X509SvidKey", "x509SvidKey", "privateKey", "BEGIN CERTIFICATE", "BEGIN PRIVATE KEY"} {
		if strings.Contains(output.String(), forbidden) {
			t.Fatal("credential field leaked")
		}
	}
}

func TestWholeResponseRejectsInvalidInputs(t *testing.T) {
	base := syntheticEntry(t, "spiffe://fixture.test/a")
	clone := func() *workload.X509SVID { return proto.Clone(base).(*workload.X509SVID) }
	cases := map[string]func() *workload.X509SVIDResponse{
		"empty":     func() *workload.X509SVIDResponse { return &workload.X509SVIDResponse{} },
		"nil-entry": func() *workload.X509SVIDResponse { return &workload.X509SVIDResponse{Svids: []*workload.X509SVID{nil}} },
		"duplicate": func() *workload.X509SVIDResponse {
			return &workload.X509SVIDResponse{Svids: []*workload.X509SVID{clone(), clone()}}
		},
		"hint": func() *workload.X509SVIDResponse {
			x := clone()
			x.Hint = "unapproved"
			return &workload.X509SVIDResponse{Svids: []*workload.X509SVID{x}}
		},
		"wire-id-mismatch": func() *workload.X509SVIDResponse {
			x := clone()
			x.SpiffeId = "spiffe://fixture.test/b"
			return &workload.X509SVIDResponse{Svids: []*workload.X509SVID{x}}
		},
		"bad-cert": func() *workload.X509SVIDResponse {
			x := clone()
			x.X509Svid = []byte("PRIVATE SENTINEL")
			return &workload.X509SVIDResponse{Svids: []*workload.X509SVID{x}}
		},
		"bad-key": func() *workload.X509SVIDResponse {
			x := clone()
			x.X509SvidKey = []byte("PRIVATE SENTINEL")
			return &workload.X509SVIDResponse{Svids: []*workload.X509SVID{x}}
		},
		"bad-bundle": func() *workload.X509SVIDResponse {
			x := clone()
			x.Bundle = []byte("PRIVATE SENTINEL")
			return &workload.X509SVIDResponse{Svids: []*workload.X509SVID{x}}
		},
		"entry-overflow": func() *workload.X509SVIDResponse {
			return &workload.X509SVIDResponse{Svids: []*workload.X509SVID{clone(), clone(), clone(), clone(), clone()}}
		},
		"bundle-overflow": func() *workload.X509SVIDResponse {
			return &workload.X509SVIDResponse{Svids: []*workload.X509SVID{clone()}, FederatedBundles: map[string][]byte{"spiffe://b.test": base.Bundle, "spiffe://c.test": base.Bundle, "spiffe://d.test": base.Bundle, "spiffe://e.test": base.Bundle}}
		},
		"authority-overflow": func() *workload.X509SVIDResponse {
			x := clone()
			x.Bundle = bytes.Repeat(base.Bundle, maxAuthorities+1)
			return &workload.X509SVIDResponse{Svids: []*workload.X509SVID{x}}
		},
		"message-overflow": func() *workload.X509SVIDResponse {
			x := clone()
			x.X509SvidKey = make([]byte, maxResponseBytes)
			return &workload.X509SVIDResponse{Svids: []*workload.X509SVID{x}}
		},
		"crl-profile": func() *workload.X509SVIDResponse {
			return &workload.X509SVIDResponse{Svids: []*workload.X509SVID{clone()}, Crl: [][]byte{{1}}}
		},
	}
	for name, makeResponse := range cases {
		t.Run(name, func(t *testing.T) {
			p, err := inspectResponse(makeResponse())
			if err == nil || len(p.Identities) != 0 {
				t.Fatal("invalid response accepted or partially projected")
			}
			if strings.Contains(err.Error(), "PRIVATE SENTINEL") {
				t.Fatal("raw parse error leaked")
			}
		})
	}
}

// The fake transport supplies protobuf input only. The production RecvMsg
// wrapper and parser decide acceptance before any SDK hint selection can occur.
type syntheticStream struct {
	grpc.ClientStream
	response *workload.X509SVIDResponse
}

func (s syntheticStream) RecvMsg(value any) error {
	proto.Merge(value.(proto.Message), s.response)
	return nil
}
func TestRecvObserverRejectsHintedSecondEntryBeforeSelection(t *testing.T) {
	a := syntheticEntry(t, "spiffe://fixture.test/a")
	b := syntheticEntry(t, "spiffe://fixture.test/b")
	a.Hint = "same"
	b.Hint = "same"
	o := newObserver()
	s := &observedStream{ClientStream: syntheticStream{response: &workload.X509SVIDResponse{Svids: []*workload.X509SVID{a, b}}}, owner: o, phase: 2}
	if s.RecvMsg(&workload.X509SVIDResponse{}) == nil {
		t.Fatal("hinted response reached SDK selection")
	}
	_, rpc, failure := o.snapshot()
	if failure == "" || rpc[1].Responses != 1 || len(o.positive.Identities) != 0 {
		t.Fatal("invalid reception was not recorded as failed")
	}
}

func rpcContext(phase int) context.Context {
	return context.WithValue(context.Background(), phaseKey{}, phase)
}
func syntheticDeniedObserver() *observer {
	o := newObserver()
	o.connection.DialAttempts = 1
	o.socketsOpened = 1
	o.HandleConn(context.Background(), &stats.ConnBegin{Client: true})
	o.HandleRPC(rpcContext(1), &stats.Begin{Client: true})
	o.HandleRPC(rpcContext(1), &stats.End{Client: true, Error: status.Error(codes.PermissionDenied, "PRIVATE SENTINEL")})
	return o
}
func TestConnectionAndAttemptGuards(t *testing.T) {
	t.Run("closed-before-delivery", func(t *testing.T) {
		o := syntheticDeniedObserver()
		if !o.live(1) {
			t.Fatal("valid denied accounting rejected")
		}
		o.HandleConn(context.Background(), &stats.ConnEnd{Client: true})
		if o.live(1) {
			t.Fatal("lost connection still considered correlated")
		}
	})
	t.Run("second-dial-never-opens", func(t *testing.T) {
		o := syntheticDeniedObserver()
		conn, err := o.dial(context.Background(), "/unreachable-fixture-socket")
		if conn != nil || err != reason("dial-extra") {
			t.Fatal("second dial was admitted")
		}
		counts, _, failure := o.snapshot()
		if counts.DialAttempts != 2 || failure != reason("dial-extra") {
			t.Fatal("extra attempt not preserved")
		}
	})
	t.Run("transparent-retry", func(t *testing.T) {
		o := syntheticDeniedObserver()
		o.HandleRPC(rpcContext(2), &stats.Begin{Client: true, IsTransparentRetryAttempt: true})
		if _, _, failure := o.snapshot(); failure != reason("rpc-extra-attempt") {
			t.Fatal("transparent attempt accepted")
		}
	})
	t.Run("repeated-attempt", func(t *testing.T) {
		o := syntheticDeniedObserver()
		o.HandleRPC(rpcContext(1), &stats.Begin{Client: true})
		if _, _, failure := o.snapshot(); failure != reason("rpc-extra-attempt") {
			t.Fatal("extra attempt accepted")
		}
	})
}

func TestSuccessfulFetchRequiresCanceledStreamEndSeparately(t *testing.T) {
	o := syntheticDeniedObserver()
	o.HandleRPC(rpcContext(2), &stats.Begin{Client: true})
	o.mu.Lock()
	o.rpcs[1].Responses = 1
	o.mu.Unlock()
	if o.live(2) {
		t.Fatal("received message alone passed before stream settlement")
	}
	o.HandleRPC(rpcContext(2), &stats.End{Client: true, Error: status.Error(codes.Canceled, "PRIVATE SENTINEL")})
	if !o.live(2) {
		t.Fatal("expected cancellation mislabeled as failed issuance")
	}
	var output bytes.Buffer
	if emit(&output, time.Now(), o, record{Event: "delivered", FetchReturned: true, StreamEndCode: "Canceled", LocalStreamCancellation: true}) != nil {
		t.Fatal("encode failed")
	}
	if strings.Contains(output.String(), "PRIVATE SENTINEL") || !strings.Contains(output.String(), `"streamEndCode":"Canceled"`) {
		t.Fatal("stream status privacy or projection incorrect")
	}
}

func TestBoundedControlAndCancellationJoin(t *testing.T) {
	for _, input := range []string{"continue\n", "", "continue", "continue\nextra", "continue\ncontinue\n", strings.Repeat("x", 33)} {
		settled, err := readControl(context.Background(), io.NopCloser(strings.NewReader(input)))
		if !settled || (err == nil) != (input == "continue\n") {
			t.Fatal("control framing outcome incorrect")
		}
	}
	reader, writer := io.Pipe()
	defer writer.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	settled, err := readControl(ctx, reader)
	if !settled || err == nil {
		t.Fatal("cancelled reader did not join")
	}
	if _, err := writer.Write([]byte("late")); err == nil {
		t.Fatal("cancelled input remained open")
	}
}

func TestExplicitFlagsOnly(t *testing.T) {
	if _, err := parseFlags([]string{"--socket-path", "/run/fixture/api.sock", "--expected-id", "spiffe://fixture.test/a"}); err != nil {
		t.Fatal("explicit generic input rejected")
	}
	for _, args := range [][]string{nil, {"--socket-path", "relative", "--expected-id", "spiffe://fixture.test/a"}, {"--socket-path", "/run/a.sock", "--expected-id", "spiffe://fixture.test"}, {"--socket-path", "/run/a.sock", "--expected-id", "not-an-id"}} {
		if _, err := parseFlags(args); err == nil {
			t.Fatal("missing or malformed explicit input accepted")
		}
	}
}

func TestOwnedSocketAndDialMustSettleBeforeClosed(t *testing.T) {
	o := newObserver()
	o.dialsInFlight = 1
	if o.settled() {
		t.Fatal("active dial falsely settled")
	}
	o.dialsInFlight = 0
	left, right := net.Pipe()
	defer right.Close()
	o.socketsOpened = 1
	conn := &ownedConn{Conn: left, owner: o}
	if o.settled() {
		t.Fatal("open owned socket falsely settled")
	}
	if conn.Close() != nil || conn.Close() != nil || !o.settled() || o.socketsClosed != 1 {
		t.Fatal("socket close not settled exactly once")
	}
}
