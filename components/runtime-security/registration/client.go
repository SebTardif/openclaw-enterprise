// Package registration performs constrained SPIRE Server Entry API operations.
// It does not admit an OCE enrollment, authenticate a runtime, or decide whether
// an assignment may register. Its caller must hold the actual OCE responsibility.
package registration

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/spiffe/go-spiffe/v2/spiffeid"
	entryv1 "github.com/spiffe/spire-api-sdk/proto/spire/api/server/entry/v1"
	"github.com/spiffe/spire-api-sdk/proto/spire/api/types"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
)

const (
	maxMessageBytes = 64 << 10
	maxPages        = 8
	maxEntries      = 16
	maxPending      = 16
	ttlSeconds      = 300
)

var (
	namePattern   = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)
	uidPattern    = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,127}$`)
	refPattern    = regexp.MustCompile(`^[A-Za-z0-9._:/-]{1,200}$`)
	digestPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
)

// Error carries only a fixed code. It never includes provider text or identity data.
type Error struct{ Code string }

func (e *Error) Error() string   { return "SPIRE registration operation failed (" + e.Code + ")." }
func failure(code string) *Error { return &Error{Code: code} }

// Options fixes the native client's deployment scope. Construction is not OCE
// admission. Only a protected local SPIRE Server administrative socket is supported.
type Options struct {
	SocketPath       string
	WorkloadSPIFFEID string
	ClusterID        string
	Namespace        string
	ContainerName    string
	Timeout          time.Duration // positive, at most three seconds; includes all RPCs
}

// ExpectedEntry is copied before any I/O. The actual State/Compute owner must
// supply the attested parent, Pod and immutable assignment correspondence.
// AssignmentRef and BindingDigest are correlation, not evidence of authority.
type ExpectedEntry struct {
	ParentAgentSPIFFEID string
	PodUID              string
	AssignmentRef       string
	BindingDigest       string
}

// Observation describes an actual provider read; it grants no OCE currentness.
// ProviderRevision is kept separate from the OCE registration admission version.
type Observation struct {
	EntryID           string
	SPIFFEID          string
	AssignmentRef     string
	BindingDigest     string
	ProviderRevision  int64
	ProviderCreatedAt int64
	ObservedAt        time.Time
}

// Registration is an original client-owned invocation, including uncertain
// creation/deletion outcomes. It cannot be recreated from an Observation, copied,
// or moved to another client. Its methods are deliberately on Client.
type Registration struct {
	self            *Registration
	owner           *Client
	mu              sync.Mutex
	entry           *types.Entry
	expected        ExpectedEntry
	known           bool
	createConfirmed bool
	deleteStarted   bool
	deleted         bool
	terminal        *Error
}

// Client owns its gRPC connection and in-flight operations. Close cancels and
// drains native calls, but makes no claim that a canceled remote mutation rolled back.
type Client struct {
	self    *Client
	options Options
	id      spiffeid.ID
	rpc     entryv1.EntryClient
	conn    *grpc.ClientConn
	root    context.Context
	cancel  context.CancelFunc
	mu      sync.Mutex
	closed  bool
	work    sync.WaitGroup
	pending chan struct{}
}

func New(options Options) (*Client, error) {
	id, err := spiffeid.FromString(options.WorkloadSPIFFEID)
	if err != nil || id.Path() == "" || id.String() != options.WorkloadSPIFFEID || len(options.WorkloadSPIFFEID) > 2048 ||
		strings.HasPrefix(id.Path(), "/spire/") || !namePattern.MatchString(options.ClusterID) ||
		!namePattern.MatchString(options.Namespace) || !namePattern.MatchString(options.ContainerName) ||
		options.Timeout <= 0 || options.Timeout > 3*time.Second || !protectedSocket(options.SocketPath) {
		return nil, failure("INVALID_CONFIGURATION")
	}
	root, cancel := context.WithCancel(context.Background())
	conn, err := grpc.NewClient("unix://"+options.SocketPath,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
			if !protectedSocket(options.SocketPath) {
				return nil, failure("SOCKET_UNAVAILABLE")
			}
			return (&net.Dialer{}).DialContext(ctx, "unix", options.SocketPath)
		}),
		grpc.WithDisableRetry(),
		grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(maxMessageBytes), grpc.MaxCallSendMsgSize(maxMessageBytes)),
	)
	if err != nil {
		cancel()
		return nil, failure("UNAVAILABLE")
	}
	c := &Client{options: options, id: id, rpc: entryv1.NewEntryClient(conn), conn: conn, root: root, cancel: cancel, pending: make(chan struct{}, maxPending)}
	c.self = c
	return c, nil
}

func protectedSocket(path string) bool {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || len(path) > 103 {
		return false
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil || resolved != path {
		return false
	}
	info, err := os.Lstat(path)
	if err != nil || info.Mode()&os.ModeSocket == 0 || info.Mode().Perm()&0077 != 0 {
		return false
	}
	owner, ok := info.Sys().(*syscall.Stat_t)
	if !ok || (owner.Uid != 0 && owner.Uid != uint32(os.Geteuid())) {
		return false
	}
	// Every directory must prevent replacement by an unrelated writer. A sticky
	// ancestor such as /tmp is safe only for the owned child checked beneath it.
	for dir := filepath.Dir(path); ; dir = filepath.Dir(dir) {
		info, err = os.Lstat(dir)
		if err != nil || !info.IsDir() {
			return false
		}
		owner, ok = info.Sys().(*syscall.Stat_t)
		if !ok || (owner.Uid != 0 && owner.Uid != uint32(os.Geteuid())) ||
			(info.Mode().Perm()&0022 != 0 && info.Mode()&os.ModeSticky == 0) {
			return false
		}
		if dir == "/" {
			break
		}
	}
	return true
}

func (c *Client) begin(ctx context.Context) (context.Context, func(), error) {
	if c == nil || c.self != c || ctx == nil {
		return nil, nil, failure("INVALID_HANDLE")
	}
	if ctx.Err() != nil {
		return nil, nil, safeError(ctx.Err())
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil, nil, failure("CLOSED")
	}
	select {
	case c.pending <- struct{}{}:
	default:
		return nil, nil, failure("BUSY")
	}
	c.work.Add(1)
	op, cancel := context.WithTimeout(ctx, c.options.Timeout)
	stop := context.AfterFunc(c.root, cancel)
	return op, func() { stop(); cancel(); <-c.pending; c.work.Done() }, nil
}

func (c *Client) expected(value ExpectedEntry) (*types.Entry, error) {
	parent, err := spiffeid.FromString(value.ParentAgentSPIFFEID)
	prefix := "/spire/agent/k8s_psat/" + c.options.ClusterID + "/"
	if err != nil || parent.String() != value.ParentAgentSPIFFEID || parent.TrustDomain() != c.id.TrustDomain() ||
		!strings.HasPrefix(parent.Path(), prefix) || !uidPattern.MatchString(strings.TrimPrefix(parent.Path(), prefix)) ||
		!uidPattern.MatchString(value.PodUID) || !refPattern.MatchString(value.AssignmentRef) || !digestPattern.MatchString(value.BindingDigest) {
		return nil, failure("INVALID_EXPECTATION")
	}
	return &types.Entry{
		SpiffeId: &types.SPIFFEID{TrustDomain: c.id.TrustDomain().String(), Path: c.id.Path()},
		ParentId: &types.SPIFFEID{TrustDomain: parent.TrustDomain().String(), Path: parent.Path()},
		Selectors: []*types.Selector{
			{Type: "k8s", Value: "ns:" + c.options.Namespace},
			{Type: "k8s", Value: "pod-uid:" + value.PodUID},
			{Type: "k8s", Value: "container-name:" + c.options.ContainerName},
		},
		X509SvidTtl: ttlSeconds,
		// JWT TTL zero uses SPIRE's X.509 TTL fallback. Other privileges, hint,
		// federation, DNS and additional attributes remain absent/false.
	}, nil
}

// CreateExact attempts creation once, with a random client-selected entry ID.
// A non-nil handle is always returned after dispatch may have occurred, including
// on error. Keep it for exact readback/cleanup; do not retry by creating a new handle.
func (c *Client) CreateExact(ctx context.Context, expected ExpectedEntry) (*Registration, Observation, error) {
	op, finish, err := c.begin(ctx)
	if err != nil {
		return nil, Observation{}, err
	}
	defer finish()
	entry, err := c.expected(expected)
	if err != nil {
		return nil, Observation{}, err
	}
	if err = c.inventory(op, entry, false); err != nil {
		return nil, Observation{}, err
	}
	var id [16]byte
	if _, err = rand.Read(id[:]); err != nil {
		return nil, Observation{}, failure("UNAVAILABLE")
	}
	id[6] = (id[6] & 0x0f) | 0x40
	id[8] = (id[8] & 0x3f) | 0x80
	entry.Id = fmt.Sprintf("%x-%x-%x-%x-%x", id[:4], id[4:6], id[6:8], id[8:10], id[10:])
	h := &Registration{owner: c, entry: entry, expected: expected}
	h.self = h
	if op.Err() != nil {
		return nil, Observation{}, safeError(op.Err())
	}
	result, err := c.rpc.BatchCreateEntry(op, &entryv1.BatchCreateEntryRequest{Entries: []*types.Entry{proto.Clone(entry).(*types.Entry)}})
	if err != nil {
		return h, Observation{}, failure("CREATE_OUTCOME_UNKNOWN")
	}
	if result == nil || unknown(result) || len(result.Results) != 1 || result.Results[0] == nil || unknown(result.Results[0]) ||
		result.Results[0].Status == nil || unknown(result.Results[0].Status) || result.Results[0].Status.Code != int32(codes.OK) {
		return h, Observation{}, failure("CREATE_OUTCOME_UNKNOWN")
	}
	if err = h.accept(result.Results[0].Entry); err != nil {
		h.terminal = err.(*Error)
		return h, Observation{}, err
	}
	h.createConfirmed = true
	observation, err := c.read(op, h)
	return h, observation, err
}

func unknown(message proto.Message) bool {
	if message == nil {
		return true
	}
	value := message.ProtoReflect()
	if !value.IsValid() || len(value.GetUnknown()) != 0 {
		return true
	}
	bad := false
	value.Range(func(field protoreflect.FieldDescriptor, value protoreflect.Value) bool {
		if field.Kind() == protoreflect.MessageKind {
			if field.IsList() {
				for i := 0; i < value.List().Len(); i++ {
					if unknown(value.List().Get(i).Message().Interface()) {
						bad = true
						break
					}
				}
			} else if unknown(value.Message().Interface()) {
				bad = true
			}
		}
		return !bad
	})
	return bad
}

func (h *Registration) accept(actual *types.Entry) error {
	if actual == nil || unknown(actual) || actual.RevisionNumber < 0 || actual.CreatedAt <= 0 || actual.CreatedAt > time.Now().Unix()+2 {
		return failure("ENTRY_INVALID")
	}
	copy := proto.Clone(actual).(*types.Entry)
	if h.known && (actual.RevisionNumber != h.entry.RevisionNumber || actual.CreatedAt != h.entry.CreatedAt) {
		return failure("ENTRY_CHANGED")
	}
	copy.RevisionNumber, copy.CreatedAt = h.entry.RevisionNumber, h.entry.CreatedAt
	// SPIRE selector order has no authority; require the exact duplicate-free set.
	if len(copy.Selectors) != len(h.entry.Selectors) {
		return failure("ENTRY_CHANGED")
	}
	type selectorPair struct{ kind, value string }
	seen := make(map[selectorPair]bool)
	for _, selector := range copy.Selectors {
		if selector == nil {
			return failure("ENTRY_INVALID")
		}
		key := selectorPair{selector.Type, selector.Value}
		if seen[key] {
			return failure("ENTRY_CHANGED")
		}
		seen[key] = true
	}
	for _, selector := range h.entry.Selectors {
		if !seen[selectorPair{selector.Type, selector.Value}] {
			return failure("ENTRY_CHANGED")
		}
	}
	copy.Selectors = h.entry.Selectors
	if !proto.Equal(copy, h.entry) {
		return failure("ENTRY_CHANGED")
	}
	if !h.known {
		h.entry.RevisionNumber, h.entry.CreatedAt, h.known = actual.RevisionNumber, actual.CreatedAt, true
	}
	return nil
}

// inventory requests all entries for the exact subject without filtering away
// privileged/downstream entries. Incomplete pagination never establishes uniqueness.
func (c *Client) inventory(ctx context.Context, expected *types.Entry, present bool) error {
	token := ""
	seen := make(map[string]bool)
	count := 0
	for page := 0; page < maxPages; page++ {
		result, err := c.rpc.ListEntries(ctx, &entryv1.ListEntriesRequest{
			Filter: &entryv1.ListEntriesRequest_Filter{BySpiffeId: proto.Clone(expected.SpiffeId).(*types.SPIFFEID)}, PageSize: maxEntries, PageToken: token,
		})
		if err != nil {
			return safeError(err)
		}
		if result == nil || unknown(result) || len(result.Entries) > maxEntries || len(result.NextPageToken) > 1024 {
			return failure("INVENTORY_INVALID")
		}
		for _, entry := range result.Entries {
			count++
			check := Registration{entry: expected, known: true}
			if !present || count > 1 || entry == nil || check.accept(entry) != nil {
				return failure("REGISTRATION_AMBIGUOUS")
			}
		}
		if result.NextPageToken == "" {
			if (present && count != 1) || ctx.Err() != nil {
				return failure("INVENTORY_INVALID")
			}
			return nil
		}
		if seen[result.NextPageToken] {
			return failure("INVENTORY_INVALID")
		}
		seen[result.NextPageToken] = true
		token = result.NextPageToken
	}
	return failure("INVENTORY_INVALID")
}

func (c *Client) read(ctx context.Context, h *Registration) (Observation, error) {
	if h.terminal != nil {
		return Observation{}, h.terminal
	}
	actual, err := c.rpc.GetEntry(ctx, &entryv1.GetEntryRequest{Id: h.entry.Id})
	if status.Code(err) == codes.NotFound {
		// An absent read cannot settle a creation whose canceled RPC might still
		// commit later. Only confirmed creation establishes an object to remove.
		if !h.createConfirmed {
			return Observation{}, failure("CREATE_OUTCOME_UNKNOWN")
		}
		if h.deleteStarted {
			h.deleted = true
			return Observation{}, failure("ENTRY_DELETED")
		}
		h.terminal = failure("ENTRY_ABSENT")
		return Observation{}, h.terminal
	}
	if err != nil {
		return Observation{}, safeError(err)
	}
	if h.deleted {
		h.terminal = failure("ENTRY_REAPPEARED")
		return Observation{}, h.terminal
	}
	if err = h.accept(actual); err != nil {
		h.terminal = err.(*Error)
		return Observation{}, err
	}
	h.createConfirmed = true
	if err = c.inventory(ctx, actual, true); err != nil {
		var fixed *Error
		if errors.As(err, &fixed) && (fixed.Code == "REGISTRATION_AMBIGUOUS" || fixed.Code == "INVENTORY_INVALID") {
			h.terminal = fixed
		}
		return Observation{}, err
	}
	if ctx.Err() != nil {
		return Observation{}, safeError(ctx.Err())
	}
	if h.deleteStarted {
		return Observation{}, failure("DELETE_OUTCOME_UNKNOWN")
	}
	return Observation{EntryID: h.entry.Id, SPIFFEID: c.options.WorkloadSPIFFEID, AssignmentRef: h.expected.AssignmentRef,
		BindingDigest: h.expected.BindingDigest, ProviderRevision: h.entry.RevisionNumber, ProviderCreatedAt: h.entry.CreatedAt, ObservedAt: time.Now().UTC()}, nil
}

func (c *Client) lockHandle(h *Registration) error {
	if h == nil || h.self != h || h.owner != c {
		return failure("INVALID_HANDLE")
	}
	// Do not queue unbounded work behind the same retained invocation.
	if !h.mu.TryLock() {
		return failure("BUSY")
	}
	return nil
}

func (c *Client) ReadExact(ctx context.Context, h *Registration) (Observation, error) {
	op, finish, err := c.begin(ctx)
	if err != nil {
		return Observation{}, err
	}
	defer finish()
	if err = c.lockHandle(h); err != nil {
		return Observation{}, err
	}
	defer h.mu.Unlock()
	return c.read(op, h)
}

// DeleteExact first rechecks the original entry and never deletes an entry whose
// contents or revision changed. SPIRE has no compare-and-delete; the caller must
// retain exclusive registration-writer custody during read/delete/readback.
// A failed dispatched delete retains its original handle for readback only.
func (c *Client) DeleteExact(ctx context.Context, h *Registration) error {
	op, finish, err := c.begin(ctx)
	if err != nil {
		return err
	}
	defer finish()
	if err = c.lockHandle(h); err != nil {
		return err
	}
	defer h.mu.Unlock()
	_, err = c.read(op, h)
	if h.deleted && h.terminal == nil {
		return nil
	}
	if err != nil {
		return err
	}
	if h.deleteStarted {
		return failure("DELETE_OUTCOME_UNKNOWN")
	}
	if op.Err() != nil {
		return safeError(op.Err())
	}
	h.deleteStarted = true
	result, err := c.rpc.BatchDeleteEntry(op, &entryv1.BatchDeleteEntryRequest{Ids: []string{h.entry.Id}})
	if err != nil || result == nil || unknown(result) || len(result.Results) != 1 || result.Results[0] == nil ||
		result.Results[0].Id != h.entry.Id || result.Results[0].Status == nil || result.Results[0].Status.Code != int32(codes.OK) {
		return failure("DELETE_OUTCOME_UNKNOWN")
	}
	_, err = c.read(op, h)
	if h.deleted && h.terminal == nil {
		return nil
	}
	if err != nil {
		return err
	}
	return failure("DELETE_OUTCOME_UNKNOWN")
}

func (c *Client) Close() error {
	if c == nil || c.self != c {
		return failure("INVALID_HANDLE")
	}
	c.mu.Lock()
	c.closed = true
	c.cancel()
	c.mu.Unlock()
	c.work.Wait()
	_ = c.conn.Close()
	return nil
}

func safeError(err error) *Error {
	if errors.Is(err, context.DeadlineExceeded) || status.Code(err) == codes.DeadlineExceeded {
		return failure("TIMEOUT")
	}
	if errors.Is(err, context.Canceled) || status.Code(err) == codes.Canceled {
		return failure("ABORTED")
	}
	return failure("UNAVAILABLE")
}
