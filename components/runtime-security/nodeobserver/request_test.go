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

func testNetworkRequest() NetworkRequest {
	request := testRequest()
	request.RequestRef = "request/network:original"
	return NetworkRequest{SchemaVersion: 1, Method: "capture-network", Execution: request, NetworkName: "pods", InterfaceName: "eth0"}
}

func TestNetworkRequestIsClosedAndDistinctFromExecution(t *testing.T) {
	request := testNetworkRequest()
	raw := encoded(request)
	actual, network, err := parseCaptureRequest(raw)
	must(t, err)
	if network == nil || actual != request.Execution || *network != request {
		t.Fatal("network request lost original execution correspondence")
	}
	_, err = ParseRequest(raw)
	requireError(t, err)
	for _, bad := range [][]byte{
		bytes.Replace(raw, []byte(`"networkName":"pods"`), []byte(`"networkName":"../pods"`), 1),
		bytes.Replace(raw, []byte(`"interfaceName":"eth0"`), []byte(`"interfaceName":null`), 1),
		bytes.Replace(raw, []byte(`"method":"capture-network"`), []byte(`"method":"capture-network","method":"capture-network"`), 1),
		bytes.Replace(raw, []byte(`"networkName":"pods"`), []byte(`"networkName":"pods","namespaceFD":4`), 1),
		bytes.Replace(raw, []byte(`"sourceVersion":1`), []byte(`"sourceVersion":1.0`), 1),
	} {
		if _, _, err := parseCaptureRequest(bad); err == nil {
			t.Fatalf("accepted altered network request: %s", bad)
		}
	}
}

func TestOriginalNetworkRequestUsesActualTLSAndWithdrawal(t *testing.T) {
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
	raw := encoded(testNetworkRequest())
	sent := make(chan error, 1)
	go func() { sent <- servicebridge.WriteFrame(client, raw, MaxBytes) }()
	original, err := receive(server, f.server.source, e)
	must(t, err)
	must(t, <-sent)
	if original.network == nil || original.request != original.network.Execution || original.digest != hash(raw) || !bytes.Equal(original.raw, raw) {
		t.Fatal("TLS receiver detached the network operation from its original request")
	}
	must(t, original.current())
	// The real controlled SPIFFE source is withdrawn. A retained network selector
	// does not keep the authenticated request alive or mint any attachment handle.
	f.server.source.Close()
	requireError(t, original.current())
}

func TestNetworkRecordPreservesNativeIntegersAndExactOriginalBytes(t *testing.T) {
	request := testNetworkRequest()
	requestDigest, enrollmentDigest := hash(encoded(request)), hash([]byte("enrollment"))
	attachment := attachmentRecord{SchemaVersion: 1, Kind: "closed-network-observation", ServiceInstance: strings.Repeat("a", 32), ObservationRef: strings.Repeat("b", 32), RequestRef: request.Execution.RequestRef, ContainerID: strings.Repeat("c", 64), NetworkName: request.NetworkName, InterfaceName: request.InterfaceName, OperationRef: "add-original", Topology: attachmentTopology{HostNamespace: attachmentNamespace{Device: 4, Inode: 5}, PodNamespace: attachmentNamespace{Device: ^uint64(0), Inode: 9007199254740993}, Host: attachmentLink{Index: 12, PeerIndex: 13, Name: "veth-test", Kind: "veth", PeerNamespaceID: 7}, Pod: attachmentLink{Index: 13, PeerIndex: 12, Name: "eth0", Kind: "veth", PeerNamespaceID: 8}}, KernelIdentity: attachmentKernel{TableHandle: ^uint64(0), FromHandle: 2, TowardHandle: 3}}
	// This is a wire-format fixture, not an enrolled source or a positive kernel
	// observation. Actual production construction still requires captureNetwork.
	raw := encoded(attachment)
	record := NetworkRecord{SchemaVersion: 1, Kind: "node-physical-network", Execution: Record{SchemaVersion: 1, Kind: "node-physical-execution", RequestDigest: requestDigest, EnrollmentDigest: enrollmentDigest, ValidUntil: request.Execution.Deadline, Physical: Physical{NodeUID: request.Execution.NodeUID, PodUID: request.Execution.PodUID, SandboxID: attachment.ContainerID, Containers: []Container{}}}, Attachment: networkAttachment(attachment, raw)}
	parsed, err := parseNetworkRecord(encoded(record), request, requestDigest, enrollmentDigest)
	must(t, err)
	if parsed.Attachment.RecordJSON != string(raw) || parsed.Attachment.NamespaceDevice != "18446744073709551615" || parsed.Attachment.NamespaceInode != "9007199254740993" {
		t.Fatal("native record rounded or reserialized")
	}
	for _, change := range []string{"digest", "original-bytes", "service", "operation", "namespace", "sandbox", "node", "pod", "source", "kind"} {
		t.Run(change, func(t *testing.T) {
			next := record
			switch change {
			case "digest":
				next.Attachment.RecordDigest = hash([]byte("other"))
			case "original-bytes":
				next.Attachment.RecordJSON += " "
			case "service":
				next.Attachment.ServiceInstance = strings.Repeat("d", 32)
			case "operation":
				next.Attachment.OperationRef = "another-add"
			case "namespace":
				next.Attachment.NamespaceInode = "9007199254740992"
			case "sandbox":
				next.Execution.Physical.SandboxID = strings.Repeat("d", 64)
			case "node":
				next.Execution.Physical.NodeUID = "other-node"
			case "pod":
				next.Execution.Physical.PodUID = "other-pod"
			case "source":
				next.Execution.EnrollmentDigest = hash([]byte("other-source"))
			case "kind":
				next.Kind = "node-physical-execution"
			}
			_, err := parseNetworkRecord(encoded(next), request, requestDigest, enrollmentDigest)
			requireError(t, err)
		})
	}
}
