# Authentication storage failures

This page defines the current controller's session-revocation and dependency
diagnostic boundaries. [Authentication](authentication.md) owns the supported
login, session, cookie, Origin, and service-key contracts.

## Durable logout

`POST /api/auth/sign-out` checks the existing browser Origin policy and verifies
the signed session cookie using Better Auth's configured cookie name and secret.
For a valid signed bearer, the controller then asks the selected primary
authentication adapter to delete that exact session. The public response clears
the cookie and acknowledges `{ "success": true }` only after deletion completes.
An already absent session is an idempotent successful logout. Logging out one
session does not revoke another session for the same account.

| Storage outcome                                                               | HTTP behavior                                                                                           |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Session deletion acknowledged, or no valid signed bearer supplied             | `200`, success response, and normal session-cookie clearing                                             |
| Session deletion fails, including missing database SELECT or DELETE privilege | `503 DEPENDENCY_UNAVAILABLE`, generic revocation-failure message, and no cookie replacement or clearing |
| Browser Origin rejected                                                       | Existing `403 FORBIDDEN`; no session deletion                                                           |

A 503 means revocation was not confirmed. The original cookie can remain valid
after storage recovers, so clients must not present that response as successful
server-side revocation. A transport failure after a committed delete can also
produce an unconfirmed outcome; it does not prove the session remains present.
Once storage recovers, retrying logout is safe. A confirmed successful deletion
prevents later replay of the original cookie. Requests already authenticated
before deletion may finish.

The controller configures a local Better Auth endpoint override for its existing
sign-out operation. It reuses Better Auth's signed-cookie verification and cookie
clearing, with direct deletion through the selected authentication adapter.
This avoids dependency logout and hooked-delete paths that can swallow storage
errors. There is no additional session store or authorization policy. The current
configuration uses its primary database as the session authority, without a
secondary session cache or configurable session-deletion hooks. Adding either
requires reviewing this revocation boundary before supporting that configuration.

Public exposure remains the controller's existing auth routes. The override does
not expose the dependency's HTTP router or introduce another public logout path.

## Credential-safe dependency diagnostics

Better Auth's configured logger never forwards dependency messages, error
objects, causes, SQL, or parameters. It writes only this event and an allowlisted
severity to stderr:

```json
{ "level": "error", "event": "authentication.dependency-diagnostic" }
```

Warning diagnostics use `"level":"warn"`. Informational and debug messages are
not enabled. This boundary applies to diagnostics originating from the configured
auth dependency, including failed session reads and deletions. It deliberately
does not classify errors by inspecting their free-form contents or token patterns.
The controller's normal HTTP errors remain generic and omit session bearers.

The diagnostic indicates that the authentication dependency emitted a warning or
error. It does not identify an account, reveal a query, or prove a particular
storage outcome. Operators should use the HTTP outcome and ordinary database
health/permission checks to investigate. Do not enable raw dependency error
logging to diagnose an authentication failure.

This boundary does not change PostgreSQL server logging, other applications'
logging, or arbitrary external adapters. Those are separate operational controls.

## Verification

The [storage-failure regression](../../tests/integration/auth-storage-failures.test.mjs)
requires a fresh, migrated, owned loopback database named `openclaw_auth_*`.
Set both `OCC_AUTH_FAILURE_DATABASE_URL` for `occ_app` and
`OCC_AUTH_FAILURE_MIGRATOR_URL` for `occ_migrator`, pointing to that same database.
Use the existing [PostgreSQL test setup](../testing/postgresql.md#postgresql-test-environment)
with those separate roles, then run:

```sh
node --test tests/integration/auth-storage-failures.test.mjs
```

The suite refuses the ordinary development database. Only the migration-role
connection changes and restores the owned fixture's session-table privileges;
the actual controller keeps the limited application role. Each case runs the
real development composition, HTTP listener, Better Auth, and PostgreSQL adapter.
It verifies actual DELETE and SELECT failures during logout, a failed session
read, retained-row and original-cookie replay after recovery, healthy durable
deletion, rejection of later replay, preservation of another session, and Origin
rejection. It uses no replacement auth methods or invented persistence results.

Each case captures its own child process's stdout and stderr and checks that
neither contains its synthetic session bearers. Dependency diagnostics must have
only the documented event and severity fields. Raw captures are retained with
mode 0600 in a mode-0700 directory; `OCC_AUTH_FAILURE_ARTIFACTS` can select an
existing parent directory. Failures report safe phase/status data rather than
printing raw captures. Do not publish those raw files: a regressed implementation
can put synthetic bearer values into them.

Without either database URL the suite explicitly skips. Supplying only one is an
error. The test is bounded application/storage evidence; it does not establish
production installation, traffic capacity, or compatibility with an untested
PostgreSQL version.
