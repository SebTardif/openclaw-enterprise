package nodeobserver

import (
	"bytes"
	"context"
	"strings"
	"testing"
	"time"

	"github.com/openclaw/openclaw-enterprise/components/runtime-security/servicebridge"
)

func testEnrollment() Enrollment {
	return Enrollment{SchemaVersion: 1, SourceRef: "source/node", Version: 1, ClusterRef: "cluster/test", NodeName: "node-test", NodeUID: "node-uid", Namespace: "test", WorkloadSocket: "/run/identity/socket", OwnSPIFFEID: serverID, PeerSPIFFEID: clientID, TrustBundleDigest: "sha256:" + strings.Repeat("1", 64), Address: "127.0.0.1:31001", CRIPath: "/run/containerd/containerd.sock", RuntimeRoot: "/run/runsc", RunscPath: "/opt/runsc", RunscDigest: "sha256:" + strings.Repeat("2", 64), SentryDigest: "sha256:" + strings.Repeat("3", 64), KubernetesURL: "https://127.0.0.1:6443", KubernetesCAPath: "/etc/node/ca", KubernetesTokenPath: "/etc/node/token"}
}
func testRequest() Request {
	return Request{SchemaVersion: 1, Method: "capture-execution", RequestRef: "request/test", SourceRef: "source/node", SourceVersion: 1, ClusterRef: "cluster/test", NodeUID: "node-uid", Namespace: "test", PodName: "harness", PodUID: "pod-uid", Deadline: time.Now().Add(2 * time.Second).UTC().Format(time.RFC3339Nano)}
}

func TestClosedRequestAndEnrollment(t *testing.T) {
	_, err := ParseEnrollment(encoded(testEnrollment()))
	must(t, err)
	raw := encoded(testRequest())
	_, err = ParseRequest(raw)
	must(t, err)
	for _, bad := range [][]byte{bytes.Replace(raw, []byte(`"schemaVersion":1`), []byte(`"schemaVersion":1,"schemaVersion":1`), 1), bytes.Replace(raw, []byte(`"schemaVersion":1`), []byte(`"SchemaVersion":1`), 1), bytes.Replace(raw, []byte(`"sourceVersion":1`), []byte(`"sourceVersion":1.0`), 1), bytes.Replace(raw, []byte(`"nodeUID":"node-uid"`), []byte(`"nodeUID":null`), 1), append(bytes.Clone(raw), []byte(`{}`)...)} {
		if _, err := ParseRequest(bad); err == nil {
			t.Fatalf("accepted malformed request %q", bad)
		}
	}
	offset := testRequest()
	offset.Deadline = time.Now().Add(time.Second).In(time.FixedZone("offset", 3600)).Format(time.RFC3339Nano)
	_, err = ParseRequest(encoded(offset))
	requireError(t, err)
	e := testEnrollment()
	e.CRIPath = "/run/../arbitrary"
	_, err = ParseEnrollment(encoded(e))
	requireError(t, err)
}

func TestOriginalTLSRequestHasExactSourceCustody(t *testing.T) {
	f := newPairFixture(t, nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	client, server := connectedPair(t, f, ctx)
	defer client.Close()
	defer server.Close()
	e := testEnrollment()
	view, err := f.server.source.TrustView()
	must(t, err)
	e.TrustBundleDigest = view.BundleSHA256
	raw := encoded(testRequest())
	sent := make(chan error, 1)
	go func() { sent <- servicebridge.WriteFrame(client, raw, MaxBytes) }()
	original, err := receive(server, f.server.source, e)
	must(t, err)
	must(t, <-sent)
	must(t, original.current())
	if original.digest != hash(raw) || !bytes.Equal(raw, original.raw) {
		t.Fatal("lost original bytes")
	}
	// A copied diagnostic record cannot prolong the original TLS source. The
	// actual context cancellation revokes the retained request handle itself.
	cancel()
	eventually(t, func() bool { return original.current() != nil })
}

func TestAuthenticatedRequestsCannotSelectAnotherNodeOrPolicy(t *testing.T) {
	for _, kind := range []string{"method", "node", "version", "namespace", "deadline", "extra-path"} {
		t.Run(kind, func(t *testing.T) {
			f := newPairFixture(t, nil)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			client, server := connectedPair(t, f, ctx)
			defer client.Close()
			defer server.Close()
			r := testRequest()
			switch kind {
			case "method":
				r.Method = "bind"
			case "node":
				r.NodeUID = "other"
			case "version":
				r.SourceVersion++
			case "namespace":
				r.Namespace = "other"
			case "deadline":
				r.Deadline = time.Now().Add(-time.Second).UTC().Format(time.RFC3339Nano)
			}
			raw := encoded(r)
			if kind == "extra-path" {
				raw = bytes.Replace(raw, []byte(`"schemaVersion":1`), []byte(`"schemaVersion":1,"criPath":"/other/socket"`), 1)
			}
			sent := make(chan error, 1)
			go func() { sent <- servicebridge.WriteFrame(client, raw, MaxBytes) }()
			e := testEnrollment()
			view, err := f.server.source.TrustView()
			must(t, err)
			e.TrustBundleDigest = view.BundleSHA256
			_, err = receive(server, f.server.source, e)
			requireError(t, err)
			must(t, <-sent)
		})
	}
}

func TestSourceWithdrawalInvalidatesOriginalRequest(t *testing.T) {
	f := newPairFixture(t, nil)
	client, server := connectedPair(t, f, context.Background())
	defer client.Close()
	defer server.Close()
	e := testEnrollment()
	view, err := f.server.source.TrustView()
	must(t, err)
	e.TrustBundleDigest = view.BundleSHA256
	sent := make(chan error, 1)
	go func() { sent <- servicebridge.WriteFrame(client, encoded(testRequest()), MaxBytes) }()
	original, err := receive(server, f.server.source, e)
	must(t, err)
	must(t, <-sent)
	must(t, original.current())
	f.server.source.Close()
	requireError(t, original.current())
}
