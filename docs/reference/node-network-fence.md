# Closed node network attachment

`oce-network-fence` implements a closed network attachment component for a separately provisioned Linux node. It creates harmless ACCEPT anchors first and activates bidirectional DROP only after proving the retained attachment and original kernel handles. It has no endpoint-opening operation, runtime grant, profile admission, or SDK submission API.

This is component source. Production CNI installation and the actual containerd/runsc start ordering require separate qualification. A successful closed CNI ADD is not workload readiness or evidence that all sandbox execution started after that ADD. A runtime configured with networking disabled does not qualify native-network traversal.

## Original attachment ownership

The protected node service receives a network-namespace FD from a root-owned CNI invocation over one Unix `SOCK_SEQPACKET` connection. The descriptor enters owned custody before request validation. ADD and CHECK require exactly one descriptor; DEL requires none. Both peers require kernel-observed root credentials. The fixed socket is `/run/oce-network-fence/control.sock`; the service refuses an existing path and never unlinks it.

The service retains the original node and Pod namespace FDs and subscribes to link events in both namespaces before their initial dumps. It verifies an actual reciprocal veth pair, including kernel namespace-ID correspondence. Link notifications, overflow, truncation, loss, changed namespaces or mismatched topology permanently invalidate the observation. A name, ifindex or source address cannot revive the old handle. The CNI container/network fields are correlation, not an authenticated original runtime effect or Pod assignment.

Before its first possible kernel write, the service synchronizes a negative operation receipt under `/var/lib/oce-network-fence/operations`. It then creates a fresh dedicated `netdev` table with exactly two initially empty ACCEPT-policy base chains on the host veth: ingress and egress at priority -500. ACCEPT in these neutral chains does not override another firewall's denial or authorize workload readiness. It reads the actual installed table and rejects extra objects, rules, chains, flags or changed attachment fields. A nonzero kernel ruleset generation is captured before this single creation transaction. The resulting generation must advance exactly once; strict neutral readback, retained namespace/link checks and a second equal generation observation establish the original anchor handles. Competing ruleset mutations refuse activation.

Activation is a single raw nfnetlink transaction against that original nonzero generation. It changes both policies by retained chain HANDLE only, without chain names, hooks, device lookup, creation or retry. Kernel generation comparison prevents same-named table replacement from reusing numeric chain handles. Device removal deletes the original netdev chains; a missing handle refuses activation instead of binding a successor. The service reports closed only after actual DROP readback and current attachment checks. A name-replacement race during the first phase can leave a harmless anchor on a successor, but cannot activate DROP there.

The acquisition has a ten-second currentness ceiling and one-second response waits. These are checks around operations, not hard syscall deadlines: Linux can process netfilter submission synchronously while waiting for its ruleset mutex. An unreturned syscall or uncertain reply retains the original operation responsibility; it is not observed settlement. The nft executable is a retained protected root-owned ELF file, checked against its selected SHA-256 before and after bounded native invocations. The service does not modify other components' tables.

The node volume and its storage durability require original installation qualification; a synchronized receipt is not proof of power-loss durability on an arbitrary mount. The attempt remains owned after caller disconnect. A failed or timed-out command, lost response, failed readback or uncertain receipt commit never produces a closed response from historical receipt data. If submission may have happened, its negative operation locator remains retained. No error path removes an installed drop.

## Retained closed attachment observations

The same protected socket accepts `OBSERVE` with one retained CNI network-namespace
descriptor and the original container/network/interface correlation. It can
observe only an already closed attempt owned by this service process. The supplied
descriptor must match the original namespace; the service checks the retained
namespace/veth topology and exact installed DROP handles before returning a record.
The record contains the original operation, topology, kernel handles, request
reference and fresh service/observation references. Those references and the
record are evidence locators, not authority to reconstruct an observation.

`INSPECT` requires the original connection, request and observation references,
SHA-256 of the exact original JSON record bytes, and no descriptors. Each successful
inspection repeats actual attachment and DROP readback. A copied record, connection
replacement or altered digest cannot inspect or revive another observation. A
wrong namespace refuses that request without invalidating the genuine attachment.
Actual attachment or rule loss instead retains `observation-unknown` and permanently
invalidates that original attempt; restoring matching rule text does not revive it.

