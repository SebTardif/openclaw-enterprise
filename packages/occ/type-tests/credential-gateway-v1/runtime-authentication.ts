import type {
  AgentRevision,
  ComputeAgentBinding,
  ComputeRevisionContext,
  Namespace,
  RuntimeAuthenticationAttachmentOutcomeV1,
  RuntimeAuthenticationDeliveryV1,
  RuntimeAuthenticationProjectionV1,
  RuntimeAuthenticationReceiverV1,
  RuntimeAuthenticationRequestV1,
  SandboxHarnessContext,
} from "@openclaw-enterprise/contracts";
import type {
  Bounds,
  BackendCapabilities,
  CoreAuthenticationBinding,
  ExternalRuntimeAuthenticationCapabilityV1,
  RuntimeAuthenticationAttachmentInspectionV1,
  RuntimeAuthenticationAttachmentV1,
  RuntimeAuthenticationOwnerV1,
  SchemaRef,
} from "@openclaw-enterprise/occ";

// Inert consumers of the exported declaration boundary. These declarations do
// not implement broker admission, provider observation or external key custody.
declare const owner: RuntimeAuthenticationOwnerV1;
declare const binding: ComputeAgentBinding;
declare const revision: Readonly<AgentRevision>;
declare const namespace: Readonly<Namespace>;
declare const bounds: Bounds;
declare const projection: RuntimeAuthenticationProjectionV1;
declare const authentication: CoreAuthenticationBinding;
declare const attachment: RuntimeAuthenticationAttachmentV1;
declare const receiver: RuntimeAuthenticationReceiverV1;
declare const delivery: RuntimeAuthenticationDeliveryV1;
declare const request: RuntimeAuthenticationRequestV1;
declare const sandbox: SandboxHarnessContext;
declare const metadata: Pick<
  RuntimeAuthenticationProjectionV1,
  Extract<keyof RuntimeAuthenticationProjectionV1, string>
>;
declare const operationSchema: SchemaRef;
declare const profileSchema: SchemaRef;

// This tuple is representable by the existing backend contract. Its declaration
// does not register a mechanism or establish genuine runtime admission.
const capability: ExternalRuntimeAuthenticationCapabilityV1 = {
  serviceId: "example-model-service",
  operationSchema,
  profileSchema,
  authenticationCapability: "example-model-session",
  authenticationMode: "external-runtime",
  mechanism: {
    name: "runtime-authentication-v1",
    version: 1,
    digest: "example-runtime-authentication-contract-digest",
  },
  acquisitionMode: "standing",
  invalidation: "source-managed",
};
const operationCapabilities: BackendCapabilities["operationCapabilities"] = [capability];

async function consume(): Promise<void> {
  const configured = await owner.status({ binding, bounds });
  const prepared = await owner.prepare({ revision, bounds });
  const context: ComputeRevisionContext = {
    secretEnvironment: [],
    ...(prepared === undefined ? {} : { runtimeAuthentication: prepared }),
  };
  const planned = await owner.prepareAttachment({ projection, receiver, bounds });
  if (planned.kind === "create") {
    planned.assertAndConsume();
    await owner.observeAttachment({
      attachment: planned.attachment,
      outcome: { kind: "created", receiverUid: "example-observed-receiver" },
      bounds,
    });
  } else {
    // @ts-expect-error The original submitted/uncertain attempt has no new create gate.
    planned.assertAndConsume();
    // @ts-expect-error Retained attempts provide no provider references for resubmission.
    planned.providers;
  }
  // Both branches inspect their original owner-retained attachment.
  const observation = await owner.inspect({ attachment: planned.attachment, bounds });
  if (observation.state === "attached") {
    const usableUntil: number = observation.usableUntil;
    const receiverUid: string = observation.receiverUid;
    void [usableUntil, receiverUid];
  } else {
    // @ts-expect-error Pending/unknown/withdrawn never expose usable session evidence.
    observation.usableUntil;
  }
  // The cleanup ports require the retained attempt or revision, not a new grant.
  await owner.withdraw({ attachment, bounds });
  await owner.closeRevision({ revision, bounds });
  // Namespace cleanup addresses retained obligations even after catalog deletion.
  await owner.closeNamespace({ namespace, bounds });
  const projectedSandbox: SandboxHarnessContext = { ...sandbox, runtimeAuthentication: request };
  void [configured, context, projectedSandbox];
}
void consume;

