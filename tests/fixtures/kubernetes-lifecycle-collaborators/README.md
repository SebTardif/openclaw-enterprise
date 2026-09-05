# Kubernetes lifecycle extraction conformance

This corpus runs the actual `KubernetesComputeDriver` through `ensureNamespace`,
`deleteNamespace`, `prepareRevision`, `activateRevision`, `deactivateRevision`, and
`retireRevision`. It injects only the Kubernetes SDK client boundary and selected
lifecycle observers. It does not call private Driver methods or the extracted
collaborators, and the client does not implement ownership, readiness, retry,
immutability, or cleanup decisions.

`before-extraction.json` freezes traces recorded from commit
`e174c90a729c4c8e58285111aa4edf9f886fa077` using Node `v24.20.0`.
The original `index.ts` was preserved outside the product checkout and loaded at
its original module URL with a Node module load hook. This retained the original
relative imports while the extraction proceeded independently. The corpus is
fixed test data; running the tests never rewrites it.

`inputs.json` contains the explicit configuration and admitted revision used for
the recording. `observations.json` contains manifests emitted by the baseline
Driver's public namespace preparation, revision preparation, and activation
operations, with fixed API server UIDs, resource versions, generation/status
observations, and EndpointSlices supplied during recording. Scenarios vary these
observations to exercise negative cases. The committed client stores patches and
deletes, serves the supplied observations, and records every attempted request.
It does not infer readiness from a patch.

Successor retirement scenarios use a second independently recorded revision's
public preparation and activation output, preserving its consistent immutable
configuration, Deployment, and HTTPRoute observations.

Traces preserve request order, resource names, complete mutation-body SHA-256
fingerprints, mutation metadata, selectors, delete preconditions, errors, and
ordered lifecycle callbacks. The conformance tests additionally state the
expected safety boundaries directly. The accepted-write/lost-response cases
model an unknown mutation effect at the client boundary; owner cancellation is
manually triggered and does not establish database lease-loss behavior.

The recorder retains all supplied SDK arguments. Injecting clients bypasses the
SDK setup of typed patch headers, so their actual Content-Type behavior remains
outside this corpus.

This is controlled-client extraction conformance. It does not establish live
Kubernetes SDK, API server, admission, networking, Pod, or OpenClaw runtime behavior.

Run with an installed Node 24 toolchain:

```sh
node --test tests/conformance/kubernetes-lifecycle-collaborators.test.mjs
```
