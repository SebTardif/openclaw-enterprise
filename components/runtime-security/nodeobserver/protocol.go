// Package nodeobserver captures physical node execution through original owned
// requests. It does not enroll nodes or establish OCC runtime/profile authority.
package nodeobserver

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/url"
	"path/filepath"
	"reflect"
	"regexp"
	"strconv"
	"time"
	"unicode/utf8"

	"github.com/spiffe/go-spiffe/v2/spiffeid"
)

const MaxBytes = 64 << 10
const Lifetime = 10 * time.Second

var ErrUnavailable = errors.New("node observation unavailable")
var ref = regexp.MustCompile(`^[A-Za-z0-9._:/-]{1,200}$`)
var name = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$`)
var digest = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
var runtimeID = regexp.MustCompile(`^[0-9a-f]{64}$`)

// Enrollment is trusted deployment input. Requests cannot select any source,
// endpoint, path, identity, enrollment version or namespace outside this value.
// The deployment owner must supply the current node enrollment; parsing is not
// enrollment and an uninstalled configuration is not a production source.
type Enrollment struct {
	SchemaVersion       int    `json:"schemaVersion"`
	SourceRef           string `json:"sourceRef"`
	Version             uint64 `json:"version"`
	ClusterRef          string `json:"clusterRef"`
	NodeName            string `json:"nodeName"`
	NodeUID             string `json:"nodeUID"`
	Namespace           string `json:"namespace"`
	WorkloadSocket      string `json:"workloadSocket"`
	OwnSPIFFEID         string `json:"ownSPIFFEID"`
	PeerSPIFFEID        string `json:"peerSPIFFEID"`
	TrustBundleDigest   string `json:"trustBundleDigest"`
	Address             string `json:"address"`
	CRIPath             string `json:"criPath"`
	RuntimeRoot         string `json:"runtimeRoot"`
	RunscPath           string `json:"runscPath"`
	RunscDigest         string `json:"runscDigest"`
	SentryDigest        string `json:"sentryDigest"`
	KubernetesURL       string `json:"kubernetesURL"`
	KubernetesCAPath    string `json:"kubernetesCAPath"`
	KubernetesTokenPath string `json:"kubernetesTokenPath"`
}

type Request struct {
	SchemaVersion int    `json:"schemaVersion"`
	Method        string `json:"method"`
	RequestRef    string `json:"requestRef"`
	SourceRef     string `json:"sourceRef"`
	SourceVersion uint64 `json:"sourceVersion"`
	ClusterRef    string `json:"clusterRef"`
	NodeUID       string `json:"nodeUID"`
	Namespace     string `json:"namespace"`
	PodName       string `json:"podName"`
	PodUID        string `json:"podUID"`
	Deadline      string `json:"deadline"`
}

// NetworkRequest selects an additional physical read on the same authenticated
// execution request. Neither the selectors nor its result grant Work authority.
type NetworkRequest struct {
	SchemaVersion int     `json:"schemaVersion"`
	Method        string  `json:"method"`
	Execution     Request `json:"execution"`
	NetworkName   string  `json:"networkName"`
	InterfaceName string  `json:"interfaceName"`
}

type NetworkAttachment struct {
	RecordJSON      string `json:"recordJSON"`
	RecordDigest    string `json:"recordDigest"`
	ServiceInstance string `json:"serviceInstance"`
	OperationRef    string `json:"operationRef"`
	NamespaceDevice string `json:"namespaceDevice"`
	NamespaceInode  string `json:"namespaceInode"`
}

// The exact attachment bytes stay a string: native uint64 identities must not
// round through a JavaScript number or a different JSON serialization.
type NetworkRecord struct {
	SchemaVersion int               `json:"schemaVersion"`
	Kind          string            `json:"kind"`
	Execution     Record            `json:"execution"`
	Attachment    NetworkAttachment `json:"attachment"`
}

func parseCaptureRequest(raw []byte) (Request, *NetworkRequest, error) {
	if r, err := ParseRequest(raw); err == nil {
		return r, nil, nil
	}
	var network NetworkRequest
	if decode(raw, &network) != nil || network.SchemaVersion != 1 || network.Method != "capture-network" || !attachmentReference.MatchString(network.NetworkName) || !attachmentInterface.MatchString(network.InterfaceName) {
		return Request{}, nil, ErrUnavailable
	}
	r, err := ParseRequest(encoded(network.Execution))
	if err != nil {
		return Request{}, nil, err
	}
	return r, &network, nil
}

func networkAttachment(record attachmentRecord, raw []byte) NetworkAttachment {
	return NetworkAttachment{RecordJSON: string(raw), RecordDigest: hash(raw), ServiceInstance: record.ServiceInstance, OperationRef: record.OperationRef, NamespaceDevice: strconv.FormatUint(record.Topology.PodNamespace.Device, 10), NamespaceInode: strconv.FormatUint(record.Topology.PodNamespace.Inode, 10)}
}

func parseNetworkRecord(raw []byte, request NetworkRequest, requestDigest, enrollmentDigest string) (NetworkRecord, error) {
	var record NetworkRecord
	if decode(raw, &record) != nil || record.SchemaVersion != 1 || record.Kind != "node-physical-network" {
		return record, ErrUnavailable
	}
	execution := record.Execution
	if execution.SchemaVersion != 1 || execution.Kind != "node-physical-execution" || execution.RequestDigest != requestDigest || execution.EnrollmentDigest != enrollmentDigest || execution.ValidUntil != request.Execution.Deadline || execution.Physical.NodeUID != request.Execution.NodeUID || execution.Physical.PodUID != request.Execution.PodUID {
		return record, ErrUnavailable
	}
	attachmentRaw := []byte(record.Attachment.RecordJSON)
	var attachment attachmentRecord
	if decodeAttachment(attachmentRaw, &attachment) != nil || !attachment.matches(attachmentRequest{SchemaVersion: 1, Operation: "ACQUIRE", RequestRef: request.Execution.RequestRef, ContainerID: execution.Physical.SandboxID, NetworkName: request.NetworkName, InterfaceName: request.InterfaceName}, attachment.Topology.PodNamespace) || record.Attachment != networkAttachment(attachment, attachmentRaw) {
		return record, ErrUnavailable
	}
	return record, nil
}

type Container struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Attempt    uint32 `json:"attempt"`
	ImageRef   string `json:"imageRef"`
	CreatedAt  string `json:"createdAt"`
	StartedAt  string `json:"startedAt"`
	FinishedAt string `json:"finishedAt"`
	State      string `json:"state"`
}

type Process struct {
	PID              int    `json:"pid"`
	StartTicks       string `json:"startTicks"`
	ExecutableDigest string `json:"executableDigest"`
	PIDNamespace     string `json:"pidNamespace"`
}

// Physical is an original source observation, deliberately not RuntimeBinding.
// In particular, it makes no inner-gVisor caller, complete profile or authority claim.
type Physical struct {
	NodeUID             string      `json:"nodeUID"`
	NodeResourceVersion string      `json:"nodeResourceVersion"`
	BootID              string      `json:"bootID"`
	NamespaceUID        string      `json:"namespaceUID"`
	PodUID              string      `json:"podUID"`
	PodResourceVersion  string      `json:"podResourceVersion"`
	SandboxID           string      `json:"sandboxID"`
	SandboxCreatedAt    string      `json:"sandboxCreatedAt"`
	SandboxAttempt      uint32      `json:"sandboxAttempt"`
	RuntimeStateDigest  string      `json:"runtimeStateDigest"`
	RuntimeBinaryDigest string      `json:"runtimeBinaryDigest"`
	Sentry              Process     `json:"sentry"`
	Containers          []Container `json:"containers"`
}

type Record struct {
	SchemaVersion    int      `json:"schemaVersion"`
	Kind             string   `json:"kind"`
	RequestDigest    string   `json:"requestDigest"`
	EnrollmentDigest string   `json:"enrollmentDigest"`
	ObservedAt       string   `json:"observedAt"`
	ValidUntil       string   `json:"validUntil"`
	Physical         Physical `json:"physical"`
}

type Command struct {
	SchemaVersion int    `json:"schemaVersion"`
	Method        string `json:"method"`
	RequestDigest string `json:"requestDigest"`
	RecordDigest  string `json:"recordDigest"`
}

type Reply struct {
	SchemaVersion int             `json:"schemaVersion"`
	Status        string          `json:"status"`
	RequestDigest string          `json:"requestDigest"`
	RecordDigest  string          `json:"recordDigest"`
	Record        json.RawMessage `json:"record"`
}

func hash(raw []byte) string   { h := sha256.Sum256(raw); return "sha256:" + hex.EncodeToString(h[:]) }
func encoded(value any) []byte { raw, _ := json.Marshal(value); return raw }
func cleanPath(path string) bool {
	return filepath.IsAbs(path) && filepath.Clean(path) == path && path != "/" && len(path) <= 4096 && !bytes.ContainsAny([]byte(path), "\x00\r\n")
}

func ParseEnrollment(raw []byte) (Enrollment, error) {
	var e Enrollment
	if decode(raw, &e) != nil {
		return e, ErrUnavailable
	}
	own, a := spiffeid.FromString(e.OwnSPIFFEID)
	peer, b := spiffeid.FromString(e.PeerSPIFFEID)
	host, port, c := net.SplitHostPort(e.Address)
	n, d := strconv.Atoi(port)
	u, f := url.Parse(e.KubernetesURL)
	if e.SchemaVersion != 1 || e.Version == 0 || e.Version > 9007199254740991 || !ref.MatchString(e.SourceRef) || !ref.MatchString(e.ClusterRef) || !name.MatchString(e.NodeName) || !ref.MatchString(e.NodeUID) || !name.MatchString(e.Namespace) || a != nil || b != nil || own.String() != e.OwnSPIFFEID || peer.String() != e.PeerSPIFFEID || own.Path() == "" || peer.Path() == "" || own == peer || own.TrustDomain() != peer.TrustDomain() || c != nil || net.ParseIP(host) == nil || d != nil || n < 1 || n > 65535 || f != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") || !digest.MatchString(e.TrustBundleDigest) || !digest.MatchString(e.RunscDigest) || !digest.MatchString(e.SentryDigest) {
		return e, ErrUnavailable
	}
	for _, p := range []string{e.WorkloadSocket, e.CRIPath, e.RuntimeRoot, e.RunscPath, e.KubernetesCAPath, e.KubernetesTokenPath} {
		if !cleanPath(p) {
			return e, ErrUnavailable
		}
	}
	if len(e.WorkloadSocket) > 103 || len(e.CRIPath) > 103 {
		return e, ErrUnavailable
	}
	return e, nil
}

func ParseRequest(raw []byte) (Request, error) {
	var r Request
	if decode(raw, &r) != nil || r.SchemaVersion != 1 || r.Method != "capture-execution" || !ref.MatchString(r.RequestRef) || !ref.MatchString(r.SourceRef) || !ref.MatchString(r.ClusterRef) || !ref.MatchString(r.NodeUID) || !ref.MatchString(r.PodUID) || !name.MatchString(r.Namespace) || !name.MatchString(r.PodName) || r.SourceVersion == 0 || r.SourceVersion > 9007199254740991 {
		return r, ErrUnavailable
	}
	d, err := time.Parse(time.RFC3339Nano, r.Deadline)
	if err != nil || d.UTC().Format(time.RFC3339Nano) != r.Deadline {
		return r, ErrUnavailable
	}
	return r, nil
}

// Exact key spelling, required fields, duplicate rejection and bounded canonical
// integers keep the Go and controller interpretations equal. API/provider JSON
// is parsed separately: these rules apply to this closed request protocol.
func decode(raw []byte, out any) error {
	if len(raw) > MaxBytes || !utf8.Valid(raw) {
		return ErrUnavailable
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	var walk func(int) bool
	walk = func(depth int) bool {
		if depth > 24 {
			return false
		}
		t, err := d.Token()
		if err != nil {
			return false
		}
		if n, ok := t.(json.Number); ok {
			v, e := n.Int64()
			return e == nil && v >= 0 && v <= 9007199254740991 && strconv.FormatInt(v, 10) == n.String()
		}
		switch t {
		case json.Delim('{'):
			keys := map[string]bool{}
			for d.More() {
				k, e := d.Token()
				s, ok := k.(string)
				if e != nil || !ok || keys[s] || !walk(depth+1) {
					return false
				}
				keys[s] = true
			}
			e, err := d.Token()
			return err == nil && e == json.Delim('}')
		case json.Delim('['):
			for d.More() {
				if !walk(depth + 1) {
					return false
				}
			}
			e, err := d.Token()
			return err == nil && e == json.Delim(']')
		}
		return t != nil
	}
	if !walk(0) {
		return ErrUnavailable
	}
	if _, e := d.Token(); e != io.EOF {
		return ErrUnavailable
	}
	var fields map[string]json.RawMessage
	kind := reflect.TypeOf(out).Elem()
	if kind.Kind() != reflect.Struct || json.Unmarshal(raw, &fields) != nil || len(fields) != kind.NumField() {
		return ErrUnavailable
	}
	for i := 0; i < kind.NumField(); i++ {
		if _, ok := fields[kind.Field(i).Tag.Get("json")]; !ok {
			return ErrUnavailable
		}
	}
	d = json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(out) != nil {
		return ErrUnavailable
	}
	return nil
}
