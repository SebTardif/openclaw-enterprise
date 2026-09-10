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

## Cleanup and restart limits

DEL returns nonterminal cleanup uncertainty and preserves the original table and handles. Deletion intent does not prove the original interface is gone, and this component does not remove a name-matching successor. The original runtime must retain the unresolved cleanup responsibility.

The owner is scoped to one dedicated service process. Dropping it is service shutdown: pending native processes receive a stop request without a blocking destructor or a claim of observed settlement. The independent original stop owner must retain that uncertainty and its receipts.

A new service process refuses existing operation receipts and an existing socket path. It cannot reconstruct old netlink subscriptions or generation identity from persisted numbers. Restart adoption and terminal cleanup are not implemented. Operator deletion of evidence is not a supported recovery protocol.

TODO(node-network-fence): connect observed attachment retirement and the original runtime's cleanup responsibility before supporting terminal cleanup or a restart recovery operation. Positive endpoint admission additionally requires the original current runtime/profile/grant and authenticated endpoint producers. Neither capability can be supplied by a caller-created receipt or Boolean.

The internal Go node observer also has a retained process-network-namespace helper. Its existing physical-execution protocol remains unchanged. A runsc sentry's namespace is not automatically the workload's CNI namespace; that correspondence is an independent receiving prerequisite. See [node execution observer](node-execution-observer.md).

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
