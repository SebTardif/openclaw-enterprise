# gVisor Alpha tests

Verify scoped Compute preparation and containment with an actual gVisor HTTP
fixture. Prepare the [Kubernetes HTTP fixture image](kubernetes.md#kubernetes-http-fixture)
first; native model-turn coverage has separate prerequisites.

## gVisor Alpha HTTP fixture

Prepare a separate disposable k3d cluster with an explicit loopback API and
home-directory kubeconfig. Preserve the default kubeconfig and context.
Install the complete verified runtime bundle using the
[gVisor preparation helper](../reference/drivers/gvisor.md#offline-runtime-preparation),
then configure the node's containerd handler and exact `oce-gvisor-systrap`
RuntimeClass with systrap and strict sidecar usage. Keep runc as the ordinary
runtime, restricted Pod security, and the enforcing NetworkPolicy controller.
The suite never installs or changes that operator-owned runtime configuration.

Build and import `tests/fixtures/kubernetes` using the linked Kubernetes recipe. Prepare shared local-path
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

A skipped suite leaves the selected gVisor development coverage unverified.
Required coverage must be executed on the selected profile before reporting it
verified.

## Related

- [Native runtime security and SPIRE](runtime-security.md).
- [Choose another test suite](README.md).
- [Results, cleanup, and troubleshooting](README.md#results-cleanup-and-troubleshooting).
