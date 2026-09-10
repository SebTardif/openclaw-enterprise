package registration_test

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/openclaw/openclaw-enterprise/components/runtime-security/registration"
	entryv1 "github.com/spiffe/spire-api-sdk/proto/spire/api/server/entry/v1"
	"github.com/spiffe/spire-api-sdk/proto/spire/api/types"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
)

// Only the external SPIRE endpoint is substituted. All client RPCs cross the
// actual generated gRPC service over its protected Unix socket. This server
// supplies no OCE assignment, responsibility, enrollment, or currentness result.
type spireServer struct {
	entryv1.UnimplementedEntryServer
	mu            sync.Mutex
	entries       map[string]*types.Entry
	creates       int
	deletes       int
	lastCreate    *types.Entry
	getError      error
	createError   error
	createReply   func(*types.Entry)
	deleteError   error
	createStarted chan struct{}
	createRelease chan struct{}
	listResponse  func(*entryv1.ListEntriesRequest, *entryv1.ListEntriesResponse) *entryv1.ListEntriesResponse
}

func (s *spireServer) ListEntries(_ context.Context, req *entryv1.ListEntriesRequest) (*entryv1.ListEntriesResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if req.Filter == nil || req.Filter.BySpiffeId == nil || req.OutputMask != nil || req.PageSize <= 0 {
		return nil, status.Error(codes.InvalidArgument, "bounded exact-subject inventory required")
	}
	result := &entryv1.ListEntriesResponse{}
	for _, entry := range s.entries {
		if proto.Equal(entry.SpiffeId, req.Filter.BySpiffeId) {
			result.Entries = append(result.Entries, proto.Clone(entry).(*types.Entry))
		}
	}
	if s.listResponse != nil {
		result = s.listResponse(req, result)
	}
	return result, nil
}

func (s *spireServer) GetEntry(_ context.Context, req *entryv1.GetEntryRequest) (*types.Entry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.getError != nil {
		return nil, s.getError
	}
	entry := s.entries[req.Id]
	if entry == nil {
		return nil, status.Error(codes.NotFound, "provider detail must not escape")
	}
	return proto.Clone(entry).(*types.Entry), nil
}

