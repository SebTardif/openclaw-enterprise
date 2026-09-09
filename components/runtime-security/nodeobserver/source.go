package nodeobserver

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/unix"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"k8s.io/cri-api/pkg/apis/runtime/v1"
)

// Source is owned by one immutable deployment configuration. Its API has no
// injectable observation callback, supplied runtime PID or caller-selected path.
type Source struct {
	self                *Source
	enrollment          Enrollment
	configuration       *protectedFile
	configurationDigest string
	binary, root        *protectedFile
	cri                 *protectedSocket
	kubernetes          *kubeClient
	mu                  sync.Mutex
	closed              bool
	active              sync.WaitGroup
	lifetime            context.Context
	cancel              context.CancelFunc
}

func Open(path string) (*Source, error) {
	f, err := openProtected(path, false, 0)
	if err != nil {
		return nil, err
	}
	raw, err := f.bytes(16384)
	if err != nil {
		f.file.Close()
		return nil, err
	}
	e, err := ParseEnrollment(raw)
	if err != nil {
		f.file.Close()
		return nil, err
	}
	s := &Source{enrollment: e, configuration: f, configurationDigest: hash(raw)}
	s.lifetime, s.cancel = context.WithCancel(context.Background())
	s.self = s
	ok := false
	defer func() {
		if !ok {
			s.Close()
		}
	}()
	s.binary, err = openProtected(e.RunscPath, false, 0)
	if err != nil {
		return nil, err
	}
	s.root, err = openProtected(e.RuntimeRoot, true, 0)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	actual, err := fileHash(ctx, s.binary.file, 256<<20)
	if err != nil || actual != e.RunscDigest {
		return nil, ErrUnavailable
	}
	s.cri, err = openSocket(e.CRIPath, 0)
	if err != nil {
		return nil, err
	}
	s.kubernetes, err = newKubernetes(e)
	if err != nil {
		return nil, err
	}
	ok = true
	return s, nil
}

func (s *Source) Enrollment() Enrollment {
	if s == nil || s.self != s {
		return Enrollment{}
	}
	return s.enrollment
}
func (s *Source) current() error {
	if s == nil || s.self != s {
		return ErrUnavailable
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.configuration.current() != nil || s.binary.current() != nil || s.root.current() != nil || s.cri.current() != nil || s.kubernetes.current() != nil {
		return ErrUnavailable
	}
	return nil
}
func (s *Source) Close() {
	if s == nil || s.self != s {
		return
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	s.mu.Unlock()
	s.cancel()
	s.active.Wait()
	if s.cri != nil {
		s.cri.close()
	}
	if s.kubernetes != nil {
		s.kubernetes.close()
	}
	for _, f := range []*protectedFile{s.configuration, s.binary, s.root} {
		if f != nil {
			f.file.Close()
		}
	}
}

// capture retains the original source request and all physical handles until
// inspection/close. It is private: public code cannot fabricate a live capture.
type capture struct {
	source     *Source
	request    Request
	record     Record
	raw        []byte
	sentry     *processHandle
	ctx        context.Context
	cancel     context.CancelFunc
	stopSource func() bool
	cri        *grpc.ClientConn
	runtime    v1.RuntimeServiceClient
	mu         sync.Mutex
	closed     bool
}

func (s *Source) capture(ctx context.Context, r Request, requestDigest string) (*capture, error) {
	deadline, err := time.Parse(time.RFC3339Nano, r.Deadline)
	e := s.enrollment
	if err != nil || deadline.After(time.Now().Add(Lifetime)) || !deadline.After(time.Now()) || r.SourceRef != e.SourceRef || r.SourceVersion != e.Version || r.ClusterRef != e.ClusterRef || r.NodeUID != e.NodeUID || r.Namespace != e.Namespace {
		return nil, ErrUnavailable
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil, ErrUnavailable
	}
	s.active.Add(1)
	s.mu.Unlock()
	owned, cancel := context.WithDeadline(ctx, deadline)
	c := &capture{source: s, request: r, ctx: owned, cancel: cancel}
	c.stopSource = context.AfterFunc(s.lifetime, cancel)
	ok := false
	defer func() {
		if !ok {
			c.close()
		}
	}()
	// The channel cannot reconnect to another Unix socket after a disconnect.
	var dialMu sync.Mutex
	dialed := false
	cc, err := grpc.NewClient("passthrough:///owned-cri", grpc.WithTransportCredentials(insecure.NewCredentials()), grpc.WithDisableRetry(), grpc.WithContextDialer(func(call context.Context, _ string) (net.Conn, error) {
		dialMu.Lock()
		defer dialMu.Unlock()
		if dialed {
			return nil, ErrUnavailable
		}
		dialed = true
		return s.cri.dial(call)
	}), grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(4<<20), grpc.MaxCallSendMsgSize(16<<10)))
	if err != nil {
		return nil, ErrUnavailable
	}
	c.cri = cc
	c.runtime = v1.NewRuntimeServiceClient(cc)
	physical, process, err := s.observe(owned, r, c.runtime)
	if err != nil {
		return nil, err
	}
	c.sentry = process
	c.record = Record{SchemaVersion: 1, Kind: "node-physical-execution", RequestDigest: requestDigest, EnrollmentDigest: s.configurationDigest, ObservedAt: time.Now().UTC().Format(time.RFC3339Nano), ValidUntil: deadline.UTC().Format(time.RFC3339Nano), Physical: physical}
	c.raw = encoded(c.record)
	if len(c.raw) > MaxBytes || c.current() != nil {
		return nil, ErrUnavailable
	}
	ok = true
	return c, nil
}
func (c *capture) close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	c.closed = true
	c.cancel()
	c.stopSource()
	if c.cri != nil {
		c.cri.Close()
	}
	if c.sentry != nil {
		c.sentry.close()
	}
	c.source.active.Done()
}
func (c *capture) current() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed || c.ctx.Err() != nil || c.sentry.current() != nil || c.source.current() != nil {
		return ErrUnavailable
	}
	again, process, err := c.source.observe(c.ctx, c.request, c.runtime)
	if process != nil {
		defer process.close()
	}
	if err != nil || !bytes.Equal(encoded(again), encoded(c.record.Physical)) || c.sentry.current() != nil {
		return ErrUnavailable
	}
	return nil
}

