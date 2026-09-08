# Testing

Choose a suite by the behavior you need to verify. Local conformance and API
tests need no provider credentials. PostgreSQL, image, Kubernetes, and real
model tests require the setup below. Run commands from the repository root.

## Run tests

| Command                 | Tests selected                                                            |
| ----------------------- | ------------------------------------------------------------------------- |
| `pnpm test`             | All conformance and integration tests.                                    |
| `pnpm test:conformance` | Conformance tests only.                                                   |
| `pnpm test:integration` | Integration tests only, including infrastructure and real-runtime suites. |

`pnpm test` selects every conformance and integration file. A green result can
include skipped infrastructure tests; it is not proof that every integration
ran. Run prepared infrastructure suites by exact filename, one suite at a time.
The `pnpm test`, `pnpm test:conformance`, `pnpm test:integration`, and
`pnpm test:postgres` scripts run `scripts/verify-workspace-boundary.mjs` and
`scripts/verify-module-boundaries.mjs` before the Node.js test runner.
`pnpm check:workspace` runs both checks without selecting tests.

Keep their variables scoped to a subshell or one test process. In particular,
the OpenShell suite detects **any** configured test database, Kubernetes context,
or runtime image as selection, then requires its explicit opt-in and full setup.
Running `pnpm test:integration` after exporting only `OCC_TEST_DATABASE_URL` can
therefore fail in OpenShell. Setting `OCC_TEST_OPENSHELL_K3D_REAL=0` does not
override that selection behavior.

## Module boundaries

The module checker reads active application and package source with the existing
TypeScript parser. It checks imports, re-exports, known constant dynamic paths,
source URLs, and dependency anchors without executing application modules.
Package manifests define supported root and subpath exports. New contract,
service, worker, provider, and console leaves join the graph automatically.

Run `node scripts/verify-module-boundaries.mjs` after dependencies are installed;
the checker never installs them. Add `--json` for the complete graph and
untruncated diagnostics. Runtime cycles are reported separately from cycle
groups that require erased type edges. The broader type-involving groups can
also contain a runtime cycle. Inline `import { type T }` and `export { type T }`
retain runtime module evaluation and count as runtime edges.

The policy is in `scripts/module-boundaries/policy.json`. Existing violations
are explicitly recorded in `exceptions.json` with the exact path, import form,
imported symbols, capability owner, and removal condition. An exception does
not claim its dependency is fixed: remove it when the import is corrected, or
the stale-exception check fails. The configured installed Driver loader has an
exact exception because its validated runtime target cannot be enumerated
statically. Unresolved local or dynamic imports fail. Package import aliases
and unsupported export-map forms also fail for review; the checker does not
analyze external dependency internals or code embedded in runtime-script strings.

The focused checker cases run with
`node --test tests/conformance/module-boundaries.test.mjs`. Keep conformance,
integration, and browser tests flat under their existing runner directories;
PostgreSQL suites also retain the `postgres-*.test.mjs` name for focused discovery.

## Integration Tests

Each linked section contains the setup requirements and commands for that suite.