func (s *spireServer) BatchCreateEntry(_ context.Context, req *entryv1.BatchCreateEntryRequest) (*entryv1.BatchCreateEntryResponse, error) {
	if len(req.Entries) != 1 || req.OutputMask != nil {
		return nil, status.Error(codes.InvalidArgument, "one full entry required")
	}
	s.mu.Lock()
	s.creates++
	entry := proto.Clone(req.Entries[0]).(*types.Entry)
	s.lastCreate = proto.Clone(entry).(*types.Entry)
	started, release := s.createStarted, s.createRelease
	s.mu.Unlock()
	if started != nil {
		close(started)
	}
	// The remote provider may finish a mutation after the client stops waiting.
	if release != nil {
		<-release
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.entries[entry.Id] != nil {
		return &entryv1.BatchCreateEntryResponse{Results: []*entryv1.BatchCreateEntryResponse_Result{{Status: &types.Status{Code: int32(codes.AlreadyExists)}, Entry: s.entries[entry.Id]}}}, nil
	}
	entry.CreatedAt = time.Now().Unix()
	entry.RevisionNumber = 0
	s.entries[entry.Id] = proto.Clone(entry).(*types.Entry)
	if s.createError != nil {
		return nil, s.createError
	}
	if s.createReply != nil {
		s.createReply(entry)
	}
	return &entryv1.BatchCreateEntryResponse{Results: []*entryv1.BatchCreateEntryResponse_Result{{Status: &types.Status{}, Entry: entry}}}, nil
}

func (s *spireServer) BatchDeleteEntry(_ context.Context, req *entryv1.BatchDeleteEntryRequest) (*entryv1.BatchDeleteEntryResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(req.Ids) != 1 {
		return nil, status.Error(codes.InvalidArgument, "one retained entry required")
	}
	s.deletes++
	if s.deleteError != nil {
		return nil, s.deleteError
	}
	delete(s.entries, req.Ids[0])
	return &entryv1.BatchDeleteEntryResponse{Results: []*entryv1.BatchDeleteEntryResponse_Result{{Id: req.Ids[0], Status: &types.Status{}}}}, nil
}

func setup(t *testing.T) (*registration.Client, *spireServer, registration.Options) {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "oce-reg-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	path := filepath.Join(dir, "server.sock")
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Chmod(path, 0600); err != nil {
		t.Fatal(err)
	}
	endpoint := &spireServer{entries: make(map[string]*types.Entry)}
	server := grpc.NewServer()
	entryv1.RegisterEntryServer(server, endpoint)
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(server.Stop)
	options := registration.Options{SocketPath: path, WorkloadSPIFFEID: "spiffe://example.test/oce/runtime/assignment-a", ClusterID: "test-cluster", Namespace: "tenant-a", ContainerName: "harness", Timeout: time.Second}
	client, err := registration.New(options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client, endpoint, options
}

func expected() registration.ExpectedEntry {
	return registration.ExpectedEntry{ParentAgentSPIFFEID: "spiffe://example.test/spire/agent/k8s_psat/test-cluster/node-a", PodUID: "pod-a", AssignmentRef: "assignment/a", BindingDigest: "sha256:" + strings.Repeat("a", 64)}
}

func code(t *testing.T, err error, want string) {
	t.Helper()
	var fixed *registration.Error
	if !errors.As(err, &fixed) || fixed.Code != want {
		t.Fatalf("got %v, want fixed code %s", err, want)
	}
	if strings.Contains(err.Error(), "provider detail") || strings.Contains(err.Error(), "spiffe://") {
		t.Fatal("provider detail escaped")
	}
}

func create(t *testing.T, client *registration.Client) (*registration.Registration, registration.Observation) {
	t.Helper()
	handle, observation, err := client.CreateExact(context.Background(), expected())
	if err != nil {
		t.Fatal(err)
	}
	if handle == nil || observation.EntryID == "" || observation.SPIFFEID != "spiffe://example.test/oce/runtime/assignment-a" || observation.AssignmentRef != expected().AssignmentRef || observation.BindingDigest != expected().BindingDigest || observation.ProviderCreatedAt <= 0 || observation.ObservedAt.IsZero() {
		t.Fatalf("incomplete actual readback: %+v", observation)
	}
	return handle, observation
}

func TestActualCreateReadDeleteAndConstrainedRequest(t *testing.T) {
	client, endpoint, _ := setup(t)
	handle, original := create(t, client)
	endpoint.mu.Lock()
	sent := proto.Clone(endpoint.lastCreate).(*types.Entry)
	endpoint.mu.Unlock()
	if sent.Id != original.EntryID || sent.X509SvidTtl != 300 || sent.JwtSvidTtl != 0 || sent.Admin || sent.Downstream || sent.StoreSvid || sent.Hint != "" || sent.ExpiresAt != 0 || len(sent.FederatesWith) != 0 || len(sent.DnsNames) != 0 || sent.AdditionalAttributes != nil {
		t.Fatalf("unexpected provider privileges: %s", sent)
	}
	want := []*types.Selector{{Type: "k8s", Value: "ns:tenant-a"}, {Type: "k8s", Value: "pod-uid:pod-a"}, {Type: "k8s", Value: "container-name:harness"}}
	if len(sent.Selectors) != len(want) {
		t.Fatal("selector count")
	}
	for i := range want {
		if !proto.Equal(sent.Selectors[i], want[i]) {
			t.Fatal("wrong constrained selector")
		}
	}
	observation, err := client.ReadExact(context.Background(), handle)
	if err != nil || observation.EntryID != original.EntryID || observation.ProviderRevision != 0 {
		t.Fatalf("read failed: %+v %v", observation, err)
	}
	if err = client.DeleteExact(context.Background(), handle); err != nil {
		t.Fatal(err)
	}
	if err = client.DeleteExact(context.Background(), handle); err != nil {
		t.Fatal(err)
	}
	_, err = client.ReadExact(context.Background(), handle)
	code(t, err, "ENTRY_DELETED")
	endpoint.mu.Lock()
	defer endpoint.mu.Unlock()
	if endpoint.creates != 1 || endpoint.deletes != 1 || len(endpoint.entries) != 0 {
		t.Fatal("unexpected extra mutation")
	}
}

func TestChangedRegistrationCannotReadOrDelete(t *testing.T) {
	changes := map[string]func(*types.Entry){
		"subject":            func(e *types.Entry) { e.SpiffeId.Path += "-other" },
		"parent":             func(e *types.Entry) { e.ParentId.Path += "-other" },
		"pod":                func(e *types.Entry) { e.Selectors[1].Value = "pod-uid:other" },
		"duplicate-selector": func(e *types.Entry) { e.Selectors[1] = proto.Clone(e.Selectors[0]).(*types.Selector) },
		"extra-selector":     func(e *types.Entry) { e.Selectors = append(e.Selectors, &types.Selector{Type: "unix", Value: "uid:0"}) },
		"selector-pair-collision": func(e *types.Entry) {
			e.Selectors[0].Type = "k8s:ns"
			e.Selectors[0].Value = "tenant-a"
		},
		"admin":      func(e *types.Entry) { e.Admin = true },
		"downstream": func(e *types.Entry) { e.Downstream = true },
		"export":     func(e *types.Entry) { e.StoreSvid = true },
		"ttl":        func(e *types.Entry) { e.X509SvidTtl++ },
		"jwt-ttl":    func(e *types.Entry) { e.JwtSvidTtl = 1000 },
		"federation": func(e *types.Entry) { e.FederatesWith = []string{"other.test"} },
		"dns":        func(e *types.Entry) { e.DnsNames = []string{"other.test"} },
		"hint":       func(e *types.Entry) { e.Hint = "other" },
		"attributes": func(e *types.Entry) { e.AdditionalAttributes = &types.Entry_AdditionalAttributes{} },
		"expiry":     func(e *types.Entry) { e.ExpiresAt = time.Now().Unix() + 100 },
		"revision":   func(e *types.Entry) { e.RevisionNumber++ },
		"created":    func(e *types.Entry) { e.CreatedAt-- },
	}
	for name, change := range changes {
		t.Run(name, func(t *testing.T) {
			client, endpoint, _ := setup(t)
			handle, original := create(t, client)
			endpoint.mu.Lock()
			change(endpoint.entries[original.EntryID])
			endpoint.mu.Unlock()
			_, err := client.ReadExact(context.Background(), handle)
			code(t, err, "ENTRY_CHANGED")
			code(t, client.DeleteExact(context.Background(), handle), "ENTRY_CHANGED")
			endpoint.mu.Lock()
			defer endpoint.mu.Unlock()
			if endpoint.deletes != 0 {
				t.Fatal("changed registration was deleted")
			}
		})
	}
}

func TestInvalidCreateReplyCannotRegainOriginalHandle(t *testing.T) {
	for _, invalid := range []struct {
		name   string
		change func(*types.Entry)
		want   string
	}{
		{"privileged", func(entry *types.Entry) { entry.Admin = true }, "ENTRY_CHANGED"},
		{"invalid-creation-time", func(entry *types.Entry) { entry.CreatedAt = 0 }, "ENTRY_INVALID"},
	} {
		t.Run(invalid.name, func(t *testing.T) {
			client, endpoint, _ := setup(t)
			endpoint.mu.Lock()
			// Corrupt only the external provider's successful create reply. Its
			// later GetEntry returns the original exact metadata, which must not
			// revive a handle that already observed this integrity failure.
			endpoint.createReply = invalid.change
			endpoint.mu.Unlock()
			handle, _, err := client.CreateExact(context.Background(), expected())
			code(t, err, invalid.want)
			if handle == nil {
				t.Fatal("lost original invocation custody")
			}
			_, err = client.ReadExact(context.Background(), handle)
			code(t, err, invalid.want)
			code(t, client.DeleteExact(context.Background(), handle), invalid.want)
			endpoint.mu.Lock()
			defer endpoint.mu.Unlock()
			if endpoint.creates != 1 || endpoint.deletes != 0 || len(endpoint.entries) != 1 {
				t.Fatal("invalid create reply permitted another mutation")
			}
		})
	}
}

func TestUnknownFieldsAndNoCachedRead(t *testing.T) {
	client, endpoint, _ := setup(t)
	handle, original := create(t, client)
	endpoint.mu.Lock()
	endpoint.entries[original.EntryID].ProtoReflect().SetUnknown([]byte{0xa0, 0x06, 0x01})
	endpoint.mu.Unlock()
	_, err := client.ReadExact(context.Background(), handle)
	code(t, err, "ENTRY_INVALID")
	client, endpoint, _ = setup(t)
	handle, _ = create(t, client)
	endpoint.mu.Lock()
	endpoint.getError = status.Error(codes.Unavailable, "provider detail must not escape")
	endpoint.mu.Unlock()
	_, err = client.ReadExact(context.Background(), handle)
	code(t, err, "UNAVAILABLE")
}

func TestForeignCopiedAndFabricatedHandles(t *testing.T) {
	client, _, _ := setup(t)
	handle, _ := create(t, client)
	other, _, _ := setup(t)
	copy := reflect.New(reflect.TypeOf(handle).Elem())
	copy.Elem().Set(reflect.ValueOf(handle).Elem())
	for _, invalid := range []*registration.Registration{nil, {}, copy.Interface().(*registration.Registration)} {
		_, err := client.ReadExact(context.Background(), invalid)
		code(t, err, "INVALID_HANDLE")
	}
	_, err := other.ReadExact(context.Background(), handle)
	code(t, err, "INVALID_HANDLE")
}

func TestAmbiguousAndIncompleteInventory(t *testing.T) {
	for _, mode := range []string{"duplicate", "token-cycle", "page-bound", "oversized-page", "wrong-entry"} {
		t.Run(mode, func(t *testing.T) {
			client, endpoint, _ := setup(t)
			handle, original := create(t, client)
			endpoint.mu.Lock()
			endpoint.listResponse = func(req *entryv1.ListEntriesRequest, result *entryv1.ListEntriesResponse) *entryv1.ListEntriesResponse {
				switch mode {
				case "duplicate":
					if req.PageToken == "" {
						result.NextPageToken = "next"
					} else {
						result.Entries[0].Id = "another-id"
					}
				case "token-cycle":
					result.Entries = nil
					result.NextPageToken = "same"
				case "page-bound":
					result.Entries = nil
					result.NextPageToken = req.PageToken + "a"
				case "oversized-page":
					for len(result.Entries) < 17 {
						result.Entries = append(result.Entries, endpoint.entries[original.EntryID])
					}
				case "wrong-entry":
					result.Entries[0].Admin = true
				}
				return result
			}
			endpoint.mu.Unlock()
			_, err := client.ReadExact(context.Background(), handle)
			if mode == "duplicate" || mode == "wrong-entry" {
				code(t, err, "REGISTRATION_AMBIGUOUS")
			} else {
				code(t, err, "INVENTORY_INVALID")
			}
		})
	}
}

func TestExistingSubjectBlocksCreate(t *testing.T) {
	client, endpoint, _ := setup(t)
	create(t, client)
	handle, _, err := client.CreateExact(context.Background(), expected())
	code(t, err, "REGISTRATION_AMBIGUOUS")
	if handle != nil {
		t.Fatal("preflight denial retained a dispatched handle")
	}
	endpoint.mu.Lock()
	defer endpoint.mu.Unlock()
	if endpoint.creates != 1 {
		t.Fatal("preexisting subject was mutated")
	}
}

func TestLostCreateReplyRecoveredOnlyByOriginalHandle(t *testing.T) {
	client, endpoint, _ := setup(t)
	endpoint.mu.Lock()
	endpoint.createError = status.Error(codes.Unavailable, "provider detail must not escape")
	endpoint.mu.Unlock()
	handle, _, err := client.CreateExact(context.Background(), expected())
	code(t, err, "CREATE_OUTCOME_UNKNOWN")
	if handle == nil {
		t.Fatal("lost cleanup custody")
	}
	observation, err := client.ReadExact(context.Background(), handle)
	if err != nil || observation.EntryID == "" {
		t.Fatalf("actual readback failed: %+v %v", observation, err)
	}
	if err = client.DeleteExact(context.Background(), handle); err != nil {
		t.Fatal(err)
	}
}

func TestCanceledCreateAbsentReadDoesNotSettleLateCommit(t *testing.T) {
	client, endpoint, _ := setup(t)
	started, release := make(chan struct{}), make(chan struct{})
	endpoint.mu.Lock()
	endpoint.createStarted, endpoint.createRelease = started, release
	endpoint.mu.Unlock()
	var releaseOnce sync.Once
	t.Cleanup(func() { releaseOnce.Do(func() { close(release) }) })
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	type result struct {
		handle *registration.Registration
		err    error
	}
	done := make(chan result, 1)
	go func() { h, _, err := client.CreateExact(ctx, expected()); done <- result{h, err} }()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("RPC did not start")
	}
	cancel()
	outcome := <-done
	code(t, outcome.err, "CREATE_OUTCOME_UNKNOWN")
	if outcome.handle == nil {
		t.Fatal("missing original invocation")
	}
	_, err := client.ReadExact(context.Background(), outcome.handle)
	code(t, err, "CREATE_OUTCOME_UNKNOWN")
	code(t, client.DeleteExact(context.Background(), outcome.handle), "CREATE_OUTCOME_UNKNOWN")
	releaseOnce.Do(func() { close(release) })
	deadline := time.Now().Add(3 * time.Second)
	for {
		_, err = client.ReadExact(context.Background(), outcome.handle)
		if err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal(err)
		}
		time.Sleep(time.Millisecond)
	}
	if err = client.DeleteExact(context.Background(), outcome.handle); err != nil {
		t.Fatal(err)
	}
}