func bootID() (string, error) {
	f, err := os.Open("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return "", ErrUnavailable
	}
	defer f.Close()
	var fs unix.Statfs_t
	if unix.Fstatfs(int(f.Fd()), &fs) != nil || fs.Type != unix.PROC_SUPER_MAGIC {
		return "", ErrUnavailable
	}
	var raw [128]byte
	n, err := f.Read(raw[:])
	if err != nil {
		return "", ErrUnavailable
	}
	value := strings.TrimSpace(string(raw[:n]))
	if len(value) != 36 || !ref.MatchString(value) {
		return "", ErrUnavailable
	}
	return value, nil
}

func (s *Source) observe(ctx context.Context, r Request, client v1.RuntimeServiceClient) (Physical, *processHandle, error) {
	var p Physical
	if s.current() != nil || ctx.Err() != nil {
		return p, nil, ErrUnavailable
	}
	boot, err := bootID()
	if err != nil {
		return p, nil, err
	}
	e := s.enrollment
	n, ns, pod, err := s.kubernetes.objects(ctx, e, r, boot)
	if err != nil {
		return p, nil, err
	}
	sandboxes, err := client.ListPodSandbox(ctx, &v1.ListPodSandboxRequest{Filter: &v1.PodSandboxFilter{LabelSelector: map[string]string{"io.kubernetes.pod.uid": r.PodUID}}})
	if err != nil || len(sandboxes.Items) != 1 {
		return p, nil, ErrUnavailable
	}
	sandbox := sandboxes.Items[0]
	if sandbox == nil || !runtimeID.MatchString(sandbox.Id) || sandbox.Metadata == nil || sandbox.Metadata.Uid != r.PodUID || sandbox.Metadata.Name != r.PodName || sandbox.Metadata.Namespace != e.Namespace || sandbox.RuntimeHandler != "oce-gvisor-systrap" || sandbox.State != v1.PodSandboxState_SANDBOX_READY || sandbox.CreatedAt <= 0 {
		return p, nil, ErrUnavailable
	}
	status, err := client.PodSandboxStatus(ctx, &v1.PodSandboxStatusRequest{PodSandboxId: sandbox.Id})
	if err != nil || status.Status == nil || status.Status.Id != sandbox.Id || status.Status.State != v1.PodSandboxState_SANDBOX_READY || status.Status.Metadata == nil || status.Status.Metadata.Uid != r.PodUID || status.Status.CreatedAt != sandbox.CreatedAt {
		return p, nil, ErrUnavailable
	}
	items, err := client.ListContainers(ctx, &v1.ListContainersRequest{Filter: &v1.ContainerFilter{PodSandboxId: sandbox.Id}})
	if err != nil || len(items.Containers) == 0 || len(items.Containers) > 16 {
		return p, nil, ErrUnavailable
	}
	expected := map[string]containerStatus{}
	for _, item := range append(pod.Status.InitContainerStatuses, pod.Status.ContainerStatuses...) {
		if _, exists := expected[item.Name]; exists || !name.MatchString(item.Name) {
			return p, nil, ErrUnavailable
		}
		expected[item.Name] = item
	}
	if len(expected) != len(pod.Spec.Containers)+len(pod.Spec.InitContainers) || len(items.Containers) != len(expected) {
		return p, nil, ErrUnavailable
	}
	declared := map[string]bool{}
	for _, item := range append(pod.Spec.InitContainers, pod.Spec.Containers...) {
		if _, exists := expected[item.Name]; !exists || declared[item.Name] {
			return p, nil, ErrUnavailable
		}
		declared[item.Name] = true
	}
	for _, item := range items.Containers {
		if item == nil || item.Metadata == nil || !runtimeID.MatchString(item.Id) || item.PodSandboxId != sandbox.Id {
			return p, nil, ErrUnavailable
		}
		api, exists := expected[item.Metadata.Name]
		if !exists || api.ContainerID != "containerd://"+item.Id || api.RestartCount != item.Metadata.Attempt {
			return p, nil, ErrUnavailable
		}
		delete(expected, item.Metadata.Name)
		result, err := client.ContainerStatus(ctx, &v1.ContainerStatusRequest{ContainerId: item.Id})
		if err != nil || result.Status == nil {
			return p, nil, ErrUnavailable
		}
		cs := result.Status
		if cs.Id != item.Id || cs.Metadata == nil || cs.Metadata.Name != item.Metadata.Name || cs.Metadata.Attempt != item.Metadata.Attempt || cs.CreatedAt <= 0 || cs.ImageRef == "" || cs.ImageRef != item.ImageRef || imageIdentity(cs.ImageRef) == "" || imageIdentity(api.ImageID) != imageIdentity(cs.ImageRef) || !(cs.State == v1.ContainerState_CONTAINER_RUNNING || cs.State == v1.ContainerState_CONTAINER_EXITED) {
			return p, nil, ErrUnavailable
		}
		p.Containers = append(p.Containers, Container{ID: cs.Id, Name: cs.Metadata.Name, Attempt: cs.Metadata.Attempt, ImageRef: cs.ImageRef, CreatedAt: strconv.FormatInt(cs.CreatedAt, 10), StartedAt: strconv.FormatInt(cs.StartedAt, 10), FinishedAt: strconv.FormatInt(cs.FinishedAt, 10), State: cs.State.String()})
	}
	sort.Slice(p.Containers, func(i, j int) bool { return p.Containers[i].Name < p.Containers[j].Name })
	raw, err := runtimeState(ctx, s.binary, s.root, sandbox.Id)
	if err != nil {
		return p, nil, err
	}
	var state struct {
		ID     string `json:"id"`
		PID    int    `json:"pid"`
		Status string `json:"status"`
	}
	if json.Unmarshal(raw, &state) != nil || state.ID != sandbox.Id || state.PID < 1 || state.Status != "running" {
		return p, nil, ErrUnavailable
	}
	process, err := openProcess(ctx, state.PID, e.SentryDigest, 0)
	if err != nil {
		return p, nil, err
	}
	ok := false
	defer func() {
		if !ok {
			process.close()
		}
	}()
	// Re-read the actual runsc owner after acquiring the kernel process handle;
	// matching expected fields alone cannot validate a PID from a stale state file.
	again, err := runtimeState(ctx, s.binary, s.root, sandbox.Id)
	if err != nil || !bytes.Equal(raw, again) || process.current() != nil {
		return p, nil, ErrUnavailable
	}
	p.NodeUID = n.Metadata.UID
	p.NodeResourceVersion = n.Metadata.ResourceVersion
	p.NamespaceUID = ns.Metadata.UID
	p.PodUID = pod.Metadata.UID
	p.PodResourceVersion = pod.Metadata.ResourceVersion
	p.BootID = boot
	p.SandboxID = sandbox.Id
	p.SandboxCreatedAt = strconv.FormatInt(sandbox.CreatedAt, 10)
	p.SandboxAttempt = sandbox.Metadata.Attempt
	p.RuntimeStateDigest = hash(raw)
	p.RuntimeBinaryDigest = e.RunscDigest
	p.Sentry = process.process
	end, err := bootID()
	if err != nil || end != boot || s.current() != nil || ctx.Err() != nil {
		return p, nil, ErrUnavailable
	}
	ok = true
	return p, process, nil
}

func imageIdentity(value string) string {
	if digest.MatchString(value) {
		return value
	}
	index := strings.LastIndex(value, "@sha256:")
	if index > 0 && digest.MatchString(value[index+1:]) {
		return value[index+1:]
	}
	return ""
}