Each observation has a ten-second absolute validity ceiling and sixteen inspections.
These bounds apply to a source read session, not the execution lifetime. A later
independently authenticated observation may use the same still-current original
CNI namespace owner. Expired observations grant no authority between reads. Idle
initial callers and retained observations use bounded polled connection pools;
observation replies are nonblocking. The existing cooperative kernel/process
deadline and unresolved-settlement limits still apply.

The private Go receiving client brackets these exchanges with its original node
capture's currentness checks and retains the exact protected socket and namespace
descriptor. OBSERVE requires that descriptor from its caller; ACQUIRE obtains it
from the original fence ADD owner as described below. Both require the actual
original CRI/Pod/create-effect owner to prove correspondence to the captured
sandbox attempt and assignment. A sentry namespace, Pod label or copied inode
cannot supply that missing association. The physical-execution protocol remains unchanged.
Neither protocol authenticates a DS endpoint or authorizes a positive opening.

`ACQUIRE` provides the original ADD descriptor to that private Go client. It
accepts the same request/container/network/interface fields as OBSERVE with no
incoming descriptors. The original node owner duplicates the CNI namespace FD
held continuously in its retained ADD attempt, brackets the duplication with live
attachment and DROP checks, and returns exactly one descriptor with the initial
observation record. The original namespace path is never reopened. Later INSPECT
requests stay on that connection and exchange no descriptors.

This supplies original ADD descriptor custody to
`capture.acquireAttachment(networkName, interfaceName)`; the source derives the
sandbox selector and request reference from its actual physical capture. The
separate original Compute owner still must pair that ADD with the exact observed
CRI creation timestamp/attempt, Pod UID, node boot and original create effect and
assignment. The network operation reference cannot stand in for an OCC operation,
Work or purpose decision. A new short acquisition must preserve that original
owner correspondence and refuse a changed service/operation/namespace.

The original ADD owner retains its descriptor independently of read-session
closure. A transferred FD may physically outlive a reader or server session;
expiry does not remotely revoke it. Current use still requires fresh inspection
and original-owner checks. Acquisition after DEL or detected genuine source loss
refuses, including after matching rules are restored.

## Cleanup and restart limits

DEL returns nonterminal cleanup uncertainty and preserves the original table and handles. Deletion intent does not prove the original interface is gone, and this component does not remove a name-matching successor. The original runtime must retain the unresolved cleanup responsibility.

The owner is scoped to one dedicated service process. Dropping it is service shutdown: pending native processes receive a stop request without a blocking destructor or a claim of observed settlement. The independent original stop owner must retain that uncertainty and its receipts.

A new service process refuses existing operation receipts and an existing socket path. It cannot reconstruct old netlink subscriptions or generation identity from persisted numbers. Restart adoption and terminal cleanup are not implemented. Operator deletion of evidence is not a supported recovery protocol.

TODO(node-network-fence): connect observed attachment retirement and the original runtime's cleanup responsibility before supporting terminal cleanup or a restart recovery operation. Positive endpoint admission additionally requires the original current runtime/profile/grant and authenticated endpoint producers. Neither capability can be supplied by a caller-created receipt or Boolean.

The internal Go node observer also has a retained process-network-namespace helper. A runsc sentry's namespace is not automatically the workload's CNI namespace; that correspondence is an independent receiving prerequisite. See [node execution observer](node-execution-observer.md).

## Build and controlled verification

The crate uses the workspace's pinned Rust toolchain and existing locked dependencies. After explicit dependency and resource preparation:

```sh
cargo test --manifest-path dataplane/Cargo.toml --locked --offline -p oce-network-fence
cargo build --manifest-path dataplane/Cargo.toml --locked --offline -p oce-network-fence --bin oce-network-fence
```

The standard native product build continues to select its existing products. This executable requires an explicit node-component build and installation selection.

