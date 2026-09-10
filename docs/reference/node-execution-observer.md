# Node execution observer

`oce-node-observer` captures physical execution on one explicitly selected
Kubernetes node. It is a protected node-local source intended for a dedicated
managed node DaemonSet. The executable and concrete controller client are
implemented; privileged installation, actual node enrollment and live runsc/CRI
qualification remain prerequisites. No DaemonSet is installed by this component.

The result is `node-physical-execution`. It is not a `RuntimeBinding`, an OCC
trusted context, a protected restart discriminator, an inner-gVisor caller proof,
or a complete delivered/effective profile. Production observer composition must
still obtain the original current enrollment, profile and effect owners.

## Protected deployment inputs

Run the server with `oce-node-observer serve <protected-enrollment-file>`. The
deployment owner supplies a regular root-owned enrollment file and protects it
and its parent directories from replacement. The file contains the exact source
reference/version, cluster reference, node name/UID, one namespace, exact server
and controller SPIFFE IDs, trust-bundle digest, listening IP/port, Workload API
socket, CRI socket, runsc state directory, pinned runsc/sentry digests, and the
authenticated Kubernetes API endpoint and credential-file paths. The closed
`Enrollment` type in `components/runtime-security/nodeobserver/protocol.go`
defines the fields; there are no path, identity or enrollment defaults.

The source requires Linux `openat2`, pidfds and actual procfs. Runtime and
credential paths reject symlinks and group/world-writable files. Configuration,
CA and token files must be regular protected files; projected symlink trees are
not supported by this first implementation. Selected root-owned CRI Unix sockets
are checked against actual kernel peer credentials. Deployment should grant only
the source and kernel observation access required by the selected runtime.
In particular, runsc state-file locking and permissions on a read-only-mounted
runtime root still require qualification with the selected installed runsc.
Compiling or testing this component does not establish that mount compatibility.

The node's Workload API must deliver the exact configured X.509-SVID and trust
bundle. The maintained service-peer transport owns the actual mutual TLS
connection and rechecks source and certificate lifetime. Requests cannot select
another node, namespace, source version, path or peer. The controller's separate
protected configuration supplies its own Workload API socket and the expected
digest of the server's original enrollment bytes. Neither configuration file nor
its digest establishes enrollment by itself.

## Physical capture and currentness

The original authenticated `capture-execution` request contains an exact Pod
name/UID and deadline, plus correspondence to the selected source, cluster,
node and namespace. The maximum capture lifetime is ten seconds, with one
connection/capture admitted at a time and 64-KiB protocol frames. The client
executable has a thirteen-second total owned-stdio bound, including startup.

The source reads the actual Node, Namespace and Pod through the configured
authenticated Kubernetes API. The Node UID and boot identity must match the
selected node and actual kernel boot identity. It reads the selected CRI v1
socket, requires one unambiguous ready sandbox for that Pod, and captures each
current container's ID, attempt, image reference, state and timestamps. It
rejects incomplete or ambiguous container inventories rather than selecting a
preferred candidate. Up to sixteen containers are supported. The source retains
the original CRI socket inode, and each capture keeps its original CRI connection
through all inspections. A replaced socket or lost connection cannot be silently
reconnected or admitted as the original source.

The original pinned runsc file descriptor executes a bounded `state` command
against the retained runtime-state directory descriptor. No shell or arbitrary
command is accepted. The source opens the returned sentry process through
procfs, holds its pidfd, reads its start identity and PID namespace, and hashes
the actual executable. It repeats the runtime state read after acquiring that
kernel handle. Commands are interrupted and joined on deadline or cancellation.

Before returning a record or answering an inspection, the source rechecks its
protected files and the original TLS request, repeats API/CRI/runtime
observation and compares the complete physical result. Changes or unavailable
inputs close the exchange without a positive response. The returned record
retains the original request digest, enrollment digest and source timestamps.
The client keeps that same TLS connection; a copy of the record cannot inspect
or revive it. Captured timestamps and IDs remain physical source observations,
not independent service admission or full runtime authority.

## Controller integration and verification

The narrow `node-execution-client.ts` sibling constructs the concrete native
client and owns its child, exact request and retained physical handle. It supplies
no default enrollment and is not attached to the production observer's execution
producer port. That attachment requires actual protected source admission and
the remaining profile/current-use owners. It cannot use a lifecycle caller's
context as the node's source context.

Run `go test -race ./nodeobserver` from `components/runtime-security` for actual
Linux process/file/socket checks and generated-SVID Workload API/TLS request
custody. These tests do not open a production CRI socket or assert live node
enrollment. Build `./cmd/oce-node-observer`, protect the executable against
replacement, select it with `OCC_NODE_OBSERVER_TEST_BINARY`, and run
`node --test tests/integration/node-execution-client.test.mjs` for the concrete
client's missing-source/cancellation behavior. The native test explicitly skips
when no executable is selected.

Positive node execution acceptance requires a separately selected disposable
cluster with actual gVisor, CRI, protected node enrollment, API credentials and
runtime artifacts. The current component checks do not establish that result.
See [runtime effects](runtime-effects.md) for the larger observation contract.

## Internal network-namespace contribution

The Linux source also includes an internal helper obtained from the original retained process handle. It retains that process's network namespace and subscribes to link notifications before capture; observation loss or changed process, namespace or link state invalidates it. It has no public constructor or restored identity representation and does not change the physical-execution record above.

For runsc, the sentry process's namespace is not automatically the workload's CNI namespace. The helper does not establish that correspondence, installed network enforcement or current authority. The separately owned [closed node network attachment](node-network-fence.md) documents the CNI/veth boundary and remaining qualification requirements.
