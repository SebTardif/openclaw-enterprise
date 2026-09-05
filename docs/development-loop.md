# Development verification loop

Choose checks from the behavior and interfaces changed. Keep feedback focused
while editing, then collect the required evidence before handoff and integration.
The [testing guide](testing.md) owns suite setup and infrastructure requirements.

## Prepare once, verify without changing the environment

Use an isolated worktree with the Node and pnpm versions declared in
`package.json`, dependencies matching the lockfile, and the explicitly prepared
[upstream SDK](reference/build.md). Preparation is a separate action: checks must
not install packages, repair links, change cluster contexts or migrate an
unselected database. Keep mutable dependency links and compiler outputs local
to the worktree; workspace imports must resolve to its own source.

If a required dependency is missing, report the setup failure before running
expensive checks. Preserve existing worktrees, ignored files and dependencies.

Run the read-only preparation check directly:

```sh
node scripts/check-development-setup.mjs --json
```

Exit 0 means the inspected local dependency and SDK metadata is prepared; exit 1
reports missing or stale setup with a separate preparation action. This does not
verify the SDK's complete contents or provenance, load application modules, run
lifecycle hooks, or establish browser, database, credential or cluster readiness.
It probes the package-manager version without invoking a package command. Source exports are identified
separately from Git worktrees.

Package-manager wrappers can perform preparation before a command starts. For
verification without automatic installation, use the direct installed commands
below; do not use `pnpm exec` as a read-only wrapper. The package scripts remain
the inventory for full suites and their required preceding checks.

| Package script                | Direct command on a prepared worktree                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `format:check` / `format:fix` | `node scripts/format.mjs --check` / `node scripts/format.mjs --write`                                         |
| `build` / `typecheck`         | `node node_modules/typescript/bin/tsc --build tsconfig.json --pretty false`                                   |
| `check:workspace`             | Run `node scripts/verify-workspace-boundary.mjs`, then `node scripts/verify-module-boundaries.mjs`.           |
| `openapi:check`               | `node scripts/generate-occ-openapi.mjs --check`                                                               |
| `test:console-browser`        | `node --test --test-concurrency=2 tests/browser/*.test.mjs`                                                   |
| `test:native`                 | Run `go -C components/runtime-security test -race ./...`, then `go -C components/runtime-security vet ./...`. |

For a test-suite script containing preceding workspace checks, retain those checks
at handoff/integration; a direct individual test is focused editing evidence.

## Formatting feedback

```sh
node scripts/format.mjs --check -- scripts/example.mjs docs/example.md
node scripts/format.mjs --write -- scripts/example.mjs
node scripts/format.mjs --check
```

Replace the example paths with existing changed files. Explicit paths are literal,
including spaces and brackets. Full checks use the canonical authored scope and
a worktree-local content cache. Generated API documentation remains excluded.
Configured plugins and configuration that cannot be safely fingerprinted run
without caching.

The pre-push hook checks fresh committed snapshots of each nondeleted outgoing
ref tip, including non-HEAD tips; dirty worktree files cannot replace committed
evidence. Outgoing verification rejects configured plugins and nonstatic or
indirect configuration until their full snapshot-owned dependencies are supported.
A missing formatter or differing outgoing dependency inputs fails with a
preparation error. The hook does not install dependencies. Formatting evidence
does not replace review of the full outgoing history and publication metadata.

## Three checkpoints

| Checkpoint  | Required action                                                                                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Editing     | Format changed files and run the smallest relevant real component tests. Run affected type checks when changing TypeScript interfaces.                                            |
| Handoff     | Run the complete checks required by the change, including consumers, generated artifacts and selected infrastructure. Record exact source, commands, outcomes and remaining gaps. |
| Integration | Verify the composed source and required regressions. Preserve the existing exact outgoing-content review and publication requirements.                                            |

An unchanged successful check can provide reused evidence when its full inputs
and freshness requirements match. Label reused, newly executed, failed, skipped
and unavailable checks separately. Source identity alone is insufficient for
live infrastructure, expiring credentials or other time-sensitive behavior.

## Select checks by change scope

Run commands from the repository root. Package-script names below identify the
canonical scope; use their direct equivalents above during verification to avoid
automatic package-manager preparation. The examples identify useful starting
points; they do not replace a change's full acceptance requirements.

| Changed scope                                                                        | Focused checks and expansion                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A component or Driver                                                                | Run its exact conformance file with `node --test tests/conformance/<name>.test.mjs`, plus its actual API/lifecycle consumers. Kubernetes conformance does not prove a live cluster.                                                                |
| TypeScript source or public contracts                                                | Run `pnpm typecheck`; include affected producer/consumer fixture projects and meaningful expected-negative tests. `pnpm build` invokes the same compiler command, so do not run both merely to repeat identical evidence.                          |
| HTTP routes or schemas                                                               | Run relevant API/security tests and `pnpm openapi:check`. Keep generated OpenAPI and reference artifacts tied to real route registration.                                                                                                          |
| Console behavior or browser fixtures                                                 | Run `node --test tests/integration/console-api.test.mjs` and the affected browser files; use `pnpm test:console-browser` for full console-browser acceptance on a prepared host.                                                                   |
| Native runtime code or native test fixtures                                          | Use focused Go package tests, then required `pnpm test:native` race/vet coverage and the real consuming integration. A cached Go test result is reused evidence.                                                                                   |
| PostgreSQL behavior                                                                  | Prepare explicitly owned disposable databases and follow the testing guide. `pnpm test:postgres` selects only the `postgres-*.test.mjs` prefix; include other affected PostgreSQL files explicitly. Preserve migrator/application role separation. |
| Packaging, images or build tooling                                                   | Run affected build-runner tests and selected real builds/smoke tests. Check dependency, SDK, image and artifact identities. Do not claim that a fixture or source inspection proves a real image.                                                  |
| Documentation or formatting                                                          | Use the installed formatter on changed supported files, then `pnpm format:check` for full scope. The generated API document is verified by OpenAPI checking. Check links and changed command examples.                                             |
| Workspace configuration, shared interfaces, renames/deletions or an unfamiliar scope | Run `pnpm check:workspace` and conservatively expand to the affected full suites and consumers. Review test discovery so moved/new tests remain selected.                                                                                          |

Ordinary Node tests import TypeScript directly; a full build is not needed just
to invoke them. A build remains required when it is itself the behavior under
test or part of the required packaging/type evidence.

## Keep resource selection explicit

`pnpm test` and `pnpm test:integration` include infrastructure-dependent files.
A green run with skips does not prove those integrations executed. Run prepared
infrastructure by exact filename and scope its environment to that process.
Do not inherit unrelated database, image, cluster or live-channel selectors
into local checks. The testing guide documents interactions between selectors.

Keep test-file process isolation. Choose bounded concurrency appropriate to
the shared host; several agents each starting a large worker pool can reduce
aggregate throughput. Preserve independent contexts, accounts, sessions,
databases, sockets and other mutable state. Database parallelism requires
resource isolation first. Do not shorten waits that prove a required timeout,
lease, quota or cancellation contract.

## Work concurrently and hand off small changes

Use isolated worktrees and narrow scopes with clear interface ownership.
Independent work can overlap in small file regions when the intended changes
are understood. Resolve mechanical conflicts during composition; inspect the
result for semantic interactions and rerun the relevant combined checks.
Avoid broad simultaneous rewrites. Shared integration remains serialized.

For each handoff record the source identity, changed scope, exact commands,
exit codes, test counts/skips, elapsed time and whether evidence was executed
or reused. Retain logs outside product source. Separate setup and command time
from review, resource and integration waiting; mark unobserved timing unknown.
