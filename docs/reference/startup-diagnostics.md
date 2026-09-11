# Controller startup diagnostics

The API and worker write one JSON startup failure record to stderr and exit with
status 1 when their startup operation fails. The API event remains `startup-error`;
the worker event remains `worker.startup-error`. Both use the same fixed diagnostic
projection in development and production.

| Code                               | Fixed error text                                                         | Meaning                                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `KUBERNETES_CONFIGURATION_INVALID` | `Kubernetes client configuration is unavailable or invalid.`             | The Kubernetes client helper could not load its selected configuration or rejected its context, cluster, identity or HTTPS settings. |
| `STARTUP_FAILED`                   | `Controller startup failed. Check the configured startup prerequisites.` | Any other startup failure, including an unrecognized error.                                                                          |

The fixed diagnostic contains only `event`, `code` and `error`. The shared OCC
logger adds `severity: "ERROR"`, an ISO timestamp in `time`, and `service` set to
`occ-api` or `occ-worker`. The complete stderr record contains only those six
fields. The `error` field is always the fixed text above; it is not an exception
object or the original exception message. The record does not include a stack,
cause, parser excerpt, file path, arbitrary properties or credential contents.
A field named `code` on an upstream exception
cannot select a diagnostic category. Categories are registered locally at the
validation boundary; all other errors receive the generic category. There is no
ordinary-log option to expose raw errors.

This replaces the launchers' previous raw error messages. Log consumers should use
the event and code fields rather than matching old exception text. Cleanup still
runs on failed startup; cleanup errors handled by the launchers do not replace or
print the original failure. A worker may also emit its existing `worker.stopped`
event on stdout while cleaning up a failed start.

The Kubernetes helper normalizes SDK file-load and parser errors into a constant
validation error before returning to its caller. Explicit kubeconfig mode still
requires exactly one requested context and exactly one cluster selected by that
context, an available credential identity, and a verified HTTPS API endpoint.
Unsupported configuration fails closed. It does not fall back to a default
kubeconfig, another context or in-cluster identity. In-cluster mode retains the
SDK's mounted ServiceAccount configuration path and the same HTTPS checks.
The bundled Compute Driver treats these normalized load failures as permanent
configuration failures rather than retryable request failures. Correct the mount
or configuration before retrying the affected operation.

For operator diagnosis, use the [deployment guide](../guides/deploy.md) and
[settings reference](settings.md) to check startup prerequisites in order: required
environment settings, mounted Installation configuration, PostgreSQL connectivity
and bootstrap state, IAM/auth configuration, then the selected Drivers. For a
Kubernetes configuration failure, check the selected mount exists and is readable
by the controller identity, the file is valid kubeconfig, the explicit context and
cluster are unique, and TLS verification is enabled. Inspect credential-bearing
files only in an operator-controlled private environment with appropriately
restricted access. Keep file contents and parser excerpts out of routine logs,
shared terminals, support tickets and general diagnostic bundles. Correct the
configuration and restart the affected process.

Run the configuration-only and serializer checks with:

```sh
node --test tests/conformance/startup-diagnostics.test.mjs
```

The launcher suite also covers generic safe failure without external services.
It checks the entire stderr stream, including the logger envelope, so additional
parser output or cleanup errors fail verification:

```sh
node --test tests/integration/startup-diagnostics.test.mjs
```

For both actual production launchers' kubeconfig cases, set
`OCC_STARTUP_DIAGNOSTICS_DATABASE_URL` to a separately migrated, empty disposable
PostgreSQL database named `openclaw_startup_*`, using the limited application role.
The test runs the real production bootstrap and checks that every malformed,
missing and semantically invalid kubeconfig reaches the Kubernetes validation
boundary after the database, Installation, IAM and auth prerequisites. Without that
URL the database-backed case explicitly skips. See the existing
[PostgreSQL test settings](../testing/postgresql.md#postgresql-test-environment) for role and
schema requirements.

These tests use harmless fixture markers. They verify source launchers and the
installed Kubernetes SDK, including valid context/TLS configuration; they do not
establish live Kubernetes connectivity, mounted credential validity, workload
readiness, container-image equivalence or a deployed log configuration. The
projection covers handled startup failures; it is not a general runtime logging
or telemetry sanitization system.
