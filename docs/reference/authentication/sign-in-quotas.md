# Sign-in quotas

The actual `POST /api/auth/sign-in/email` wrapper reserves both budgets before
Better Auth performs account lookup or password verification:

| Dimension                             | Initial burst | Continuous refill             |
| ------------------------------------- | ------------- | ----------------------------- |
| Transport source                      | 30 attempts   | One attempt every two seconds |
| Transport source and normalized email | Five attempts | One attempt every 12 seconds  |

Every admitted attempt consumes both budgets, including successful logins and
unknown accounts. Email is trimmed and lowercased consistently with provisioning.
The controller derives the source only from the connection's remote address;
`Forwarded`, `X-Forwarded-For`, and `X-Real-IP` cannot select or reset it. IPv4 and
IPv4-mapped IPv6 forms share a source. Missing transport identity fails closed.
There is no account-only lockout, so another source can still authenticate the
same account. Browser Origin checks run first. Invalid bodies rejected by the
route schema do not reach account/password work or consume these quotas.

Controllers with PostgreSQL authentication share atomic quota reservations in
the same database. All replicas must use the same Installation and
`OCC_AUTH_SECRET`, as required for their shared authentication configuration.
There is no process-local fallback when PostgreSQL is unavailable. The in-memory adapter has process-local accounting only.

Storage has exactly 4,096 possible source slots and 16,384 possible source/email
slots. An HMAC keyed by the auth secret selects each slot. The table stores only
slot numbers and refill timestamps, never addresses, email addresses, passwords,
or tokens. Slots can collide and conservatively share a budget. Fixed slots
remain allocated, so attacker-selected identifiers cannot grow the table beyond
20,480 rows. With a normally advancing database clock, prior activity stops
affecting admission after at most 60 seconds without further admitted attempts.
Denied attempts do not extend this debt. A backward database-clock adjustment
can lengthen throttling until the clock catches up.

| Condition                                                                | Response                                       |
| ------------------------------------------------------------------------ | ---------------------------------------------- |
| Either budget exhausted                                                  | `429 RATE_LIMITED`, `Retry-After: 12`          |
| Quota storage unavailable, timed out, or its local waiting bound reached | `503 DEPENDENCY_UNAVAILABLE`, `Retry-After: 1` |

Both responses use the existing generic authentication failure message and
request metadata. They contain no account-existence or remaining-budget detail,
set no session cookie, and are not cacheable. Retry values are fixed server
constants; arbitrary upstream error headers are not forwarded. Authentication
never proceeds after a quota error. Each storage reservation has a one-second
deadline, with at most 32 outstanding reservations per controller auth instance.
A pool acquisition that completes after its deadline is discarded without
performing quota or password work. A lost commit acknowledgement can consume
quota despite the returned 503; it never authorizes an unconfirmed admission.
The deadline bounds quota admission, not the entire HTTP/password operation or
time spent waiting outside the application.

Behind a proxy or shared NAT, clients share that transport source's budget.
Deployments must account for this limit; the controller currently has no
authenticated proxy identity adapter. Ingress controls may provide additional
protection but do not change the controller's source trust boundary. Rotating
the auth secret remaps slots and is not a quota-preserving operation.

For contributor coverage and database prerequisites, see
[authentication tests](../../testing/local.md#authentication-and-authorization-coverage)
and [PostgreSQL testing](../../testing/postgresql.md).
