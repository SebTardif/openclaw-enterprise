---
status: Proposed
---

# Proposal: Verify Keycloak OIDC sign-in locally and in CI

- **ID:** RFC-0059
- **Owner:** freeqaz (proposal and auth review). CI and Local Setup review: OCE maintainers.
- **Created:** 2026-10-03
- **Last updated:** 2026-10-03
- **RFC PR:** [#1117](https://github.com/openclaw/openclaw-enterprise/pull/1117)
- **Related:** [RFC-0042](0042-oidc-sign-in.md) (generic OIDC sign-in; implementation
  [#790](https://github.com/openclaw/openclaw-enterprise/pull/790));
  [OIDC sign-in guide](../../docs/guides/deploy/oidc-sign-in.md); in-cluster IdP egress note
  [#903](https://github.com/openclaw/openclaw-enterprise/pull/903); token service
  [RFC-0056 (#924)](https://github.com/openclaw/openclaw-enterprise/pull/924).

<a id="problem-and-decision"></a>

## Summary

Keycloak is the only identity provider OCE has ever been checked against, twice by hand and
never by CI. This RFC makes it a **verified** provider: one checked-in realm file feeds a
Keycloak guide page, an opt-in Local Setup sign-in profile that runs a persistent Keycloak in
the k3d cluster, and a CI lane that drives the real browser flow against a pinned Keycloak,
with no change to product authentication and no test-only knobs. Dogfood adoption waits on
host port 443, which another service holds (Open questions).

## Motivation

Every automated OIDC test uses the `fakeOidc` fixture
([production-sign-in.mjs](../../tests/helpers/production-sign-in.mjs)), which by its own
description proves OCE against its own reading of OIDC, not any IdP's behaviour. Keycloak
26.3.0 on the dogfood cluster was exercised twice: for #790 (the API on the host in a private
network namespace, `unshare -rn`) and again on the dogfood install, where it found two
defects: the egress policy's port match (docs fix #903) and silent provider outages (#806).
Neither harness is in the repository, and the dogfood Keycloak runs `start-dev` with an H2
file on the Pod's ephemeral filesystem, lost on every Pod restart. The
[guide](../../docs/guides/deploy/oidc-sign-in.md) gives Keycloak one table row and one line
on finding `sub`. RFC-0042's Auth0 live check never ran.

Locally, humans sign in to Local Setup with the generated administrator password and
automation uses the 30-day bootstrap service key; `occ dev up` has no sign-in option, and
enabling OIDC on dogfood took hand-built DNS, TLS, egress and browser workarounds that live
outside the repository.

## Goals

- **Supported Keycloak**: a documented realm recipe, a pinned major version, and a named list
  of flows CI verifies, all derived from one realm file so the guide cannot drift from what is
  tested.
- **Local sign-in**: one environment variable gives the routing-enabled Kubernetes-only Local
  Setup install a Keycloak that survives restarts, with the development administrator
  attached, so browser sessions are short-lived and the password serves recovery only.
- **CI**: a hermetic lane with a digest-pinned Keycloak, a real browser and deadline-bounded
  waits, runnable on a developer host.

## Non-goals

- IdP-issued credentials for API clients (bearer tokens, token exchange, client credentials,
  device flow). Bearer authentication stays disabled
  ([auth/index.ts](../../apps/controller/src/auth/index.ts), `verify`); short-lived machine
  credentials are RFC-0056's territory.
- Claim, group or role mapping; just-in-time accounts; RP-initiated or back-channel logout;
  runtime discovery; private-key client authentication. RFC-0042's non-goals stand.
- New chart surface: no IdP CA value, no egress port knob, no relaxation of the endpoint
  rules below. The in-cluster egress workaround stays a documented extra NetworkPolicy.
- Relaxing the OIDC and native-admin exclusivity, for development included: OIDC supports
  host-only cookies only, so the chart fails when both are enabled
  ([\_helpers.tpl](../../deploy/helm/openclaw-enterprise/templates/_helpers.tpl)): a
  cookie-scope decision (RFC 31, RFC-0042), not a tooling one.
- Keycloak as a production recipe: `start-dev` and the dev-file database are development
  tooling, and the guide says so.
- Verifying Auth0, Okta or Entra ID, or changing RFC-0042's status.

<a id="design"></a>

## Proposal

### One realm file

`tests/fixtures/keycloak/realm-oce.json` is a hand-edited Keycloak realm export that the
launcher and the lane import unchanged: realm `oce`; one confidential client `oce-console`
with the authorization-code flow only, PKCE `S256` required, no implicit or direct grants, no
audience mapper and one redirect URI; and users `alice` and `carol` with fixed IDs, so their
`sub` values are known. It contains no secret: the redirect URI, client secret and user
passwords are `${VAR}` placeholders that `--import-realm` resolves from environment variables
set from per-run values kept in `0600` files. The import guide places no restriction on
which environment variables a placeholder may read, and PR 1 verifies by test that an unset
one imports as literal text, so the lane and the launcher refuse to start Keycloak while any
placeholder variable is empty, and readiness reads the client back through the admin API and
fails if its secret is the placeholder text.
The image digest sits beside the realm in `tests/fixtures/keycloak/image.json`; `prepare.mjs`
and the launcher both read it, so one bump changes both.

### What "supported" means

The guide gains a child page, `docs/guides/deploy/oidc-keycloak.md`, linked from its IdP
table: the pinned major version (26), the realm recipe as admin-console steps, where `sub` is
shown, and the constraints the lane enforces:

- The realm's default `RS256` key is 2,048 bits or more.
- The client has no audience mapper: a Keycloak ID token's `aud` is the client ID by default,
  and OCE refuses any other audience.
- `KC_HOSTNAME` is the issuer's origin written without a port; the issuer is
  `${KC_HOSTNAME}/realms/<realm>` and must equal `auth.oidc.issuer` character for character.
- The four endpoints share one DNS host, written without a port, served over HTTPS on 443
  with a certificate the API trusts. The host does not end in `.localhost` when the API runs
  in a Pod, because the controller image resolves such names to loopback.

The page ends with the verified-flow table below and links `docs/testing/keycloak.md`, which
owns the lane.

### Local Setup sign-in profile

`OCC_DEVELOPMENT_SIGN_IN=keycloak` is read by `occ dev up` in the routing-enabled
Kubernetes-only profile (`OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes`,
`OCC_DEVELOPMENT_SANDBOX_DRIVER=none`): the only one that installs Envoy Gateway and
cert-manager and sets the HTTPS `auth.baseUrl`
(`https://console.occ-dev-<name>.oce.localhost:<browserPort>`,
[openshell_k3d.go](../../internal/occdev/openshell_k3d.go)) the chart requires for
`auth.oidc`, so no new chart values are needed; with any other sandbox driver the launcher
refuses the variable and says why. It adds:

| Piece        | Shape                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Keycloak     | Namespace `occ-development-keycloak`: the pinned image running `start-dev --import-realm` with `KC_DB=dev-file` on a PersistentVolumeClaim, the realm directory as a ConfigMap, and generated admin, client and user secrets. Import runs only when the realm is absent, so it survives Pod restarts; `occ dev down` removes the volume. Redirect URI: `<auth.baseUrl>/api/auth/providers/oidc/callback`.                                                                                                                                              |
| Name and TLS | `keycloak.occ-dev-<name>.oce.test`, terminated by a dedicated Gateway `keycloak` in `occ-development-keycloak` (the chart's Gateway is untouched): a CoreDNS rewrite to that Gateway's Envoy Service, and a Certificate issued in the release namespace from the chart's gateway-routing CA Issuer (a namespaced `Issuer`), its Secret mirrored to `occ-development-keycloak` for the listener. The API already trusts that root (`NODE_EXTRA_CA_CERTS`); the browser does not, so the launcher exports it to `gateway-ca.crt` in the state directory. |
| Host port    | **New, creation-time:** a k3d `--port 127.0.0.1:443:<keycloak Gateway NodePort>@loadbalancer` publication beside the existing API and browser ports. k3d fixes port maps at creation, so toggling the profile is `occ dev down` then `occ dev up`; the launcher refuses the variable on a cluster created without it.                                                                                                                                                                                                                                  |
| Egress       | The extra API-to-Envoy-Pods NetworkPolicy on the Gateway's target port, as the guide documents for in-cluster IdPs.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Chart values | Two Helm passes. The first bootstraps as today and the launcher reads the administrator's user ID. The second upgrades with `auth.oidc.*`, `auth.recoveryUserId` (that ID), `auth.passwordSignIn: recovery-only` and `agentNativeAdmin.enabled: false`. Only then (the attach route answers 409 while OIDC is off) the launcher signs in with the administrator password, allowed for the recovery account, using the exact `Origin`, and `POST`s `/api/auth/accounts/<id>/providers/oidc` with `alice`'s subject and the account version.             |
| Developer    | Startup prints the Console URL, the `alice` password file, the two CAs to import (browser CA for the Console, gateway CA for Keycloak) and the `/etc/hosts` line `127.0.0.1 keycloak.occ-dev-<name>.oce.test`.                                                                                                                                                                                                                                                                                                                                         |

### CI lane

A new lane, `keycloak-oidc`, with one file,
`tests/integration/keycloak-oidc-sign-in.test.mjs`, and `prepare.keycloak: true`. Prepare
treats Keycloak like its PostgreSQL server: a tracked resource that cleanup always removes,
even after a failed run.

1. **Start.** Generate a two-day private CA and leaves for `keycloak.oce.localhost` and
   `127.0.0.1` with `openssl` (as `routing.mjs` does). Unless `dns.lookup` returns exactly
   `127.0.0.1` for that name (a `::1`-first answer against a loopback-only publication is a
   flake), add the `/etc/hosts` line with `sudo -n` and remove it in cleanup;
   `docs/testing/keycloak.md` gives the manual one-liner and records the runner image's
   observed behaviour after the first green run. Reserve a free loopback port (bind
   `127.0.0.1:0`, record, close) and resolve the realm's redirect URI to
   `https://127.0.0.1:<port>/api/auth/providers/oidc/callback`. Pull the pinned image through
   `pullImage`'s bounded retry and the repository-digest check `prepare.mjs` already applies
   to pinned images; run `start-dev --import-realm` with HTTPS on the Keycloak leaf,
   `KC_HOSTNAME=https://keycloak.oce.localhost`, the realm directory read-only and the HTTPS
   port published on `127.0.0.1:443` (a busy 443 fails fast). Readiness is the discovery
   document returning the configured issuer plus the client-secret check above, polled under
   a 180-second deadline; no fixed sleeps.
2. **Hand over.** The file receives `OCC_TEST_DATABASE_URL`, the issuer, the reserved port,
   the secret, admin-credential and leaf file paths, the container name and
   `NODE_EXTRA_CA_CERTS=<CA>`, which Node reads only at start, so prepare sets it.
3. **Prove.** The test composes the production API in-process (`composeProductionSignIn`,
   inject-only, no listener) behind the HTTPS reverse proxy
   [console-app.mjs](../../tests/helpers/console-app.mjs) already uses, bound to the reserved
   port through a new fixture option (today it calls `availablePort()`) with the loopback
   leaf. That origin, `https://127.0.0.1:<port>`, is `OCC_AUTH_BASE_URL` for both
   compositions and matches the realm's one redirect URI; OCE does not constrain its port.
   Playwright's Chromium (already a `checks-browser` dependency) trusts both leaves through
   `--ignore-certificate-errors-spki-list`, as `console-app.mjs` does for one, and fills
   Keycloak's real login form; the controller reaches the real token and JWKS endpoints under
   the endpoint rule above with its unmodified transport. Requests are observed, never
   stubbed.

| Verified flow (one named test each)                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discovery matches the four configured values; the JWKS offers an `RS256` key of 2,048 bits or more with a `kid`.                                                                                                                   |
| `alice`, attached, signs in through the Console: the authorization request carries `scope=openid`, `code_challenge_method=S256`, a nonce and the configured redirect URI; `/console/` loads with a session (`client_secret_post`). |
| The same with `client_secret_basic`, by recomposing the API with that setting.                                                                                                                                                     |
| Adding a higher-priority realm key through the admin API changes the JWKS `kid`; the next sign-in succeeds with no controller restart.                                                                                             |
| `carol`, not attached, lands on `/console/?authError=oidc`, is audited `EXTERNAL_IDENTITY_REJECTED`, and no account exists.                                                                                                        |
| Console sign-out deletes the OCE session; one click signs `alice` in again without a login form while the Keycloak session lives. Disabling her in Keycloak leaves the OCE session until it ends and refuses the next sign-in.     |

The `alice` flow is also the real-token proof of the single-audience rule; fail-closed
behaviour on a provider outage stays with the `fakeOidc` test that pins it.

The lane joins `scripts/ci/test-suites.json` and the `full` group at once and runs as its own
workflow job on `blacksmith-8vcpu-ubuntu-2404` with a 25-minute budget, not yet
`CI Required`, as [First Agent smoke](../../docs/testing/first-agent-smoke.md) started. The
suite audit applies from day one: expected test names are listed, and a skip fails the lane.

### What changes for credentials

For humans, the Console session is the eight-hour, non-refreshing session RFC-0042 already
gives OIDC sign-in; the change is that Local Setup can use it. Scoping stays OCE IAM on the
attached account; Keycloak decides only who may authenticate. For automation, nothing
changes: bootstrap still writes a 30-day service key, shorter-lived keys (`expiresIn`) come
from the [service-key API](../../docs/reference/authentication/service-api-keys.md), and
IdP-issued machine credentials wait for RFC-0056.

### Security and failure

- Every secret is generated per run or install and lives in `0600` files; the realm file
  holds none; the CA lives two days; Keycloak admin credentials never leave the lane or the
  launcher state directory.
- No environment-gated behaviour in the controller or the chart: TLS trust uses the
  documented `NODE_EXTRA_CA_CERTS` path, the endpoint rule applies unchanged, and the fetch
  transport is the production one.
- A Keycloak that does not become ready, a changed login form, a digest mismatch, a literal
  placeholder or a busy port fails the lane with the step named; cleanup runs regardless.

## Rationale and alternatives

- **Extend `postgres-auth`**: rejected. Keycloak adds a 450 MB pull and a JVM start to a
  `CI Required` lane whose tests mock `globalThis.fetch` per test, which a real-IdP file
  must not share a process with.
- **Reach 443 by intercepting `fetch`** or an undici dispatcher: rejected; it proves a
  patched stack. **`unshare -rn`** as #790 did: rejected for CI; Ubuntu 24.04 restricts
  unprivileged user namespaces and the socket bridging is fragile.
- **The dogfood browser workaround** (`kubectl port-forward` plus a Chromium
  `--host-resolver-rules` flag): rejected for developers; it needs a long-lived process
  beside the cluster and a specially launched browser.
- **A `*.localhost` name for the launcher**: rejected; the API Pod resolves it to loopback.
  The lane can use one because its API is a host process.
- **A Testcontainers dependency**: rejected; it hides the digest pin and the retry policy CI
  already standardises.

## Delivery and verification

Three pull requests in dependency order, each human-gated:

1. **Realm file, lane and testing page.** `realm-oce.json`, `image.json`,
   `prepare.keycloak`, the lane JSON, the test file, the workflow job,
   `docs/testing/keycloak.md` and the `ci.md` lane list. Evidence: the job green on the PR
   and on `main`; a developer-host run through `scripts/ci/run-tests.mjs run keycloak-oidc`;
   cleanup verified after a forced failure.
2. **Keycloak guide page.** The recipe, constraints and verified-flow table; the IdP table
   row links to it; `docs.json` and the cheat sheets updated. Evidence: `docs:check` and a
   read-through against the realm.
3. **Launcher profile.** `OCC_DEVELOPMENT_SIGN_IN=keycloak`, its manifests, the 443 port
   publication, the gateway CA export, the two Helm passes, the attach step, the printed
   instructions, and the Local Setup and development settings pages. Evidence: a fresh
   `occ dev up` signs `alice` in through the Console, survives a Keycloak Pod restart with
   the realm intact, and `occ dev down` leaves nothing. Dogfood adoption follows (Open
   questions).

Still unverified: Auth0, Okta and Entra ID; the chart's egress policy from a Pod in CI (the
launcher profile and dogfood cover it); other Keycloak versions.

## Risks

- **Keycloak cost and flakiness.** About 450 MB from `quay.io`, 15-40 s to start, ~1 GB of
  memory. Mitigations: digest pin, `pullImage` retry, deadline-bounded readiness, a dedicated
  lane, non-required until the soak proves it.
- **Login-form scraping.** Playwright selectors on Keycloak's login page break across
  versions; the digest pin makes this a reviewed change per bump.
- **Port 443 on developer hosts.** The lane and the profile both take loopback 443, so a host
  runs one at a time and neither beside a local web server on 443; both fail fast.
- **Realm drift.** Import runs only on an empty database, so a changed realm file needs
  `occ dev down` with volumes; the launcher says so when it sees an older realm hash.

## Open questions

| Question                                                                        | Owner       | Proposed default                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| When does the lane become `CI Required`?                                        | freeqaz     | After two weeks of green runs on `main` with no infrastructure failure; promotion is a `ci.yml` `pr-safe` matrix entry plus the `test-suites.json` `ci`-group edit, not its own pull request.                                                                                                                                                                                       |
| How does the dogfood install adopt the Keycloak profile?                        | freeqaz     | Another service binds host 0.0.0.0:443. Proposed: that service SNI-routes `keycloak.occ-dev-oce-dogfood.oce.test` to the k3d load balancer and the cluster is recreated with the profile; fallback, a second OIDC-only install on a host with 443 free. Either way dogfood loses embedded-Agent browser chat (`agentNativeAdmin.enabled: false`, why OIDC was switched off before). |
| Is a chart-topology Keycloak lane (k3d, NetworkPolicy, Pod DNS) worth its cost? | maintainers | Not now: it alone would catch a D82-style egress port match, at about ten minutes of cluster setup per run, and the launcher profile gives the same topology on demand. Revisit after promotion, reusing the profile as the fixture.                                                                                                                                                |
| Keycloak version policy                                                         | maintainers | Pin 26.x by digest; bump with the other pinned images and re-check the login selectors.                                                                                                                                                                                                                                                                                             |
