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

## Build and verification

[Build and controlled verification](../testing/node-network-fence.md#build-and-controlled-verification) covers explicit component installation, disposable kernel fixtures and the separately qualified gVisor traversal tuple. Those results do not establish production start ordering, endpoint admission, restart recovery or terminal cleanup.
