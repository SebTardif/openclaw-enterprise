# Lifecycle status fixture preview

`apps/controller/src/console/lifecycle-presentation.mjs` is a read-only display
adapter for lifecycle fixtures. It exercises the existing console DOM and view
lifetime helpers without connecting the console to a lifecycle API. Every
rendered view is marked **Fixture preview only · no live status or operations**.
The production console does not import or serve this module.

The [minimum operator workflow](operator-workflow.md) remains the entrypoint for
supported management commands and their current limits. This preview neither
adds lifecycle commands nor establishes serving, shutdown, retention, or purge.
Browser chat remains unexposed.

## Run the selected checks

From a checkout with the required Node version:

```sh
node --test tests/browser/console-lifecycle-presentation.test.mjs
```

This suite has no package dependencies. It calls the actual presentation module,
`dom.mjs`, and `view-lifetime.mjs` using a recording DOM port. It verifies displayed
text and attributes, safe projection, view invalidation, and absence of production
imports. The port does not parse HTML or implement browser layout. These are
**controlled-DOM tests**, despite the test directory name; they do not establish
Chromium rendering, session authentication, server authorization, or actual HTTP
behavior. No browser install, server, database, provider, or runtime is started.

## Display adapter lifetime

`createLifecyclePresentation(view)` accepts the destination DOM element. Its
methods manage a single preview, with no event listeners, polling, network
client, storage, or operation controls:

| Method                     | Meaning                                                                                                                                                                           |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `begin(scope, capability)` | Clears the prior preview, copies the exact fixture Namespace/Agent selection, and returns a new display token. Invalid scope or capability returns null with an unavailable view. |
| `present(token, result)`   | Displays one result only for the current token. A token is consumed once. Superseded, duplicated, cleared, or disposed tokens return false and cannot alter the view.             |
| `clearAccess()`            | Invalidates pending results and removes private fixture content. The caller must arrange any real session/scope checks in a future consumer.                                      |
| `dispose()`                | Permanently invalidates the instance and empties its view.                                                                                                                        |

Tokens manage local display lifetime. They are not authentication, an operation
locator, an access grant, or proof of current server permission. A future
consumer must separately provide authenticated reads, exact scope checks, and
session revocation behavior before using these display functions.

The `capability` argument is a local fixture selector: `legacy`, `drain`, or
`lifecycle-control-v1`. It is not a proposed server capability DTO or feature flag.
Legacy fixtures leave lifecycle preview unavailable. Drain fixtures can display
read projections and minimal disable/stop receipts, but reject deploy/resume
receipts. Live fixtures exercise the selected future display shapes. Missing or
unknown capability stays unavailable. None enables a protocol against the
current bodyless deployment bridge or grants an operation permission.

## Fixture results and truthful presentation

The local `result.kind` selects a presentation branch. `envelope` contains the
corresponding sanitized fixture response. These display selectors are not new
HTTP endpoints or a server schema; the canonical server projection and generated
client remain separate implementation work.

| Kind          | What is displayed                                                                                                                                               | What remains unestablished                                                                                                                                                                        |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`      | Exact fixture owner, distinct requested/selected/serving revision observations, head and observed generation, operation observation, and independent conditions | Matching generations alone do not prove freshness. A stale observation stays explicitly stale; no client freshness budget is invented.                                                            |
| `receipt`     | Minimal accepted-operation fields or the minimal unchanged generation/mode response                                                                             | Admission is not serving. An unchanged response creates no operation and discloses no prior revision or head.                                                                                     |
| `error`       | Closed safe reason classes and a valid diagnostic request ID                                                                                                    | Backend message/details never supply current generation, private state, or a successful outcome.                                                                                                  |
| `interrupted` | Unknown outcome and a warning against automatic POST replay                                                                                                     | An interrupted response does not establish absence, rollback, cancellation, or success.                                                                                                           |
| `discovery`   | Bounded candidate count with an unresolved-recovery message                                                                                                     | Zero, one, or several candidates cannot identify an uncertain request from equal content, timestamps, or an empty page.                                                                           |
| `history`     | A supplied exact operation matching the separately known `operationRef`, with its immutable fields and historical observation                                   | This fixture assumes a separately authorized exact historical read. It does not verify the server's immutable association, grant current execution authority, or turn cancellation into rollback. |

Unknown or malformed display shapes remain unavailable. No raw object is
stringified into the page. The preview accepts only the finite fields it renders;
additional protected fields or unsupported retained-store projections require a
canonical producer handoff before display support. Values pass through the
existing DOM text helper, and backend diagnostics are replaced with fixed local
messages. Original `observedAt` and `recordedAt` strings are preserved. Null
observations remain missing; no timestamp is replaced with the browser's clock.

The supplied `serving` and `stopComplete` predicates are labeled as values in the
fixture observation. The adapter never computes them by combining conditions.
In particular:

- An active database selection is distinct from a serving observation.
- A false serving predicate does not prove execution terminated.
- Access denial, route removal, execution termination, credential revocation,
  and retained state remain five independent conditions.
- A supplied physical-stop-complete observation can coexist with uncertain
  credential revocation or retention verification; neither becomes confirmed.
- A superseded historical operation remains historical after head advancement.
  No result offers a mutation retry, arbitrary candidate selection, or purge.

## Required production and operator handoffs

The retained console integration still needs the canonical browser-compatible
schema/client and sanitized status/history projector, followed by the actual
server-owned legacy/drain/live capability and coordinated cutover. A fixture
selector cannot replace those pieces. Production integration must preserve
[authentication](../reference/authentication.md), exact action and resource
visibility, and the [console's session and stale-response behavior](../reference/console.md).

Executable lifecycle/status/recovery procedures must establish accepted intent,
current authorized observations, separate denial and termination results,
stale-generation recovery, and uncertainty after a lost response. Until that
procedure is implemented and exercised, the
[operator entrypoint](operator-workflow.md#disable-stop-retention-and-purge-limits)
continues to identify it as unavailable.

The persistence owner separately supplies the supported retained-stop and
explicit exact-owned purge procedure, including incomplete deletion, an
unaffected second Agent, and live-store versus backup/volume/audit/provider
exclusions. This preview selects no public purge endpoint. Lifecycle management
permission also supplies no collaboration transcript, channel turn-status, or
cancellation authority.

Installed console checks, a second operator's executable rehearsal, real
Slack/Teams interaction, persistence and runtime qualification remain separate.
Passing these fixture tests completes only their display behavior; it cannot
complete the retained operator workflow or those provider obligations.