In a separately authorized isolated node fixture, provision root-owned non-writable ancestors for `/run/oce-network-fence`, and separately provision an empty `/var/lib/oce-network-fence/operations` on the selected persistent node volume, then supply a protected nft artifact and its exact selected SHA-256:

```text
oce-network-fence serve /absolute/protected/nft <selected-sha256>
```

For a separately qualified chained CNI installation, the executable accepts standard CNI environment variables and a version 1.0.0 or 1.1.0 configuration with `type: "oce-network-fence"`, a network name and the matching `prevResult`. It forwards the prior result as an opaque JSON object only after actual closed attachment observation. Only its object shape and matching version are checked; interface/IP/route/DNS fields are not interpreted or validated here. The selected preceding plugin and receiving CNI runtime must validate that result. Unknown outer configuration fields and unsupported commands fail. VERSION reports supported protocol versions; it grants no network access.

Unit tests cover the fixed outer CNI schema, strict nft decoding, negative protocol inputs, namespace FD custody, local descriptor transfer and native child timeout/output-overflow ownership. They do not prove installed kernel behavior. Actual verification requires healthy local receivers before attachment, observed bidirectional drop after attachment, original-link replacement, failed/unknown installation, caller loss, daemon death retaining kernel drop, and truthful unresolved cleanup. Execute these only in explicitly owned disposable namespaces with no external routes; retain actual failure and cleanup evidence.

The outer veth fence does not filter communication that remains inside a sandbox, including loopback. It does not establish inner containment, native firewall/DNS identity, or a complete effective runtime profile.

## Reproducible kernel fixture

`dataplane/services/oce-network-fence/tests/kernel_live.py` invokes the actual
service and CNI executable in an explicitly selected disposable Docker container.
It refuses an initial network other than loopback. Supply a compatible built
binary, Python 3, `ip`, `unshare`, `nsenter` and a protected native `nft` executable.
The container requires `NET_ADMIN`, `SYS_ADMIN`, and a seccomp profile permitting
its private network-namespace operations. These are fixture permissions, not an
Agent deployment profile. Use `--network none`, read-only binary/test mounts, and
no host namespaces, Docker socket or writable host volumes.

Inside that separately provisioned fixture, run:

```sh
python3 /absolute/kernel_live.py --binary /absolute/oce-network-fence --isolated-container --scenario closed
```

Run `caller-loss` and `link-replacement` in fresh containers as separate scenarios.
The former closes the actual protected IPC caller before reading its reply and
checks that installation remains owned. The latter replaces the original veth
with an identically named successor and requires stale CHECK refusal without
removing that successor. Every scenario starts with healthy TCP receivers in both
namespaces. The closed path then checks actual bidirectional denial, retained
kernel identity, DEL uncertainty, drop after daemon death, and restart refusal.

The `observation` scenario exercises actual descriptor transfer and retained
readback, exact record bytes/digest, wrong namespace rejection, cross-connection
replay refusal, session budget and expiry, independent re-observation, idle caller
isolation and DEL invalidation. `observation-rules` changes an actual DROP policy
and verifies that later restoration cannot revive the original source.
`observation-link` replaces the observed veth and requires the retained session to
refuse without adopting or deleting the successor. Each needs its own fresh
container. The two link-replacement scenarios stop after successor checks: their
traffic assertions concern the original attachment before replacement, since the
successor has no configured traffic path.

`acquisition`, `acquisition-rules` and `acquisition-link` exercise the same current
read behavior using the descriptor supplied by ACQUIRE. Each removes the original
CNI namespace path after actual ADD and checks that the returned descriptor still
matches the original namespace and record. The cases also reject unexpected
incoming descriptors and missing attempts; DEL, rule loss and link replacement
prevent later acquisition. These remain component namespace/transport tests,
without a claim of original Compute/CRI creation integration.

