# Controller GitHub read-service startup

The maintained controller server exposes `createControllerServer` from
`apps/controller/src/server.mjs`. Trusted in-process composition can supply
already-created original GitHub read-service definitions through this function.
The ordinary controller executable uses the same composition path.

## Programmatic composition

`createControllerServer({ githubReadServices })` accepts an optional readonly
array of original `ControllerGitHubReadService` handles. Construct those handles
with the existing `defineControllerGitHubGitReadV3` or separately selected
`defineControllerGitHubMetadataReadV2` factory from
`apps/controller/src/composition/github-read-mediation.ts`, using the actual
accepted-execution, Work and native deployment owners. Keep this assembly in a
fixed trusted process callsite.

The function copies the array before its first asynchronous operation, preserving
each handle by identity, and forwards the captured list once to
`composeProduction`. The original production factory remains responsible for
definition membership and construction refusal. Copying a definition's fields
does not create a valid original handle. YAML, environment strings, requests and
dynamic module-path loading cannot supply read-service authority.

All existing startup environment, Installation configuration, Driver and logging
validation still applies. Omitting `githubReadServices`, or setting it to
`undefined`, preserves the existing startup selection. An explicit list,
including an empty list, is refused in development mode. Non-array selections
are refused before asynchronous startup work.

The result contains:

| Field           | Caller responsibility                                                                 |
| --------------- | ------------------------------------------------------------------------------------- |
| `app`           | The composed controller app; close it when finished, including after a failed listen. |
| `listenOptions` | The validated `{ host, port }` for `app.listen()`.                                    |
| `logger`        | The selected controller logger.                                                       |

Importing the module does not compose, listen or install signal handlers.
Programmatic callers own listening, shutdown and error reporting. For example,
after a trusted static assembly has obtained `originalReadServices`:

```js
const { app, listenOptions } = await createControllerServer({
  githubReadServices: originalReadServices,
});
try {
  await app.listen(listenOptions);
} catch (error) {
  await app.close().catch(() => {});
  throw error;
}
// The owning process must also await app.close() during normal shutdown.
```

Running `node apps/controller/src/server.mjs` directly retains CLI listening,
fixed redacted startup diagnostics and signal-driven shutdown. Concurrent
shutdown or listen-failure cleanup joins one app close operation. Signal
handlers installed by the CLI are removed after cleanup finishes.

## Current limits

The ordinary executable currently calls `createControllerServer()` without
read-service definitions. It does not select or construct the genuine
accepted-execution owner or full Work/custody source. A fixed production owner
assembly must still obtain those original operands, the actual State admission,
read policy, current route, inventory/key and protected native listener inputs,
then construct the original definition and supply it to this programmatic path.
Missing original operands remain unavailable; this forwarding function cannot
manufacture them or make an admitted repository read succeed.

## Verification

Run the focused startup cases from the repository root:

```sh
node --experimental-test-module-mocks --test --test-concurrency=1 tests/conformance/controller-server-github-read-startup.test.mjs
```

The tests execute the real startup forwarding and direct-entry code with
controlled configuration, Driver, composition, logging and app peers. They check
identity-preserving list capture, default selection, development refusal,
composition failure, listening, joined cleanup and signal-handler removal.
They establish no original factory membership, PostgreSQL admission, native
execution, live GitHub access or positive request-to-read integration.
