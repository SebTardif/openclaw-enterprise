package nodeobserver

import (
	"bytes"
	"encoding/json"
	"io"
	"reflect"
	"regexp"
	"strconv"
	"unicode/utf8"
)

const attachmentSocketPath = "/run/oce-network-fence/control.sock"

var attachmentLocator = regexp.MustCompile(`^[0-9a-f]{32}$`)
var attachmentReference = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,256}$`)
var attachmentInterface = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,15}$`)

type attachmentRequest struct {
	SchemaVersion int    `json:"schemaVersion"`
	Operation     string `json:"operation"`
	RequestRef    string `json:"requestRef"`
	ContainerID   string `json:"containerId"`
	NetworkName   string `json:"networkName"`
	InterfaceName string `json:"interfaceName"`
}
type attachmentInspect struct {
	SchemaVersion  int    `json:"schemaVersion"`
	Operation      string `json:"operation"`
	RequestRef     string `json:"requestRef"`
	ObservationRef string `json:"observationRef"`
	RecordDigest   string `json:"recordDigest"`
}
type attachmentReply struct {
	SchemaVersion int             `json:"schemaVersion"`
	Status        string          `json:"status"`
	RequestRef    string          `json:"requestRef"`
	RecordDigest  string          `json:"recordDigest"`
	Record        json.RawMessage `json:"record"`
}
type attachmentNamespace struct {
	Device uint64 `json:"device"`
	Inode  uint64 `json:"inode"`
}
type attachmentLink struct {
	Index           uint32 `json:"ifindex"`
	PeerIndex       uint32 `json:"iflink"`
	Name            string `json:"name"`
	Kind            string `json:"kind"`
	PeerNamespaceID int32  `json:"peer_netnsid"`
}
type attachmentTopology struct {
	HostNamespace attachmentNamespace `json:"host_namespace"`
	PodNamespace  attachmentNamespace `json:"pod_namespace"`
	Host          attachmentLink      `json:"host"`
	Pod           attachmentLink      `json:"pod"`
}
type attachmentKernel struct {
	TableHandle  uint64 `json:"tableHandle"`
	FromHandle   uint64 `json:"fromHandle"`
	TowardHandle uint64 `json:"towardHandle"`
}

// This is observation data only. No public constructor converts it into custody.
type attachmentRecord struct {
	SchemaVersion   int                `json:"schemaVersion"`
	Kind            string             `json:"kind"`
	ServiceInstance string             `json:"serviceInstance"`
	ObservationRef  string             `json:"observationRef"`
	RequestRef      string             `json:"requestRef"`
	ContainerID     string             `json:"containerId"`
	NetworkName     string             `json:"networkName"`
	InterfaceName   string             `json:"interfaceName"`
	OperationRef    string             `json:"operationRef"`
	Topology        attachmentTopology `json:"topology"`
	KernelIdentity  attachmentKernel   `json:"kernelIdentity"`
}

func (r attachmentRecord) matches(request attachmentRequest, namespace attachmentNamespace) bool {
	t, k := r.Topology, r.KernelIdentity
	return r.SchemaVersion == 1 && r.Kind == "closed-network-observation" && attachmentLocator.MatchString(r.ServiceInstance) && attachmentLocator.MatchString(r.ObservationRef) && ref.MatchString(r.RequestRef) && r.RequestRef == request.RequestRef && r.ContainerID == request.ContainerID && r.NetworkName == request.NetworkName && r.InterfaceName == request.InterfaceName && attachmentReference.MatchString(r.OperationRef) && t.PodNamespace == namespace && t.PodNamespace.Inode != 0 && t.HostNamespace.Inode != 0 && t.HostNamespace != t.PodNamespace && t.Host.Kind == "veth" && t.Pod.Kind == "veth" && attachmentInterface.MatchString(t.Host.Name) && t.Pod.Name == request.InterfaceName && t.Host.Index > 0 && t.Pod.Index > 0 && t.Host.PeerIndex == t.Pod.Index && t.Pod.PeerIndex == t.Host.Index && t.Host.PeerNamespaceID >= 0 && t.Pod.PeerNamespaceID >= 0 && k.TableHandle > 0 && k.FromHandle > 0 && k.TowardHandle > 0 && k.FromHandle != k.TowardHandle
}

// The fence has native uint64 handles; do not round them through float64 or
// constrain them to the JavaScript integer range. All object levels have exact
// field spelling and reject missing, unknown and duplicate keys. Null is allowed
// only in RawMessage (the INSPECT reply's explicitly empty record).
func decodeAttachment(raw []byte, out any) error {
	if len(raw) == 0 || len(raw) > MaxBytes || !utf8.Valid(raw) {
		return ErrUnavailable
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	var walk func(int) bool
	walk = func(depth int) bool {
		if depth > 12 {
			return false
		}
		token, err := d.Token()
		if err != nil {
			return false
		}
		if number, ok := token.(json.Number); ok {
			value := number.String()
			if len(value) > 0 && value[0] == '-' {
				n, e := strconv.ParseInt(value, 10, 64)
				return e == nil && strconv.FormatInt(n, 10) == value
			}
			n, e := strconv.ParseUint(value, 10, 64)
			return e == nil && strconv.FormatUint(n, 10) == value
		}
		switch token {
		case json.Delim('{'):
			seen := map[string]bool{}
			for d.More() {
				key, e := d.Token()
				k, ok := key.(string)
				if e != nil || !ok || seen[k] || !walk(depth+1) {
					return false
				}
				seen[k] = true
			}
			end, e := d.Token()
			return e == nil && end == json.Delim('}')
		case json.Delim('['):
			return false
		}
		return true
	}
	if !walk(0) {
		return ErrUnavailable
	}
	if _, err := d.Token(); err != io.EOF {
		return ErrUnavailable
	}
	var exact func([]byte, reflect.Type) bool
	exact = func(data []byte, kind reflect.Type) bool {
		if kind == reflect.TypeFor[json.RawMessage]() {
			return true
		}
		if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
			return false
		}
		if kind.Kind() != reflect.Struct {
			return true
		}
		var fields map[string]json.RawMessage
		if json.Unmarshal(data, &fields) != nil || len(fields) != kind.NumField() {
			return false
		}
		for i := 0; i < kind.NumField(); i++ {
			f := kind.Field(i)
			value, ok := fields[f.Tag.Get("json")]
			if !ok || !exact(value, f.Type) {
				return false
			}
		}
		return true
	}
	kind := reflect.TypeOf(out)
	if kind == nil || kind.Kind() != reflect.Pointer || !exact(raw, kind.Elem()) {
		return ErrUnavailable
	}
	d = json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(out) != nil {
		return ErrUnavailable
	}
	return nil
}