func TestUnknownDeleteDoesNotRetryMutation(t *testing.T) {
	client, endpoint, _ := setup(t)
	handle, original := create(t, client)
	endpoint.mu.Lock()
	endpoint.deleteError = status.Error(codes.Unavailable, "provider detail must not escape")
	endpoint.mu.Unlock()
	code(t, client.DeleteExact(context.Background(), handle), "DELETE_OUTCOME_UNKNOWN")
	_, err := client.ReadExact(context.Background(), handle)
	code(t, err, "DELETE_OUTCOME_UNKNOWN")
	code(t, client.DeleteExact(context.Background(), handle), "DELETE_OUTCOME_UNKNOWN")
	endpoint.mu.Lock()
	if endpoint.deletes != 1 {
		t.Fatal("uncertain delete was retried")
	}
	// The external provider subsequently confirms the same object is absent.
	delete(endpoint.entries, original.EntryID)
	endpoint.mu.Unlock()
	if err := client.DeleteExact(context.Background(), handle); err != nil {
		t.Fatal(err)
	}
}

func TestObservedChangeCannotRollBackToOriginal(t *testing.T) {
	client, endpoint, _ := setup(t)
	handle, observation := create(t, client)
	endpoint.mu.Lock()
	original := proto.Clone(endpoint.entries[observation.EntryID]).(*types.Entry)
	endpoint.entries[observation.EntryID].RevisionNumber++
	endpoint.mu.Unlock()
	_, err := client.ReadExact(context.Background(), handle)
	code(t, err, "ENTRY_CHANGED")
	endpoint.mu.Lock()
	endpoint.entries[observation.EntryID] = original
	endpoint.mu.Unlock()
	_, err = client.ReadExact(context.Background(), handle)
	code(t, err, "ENTRY_CHANGED")
}

