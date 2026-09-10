# Closed attachment observations

The node fence exposes a bounded observation protocol on its existing protected
root-owned Unix packet socket. `OBSERVE` must supply one retained network-namespace
descriptor and the original CNI correlation fields. The service observes only an
already closed attachment and returns its original operation, namespace/veth
topology and installed kernel handles. It does not open an endpoint or authenticate
a runtime effect, workload identity or profile.

The receiver retains that socket and namespace descriptor. `INSPECT` on the same
connection must name the original request, observation reference and SHA-256 of
the exact original record bytes. It performs fresh attachment and DROP readback.
Transferred or deserialized records cannot create another observation session.

`ACQUIRE` accepts the same correlation fields with no incoming descriptor. It
duplicates the namespace held continuously by the original live CNI ADD attempt,
then returns exactly one descriptor with the observation record. It never reopens
the original CNI namespace path or reconstructs an attempt from a receipt. The
private Go `capture.acquireAttachment(networkName, interfaceName)` client receives
that descriptor through the protected source and retains the same inspection
connection. The original Compute owner must still establish the exact CRI/Pod,
create-effect and assignment correspondence. An ADD operation locator is not a
Work identity or a current policy decision.

One observation lasts at most ten seconds and permits sixteen inspections. These
are observation validity bounds, not an execution lifetime. A later independently
authenticated observation can use the original still-current CNI namespace owner.
Expiry, a disconnected reader or an invalid inspection ends the read session.
Genuine loss of the original attachment or closed rules retains negative
`observation-unknown` evidence and cannot be revived by restoring matching rules.

Closing a read releases its local descriptors; it cannot revoke an FD already
transferred to another process. A retained FD alone does not make an expired
observation current. Later acquisition requires fresh original-owner checks and
the same still-current original service/ADD attempt; replacements are refused.

The original runtime must supply actual CRI/Pod/create-effect correspondence for
the CNI descriptor. A sentry process namespace, Pod label, address or supplied
inode is insufficient. The Go node observer includes a private receiving client;
its physical execution service still awaits this original source integration.

Idle readers use a bounded polled connection pool and cannot occupy a blocking
first-packet receive. Observation replies are nonblocking; a reader that stops
receiving loses its session. Kernel/process operations retain their existing
cooperative deadline and unresolved-settlement semantics; this protocol does not
turn an unreturned syscall into an observed terminal result.

The executable and source tests use the workspace's existing locked dependencies.
In an explicitly allocated fresh network-disabled kernel fixture, the existing
`tests/kernel_live.py` additionally supports `observation`, `observation-rules`
and `observation-link`.
The corresponding `acquisition`, `acquisition-rules` and `acquisition-link`
scenarios receive the actual original ADD descriptor after its original namespace
path has been removed, and check acquisition refusal for absent or retired state.
These exercise actual CNI attachment, protected descriptor transfer, same-session
inspection, replay/refusal, expiration, independent re-observation, deletion and
permanent rule-loss refusal and refusal of a same-name veth successor. They do not qualify containerd start ordering, gVisor
traffic, workload identity, positive routing, restart recovery or terminal cleanup.

The separate `tests/gvisor_kernel_live.py` fixture uses an actual pinned runsc
sandbox and its original CNI namespace. It checks retained AF_PACKET custody,
healthy bidirectional TCP/UDP and established connections, then denial after
actual CNI ADD while the same receivers remain healthy. See the
[gVisor traversal fixture](../../../docs/reference/node-network-fence.md#reproducible-gvisor-traversal-fixture)
for its disposable-container inputs, resource limits and qualification boundary.