const issuedAttachment: ExternalRuntimeAuthenticationCapabilityV1 = {
  ...capability,
  // @ts-expect-error The external runtime bridge consumes an externally retained standing key.
  acquisitionMode: "issued",
};
const revocableSource: ExternalRuntimeAuthenticationCapabilityV1 = {
  ...capability,
  // @ts-expect-error Receiver withdrawal cannot revoke the shared standing provider key.
  invalidation: "per-credential",
};
const wrongMechanism: ExternalRuntimeAuthenticationCapabilityV1["mechanism"] = {
  ...capability.mechanism,
  // @ts-expect-error Token issuance is a different owner bridge.
  name: "token-issuer-v1",
};
const wrongVersion: ExternalRuntimeAuthenticationCapabilityV1["mechanism"] = {
  ...capability.mechanism,
  // @ts-expect-error The implemented contract must match the exact admitted version.
  version: 2,
};

// @ts-expect-error Even complete safe metadata cannot reconstruct an owner-issued handle.
const reconstructed: RuntimeAuthenticationProjectionV1 = metadata;
// @ts-expect-error A core authentication binding is not an admitted runtime projection.
const unprojected: RuntimeAuthenticationProjectionV1 = authentication;
// @ts-expect-error Runtime preparation does not produce a retained cleanup obligation.
const unsubmitted: RuntimeAuthenticationAttachmentV1 = projection;
// @ts-expect-error The retained cleanup obligation does not authorize a new runtime session.
const cleanupAsAuthority: RuntimeAuthenticationProjectionV1 = attachment;
// @ts-expect-error Grant bindings cannot substitute for a retained attachment during cleanup.
owner.withdraw({ attachment: authentication, bounds });
// @ts-expect-error Inspection requires the original retained attempt, not a receiver's IDs.
owner.inspect({ attachment: receiver, bounds });
// @ts-expect-error The exact provider instance cannot be omitted from receiver admission.
const noGateway: RuntimeAuthenticationReceiverV1 = {
  sandboxDriverId: "example-sandbox",
  workspace: "example-workspace",
  namespaceName: "example-namespace",
  resourceName: "example-resource",
};
// @ts-expect-error The exact provider workspace cannot be omitted from receiver admission.
const noWorkspace: RuntimeAuthenticationReceiverV1 = {
  sandboxDriverId: "example-sandbox",
  gatewayEndpoint: "https://example.invalid",
  namespaceName: "example-namespace",
  resourceName: "example-resource",
};
// @ts-expect-error Create success is not inspected authentication attachment evidence.
const createAsAttached: RuntimeAuthenticationAttachmentInspectionV1 = { kind: "created" };
// @ts-expect-error Attached inspection requires both exact receiver and a finite usable bound.
const incompleteInspection: RuntimeAuthenticationAttachmentInspectionV1 = { state: "attached" };
// @ts-expect-error A create observation cannot itself report broker-authenticated attachment.
const inventedOutcome: RuntimeAuthenticationAttachmentOutcomeV1 = { kind: "attached" };
// @ts-expect-error Provider references carry no standing provider key material.
delivery.modelApiKey;
// @ts-expect-error Whole-session attachment does not claim per-request authorization.
const requestPermission: RuntimeAuthenticationProjectionV1["session"]["permission"] = "request";
// @ts-expect-error Session lifetime cannot be unbounded.
const unbounded: RuntimeAuthenticationProjectionV1["session"]["lifetime"] = "unbounded";
// @ts-expect-error The runtime consumer cannot substitute another immutable profile.
projection.profileDigest = "replacement-profile";
if (delivery.kind === "create") {
  // @ts-expect-error A Sandbox cannot append arbitrary provider references to the delivery.
  delivery.providers.push("another-provider");
} else {
  // @ts-expect-error Recovery never provides another create gate.
  delivery.assertAndConsume();
  // @ts-expect-error Recovery cannot re-submit provider references.
  delivery.providers;
  // @ts-expect-error Recovery inspects the existing attempt rather than reporting another create.
  delivery.observe({ kind: "created" });
}

void [
  operationCapabilities,
  issuedAttachment,
  revocableSource,
  wrongMechanism,
  wrongVersion,
  reconstructed,
  unprojected,
  unsubmitted,
  cleanupAsAuthority,
  noGateway,
  noWorkspace,
  createAsAttached,
  incompleteInspection,
  inventedOutcome,
  requestPermission,
  unbounded,
];
