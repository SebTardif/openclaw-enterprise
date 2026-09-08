# OpenShell gateway client lifetime

Status: implemented in source; execution verification pending. The current
behavior is owned by the [OpenShell driver reference](../docs/reference/drivers/openshell-sandbox.md#gateway-client-lifetime).

## Design alignment and scope

The [platform design](../docs/design.md) assigns Sandbox behavior to the selected
Driver capability. This change keeps mutable call ownership inside the concrete
OpenShell driver and leaves endpoint and option selection as value projection.
It does not change the common Driver contract, worker shutdown, Go adapter,
provider protocol, or supported runtime profiles.

The earlier [options ownership implementation](openshell-options-ownership.md)
remains a point-in-time record. This change preserves accepted immutable
configuration and injected capability identity while replacing the native
endpoint cache with one adapter per call. Historical assumptions about adapter
reuse by endpoint no longer describe the current implementation.

## Ownership

The driver owns a terminal closed flag, an active set of native call records,
and a separate once-only injected-close marker. Each call record holds its
adapter and a close-request marker. Construction failure registers no record;
synchronous invocation failure and asynchronous settlement both run retirement.
There is no Namespace membership table, endpoint cache, or settled-call history.

Native health, create, and revision-delete operations use the same owner.
Options are selected from the existing immutable accepted configuration. Each
call's adapter receives the selected endpoint and unchanged authentication file
paths, preserving operation-time credential reads in the native implementation.
Namespace-only cleanup does not dispose unrelated adapters. A surviving caller
continues using its own adapter even when another Namespace call settles or
cleanup fails, is omitted, or is followed by Namespace recreation.

The injected client remains the exact supplied capability and owns its existing
pending operations. The driver passes requests and signals directly to it and
requests its close only once at driver close. There is no new injected-call
registry or per-operation injected close. Existing construction-time native
executable-path validation remains unchanged.

## Terminal close and settlement

`close(): void` first rejects future admission, then requests cancellation of
every active native adapter and the injected capability. Markers are set before
notifications, so repeated and reentrant close cannot repeat them. All
notifications are attempted and synchronous failures are aggregated. Native
entries remain active until their underlying operations settle. A failed close
request does not prove resource release and does not erase pending ownership.

Settlement requests retirement if close has not already done so, then removes
the settled record. Operation and retirement failures are reported together
when both occur; settled failures are not retained. Abort or deadline
notifications alone do not count as settlement. Never-settled calls remain
owned, so this bounds historical retention by actual unresolved work rather
than imposing a fixed memory or concurrency quota.

Effectful public methods reject newly admitted work after close. An additional
check before gateway invocation handles close during asynchronous preparation.
Already-admitted Kubernetes work keeps its original context signal and may
continue; this change promises neither broad cancellation nor rollback.
`configureAgent` remains a pure projection usable after close.

The synchronous close method requests cancellation rather than joining drain,
subprocess reaping, or provider termination. Generic Driver/worker shutdown
wiring is outside this implementation and is not supplied by Namespace cleanup.

## Verification boundary

The [lifetime conformance suite](../tests/conformance/openshell-client-lifecycle.test.mjs)
uses the actual driver with test-only module mocking of the existing native
client import, supported injected clients, and a minimal test-local subclass at
the existing nominal Kubernetes SDK boundary. The fixtures control public
capability results and real pending promises; they do not patch driver lifetime
methods, rebuild ownership logic, or emulate a native protocol.

Cases cover endpoint churn without cleanup; shared-endpoint survivor usability;
cleanup failure and recreation; constructor and synchronous invocation failures;
abort and signal deadlines before settlement; aggregate cancellation and
reentrancy; admission before use and during resource/readiness awaits; injected
identity and close ownership; immutable selected values; actual health/create/
delete wiring; retirement failures; and calls still unresolved after close.

Execution requires `--experimental-test-module-mocks`, which the `test` and
`test:conformance` scripts supply. See the reference's focused invocation.
Source authoring alone is not a passing check. Real Go adapter/process/protocol,
subprocess-deadline, provider, and cluster verification remain separate from
these controlled driver cases.