func TestDeletedEntryReappearanceDoesNotClaimCleanup(t *testing.T) {
	client, endpoint, _ := setup(t)
	handle, observation := create(t, client)
	endpoint.mu.Lock()
	original := proto.Clone(endpoint.entries[observation.EntryID]).(*types.Entry)
	endpoint.mu.Unlock()
	if err := client.DeleteExact(context.Background(), handle); err != nil {
		t.Fatal(err)
	}
	endpoint.mu.Lock()
	endpoint.entries[observation.EntryID] = original
	endpoint.mu.Unlock()
	code(t, client.DeleteExact(context.Background(), handle), "ENTRY_REAPPEARED")
}

func TestInvalidInputsAndClosedClient(t *testing.T) {
	client, endpoint, options := setup(t)
	for _, change := range []func(*registration.ExpectedEntry){
		func(e *registration.ExpectedEntry) {
			e.ParentAgentSPIFFEID = "spiffe://other.test/spire/agent/k8s_psat/test-cluster/node-a"
		},
		func(e *registration.ExpectedEntry) {
			e.ParentAgentSPIFFEID = "spiffe://example.test/spire/agent/k8s_psat/other/node-a"
		},
		func(e *registration.ExpectedEntry) { e.PodUID = "pod/name" },
		func(e *registration.ExpectedEntry) { e.BindingDigest = "" },
	} {
		input := expected()
		change(&input)
		handle, _, err := client.CreateExact(context.Background(), input)
		code(t, err, "INVALID_EXPECTATION")
		if handle != nil {
			t.Fatal("invalid input dispatched")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, _, err := client.CreateExact(ctx, expected())
	code(t, err, "ABORTED")
	endpoint.mu.Lock()
	if endpoint.creates != 0 {
		t.Fatal("invalid input reached provider")
	}
	endpoint.mu.Unlock()
	if err = os.Chmod(options.SocketPath, 0666); err != nil {
		t.Fatal(err)
	}
	_, err = registration.New(options)
	code(t, err, "INVALID_CONFIGURATION")
	if err = client.Close(); err != nil {
		t.Fatal(err)
	}
	_, _, err = client.CreateExact(context.Background(), expected())
	code(t, err, "CLOSED")
}
