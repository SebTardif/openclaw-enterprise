# Hosted native execution owner

`HostedNativeOwner` connects the original Node hosted harness to the canonical turn journal. Its only constructor acquires the concrete upstream Workload API and mutual TLS connection. It does not accept a generic service context or a ready DTO as a substitute for the native socket.

This is a component integration surface. A production caller, protected SPIFFE enrollment, original human/Agent authorization, independent ongoing control and stop responsibility, and the compatible native construction gate remain required. The component supplies no positive fallback for missing authority. See the [turn journal](turn-journal.md) for canonical persistence and the [runtime authority interfaces](runtime-authority.md) for independently authenticated calls.

## Composition

1. Connect the selected upstream harness with the exact assignment and trusted bootstrap inputs. Supply a genuine `HostedNativeControlSource`; it must acquire and validate independently authenticated current calls for continuation or interruption of the exact execution and start.
2. Bind the owner's `evidence` inspection methods into the original journal's evidence provenance port. These inspect private membership originating from actual native ready/interruption exchanges and recheck current authority and the owned socket on use.
3. Bind that same original `TurnJournalStore` with `bindJournal`.
4. Pass the original authorized dispatch, verified consumption, text turn and actual authority call to `dispatchAndConsumeAndInitiate`.

The last operation invokes the original combined store transaction once. Its callback retains the actual guard object, correlates the original attempt and text turn, and forwards them to `SelectedExecutionController.acceptInitiation`. The controller performs no second consumption. Copied or reopened guards cannot acquire the private original clock membership.

The upstream adapter sends the exact selected intent and original input on its owned socket. It retains an opaque ready handle independently from the start DTO. This owner wraps that actual receipt in private evidence membership, allowing the original journal to retain the canonical start before the native gate is confirmed.

## Currentness and uncertainty

The initiation guard ends with the original callback. During acceptance, `journal/armExecution` identifies the actual pending native construction on the authenticated socket. The canonical controller transfers the original committed `pre-commit-monotonic-v2` clock once into a retained stop owner and issues mandatory `host-stop-v2` conditional self-cleanup of only that construction. Its full control is retained canonically before the reverse reply allows native construction to proceed. The resulting `host-controlled-v2` start embeds this exact control, without a guest-clock mapping. Both modes retain this control: `deadlineAtMs` is `null` for uncapped selection or exactly the safe integer `anchorAtMs + maximumExecutionMs` for a finite cap.

A finite cap arms a timer against the original process clock; bounded waits and monotonic rechecks preserve long configured durations. Uncapped selection arms no duration timer. At finite expiry or a protective stop request, the retained closure sends direct `native/cancelConstruction` using its original target and control. It requires no fresh human grant, continuation check or database write. Its promise observes the cancellation request; it does not establish physical settlement or release capacity. A cancellation before arm acknowledgment keeps late acceptance gated. Process loss remains unknown, without a daemon-survival guarantee.

Ongoing checks obtain separate current authority calls; each returned operation guard retains the exact call's signal and deadline through submission. No serialized `AuthorityCallV1` or native identity label creates a trusted context.

An uncertain native acceptance retains ownership without a second acceptance or capacity reclamation. When acceptance fails after stop transfer but before a ready owner is retained, the controller requests the original construction cleanup even in uncapped mode. `resolveStart` uses the controller's original canonical readback. `requestInterruption` records the exact independently authorized interruption; `resolveInterruption` exposes canonical recovery for an uncertain journal retention acknowledgment. A potentially submitted native interruption is not automatically submitted again.

The `closed` promise establishes native TLS socket closure only. Native turn completion, transport loss, interruption acknowledgment and physical closure of all execution tasks/children remain distinct. Neither socket loss nor a terminal event authorizes a new execution or proves workspace release.

## Configuration and verification

The [Agent duration setting](agents.md#execution-duration-selection) defaults to
uncapped and admits an explicit finite-or-null revision snapshot. The journal
component consumes the original authority's matching selection. Both selections
require the same retained stop control; a large timestamp, Infinity or omitted
control cannot represent uncapped execution. The
[implementation record](../../specs/24-configurable-execution-limits.md) separates
these implemented components from the remaining production composition and
native qualification.

The selected SDK must contain the concrete connector and matching public
`pre-commit-monotonic-v2`, `host-stop-v2` and `host-controlled-v2` codecs, and the
native construction gate must implement that same contract. `HostedNativeOwner`
passes these values through the connector; it does not translate older SDK or
native wire formats. Configure the Workload API socket, exact local/native
SPIFFE IDs, assignment, native `/native` endpoint and finite transport/authority
bounds through the trusted host composition. There is no production dispatcher
that selects the saved revision policy for this component, standalone server
command or environment-based authority factory supplied by this module.

The upstream socket tests use generated identities and actual local TLS/Unix sockets. Controlled protocol responses prove Node adapter behavior only. Original dispatch-clock and journal tests separately exercise real PostgreSQL persistence. A composed real native/journal acceptance, uncapped continuation, finite expiry and independently requested interruption with physical task/helper closure are still required before claiming a qualified provider-backed model turn or deployed gVisor execution. Source changes or a locally rebuilt SDK do not establish those outcomes.

To run the journal/transport integration test, prepare the matching SDK and Codex
plugin using the repository build procedure. Configure `OCC_TEST_DATABASE_URL`
for the limited-role test database, `OCC_TEST_CODEX_PLUGIN_ROOT` for that prepared
plugin installation, and the matching OpenClaw test configuration/state paths.
Then run:

```sh
node --test tests/integration/hosted-native-owner.test.mjs
```

The test verifies that the plugin and OCC resolve the same installed SDK. It
uses actual PostgreSQL transactions and TLS sockets, controlled initial
admission/current-authority fixtures, and a synthetic native endpoint. It does
not execute Rust Core or establish production enrollment or physical task joins.