| Suite                     | What it verifies                                                                                                                      | Setup and commands                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Local API and lifecycle   | HTTP routes, authentication, startup, worker behavior, Driver packages, and local process boundaries.                                 | [Local checks](#local-checks)                                             |
| PostgreSQL                | Real persistence, constraints, authentication, API keys, Secret metadata, queue claims, recovery, and production bootstrap.           | [PostgreSQL](#postgresql)                                                 |
| Images and Helm           | Built controller modules, runtime startup, and rendered production packaging.                                                         | [Images and Helm](#images-and-helm)                                       |
| Docker Compose            | Real PostgreSQL, API, worker, isolated containers, and embedded OpenClaw plus dedicated Codex model turns.                            | [Docker Compose model turns](#docker-compose-model-turns)                 |
| Kubernetes HTTP fixture   | Real Kubernetes API, RBAC, ownership, revision routing, namespace preservation, and enforced NetworkPolicies.                         | [Kubernetes HTTP fixture](#kubernetes-http-fixture)                       |
| gVisor Alpha HTTP fixture | Actual gVisor execution, scoped Compute lifecycle, shared workspace retention, and unsafe-placement containment.                      | [gVisor Alpha HTTP fixture](#gvisor-alpha-http-fixture)                   |
| Kubernetes real runtimes  | Dedicated Codex, embedded OpenClaw, shared workspace, Secret API delivery, rotation, authorization, and focused workspace-file proof. | [Kubernetes model turns and Secrets](#kubernetes-model-turns-and-secrets) |
| Slack                     | Actual Socket Mode ingress and a gateway-authored reply through dedicated Codex.                                                      | [Slack](#slack)                                                           |
| ChatGPT service accounts  | Actual provider account creation, credential issuance, exact Agent delivery, and a model turn.                                        | [ChatGPT service accounts](#chatgpt-service-accounts)                     |
| OpenShell Sandbox         | Provider-owned dedicated Harness execution and filesystem/network enforcement through real tools.                                     | [OpenShell Sandbox](#openshell-sandbox)                                   |

## Console browser checks

The [console](reference/console.md) uses real controller routes in
`tests/integration/console-api.test.mjs`, `tests/browser/console.test.mjs`, and
`tests/browser/console-agents.test.mjs`. The shared browser fixture runs
Fastify, Better Auth memory storage, Native IAM, and in-memory platform storage
on an ephemeral loopback port. Configuration and Compute helpers are test-only.
The Agent browser suite seeds active revision pointers only to render admitted
history; that fixture does not prove runtime dispatch, worker leases, Compute
Driver effects, PostgreSQL persistence, live Provider health, or deployed Agent
runtime behavior.

Run the API/static boundary checks without a browser:

```sh
node --test tests/integration/console-api.test.mjs
```

On a host approved for browser automation, provision Playwright's Chromium and
run the dedicated browser suite:

```sh
pnpm exec playwright install chromium
pnpm test:console-browser
```

`OCC_TEST_BROWSER_EXECUTABLE` optionally selects an approved existing browser
executable. The suite always uses a fresh context. Browser setup is explicit;
the test command does not install software or silently skip a missing browser.
Do not change managed browser policies to make the suite run. A managed Chrome
debugging policy can currently block the browser suite on locked-down hosts; use
an approved browser environment instead. Set `OCC_TEST_CONSOLE_ARTIFACT_DIR` to
retain screenshots at a chosen path; otherwise the suite uses a temporary
directory. The existing
[image smoke test](#images-and-helm) also loads console assets from the built
controller image; it does not claim a live production deployment.

## Requirements and credentials

Use Node.js 24 or newer and the pnpm version pinned in
[`package.json`](../package.json), with dependencies installed from the lockfile:

```sh
pnpm install --frozen-lockfile
```

The tests import TypeScript source directly; a separate build is not required
to invoke them. Some local integrations also execute Git, `tar`, and pnpm. The
Driver-package test installs local fixture archives offline into temporary
directories with lifecycle scripts disabled.

| Input you supply                                                        | Used by                                                          | Where it comes from                                                                                                                                                           |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`                                                        | Docker, ordinary Kubernetes runtime tests, Slack, and OpenShell. | An existing authorized provider credential with access to the selected model.                                                                                                 |
| `OCC_TEST_CHATGPT_ADMIN_KEY_PATH` and `OCC_TEST_CHATGPT_WORKSPACE_ID`   | Real ChatGPT service-account test.                               | A protected file containing an authorized workspace admin key, plus its exact workspace ID. The test issues the Agent's credential itself; it does not need `OPENAI_API_KEY`. |
| `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`, `OCC_TEST_SLACK_SENDER_BOT_TOKEN` | Slack test only.                                                 | An existing Socket Mode app, its bot, and a distinct sender bot in the same workspace and test channel.                                                                       |
| Application-role database URLs                                          | PostgreSQL and Kubernetes integrations.                          | The disposable local databases prepared below. The documented local passwords are development fixtures, not production credentials.                                           |
| Dedicated kubeconfig                                                    | Kubernetes integrations.                                         | The disposable cluster prepared below, with authority to provision the test's scoped resources and RBAC.                                                                      |

Tests generate their own local login credentials, session secrets, transport
tokens, and scoped Kubernetes Secrets. The Kubernetes Secret API case also
provisions its test IAM grants, after proving deployment is denied without the
Agent's exact `operate` grant. You do **not** need to prepare Agent-specific
Secrets or manually grant native IAM access before running that case. This
test setup does not provide a public IAM-management interface; see the
[Secret binding requirements](reference/drivers/kubernetes-secret.md#bind-a-secret-to-gateway-environment).

Supply real keys through your authorized credential manager or an existing
private environment file. Test entrypoints do not automatically load `.env`.
For example, after preparing a file outside the repository:

```sh
TEST_ENV_FILE=/absolute/path/to/private/runtime-test.env
chmod 600 "$TEST_ENV_FILE"
node --env-file="$TEST_ENV_FILE" --test tests/integration/docker-compute-real.test.mjs
```

That file must contain the inputs for the selected suite, including its opt-in
and images. Node passes the loaded environment to test subprocesses. Existing
exported values take precedence over the file, so avoid stale selectors or keys
in the parent shell. Do not print credentials, commit them, or include them in
command-line arguments. For the ChatGPT admin key, use its dedicated file-path
option as shown below.

Model suites make real provider requests. Set `OCC_TEST_OPENAI_MODEL` explicitly
to an authorized model that supports Codex custom tools; the Kubernetes examples
use `gpt-5.1`. Docker defaults to `gpt-5.6-sol`, OpenShell to `gpt-5.6-sol`, and
the Kubernetes Harness and ChatGPT account suites currently default to `gpt-4.1`.
The latter default does not support the documented dedicated Codex request
shape; override it when running those suites.

## Local checks

With infrastructure selectors unset:

```sh
pnpm check:workspace
pnpm format:check
pnpm typecheck
pnpm openapi:check
pnpm test:conformance
pnpm test:integration
```

`check:workspace` checks the active workspace.
The test scripts above run the same canonical workspace verification before
their selected Node.js tests. `openapi:check` compares generated routes and both
API artifacts with the checked-in versions. `typecheck` and `build` currently
invoke the same TypeScript build command.

The [conformance tests](../tests/conformance/) cover domain rules and selected
Driver contracts. Kubernetes conformance tests use fixtures and rendered
resources; they do not exercise a live cluster.

The local [integration tests](../tests/integration/) include these groups:

- `occ-api`, `configuration-controller`, `secret-api`, and `service-api-keys`:
  actual Fastify routes with test Drivers and in-memory state.
- `controller-lifecycle`, `configuration-startup`, `secret-driver-startup`, and
  `sandbox-driver-startup`: admission, lifecycle, and startup validation.
- `production-controller-security` and `production-healthcheck`: internal
  request admission, HTTP cancellation, and readiness-marker behavior.
- `driver-plugin-installation` and `git-hooks`: local package installation,
  Driver selection, and hook installation/preservation in temporary checkouts.
- `compute-singleton-worker`: two local validation cases and six additional
  database-backed cases when `OCC_TEST_DATABASE_URL` is supplied.

To target a file or one named case:

```sh
node --test tests/integration/secret-api.test.mjs
node --test --test-name-pattern='part of the test name' tests/integration/secret-api.test.mjs
```

## PostgreSQL

Requires Docker Compose. Use disposable databases: tests can initialize or
change singleton platform state. The production bootstrap database must be
migrated and contain no Installation.

The following creates three new databases: general tests, production bootstrap,
and Kubernetes. If any name already exists, choose a new test name and update
the corresponding URL; do not drop an existing database to make setup pass.

```sh
pnpm db:up

(
  set -eu
  for test_database in openclaw_test_local openclaw_bootstrap_local openclaw_k8s_local; do
    docker compose -f compose.postgres.yaml exec -T postgres \
      psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
      -c "CREATE DATABASE $test_database"
    docker compose -f compose.postgres.yaml exec -T postgres \
      psql -v ON_ERROR_STOP=1 -U postgres -d "$test_database" \
      -c "GRANT CREATE ON DATABASE $test_database TO occ_migrator; CREATE SCHEMA occ AUTHORIZATION occ_migrator; CREATE SCHEMA drizzle AUTHORIZATION occ_migrator; REVOKE CREATE ON SCHEMA public FROM PUBLIC;"
    OCC_MIGRATION_DATABASE_URL="postgresql://occ_migrator:occ-migrator-local@127.0.0.1:55432/$test_database" \
      pnpm db:migrate
  done
)
```

Compose provisions the local `occ_migrator` and `occ_app` roles. Run migrations
as `occ_migrator` and the tests as the less-privileged `occ_app`. Queue coverage
uses `OCC_TEST_DATABASE_URL` with the other `pg.Pool`-backed PostgreSQL tests;
production bootstrap still needs its own URL:

```sh
(
  export OCC_TEST_DATABASE_URL=postgresql://occ_app:occ-app-local@127.0.0.1:55432/openclaw_test_local
  export OCC_PRODUCTION_WIREUP_DATABASE_URL=postgresql://occ_app:occ-app-local@127.0.0.1:55432/openclaw_bootstrap_local
  pnpm test:postgres
  node --test tests/integration/compute-singleton-worker.test.mjs
)
```

The two PostgreSQL URLs select different coverage. Omitting the general URL
skips most persistence tests, including queue coverage; omitting
`OCC_PRODUCTION_WIREUP_DATABASE_URL` skips production bootstrap. `test:postgres`
does not include the singleton-worker file, hence the second command.

Four optional live Configuration cases additionally require
`OCC_TEST_KUBERNETES_CONFIGURATION=1` and an already configured live Kubernetes
Configuration Driver in the subprocess startup environment. The flag alone
does not configure that Driver. A pre-bootstrap case also skips if its database
already has an Installation. See [PostgreSQL settings](reference/settings.md#postgresql-test-environment).

For a repeat of production bootstrap, prepare a fresh migrated database and
change its URL. Keep the general and bootstrap databases separate.

## Images and Helm

Prepare the five-package context using the [runtime image recipe](../deploy/runtime/README.md)
and set `OCC_RUNTIME_BUILD_CONTEXT` to its absolute task-owned directory. It uses
already built core, AI, Slack, Microsoft Teams, and Codex plugin artifacts plus
frozen dependency policy; it does not rebuild the SDK. Verify that context,
build the image, then run its startup smoke against the resulting local image ID:

```sh
node deploy/runtime/prepare-local-packages.mjs --verify-context "$OCC_RUNTIME_BUILD_CONTEXT"
docker build -f deploy/runtime/Dockerfile \
  --tag openclaw-enterprise-runtime:test "$OCC_RUNTIME_BUILD_CONTEXT"
OCC_TEST_RUNTIME_IMAGE="$(docker image inspect --format '{{.Id}}' openclaw-enterprise-runtime:test)" \
  node --test tests/integration/runtime-image-startup.test.mjs
```

This checks gateway readiness and bundled Codex, Slack, and Microsoft Teams plugin loading from a
fresh runtime home, then initializes the image's real Codex app-server through
the installed plugin's version guard. The smoke runs offline without provider
or channel credentials. Native Codex CLI is pinned to `0.153.0`. This does not
make a model call, establish authenticated WebSocket operation, or prove live
Slack/Teams delivery, Kubernetes behavior, or gVisor qualification; run the
[live Slack test](#slack) for Slack delivery proof. Source-artifact acceptance
remains a separate gate: successful local packaging and offline smoke do not
qualify provisional artifacts for shared integration or deployment.

The local Docker image ID binds this smoke to the built image without a registry
push. It is not a registry manifest digest and must not be substituted into a
Kubernetes `repository@sha256:...` reference.

Build the controller image using the [production prerequisites](guides/deploy.md#production-prerequisites),
then set `OCC_TEST_PRODUCTION_IMAGE` to the local tag you built:

```sh
OCC_TEST_PRODUCTION_IMAGE=openclaw-enterprise:reviewed \
  node --test tests/integration/production-image-startup.test.mjs
```

The controller smoke intentionally uses an unreachable database with networking
disabled. It verifies module loading and packaged OpenShell protocol assets;
the expected database error is the boundary being tested.

With Helm and a `yq` executable supporting `eval-all -o=json` installed:

```sh
node --test tests/integration/production-kubernetes-packaging.test.mjs
```

This renders the chart and verifies configuration, RBAC, networking, credential
placement, and bootstrap ordering. It does not install the chart. Missing Helm
or `yq` skips this suite; unset image selectors skip the image smokes.

## Docker Compose model turns

Requires Docker Engine, Compose, the built runtime image, host Python 3 with
PTY support, and an exported `OPENAI_API_KEY` or a private environment file
supplying it. The suite creates and migrates its own Compose database; the
separate PostgreSQL setup above is not required.

```sh
OCC_TEST_DOCKER_COMPUTE_REAL=1 \
OCC_DOCKER_RUNTIME_IMAGE=openclaw-enterprise-runtime:test \
OCC_TEST_OPENAI_MODEL=gpt-5.6-sol \
  node --test tests/integration/docker-compute-real.test.mjs
```

Both the embedded and dedicated paths must produce provider-backed responses.
The test also checks authentication, isolation, Agent deletion, invalid-token
TUI rejection, two same-session TUI replies, and Ctrl+D TUI exit while the
gateway remains ready. It generates its own Compose project, ports, network
range, and local administrator, then removes its project volumes and labelled
containers/networks.

An image selector also enables the suite without the opt-in flag. Missing
Docker, images, or the model credential then fails the run. Explicitly select
an image rather than relying on the test's historical local-image fallback.
See [Docker test settings](reference/settings.md#docker-compose-development-test-environment)
for separate gateway and Agent images.

## Kubernetes HTTP fixture

Requires Docker, k3d, `kubectl`, and the migrated `openclaw_k8s_local` database
from [PostgreSQL](#postgresql). Create a new disposable cluster; if `oce` already
exists, use a new name consistently throughout these commands.

```sh
mkdir -m 700 -p /tmp/oce-k3d
k3d cluster create oce \
  --api-port 127.0.0.1:6443 \
  --kubeconfig-update-default=false \
  --kubeconfig-switch-context=false
k3d kubeconfig get oce > /tmp/oce-k3d/kubeconfig
chmod 600 /tmp/oce-k3d/kubeconfig

docker build --pull=false -t oce-fixture:local tests/fixtures/kubernetes
k3d image import oce-fixture:local -c oce

OCC_TEST_KUBERNETES_KUBECONFIG=/tmp/oce-k3d/kubeconfig \
OCC_TEST_KUBERNETES_CONTEXT=k3d-oce \
OCC_TEST_KUBERNETES_IMAGE=oce-fixture:local \
OCC_TEST_DATABASE_URL=postgresql://occ_app:occ-app-local@127.0.0.1:55432/openclaw_k8s_local \
  node --test tests/integration/kubernetes-compute-real.test.mjs
```

All three fixture cases must run: Driver lifecycle/isolation, externally managed
namespace preservation, and PostgreSQL API-plus-worker reconciliation. No model
key is needed. Missing all cluster selectors skips the suite; partial selectors
fail, and a missing database skips the API-plus-worker case.

The tests require an explicit loopback `k3d-*` context and enforcing
NetworkPolicies. They create scoped RBAC and resources, and configure the
selected cluster's local-path provisioner for shared filesystem tests. Because
that changes cluster-wide storage configuration, use a disposable cluster.

## gVisor Alpha HTTP fixture

Prepare a separate disposable k3d cluster with an explicit loopback API and
home-directory kubeconfig. Preserve the default kubeconfig and context.
Install the complete verified runtime bundle using the
[gVisor preparation helper](reference/drivers/gvisor.md#offline-runtime-preparation),
then configure the node's containerd handler and exact `oce-gvisor-systrap`
RuntimeClass with systrap and strict sidecar usage. Keep runc as the ordinary
runtime, restricted Pod security, and the enforcing NetworkPolicy controller.
The suite never installs or changes that operator-owned runtime configuration.

Build and import `tests/fixtures/kubernetes` as above. Prepare shared local-path
storage only in this disposable cluster, then run the opt-in suite with all
selectors scoped to the test process:

```sh
OCC_TEST_KUBERNETES_KUBECONFIG="$HOME/.cache/oce-gvisor-cluster/kubeconfig" \
OCC_TEST_KUBERNETES_CONTEXT=k3d-oce-gvisor-alpha \
node --input-type=module - <<'JS'
import { configureExistingK3dLocalPathSharedFileSystem } from './tests/helpers/kubernetes-real.mjs';
await configureExistingK3dLocalPathSharedFileSystem({
  kubeconfigPath: process.env.OCC_TEST_KUBERNETES_KUBECONFIG,
  kubernetesContext: process.env.OCC_TEST_KUBERNETES_CONTEXT,
});
JS

OCC_TEST_GVISOR_K3D_REAL=1 \
OCC_TEST_KUBERNETES_KUBECONFIG="$HOME/.cache/oce-gvisor-cluster/kubeconfig" \
OCC_TEST_KUBERNETES_CONTEXT=k3d-oce-gvisor-alpha \
OCC_TEST_KUBERNETES_IMAGE=oce-fixture:local \
  node --test tests/integration/gvisor-kubernetes-real.test.mjs
```

This suite needs no PostgreSQL database or model credential. It exercises the
actual Compute Driver with scoped Kubernetes credentials, preparation of two
real gVisor fixture revisions, default-deny networking, retained workspace bytes, and
confirmed Pod removal after unsafe-placement containment. It removes its own
namespaces and RBAC while preserving the RuntimeClass. Retain node-side binary
hashes, runtime flags, image digests, and process evidence with the test output;
a RuntimeClass label alone does not establish which runtime ran.

No opt-in explicitly skips this separate suite. Once opted in, missing setup or
a failed live check fails the test. Without real runtime configuration,
activation leaves routing inactive. The HTTP fixture does not establish real
activation/cutover, gateway, Codex, model, or external credential behavior. Run those acceptance
checks separately for the selected Alpha deployment.

## Kubernetes model turns and Secrets

Use the disposable cluster and `openclaw_k8s_*` database above, an exported
`OPENAI_API_KEY`, and approved real gateway/Codex images. Import local image
tags, then register their corresponding immutable references inside k3s.
Replace the placeholders with the exact tags and digest references for your
images:

```sh
k3d image import '<local-gateway-tag>' '<local-codex-tag>' -c oce
docker exec k3d-oce-server-0 ctr -n k8s.io images tag \
  '<imported-gateway-image>' '<gateway-image>@sha256:<digest>'
docker exec k3d-oce-server-0 ctr -n k8s.io images tag \
  '<imported-codex-image>' '<codex-image>@sha256:<digest>'
```

Prepare a private runtime environment file with the model key and these
nonsecret settings, using the actual digest references:

```dotenv
OCC_TEST_KUBERNETES_KUBECONFIG=/tmp/oce-k3d/kubeconfig
OCC_TEST_KUBERNETES_CONTEXT=k3d-oce
OCC_TEST_DATABASE_URL=postgresql://occ_app:occ-app-local@127.0.0.1:55432/openclaw_k8s_local
OCC_TEST_KUBERNETES_GATEWAY_IMAGE=<gateway-image>@sha256:<digest>
OCC_TEST_KUBERNETES_AGENT_IMAGE=<codex-image>@sha256:<digest>
OCC_TEST_OPENAI_MODEL=gpt-5.1
```

Workspace-file conformance and Helm rendering are separate from the real
private-routing proof. The focused case requires Envoy Gateway v1.9 and
cert-manager controllers/CRDs in the selected disposable cluster, in addition
to the database, native gateway/Codex images, and authorized model credential.
It must use the real Envoy data plane; a hand-built TLS proxy does not exercise
the supported routing or authentication implementation.

The focused proof creates an Agent through production OCC composition, waits
for Compute's automatic HTTPRoute, writes and reads all four supported files,
and asks a fresh native session for the marker supplied only through
`AGENTS.md`. It then replaces the gateway Pod and repeats file reads and fresh
model consumption. Proxy authentication denials, key rotation, and cert-manager
leaf renewal under the same CA are separate required assertions.

Install the Envoy Gateway and cert-manager controllers in the disposable
cluster first. The fixture creates its own GatewayClass, CA Issuer, Gateway,
and service-key Secret; it does not install the controllers. The default
controller namespaces are `envoy-gateway-system` and `cert-manager`; override
them with `OCC_TEST_ENVOY_GATEWAY_NAMESPACE` and
`OCC_TEST_CERT_MANAGER_NAMESPACE` when needed. Helm must be on `PATH` or selected
by `OCC_HELM_BIN`.

Create a disposable test CA before starting Node so its ordinary TLS verifier
trusts the cert-manager-issued leaf. Do not use a production CA signing key:

```sh
umask 077
TEST_GATEWAY_CA_DIR=$(mktemp -d)
openssl req -x509 -newkey rsa:2048 -sha256 -days 2 -nodes \
  -subj '/CN=OCC disposable routing test CA' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -keyout "$TEST_GATEWAY_CA_DIR/key.pem" \
  -out "$TEST_GATEWAY_CA_DIR/cert.pem"
export OCC_TEST_GATEWAY_CA_CERT_PATH="$TEST_GATEWAY_CA_DIR/cert.pem"
export OCC_TEST_GATEWAY_CA_KEY_PATH="$TEST_GATEWAY_CA_DIR/key.pem"
export NODE_EXTRA_CA_CERTS="$TEST_GATEWAY_CA_DIR/cert.pem"

OCC_TEST_GATEWAY_ROUTING_REAL=1 OCC_TEST_SLACK_LIVE=0 \
  node --env-file="$TEST_ENV_FILE" --test \
  --test-name-pattern='Envoy-routed workspace files' \
  tests/integration/harness-topology-k3d-real.test.mjs
```

The focused fixture currently requires Docker Desktop and free local port 443.
Docker publishes that loopback port without running the test process as root.
TCP forwarders carry unchanged TLS bytes through `host.docker.internal` and a
Pod to the real Envoy listener, providing a genuine nonloopback downstream peer.
They do not implement HTTP,
authentication, header rewriting, or native RPC. OCC's production API and
worker run in the Node test process; this is not a Helm-installed controller
proof. The test applies the chart's Gateway policies, rotates the listener key
and API-side key file, and verifies certificate renewal without restarting OCC.
Remove only the newly created test CA directory after the run.

The ordinary native-runtime command below leaves this additional routing case
unselected. The earlier Docker manual-proxy proof has been removed because
Docker does not implement automatic private Agent routes.

Run the ordinary runtime cases independently of Slack:

```sh
OCC_TEST_HARNESS_K3D_REAL=1 OCC_TEST_SLACK_LIVE=0 \
  node --env-file="$TEST_ENV_FILE" --test tests/integration/harness-topology-k3d-real.test.mjs
```

Three non-Slack runtime cases must pass: dedicated Codex, embedded OpenClaw with
a persisted service-account credential, and embedded OpenClaw using the Secret
API. The Secret API case verifies native SecretRefs, exact grants and denial,
shared Secrets, rotation, and redeployment. It prepares those Secrets and grants
itself. The independent Slack case is expected to skip in this run.

This suite uses the real production API and worker in the Node test process.
It does not install the controller with Helm. Missing selected-suite
prerequisites fail; an unselected suite skips. Default Codex version expectation
is `0.153.0`; see [runtime settings](reference/settings.md#kubernetes-real-runtime-test-environment)
for version assertions and alternate image variables.

## Slack

Use the Kubernetes runtime prerequisites and model credential above, plus an
authorized test channel. The gateway image must already contain the Slack plugin
and its runtime dependencies. Run the [runtime image smoke](#images-and-helm)
before provisioning the cluster, and use a Codex app-server version accepted by
the gateway's installed Codex plugin. Successful `--version` commands alone do
not prove that the two runtimes are compatible.

Put the three Slack tokens in the private environment
file. Set `OCC_TEST_SLACK_CHANNEL_ID` and `OCC_TEST_SLACK_PROXY_URL`; the proxy URL
must have a literal IP and explicit port. Both bots must belong to the same
workspace and have joined the channel. Use an existing Socket Mode app configured
to receive the test messages.

```sh
OCC_TEST_SLACK_LIVE=1 \
  node --env-file="$TEST_ENV_FILE" --test tests/integration/harness-topology-k3d-real.test.mjs
```

This posts real Slack messages and leaves them in the channel. It verifies the
reply and exact runtime/session evidence. The sender bot must differ from the
Agent bot; its credential remains with the test runner. This selection skips
the ordinary runtime cases, so run both selections for complete Harness
coverage. See [Slack test settings](reference/settings.md#slack-test-environment).

## ChatGPT service accounts

Use the same disposable cluster, migrated database, and immutable runtime
images. Supply a protected admin-key file and the exact authorized workspace ID;
the test creates a real provider account and issues its model credential.

```sh
(
  unset OCC_TEST_CHATGPT_ADMIN_KEY
  export OCC_TEST_CHATGPT_ADMIN_KEY_PATH=/absolute/path/to/private/chatgpt-admin-key
  export OCC_TEST_CHATGPT_WORKSPACE_ID='<authorized-workspace-id>'
  OCC_TEST_CHATGPT_SERVICE_ACCOUNT_REAL=1 \
    node --env-file="$TEST_ENV_FILE" --test tests/integration/service-account-driver-real.test.mjs
)
```

Keep `OCC_TEST_CHATGPT_ADMIN_KEY` out of that environment file as well: a nonempty
environment key takes precedence over the file-path option. Protect the supplied
key file with mode `0600`. `OPENAI_API_KEY` is not required. Set the supported
model explicitly as above. The test attempts provider-account deletion and
scoped resource cleanup; investigate any reported cleanup failure before rerunning.

## OpenShell Sandbox

This suite needs a separately prepared disposable cluster with the selected
RuntimeClass, Agent Sandbox CRD, and ready Agent Sandbox controller. It also
needs OpenShell CLI/Helm/chart files, imported immutable OpenShell gateway and
supervisor images, real gateway/Codex images, the Kubernetes test database,
`openssl`, and `OPENAI_API_KEY`. The standard k3d recipe alone is insufficient.

Prepare these inputs using the
[OpenShell test settings](reference/settings.md#openshell-test-environment) and
[OpenShell requirements](reference/drivers/openshell-sandbox.md#kubernetes-and-admission-requirements),
then run the exact file:

```sh
OCC_TEST_OPENSHELL_K3D_REAL=1 \
  node --env-file="$TEST_ENV_FILE" --test tests/integration/sandbox-driver-openshell-k3d-real.test.mjs
```

The test proves provider-owned dedicated Codex execution, real tool filesystem
and network enforcement, duplicate reconciliation, replacement/cleanup with an
absent Pod, and rejection of embedded placement. It uses explicit integration
bridges documented in the Driver reference; it is not general production-installation
proof. Missing prerequisites after selection fail rather than skip.

## Results, cleanup, and troubleshooting

Read the test runner's pass, failure, and skip counts. Record the selected files,
commit, nonsecret image digests/model, and which optional cases were enabled.
Do not report a skipped model turn, database case, or cluster case as verified.
Keep optional live Configuration cases and mutually exclusive Slack selection
distinct from missing prerequisites.

Tests normally clean up their own temporary processes, resources, and files.
Kubernetes suites leave the selected cluster and database in place. After all
needed suites finish, remove only the disposable cluster you created:

```sh
k3d cluster delete oce
```

Retain failure evidence before removing test resources. Review and remove only
databases created for this run when no test connections remain. Do not delete
shared Compose volumes, existing databases, or unrelated clusters. Slack messages
remain; provider-account cleanup failures require explicit follow-up.

| Symptom                                                  | Check or recovery                                                                                                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Green command with expected integration coverage absent  | Inspect skips and selection variables; target the exact suite with its full prerequisites.                                                                    |
| OpenShell prerequisite error during a database-only run  | Run `test:postgres` and the singleton-worker file directly; do not invoke the all-integration glob with shared infrastructure variables.                      |
| Provider authentication or unsupported custom-tool error | Check credential/model access without printing the key; explicitly select a compatible model.                                                                 |
| Kubernetes `ImagePullBackOff`                            | Import the local tag and register the exact configured digest alias inside k3s.                                                                               |
| Bootstrap database already contains an Installation      | Use a new disposable, migrated bootstrap database.                                                                                                            |
| Secret-backed deployment denied                          | The test's missing-grant case deliberately expects `403`; a failing positive case needs exact caller and Agent `operate` grants, not broader Kubernetes RBAC. |
| Missing Helm or `yq`                                     | Install the required tools before claiming packaging coverage; this test does not install them.                                                               |

## Related

- [Test environment settings](reference/settings.md#postgresql-test-environment)
- [Deployment guide](guides/deploy.md)
- [Runtime image recipe](../deploy/runtime/README.md)
- [Contributor integration boundaries](../AGENTS.md#running-integration-tests)

## OpenShell and SPIFFE Go components

Build and check the native implementation before exercising the controller
adapter:

```sh
go -C components/runtime-security build -o ./bin/oce-runtime-security ./cmd/oce-runtime-security
go -C components/runtime-security test -race ./...
go -C components/runtime-security vet ./...
```

Native wire tests require local socket creation. The controller adapter's tests
must invoke the actual compiled executable. The [module README](../components/runtime-security/README.md)
and [identity reference](reference/workload-identity.md) explain the native
command and local identity boundary.

For genuine provider interoperability, provision SPIRE and a registration for
the actual Go test process, then select:

```sh
OCC_TEST_SPIFFE_SOCKET_PATH=/run/spire/agent.sock \
OCC_TEST_SPIFFE_ID=spiffe://example.org/controller \
OCC_TEST_SPIFFE_AUDIENCE=oce-local-test \
go -C components/runtime-security test ./identity -run TestRealSPIRE -count=1
```

Any of these settings selects the real test and requires all three. Without
them it skips explicitly. Keep native local SPIRE proof separate from actual
Kubernetes/OpenShell/Kata guest attestation and current runtime authorization.
The earlier TypeScript implementation's tests are historical checkpoint
receipts, not validation of the native components.

The [SPIRE first observation fixture](../tests/fixtures/spire-first-observation-v1/README.md)
adds separate test-only H0/H1/H2 coverage: actual SPIRE receiver PID metadata,
protected Pod/sandbox mapping, and complete delivered X.509 identity sets for
two coexisting gVisor Pods whose identity-observer phases run serially. It
requires a separately prepared disposable environment, with no default
kubeconfig or provider selection:

```sh
OCC_TEST_SPIRE_FIRST_OBSERVATION_REAL=1 \
OCC_SPIRE_FIRST_OBSERVATION_PROFILE=/absolute/operator/profile.json \
OCC_SPIRE_FIRST_OBSERVATION_PROFILE_SHA256='<sha256-of-exact-profile-bytes>' \
node --test --test-concurrency=1 tests/integration/gvisor-spire-first-observation-real.test.mjs
```

The preparation owner retains cluster/runtime/image and SPIRE management
ownership; the selected test owns its A/B Pods, registrations and observer
children. Unit checks and offline builds verify fixture machinery only. Live
coverage remains unexecuted until separately allocated and run; even a passing
first slice does not establish native Codex consumption, identity renewal,
replacement/replay behavior or current production authorization. See the
fixture README for its exact profile contract, metadata limits and settlement
requirements.

The selected gVisor flags include `--network=none` alongside systrap/STRICT and
`--host-uds=open`. The live test requires loopback-only guest interfaces and
unreachable results for fixed operator-owned management endpoints. Default-deny
NetworkPolicy alone does not prove isolation from the workload's own node.
The effective runtime/network checks remain unrun, and unsupported UDS or
network-none behavior has no automatic fallback.
Configured RBAC checks verify the expected grants; they do not rule out other
grants to the same ServiceAccounts or groups. Full effective RBAC qualification
remains separate.

Run the native controller process tests from the repository root:

```sh
node --test tests/integration/openshell-native-bridge.test.mjs tests/integration/sandbox-driver-startup.test.mjs
```

The process suite compiles the Go executable into a temporary directory by
default. To verify an existing build, set `OCC_RUNTIME_SECURITY_BINARY` to its
absolute path. The actual native command runs in both cases; local socket
permissions are required. Production image checks additionally inspect the
packaged executable and its third-party license/version records.
