# Selected development setup requirements

The preparation doctor checks local dependency metadata by default. Add an
explicit requirements file when a check also needs a particular tool or local
protocol endpoint. Resources omitted from the file are not probed or made into
requirements. The [development loop](../development-loop.md) describes the
ordinary verification sequence; the [testing guide](../testing.md) owns actual
integration setup and acceptance.

```sh
node scripts/check-development-setup.mjs --root /path/to/worktree --requirements /path/to/requirements.json --json
```

`--root` selects a checkout or source export. Omitting it keeps the script's own
repository root. Omitting `--requirements` preserves the original metadata-only
check and report. No environment variable implicitly selects a service, Docker
context, kubeconfig, database or credential. Run the command directly with Node;
preparation remains a separate action owned by the setup owner.

## Declare requirements

A requirements file is credential-free JSON with schema
`oce.development-setup-requirements/v1` and between 1 and 16 entries. Every entry
needs a unique lowercase `id`, `kind`, responsible `owner`, and concrete `action`
for that owner to take separately if the requirement cannot be established.
The doctor reports the owner/action; it does not execute the action.

For example, a native-source change can select its Go module:

```json
{
  "schema": "oce.development-setup-requirements/v1",
  "requirements": [
    {
      "id": "native-go",
      "kind": "tool",
      "tool": "go",
      "module": "components/runtime-security",
      "owner": "native worktree setup owner",
      "action": "Prepare a standard Go distribution meeting this module's go.mod requirement on PATH, then rerun the doctor."
    }
  ]
}
```

The doctor resolves the Go executable from `PATH`, reads the distribution's
adjacent `VERSION` file, compares it with the selected module's `go` and optional
`toolchain` directives, and records SHA-256 identities for the executable,
version file and module manifest. It does **not** execute Go: even a version
command can update Go telemetry. A matching result establishes installed
metadata agreement, not compilation, module-download availability, provenance
or Go usability. Missing metadata, unsupported shims/custom layouts and
unrecognized version formats remain unprepared.

Other supported `tool` values are `docker`, `kubectl`, `helm`, `k3d` and `psql`.
Each requires `minimumVersion`, a numeric `major.minor` or `major.minor.patch`.
The doctor invokes only its fixed client-version command. Client availability
and version agreement do not establish daemon, server, credentials or cluster
readiness. Version output formats outside the supported forms fail explicitly.

## Select local protocol diagnostics

Select only endpoints already allocated for the intended check. Selection does
not allocate a service or grant access to another person's infrastructure.
Only numeric loopback HTTP addresses (`127.0.0.1` or `[::1]`) and explicit local
Docker socket paths are supported. Remote endpoints, ambient contexts, URL
credentials, queries, fragments, authentication headers and redirect following
are unsupported.

| Kind     | Additional fields                                   | Successful evidence and limits                                                                                                                                                                                 |
| -------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http`   | `url`, nonempty `expectedBody`                      | HTTP 200 with the exact response bytes selected by the caller. This proves only that declared response contract; authentication, schema and workloads remain unverified.                                       |
| `docker` | `endpoint` containing exactly `socketPath` or `url` | Explicit `GET /_ping` returns `OK`, and `GET /version` returns recognized version fields. This proves API responses; it does not test container creation, workload permissions or usable daemon configuration. |
| `tcp`    | `host`, `port`                                      | A connection is transport evidence only. Even a successful connection leaves the requirement **unprepared** because service identity, authentication and schema are unverified.                                |

Example entries for an already allocated local service:

```json
{
  "schema": "oce.development-setup-requirements/v1",
  "timeoutMs": 2000,
  "requirements": [
    {
      "id": "allocated-health",
      "kind": "http",
      "url": "http://127.0.0.1:8080/health",
      "expectedBody": "ready\n",
      "owner": "local service setup owner",
      "action": "Make the already allocated local service expose its documented health response at the selected endpoint, then rerun this requirement."
    }
  ]
}
```

A Docker entry uses, for example, `"endpoint": { "socketPath": "/var/run/docker.sock" }`.
The doctor reads no Docker context and issues only the two fixed API requests.
If a selected capability has no backend, such as `kind: "postgres-auth-schema"`
or `kind: "kubernetes"`, the doctor reports `unsupported` with the supplied
owner/action and keeps the result unprepared. Use the actual selected integration
suite to establish database authentication/schema or Kubernetes workload
acceptance. Generic health and TCP probes cannot substitute for it.

## Read the result and diagnose failures

The existing `oce.development-setup/v1` report gains `selectedRequirements` only
when requested. That nested `oce.development-setup-requirements-result/v1` report
contains per-requirement status, reason, owner/action, duration and an `evidence`
object describing exactly what was observed. Valid selections carry a SHA-256
of their JSON representation, binding the result to the selected targets and
contracts without echoing endpoint configuration. Overall exit 0 requires both base
metadata and every selected requirement to succeed. Exit 1 includes missing,
stale, unavailable, unsupported and invalid selections; exit 2 is invalid CLI
syntax. A successful source-export check never establishes Git-worktree or
outgoing-commit verification.

Malformed files, empty requirements, duplicate IDs, missing ownership/actions,
unknown fields and invalid targets fail before any selected probe runs. Error
responses and command stderr are not echoed; URL or response credentials are
not copied into receipts. Keep credentials out of requirement IDs, owners and
actions, because these deliberately appear in the report.

Each entry has an optional `timeoutMs` from 50 to 2000 (default 1500). The entire
selection has an optional `timeoutMs` from 50 to 10000 (default 10000). Remaining
requirements fail when that budget is exhausted. HTTP bodies and tool output
are capped at 16 KiB. These are probe deadlines and input limits, not guarantees
against an operating-system stall while reading local files.

A permission error can come from process/socket restrictions or path access;
it is not evidence that changing file permissions is the right repair. A
connection refusal is different from a timeout, authentication denial, malformed
response or unsupported readiness check. The responsible setup owner should
resolve the reported condition in the allocated environment, then rerun.
Verification itself does not install/download tools, repair links, migrate
schemas, modify contexts, change telemetry settings or start resources.

## Verify the doctor

```sh
node --test --test-concurrency=1 tests/conformance/development-setup.test.mjs tests/conformance/development-setup-requirements.test.mjs
```

The selected-requirement tests use real Node HTTP/TCP protocol fixtures on owned
ephemeral loopback ports and local filesystem/toolchain metadata. They verify
matching and unavailable contracts, body/deadline limits, no redirects, no
implicit selection, source-export reporting and preserved fixture files. They
are diagnostic-client evidence, not real Docker, PostgreSQL or Kubernetes
acceptance. The standard Go-distribution success case explicitly skips if that
local prerequisite is unavailable; skipped evidence is not a prepared result.