The selected nft executable must return the attached `dev` in each chain's JSON
readback. The fixture has passed with nftables 1.1.3 and Linux 6.8.0. nftables 1.0.6
omits this field: installation may have happened, but the service refuses to
certify it and retains `installation-unknown`. Only harmless ACCEPT anchors may remain in this case; no DROP activation is attempted. The separate `incomplete-readback`
scenario verifies that actual negative behavior using an explicitly selected older
fixture. Do not omit the device check to accept an incomplete tool response.

These isolated kernel results do not establish containerd/CNI ordering, actual
gVisor traversal, positive endpoint admission, production authentication, crash
recovery or terminal cleanup. Installation qualification must still bind those
properties to its actual selected runtime and node artifacts.

The ignored Rust test `activation::tests::live_original_handle_activation_races`
requires the same fresh network-disabled root fixture, the built test executable,
and `OCE_FENCE_KERNEL_TEST=1`. It performs actual anchor creation/readback followed
by device replacement, table recreation with reused numeric chain handles, or
removal of the second chain. The production policy-only activation must refuse;
no surviving chain may become DROP. The missing-second-chain case additionally
checks atomic rollback of the first policy update.

## Reproducible gVisor traversal fixture

`dataplane/services/oce-network-fence/tests/gvisor_kernel_live.py` exercises the
actual runsc sandbox network stack against the existing CNI/service executable.
It creates one original network namespace and reciprocal veth, supplies that
namespace as the OCI network path, and retains it for actual CNI ADD. The fixture
checks that the same sentry owns the same AF_PACKET socket in that namespace
before and after closure.

Use a separately selected disposable container with the same isolation rules as
the native kernel fixture. Supply Python 3 and its standard library, `ldd`, the
network tools, the built fence binary, and a pinned complete runsc runtime tree
with its required sidecars. Mount the runtime tree, binary and fixture read-only.
Bound the outer container to 2 GiB memory, 2 CPUs and 512 PIDs. The fixture fixes
runsc to sandbox networking, systrap, STRICT sidecars and XDP off; it disables
runsc host-setting adjustments and leaves cgroup limits to the outer container.
It copies at most 256 MiB of Python files from the selected image into a temporary
probe rootfs. The harmless guest runs as UID/GID 1000 with no capabilities and a
read-only root filesystem.

Inside that separately provisioned container, run:

```sh
python3 /absolute/gvisor_kernel_live.py --binary /absolute/oce-network-fence --runsc /absolute/runtime/bin/runsc --isolated-container
```

The fixture limits execution to 270 seconds and bounds each guest readiness or
traffic request to at most 30 seconds. An outer launcher must also enforce a
five-minute deadline and remove only its uniquely named container on timeout.
Preserve the fixture's emitted JSON and the launcher's command, artifact hashes,
exit status and final container-absence observation. Log size is checked after
execution; the launcher must bound retained output independently.

Both the sentry and gofer need permission to change mount propagation in their
private mount namespaces. An outer Docker AppArmor policy can deny that operation
even with `SYS_ADMIN` and a permissive seccomp profile. The bounded fixture has
run with a separately selected container-local `apparmor=unconfined` option; this
is an outer test-container prerequisite, not an Agent runtime profile. Do not
change host profiles or add host namespaces, devices, writable host volumes or
privileged mode to run this test. Preserve actual startup failures without
counting them as network denial.

The actual fixture has passed with runsc release-20260831.0, nftables 1.1.3 and
Linux 6.8.0. It establishes healthy bidirectional IPv4 TCP/UDP delivery and
pre-established TCP connections before ADD, then requires new TCP, UDP and
established-connection payload delivery to fail in both directions after the
original attachment closes. Receiver logs independently exclude those payloads;
local TCP and UDP health probes show that the same receivers remain functional.
The original sandbox PID, AF_PACKET socket and closed CNI CHECK remain current
through the assertions. Teardown force-deletes the test sandbox and removes its
veth; outer container removal retires the remaining private fixture state.

This result qualifies that runsc/veth/fence traversal tuple. It does not establish
cold start behind an already closed fence, containerd/CRI/CNI start ordering,
original Work association, IPv6 or XDP behavior, positive endpoint rules, DS or
workload identity, restart recovery, or product terminal cleanup.
