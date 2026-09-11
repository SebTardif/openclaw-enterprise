# Native runtime security and SPIRE tests

Verify native Go process behavior separately from selected real-provider and
gVisor fixture coverage. These checks do not admit production workloads.

## Native component checks

Build and check the native implementation before exercising the controller
adapter. Go 1.26 or newer is required:

```sh
go -C components/runtime-security build -o ./bin/oce-runtime-security ./cmd/oce-runtime-security
go -C components/runtime-security test -race ./...
go -C components/runtime-security vet ./...
```

Native wire tests require local socket creation. The controller adapter's tests
must invoke the actual compiled executable. The [module README](../../components/runtime-security/README.md)
and [identity reference](../reference/workload-identity.md) explain the native
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

The [SPIRE first observation fixture](../../tests/fixtures/spire-first-observation-v1/README.md)
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

## Native build inputs

The controller image includes `/usr/local/bin/oce-runtime-security`, built from
[`components/runtime-security`](../../components/runtime-security/README.md).
Both production and development image targets require `GO_BASE_IMAGE` to name
an approved digest-pinned Go 1.26 or newer builder. Compose passes this build
argument through; a blank value fails image building. Native local development
uses `pnpm build:native` with an installed Go toolchain.

An OpenShell `gateway.binaryPath` override must be an absolute path to a trusted
Go executable. The default is `/usr/local/bin/oce-runtime-security`. The
controller invokes it directly, without a shell or inherited environment, and
passes credentials by configured file paths in bounded stdin JSON. The Go
component opens those files and handles TLS and gRPC.

The Docker Compose real integration also requires `GO_BASE_IMAGE`, since it
builds the development controller image. The production image startup check
verifies that the packaged native executable can run.

## SPIFFE test environment

These variables select only the Go identity package's real-provider tests.
They do not change controller authentication or runtime Driver selection.

| Variable                      | Meaning                                                             |
| ----------------------------- | ------------------------------------------------------------------- |
| `OCC_TEST_SPIFFE_SOCKET_PATH` | Absolute protected Unix socket path of the real local SPIRE Agent.  |
| `OCC_TEST_SPIFFE_ID`          | Exact SPIFFE workload ID registered for the actual Go test process. |
| `OCC_TEST_SPIFFE_AUDIENCE`    | Explicit JWT audience used for issuance and validation.             |

Providing any one selects the test and requires all three. An unconfigured test
skips. See [workload identity](../reference/workload-identity.md) and the
[Go module](../../components/runtime-security/README.md) for the client,
metadata-only native diagnostic and test commands.

## Runtime service trust test inputs

The [runtime service trust reference](../reference/settings/runtime-services.md#runtime-service-trust-and-authenticated-readback)
owns production source and listener configuration. These inputs select local
registry/transport and disposable persistence tests; they do not create runtime
service admission:

| Variable                                          | Meaning                                                                                                               |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `OCC_RUNTIME_AUTHORITY_TEST_BINARY`               | Actual built native binary for local registry/transport integration tests; it must satisfy executable custody checks. |
| `OCC_RUNTIME_SERVICE_TRUST_DATABASE_URL`          | Disposable PostgreSQL 18 test database accessed with the limited application role.                                    |
| `OCC_RUNTIME_SERVICE_TRUST_MIGRATOR_DATABASE_URL` | The same database's migrator role, used only for explicit reversible test locks and constraint checks.                |

## Related

- [OpenShell integration](openshell.md).
- [gVisor Alpha HTTP fixture](gvisor.md).
- [Choose another test suite](README.md).
