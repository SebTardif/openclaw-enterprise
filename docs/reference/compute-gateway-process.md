# Agent Gateway process participant

The selected Kubernetes Compute Driver exposes `getAgentGatewayProcessParticipant()` for the versioned Agent Gateway protocol. Its subject is the Installation, Namespace membership and Agent, with an original process generation and create effect. The historical Installation service participant remains available through `getInstallationProcessParticipant()`. The two protocols retain distinct call and submission identities; neither an Installation lookup nor a matching serialized object enrolls an Agent call.

Both protocols use the existing selected Driver and cached Kubernetes client. Selecting the Agent dependencies refuses the legacy revision preparation and activation entrypoints before lifecycle hooks or API work. Creation for that selection goes through the original `createOriginal` participant. This change does not install a Harness creator, a serving activation participant, or a production admission source.

## Original invocation and effect custody

The original call owner synchronously enrolls the exact method, complete immutable input and same call object, registering a whole-invocation drain before acceptance or any currentness fence. Enrollment establishes call custody. The accepting owner must independently authenticate the caller and grant the current operation lifetime. Missing enrollment, accepting methods, retention methods or other required participants return unavailable before client access.

The same original scope survives the submission transaction's COMMIT. It retains deferred acceptance, currentness checks, plan acquisition, SDK work and late original-record retention. Cancellation or deadline expiry can return unavailable or an original-operation unknown result while this scope continues joining the underlying work. Deferred results from callbacks that must be synchronous are refused and retained until settlement. No later accepting scope or freshly issued call replaces the original one.

`createOriginal` reacquires the protected launch source, reads the exact existing Namespace UID, and obtains the original owner's durable submission claim. Only a newly committed claim can produce the one-use submission ticket. The ticket is consumed synchronously inside the existing request closure immediately before the SDK create call, followed only by local cancellation/deadline checks. Claim uncertainty, an unknown SDK outcome or failed durable acknowledgment retain the original operation. None permits replay or successor allocation.

## Admitted launch correspondence

The launch source provides the original admitted selection, complete canonical manifest bytes, revision and configuration association, and exact physical target. The pure renderer checks the existing manifest digest and five role digests using the canonical decoder and projection functions. It compares the Installation, Namespace, Agent, admitted revision, configuration reference/version/digest, all four selection fields, and the resolved profile roles. This comparison grants no current authority.

The original qualified participants resolve the manifest's logical cluster and Namespace allocation into the exact target, its runtime implementation into the complete immutable renderer template, its environment and module definitions into their fixed values, and its store definitions into concrete volumes. These resolutions require authentic original-owner custody. Matching definition references or digests alone do not authenticate them, and a database selection lease is not a provider mutation permit.

The Gateway image and executable arguments come from the admitted artifact and argument definition. Only the declared configuration, state and bootstrap path bindings can be expanded. The selected RuntimeClass is explicit in that definition. The renderer preserves the qualified init image and template while applying the original complete resource accounting for one ordinary init followed by one application container. Broader topologies remain unsupported. Both Gateway and Harness accounting inputs must be complete for the shared resource plan; this renderer creates only the Gateway.

The original store participant supplies an explicit accounting-to-volume mapping for the runtime home and temporary store. Their accounting identities, disk medium and exact capacities must match the final volume definitions. All retained init mounts must reference the final qualified volume set. A missing or mismatched definition, selected resource value, logical placement, volume capacity or resolved module is refused before Kubernetes clients are used. The existing global admitted resource-policy path remains unavailable; this bounded process consumer does not enable it.

## Observation, recovery and retirement

`discoverOriginal` and `recoverOriginal` read the protected original correlation. A found record is neither a current API observation nor evidence that a late create has settled. Missing correlation stays unknown.

`observeExact` rereads the original record and protected launch definition, then uses the existing Namespace → Deployment → ReplicaSet → Pod ownership checks and selected container identities. The original record retains its creation resource version; a current observation reports fresh resource versions. All attributable descendants are retained, including ambiguous sets. A single UID chain is reported only for one attributable Pod. API absence does not prove physical termination.

`requestRetirement` requires a separate current cleanup responsibility bound to the exact original object. It rereads the Namespace UID, Deployment UID and generation, and submits deletion with the observed current UID and resource-version preconditions. The original cleanup owner retains the request outcome independently of caller cancellation. A successful API response still reports unknown physical termination and cannot authorize a successor.

`readReplacementDisposition` consumes only a separately authenticated current physical receipt for the exact original operation, including complete process-tree and late-create closure. It cannot derive such a receipt from API absence, an acknowledged delete, a close result or a Boolean. Unconfigured original call, admission, launch, physical-store and physical-termination producers remain unavailable.

The controlled component suite exercises the actual Driver, canonical manifest decoder, collaborator and official Kubernetes SDK serializers through a controlled transport. It covers original-call and version boundaries, immutable launch mismatches, one-use dispatch, cancellation and deferred drains, current UID/resource-version checks and the physical-unknown distinction. These tests and the strict consumer establish source correspondence; they do not establish live cluster, identity, provider or physical-termination qualification.
