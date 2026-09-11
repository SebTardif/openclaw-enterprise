# Local Kubernetes and development operations

Build digest-pinned local Kubernetes images, verify development TUI access, or
stop the development stack. Run commands from the repository root. Use the
[production deployment sequence](../deploy.md#production) for Namespace and Agent setup.

## Build images for local Kubernetes

This uses the same build/import path as the local Kubernetes tests. Build the
controller from this checkout and one combined OpenClaw/Codex image for both
Installation image slots. Local build digests vary by build and platform, so
read them from the imported images instead of copying a sample digest.

Prerequisites: Docker, k3d, and [yq v4](https://github.com/mikefarah/yq).
Create a disposable single-server cluster without changing your kubeconfig:

```bash
export CLUSTER="occ-images-$(date +%s)"
export OCC_EXAMPLE_DIRECTORY="$(mktemp -d)"
k3d cluster create "$CLUSTER" --servers 1 --agents 0 \
  --api-port 127.0.0.1:0 \
  --kubeconfig-update-default=false --kubeconfig-switch-context=false
k3d kubeconfig get "$CLUSTER" > "$OCC_EXAMPLE_DIRECTORY/kubeconfig"
chmod 600 "$OCC_EXAMPLE_DIRECTORY/kubeconfig"
export KUBECONFIG_FILE="$OCC_EXAMPLE_DIRECTORY/kubeconfig"
export CONTEXT="k3d-$CLUSTER"
```

Build and import the images. Select the [controller SDK inputs](build-inputs.md#controller-sdk-build-inputs)
and `NODE_BASE_IMAGE` first. Set `GO_BASE_IMAGE` to an approved digest-pinned
Go 1.26 or newer builder as described above, and prepare
`OCC_RUNTIME_BUILD_CONTEXT` with the [local package procedure](build-inputs.md#prepare-the-runtime-build-context).
These local builds and imports do not require a registry push:

```bash
docker build --target runtime \
  --build-arg NODE_BASE_IMAGE="$NODE_BASE_IMAGE" \
  --build-arg GO_BASE_IMAGE="$GO_BASE_IMAGE" \
  --build-context oce-upstream-inputs="$OCC_BUILD_UPSTREAM_SDK_CONTEXT" \
  --build-arg OCE_UPSTREAM_SDK_MANIFEST_SHA256="$OCC_BUILD_UPSTREAM_SDK_MANIFEST_SHA256" \
  -t "localhost/$CLUSTER/controller:local" .
node deploy/runtime/prepare-local-packages.mjs --verify-context "$OCC_RUNTIME_BUILD_CONTEXT"
docker build -f deploy/runtime/Dockerfile \
  -t "localhost/$CLUSTER/runtime:local" "$OCC_RUNTIME_BUILD_CONTEXT"
k3d image import "localhost/$CLUSTER/controller:local" \
  "localhost/$CLUSTER/runtime:local" -c "$CLUSTER"
```

Register each imported manifest digest in k3s. A Docker image ID from
`docker image inspect --format '{{.Id}}'` identifies the local image configuration;
it is not the registry or imported manifest digest required in the references
below:

```bash
for role in controller runtime; do
  tag="localhost/$CLUSTER/$role:local"
  digest="$(docker exec "k3d-$CLUSTER-server-0" ctr -n k8s.io images list |
    awk -v image="$tag" '$1 == image { print $3 }')"
  printf '%s\n' "$digest" | grep -Eq '^sha256:[a-f0-9]{64}$' || exit 1
  reference="localhost/$CLUSTER/$role@$digest"
  docker exec "k3d-$CLUSTER-server-0" ctr -n k8s.io images tag "$tag" "$reference"
  if [ "$role" = controller ]; then
    export CONTROLLER_IMAGE="$reference"
  else
    export RUNTIME_IMAGE="$reference"
  fi
done
```

Populate private YAML copies with those references:

```bash
umask 077
cp deploy/examples/production/{values,installation,bootstrap-pvc}.yaml "$OCC_EXAMPLE_DIRECTORY/"
yq -i '.images.controller = strenv(CONTROLLER_IMAGE)' "$OCC_EXAMPLE_DIRECTORY/values.yaml"
yq -i '.drivers.compute.configuration.images.gateway = strenv(RUNTIME_IMAGE) |
  .drivers.compute.configuration.images.agent = strenv(RUNTIME_IMAGE)' "$OCC_EXAMPLE_DIRECTORY/installation.yaml"
printf 'Image-configured examples: %s\n' "$OCC_EXAMPLE_DIRECTORY"
```

These references work in this cluster and retain `requireImmutableDigest: true`.
Use the generated directory in place of `/secure/occ` in the production commands;
keep its image values and kubeconfig instead of copying the templates again.
Set the remaining database, HTTPS, network, and storage inputs for your trial
(k3d's default StorageClass is `local-path`). The images alone do not configure
those dependencies or prove an Agent model turn. When finished with the trial,
run `KUBECONFIG="$KUBECONFIG_FILE" k3d cluster delete "$CLUSTER"`.

## Stop development safely

```bash
docker compose down
```

This preserves PostgreSQL, Configuration, and bootstrap-key volumes. Use
`docker compose down --volumes` only when deliberately deleting the local
Installation after accounting for Agent containers and tenant networks owned by
Docker Compute.

## Development end-to-end TUI

Prerequisites: completed [development startup](../deploy.md#development), exported
`OCC_URL` and `OCC_SERVICE_KEY_FILE` from the `dev-up` output,
`OPENAI_API_KEY` available to the worker, and the quickstart runtime image.

Recreate the worker when it was already running without the model credential:

```bash
docker compose up -d --force-recreate worker
docker compose exec -T worker \
  node -e 'process.exit((process.env.OPENAI_API_KEY || "").trim() ? 0 : 1)'
```

Select the initial `default` Namespace and save its server-generated ID:

```bash
NAMESPACE_ID="$(scripts/occ-api GET /namespaces | python3 -c 'import json,sys; matches=[n for n in json.load(sys.stdin)["data"] if n["name"] == "default"]; assert len(matches) == 1, "Expected one bootstrap-created default Namespace"; print(matches[0]["id"])')"
export NAMESPACE_ID
```

Poll `scripts/occ-api GET "/namespaces/$NAMESPACE_ID"` until `data.status` is
`ready`. Create `configuration.json` from the embedded OpenClaw example in
[Configure the Agent runtime](production-agents.md#configure-the-agent-runtime), then create the
Agent:

```bash
CONFIGURATION_RESPONSE="$(scripts/occ-api POST "/namespaces/$NAMESPACE_ID/configurations" configuration.json)"
CONFIGURATION_ID="$(printf '%s' "$CONFIGURATION_RESPONSE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["id"])')"
printf '{"name":"tui-agent","configurationId":"%s","executionMode":"embedded"}\n' "$CONFIGURATION_ID" > agent.json
AGENT_RESPONSE="$(scripts/occ-api POST "/namespaces/$NAMESPACE_ID/agents" agent.json)"
AGENT_ID="$(printf '%s' "$AGENT_RESPONSE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["id"])')"
export AGENT_ID
```

Continue with [Submit an identified deployment](production-agents.md#submit-an-identified-deployment)
only when its genuine suppliers, selected ServiceAccount and saved profile
selection are available. The default composition leaves that admission path
unavailable; the Configuration and Agent creation above do not supply those
inputs. Prepare and retain the exact V2 command as described there, then submit
that file:

```bash
: "${DEPLOY_COMMAND_FILE:?set the protected retained V2 command file}"
OPERATION_REF="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["operationRef"])' "$DEPLOY_COMMAND_FILE")"
export OPERATION_REF
DEPLOY_RESPONSE="$(scripts/occ-api POST "/namespaces/$NAMESPACE_ID/agents/$AGENT_ID/deploy" "$DEPLOY_COMMAND_FILE")"
printf '%s' "$DEPLOY_RESPONSE" | python3 -c 'import json,os,sys; data=json.load(sys.stdin)["data"]; assert data["disposition"] == "accepted" and data["operation"]["operationRef"] == os.environ["OPERATION_REF"]'
```

Stop on an error or uncertain response and follow [lifecycle recovery](../lifecycle-recovery.md).
The accepted receipt supplies no revision ID. When the lifecycle reader and
fresh exact Agent-read permission are available, obtain the original operation's
revision through a separate read:

```bash
OPERATION_RESPONSE="$(scripts/occ-api GET "/namespaces/$NAMESPACE_ID/agents/$AGENT_ID/lifecycle/operations/$OPERATION_REF")"
REVISION_ID="$(printf '%s' "$OPERATION_RESPONSE" | python3 -c 'import json,os,sys; op=json.load(sys.stdin)["data"]["operation"]; assert op["operationRef"] == os.environ["OPERATION_REF"] and op["kind"] == "deploy" and isinstance(op["requestedRevisionId"], str); print(op["requestedRevisionId"])')"
export REVISION_ID
```

An unavailable operation read leaves this continuation unavailable. Do not infer
the original operation's revision from a newer Agent selection. After
`GET /namespaces/$NAMESPACE_ID` reports `ready` and
`GET /namespaces/$NAMESPACE_ID/agents/$AGENT_ID` reports the deployed
`activeRevisionId`, discover the single owned Docker gateway container:

```bash
GATEWAY_CONTAINER="$(docker ps -q \
  --filter label=org.openclaw.enterprise.managed=true \
  --filter label=org.openclaw.enterprise.compute-driver=docker \
  --filter label=org.openclaw.enterprise.namespace-id="$NAMESPACE_ID" \
  --filter label=org.openclaw.enterprise.agent-id="$AGENT_ID" \
  --filter label=org.openclaw.enterprise.revision-id="$REVISION_ID" \
  --filter label=org.openclaw.enterprise.role=gateway)"
test "$(printf '%s\n' "$GATEWAY_CONTAINER" | sed '/^$/d' | wc -l)" -eq 1
export GATEWAY_CONTAINER
```

Attach the TUI inside that container. It already has the gateway URL and token:

```bash
E2E_SESSION="occ-tui-$(date +%Y%m%d%H%M%S)"
NONCE="$(python3 -c 'import secrets; print("OCC_TUI_" + secrets.token_hex(8))')"
docker exec -it -e OPENCLAW_STATE_DIR=/tmp/occ-tui-client \
  "$GATEWAY_CONTAINER" node /app/openclaw.mjs tui \
  --session "$E2E_SESSION" --message "Reply exactly: $NONCE"
```

Verify the assistant replies with the nonce, send a second nonce in the same
TUI, then press Ctrl+D. Exiting the TUI does not stop the Agent gateway. Do not
pass OCC service keys, gateway tokens, `--url`, or `--token` on the command
line.
