import { createHash } from "node:crypto";
import { InMemoryPlatformState } from "../../../packages/occ/src/state/platform-state.ts";
import { RuntimeAuthorityTransactionGuard } from "../../../packages/occ/src/runtime-authority/repository.ts";
import { NativeIAMDriver } from "../../../packages/iam/src/index.ts";
import { snapshotCanonicalJsonV1 } from "../../../packages/occ/src/credential-broker-v1/schema-json.ts";
import type { CredentialAccessGrant } from "../../../packages/occ/src/credential-gateway-v1/connection.ts";
import type {
  RegisteredSchemaCodec,
  DefinitionRef,
} from "../../../packages/occ/src/credential-gateway-v1/schema.ts";
import type { CredentialSchemaRegistryV1 } from "../../../packages/occ/src/credential-broker-v1/schema-registry.ts";
import type {
  OriginalGrantOperationProjectionOwnerV1,
  RegisteredGrantOperationProjectionV1,
} from "../../../packages/occ/src/root-work-v1/selected-iam-ports.ts";
import {
  encodeRootWorkIdentityV1,
  digestRootWorkIdentityV1,
} from "../../../packages/contracts/src/root-work-v1.ts";
import {
  createNativeRootIamAdmissionV1,
  createCredentialSchemaRegistryV1,
  CREDENTIAL_SCHEMA_PRIMITIVES_V1 as primitives,
  INSTALLED_CREDENTIAL_SCHEMA_PRIMITIVES_V1 as admittedPrimitives,
} from "../../../packages/occ/src/index.ts";

/** Test-only absent original-owner boundaries. Neither SQL nor application integration. */
export const PEER_PROVENANCE = Object.freeze({
  state:
    "ControlledNativeRootIamStateOwnerV1 uses genuine InMemoryPlatformState UoWs and a controlled subclass of the original serial guard. Its extra participant protocol models future State behavior only.",
  core: "ControlledOriginalCoreRecognitionV1 test owner has exact-object WeakMap custody; no DATA mint.",
  effects:
    "ControlledRootEffectCorrespondenceOwnerV1 independent retained originals and request bounds; no candidate echo.",
  grantOperations:
    "OriginalRegisteredGrantProjectionPeer restores actual registered JSON codecs under fixed test-only github.read/github:repo semantics. It is not a production provider-specific mapping.",
  clock:
    "Controlled trusted clock; actual NativeIAMDriver and evaluateAuthorization are unchanged.",
});
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export function cloneBinding(binding) {
  const { authentication, originalPrClaim, ...inert } = binding;
  return {
    ...structuredClone(inert),
    authentication,
    ...(binding.effect === "pr-create" ? { originalPrClaim } : {}),
  };
}
function originalData(binding) {
  const { authentication, ...rest } = cloneBinding(binding);
  return rest;
}
export class ControlledOriginalCoreRecognitionV1 {
  registry = new WeakMap();
  issue(facts) {
    const handle = Object.freeze(Object.create(null));
    this.registry.set(handle, structuredClone(facts));
    return handle;
  }
  recognize(handle) {
    return this.registry.get(handle);
  }
}
/** Nonserial test participant enrollment on the original serial mutation guard.
 * Production State has no enroll method; this controlled extension is not its implementation.
 */
class ControlledAdmissionGuard extends RuntimeAuthorityTransactionGuard {
  participants = new Set();
  accepting = true;
  participantFailure;
  enroll(callback) {
    if (!this.accepting)
      return Promise.reject(new Error("Controlled State is closed to registration."));
    let result;
    try {
      result = callback();
    } catch (error) {
      result = Promise.reject(error);
    }
    const tracked = Promise.resolve(result).catch((error) => {
      this.participantFailure = error;
      throw error;
    });
    this.participants.add(tracked);
    tracked.catch(() => {}); // Observe unawaited failure while retaining sticky outer failure.
    return tracked;
  }
  poison(error) {
    this.participantFailure = error;
  }
  async finish() {
    this.accepting = false;
    await Promise.allSettled([...this.participants]);
    await super.finish();
    if (this.participantFailure) throw this.participantFailure;
  }
}
export class ControlledNativeRootIamStateOwnerV1 {
  store = new InMemoryPlatformState();
  units = new WeakMap();
  snapshot;
  lockWait;
  beforeLock;
  beforePreparation;
  scopes = [];
  events = [];
  outcome = "commit";
  async transact(use) {
    return this.store.transact(async (uow) => {
      const context = { guard: new ControlledAdmissionGuard(), active: true };
      this.units.set(uow, context);
      try {
        const value = await use(uow);
        await context.guard.finish();
        if (this.outcome !== "commit") throw new Error("Controlled outer " + this.outcome);
        this.events.push("commit");
        return value;
      } finally {
        context.active = false;
        context.guard.accepting = false;
      }
    });
  }
  async withPreparationSnapshot(locator, bounds, use) {
    this.events.push("preparation-fence");
    if (this.beforePreparation) await this.beforePreparation();
    return this.transact((uow) => use(uow, structuredClone(this.snapshot)));
  }
  retainAdmissionFenceIn(uow, consume) {
    const context = this.units.get(uow);
    if (!context?.active || !context.guard.accepting)
      return Promise.reject(new Error("Foreign, closed or late original UoW."));
    this.events.push("enrolled");
    return context.guard.enroll(() => {
      let scopeActive = true;
      const scope = {
        lockSnapshot: async (locator, bounds) => {
          try {
            if (!scopeActive || !context.active) throw new Error("Escaped admission scope.");
            this.events.push("lock");
            if (this.beforeLock) await this.beforeLock();
            if (this.lockWait) await this.lockWait.promise;
            if (!scopeActive || !context.active) throw new Error("Expired admission scope.");
            return structuredClone(this.snapshot);
          } catch (error) {
            context.guard.poison(error);
            throw error;
          }
        },
      };
      this.scopes.push(scope);
      // Invocation occurs synchronously, before this method returns its Promise.
      const result = consume(scope);
      return Promise.resolve(result).finally(() => {
        scopeActive = false;
      });
    });
  }
  read(uow, operation) {
    const context = this.units.get(uow);
    if (!context?.active) return Promise.reject(new Error("Foreign original effect UoW."));
    return context.guard.run(operation);
  }
}
export class ControlledRootEffectCorrespondenceOwnerV1 {
  state;
  retained;
  bounds;
  readWait;
  reads = 0;
  registeredLocator;
  constructor(state, retained, bounds) {
    this.state = state;
    this.retained = retained;
    this.bounds = bounds;
    const b = retained.binding;
    this.registeredLocator = JSON.stringify([
      b.root.installationId,
      b.root.rootWorkId,
      b.effect,
      b.operationId,
      b.originalAttemptId,
      b.inspectionReservationId,
    ]);
  }
  boundsFor(binding) {
    const key = JSON.stringify([
      binding.root.installationId,
      binding.root.rootWorkId,
      binding.effect,
      binding.operationId,
      binding.originalAttemptId,
      binding.inspectionReservationId,
    ]);
    return key === this.registeredLocator ? this.bounds : undefined;
  }
  readIn(uow, locator, bounds) {
    return this.state.read(uow, async () => {
      this.reads += 1;
      if (this.readWait) await this.readWait.promise;
      const b = this.retained.binding;
      if (
        locator.installationId !== b.root.installationId ||
        locator.rootWorkId !== b.root.rootWorkId ||
        locator.effect !== b.effect ||
        locator.operationId !== b.operationId ||
        locator.originalAttemptId !== b.originalAttemptId ||
        locator.inspectionReservationId !== b.inspectionReservationId
      )
        return undefined;
      // Copy only inert fields. Original opaque PR custody remains the original object.
      const { binding, ...rest } = this.retained;
      const originalPrClaim = binding.effect === "pr-create" ? binding.originalPrClaim : undefined;
      const { originalPrClaim: _claim, ...inert } = binding;
      return {
        ...structuredClone(rest),
        binding: { ...structuredClone(inert), ...(originalPrClaim ? { originalPrClaim } : {}) },
      };
    });
  }
}
/** Fixed test registration only; never installed as a production grant mapping. */
export class OriginalRegisteredGrantProjectionPeer implements OriginalGrantOperationProjectionOwnerV1 {
  calls = 0;
  inputs: Readonly<CredentialAccessGrant>[] = [];
  readonly registry: CredentialSchemaRegistryV1;
  readonly definition: DefinitionRef;
  readonly operationCodec: RegisteredSchemaCodec;
  readonly profileCodec: RegisteredSchemaCodec;
  constructor(
    registry: CredentialSchemaRegistryV1,
    definition: DefinitionRef,
    operationCodec: RegisteredSchemaCodec,
    profileCodec: RegisteredSchemaCodec,
  ) {
    this.registry = registry;
    this.definition = Object.freeze({
      ...definition,
      interpreter: Object.freeze({ ...definition.interpreter }),
    });
    this.operationCodec = operationCodec;
    this.profileCodec = profileCodec;
    for (const name of ["registry", "definition", "operationCodec", "profileCodec"])
      Object.defineProperty(this, name, { writable: false, configurable: false });
  }
  retainOperation(input: unknown) {
    this.registry.assertCodec(this.operationCodec, this.operationCodec.binding);
    return this.operationCodec.retain(this.operationCodec.validate(input));
  }
  projectRegisteredGrant(
    grant: Readonly<CredentialAccessGrant>,
  ): Readonly<RegisteredGrantOperationProjectionV1> {
    this.calls += 1;
    this.inputs.push(grant);
    const canonical = (value: unknown) =>
      snapshotCanonicalJsonV1(value, { maxBytes: 65536, maxDepth: 32 }).canonicalJson;
    if (
      canonical(grant.operations.definition) !== canonical(this.definition) ||
      canonical(grant.credentialProfile.selection.definition) !== canonical(this.definition) ||
      !grant.services.some(
        (service) => service.serviceId === "github" && service.audience === "github",
      )
    )
      throw new Error("Unknown selected fixture mapping.");
    const { definition, role, schema } = grant.operations;
    this.registry.assertCodec(this.operationCodec, { definition, role, schema });
    const selected = grant.credentialProfile.selection;
    this.registry.assertCodec(this.profileCodec, {
      definition: selected.definition,
      role: selected.role,
      schema: selected.schema,
    });
    const operations = this.operationCodec.retain(this.operationCodec.restore(grant.operations));
    const profile = this.profileCodec.retain(this.profileCodec.restore(selected));
    if (
      canonical(operations) !== canonical(grant.operations) ||
      canonical(profile) !== canonical(selected) ||
      canonical(grant.credentialProfile.schema) !== canonical(profile.schema) ||
      grant.credentialProfile.selectionDigest !== profile.digest
    )
      throw new Error("Original codec correspondence failed.");
    const decoded: unknown = JSON.parse(operations.canonicalJson);
    const decodedProfile: unknown = JSON.parse(profile.canonicalJson);
    if (
      !decoded ||
      typeof decoded !== "object" ||
      !("action" in decoded) ||
      !("canonicalResource" in decoded) ||
      typeof decoded.action !== "string" ||
      typeof decoded.canonicalResource !== "string" ||
      Object.keys(decoded).length !== 2 ||
      !decodedProfile ||
      typeof decodedProfile !== "object" ||
      !("mode" in decodedProfile) ||
      decodedProfile.mode !== "read" ||
      Object.keys(decodedProfile).length !== 1
    )
      throw new Error("Unknown original fixture operation/profile.");
    return {
      grantId: grant.grantId,
      connectionId: grant.connectionId,
      connectionGeneration: grant.connectionGeneration,
      definition: operations.definition,
      originalOperations: operations,
      originalProfile: grant.credentialProfile,
      permitted: [
        {
          serviceId: "github",
          exactAction: decoded.action,
          canonicalResource: decoded.canonicalResource,
          profileSelectionDigest: grant.credentialProfile.selectionDigest,
        },
      ],
    };
  }
}

export function fixture(effect = "resource", options = {}) {
  let time = 1000;
  const controller = new AbortController();
  const durationPolicy = {
    policyId: "duration",
    policyVersion: "duration-1",
    kind: "finite",
    originalDeadline: 100000,
  };
  const cancellation = {
    ownerPrincipalId: "canceller",
    authorizationId: "cancel-auth",
    dependencyIds: ["dep-1"],
  };
  const selection = { driverId: "occ-native-iam", configurationGeneration: "generation-1" };
  const root = {
    schemaVersion: "root-work-v1",
    installationId: "installation",
    namespaceId: "namespace",
    agentId: "agent",
    agentRevisionId: "revision",
    rootWorkId: "root",
    executionId: "execution",
    requesterPrincipalId: "requester",
    servicePrincipalId: "service",
    assignmentId: "assignment",
    assignmentGeneration: "1",
    selectedIam: selection,
    immutableCeilingDigest: "a".repeat(64),
    durationPolicy,
    policyVersion: "policy-1",
    cancellation,
    admittedAt: 500,
  };
  const policy = {
    kind: "retained-service-policy",
    servicePrincipalId: "service",
    servicePolicyId: "service-policy",
    servicePolicyVersion: "service-policy-1",
    policyVersion: "policy-1",
    scopeCeiling: [{ action: "github.read", canonicalResource: "github:repo" }],
    eligibleDataDomains: ["source"],
    audienceRefs: ["github"],
    aggregateLimits: [{ name: "calls", maximum: 10 }],
    durationPolicy,
    cancellation,
    immutableCeilingDigest: "a".repeat(64),
  };
  const { registry, operationCodec, profileCodec, ...schemaData } = schemaTemplate();
  const { definition, schema, resourceSchema, profile, operationValue } =
    structuredClone(schemaData);
  const grantOperations = new OriginalRegisteredGrantProjectionPeer(
    registry,
    schemaData.definition,
    operationCodec,
    profileCodec,
  );
  const resource = {
    upstreamInstanceId: "github-instance",
    resourceSchema,
    canonicalResourceId: "owner/repo",
  };
  const core = new ControlledOriginalCoreRecognitionV1();
  const authentication = core.issue({
    identity: root,
    fullPolicy: policy,
    closureVersion: "open-1",
  });
  const base = {
    authentication,
    root,
    grantId: "grant",
    leaseId: "lease",
    operationId: "operation",
    originalAttemptId: "attempt",
    inspectionReservationId: "reservation",
    inputDigest: "sha256:" + "e".repeat(64),
    factsDigest: "sha256:" + "f".repeat(64),
    bounds: {
      authorityDeadline: 90000,
      requestDeadline: 80000,
      requestedAllowance: 1,
      capacityUnits: effect === "root-cancel" ? 0 : 1,
      withdrawalProfile: {
        profileId: "native",
        profileVersion: "1",
        maximumObservationLagMs: 0,
        maximumDecisionToSendMs: 0,
        maximumEnforcementDelayMs: 0,
        clockAllowanceMs: 0,
      },
    },
  };
  const binding =
    effect === "root-cancel"
      ? {
          ...base,
          effect,
          requester: { kind: "authenticated-canceller", principalId: "canceller" },
          receiver: { kind: "root-work", rootWorkId: "root" },
          iam: { action: "work.cancel", resource: { kind: "root-work", rootWorkId: "root" } },
        }
      : {
          ...base,
          effect,
          connection: {
            connectionId: "connection",
            namespaceId: "namespace",
            generation: "connection-1",
            definition,
            upstreamInstanceId: "github-instance",
          },
          target: {
            resource,
            holdIdentity: {
              upstreamInstanceId: "github-instance",
              resourceNamespace: "github",
              resourceKind: "repository",
              canonicalResourceId: "owner/repo",
              credentialAuthorityId: "authority",
            },
          },
          operationSchema: schema,
          profile,
          callerServiceId: "broker",
          serviceId: "github",
          audienceRef: "github",
          iam: { action: "github.read", canonicalResource: "github:repo" },
          receiver: { kind: effect, receiverId: "receiver", incarnation: "incarnation-1" },
          ...(effect === "credential" ? { operation: "acquire" } : {}),
          ...(effect === "pr-create"
            ? { originalPrClaim: Object.freeze(Object.create(null)) }
            : {}),
        };
  const nativePolicy = {
    identities: [
      { kind: "service_principal", id: "service", namespaceId: "namespace", agentId: "agent" },
      {
        kind: "principal",
        id: "canceller",
        issuer: "https://identity.example",
        subject: "cancel-user",
      },
      {
        kind: "principal",
        id: "requester",
        issuer: "https://identity.example",
        subject: "request-user",
      },
    ],
    groups: [{ id: "cancel-group", name: "cancellers" }],
    memberships: [{ groupId: "cancel-group", principalId: "canceller" }],
    roles: [
      {
        id: "service-role",
        namespaceId: "namespace",
        permissions: [
          { action: "operate", resourceKind: "agent" },
          { action: "operate", resourceKind: "secret" },
        ],
      },
      { id: "cancel-role", permissions: [{ action: "operate", resourceKind: "agent" }] },
    ],
    bindings: [
      {
        id: "service-agent",
        namespaceId: "namespace",
        subjectKind: "identity",
        subjectId: "service",
        roleId: "service-role",
        resourceKind: "agent",
        resourceId: "agent",
      },
      {
        id: "service-secret",
        namespaceId: "namespace",
        subjectKind: "identity",
        subjectId: "service",
        roleId: "service-role",
        resourceKind: "secret",
        resourceId: "secret",
      },
      {
        id: "cancel-binding",
        subjectKind: "group",
        subjectId: "cancel-group",
        roleId: "cancel-role",
        resourceKind: "agent",
        resourceId: "agent",
      },
    ],
    restrictions: [],
  };
  const record = {
    identity: structuredClone(root),
    canonicalIdentity: encodeRootWorkIdentityV1(root),
    identityDigest: digestRootWorkIdentityV1(root),
    fullPolicy: structuredClone(policy),
    originalInvocationId: "invocation",
    originalIntentDigest: "sha256:" + "1".repeat(64),
    state: "open",
    closureVersion: "open-1",
    cancellationAuthorizationId: "cancel-auth",
    closedAt: null,
    retainedObligationRefs: [],
    assignment: {
      installationId: "installation",
      namespaceId: "namespace",
      agentId: "agent",
      agentRevisionId: "revision",
      executionId: "execution",
      assignmentId: "assignment",
      assignmentGeneration: "1",
      servicePrincipalId: "service",
      selectedIam: structuredClone(selection),
      allocation: {
        namespaceId: "namespace",
        agentId: "agent",
        assignmentRef: "assignment",
        createEffectRef: "create",
        installationId: "installation",
        revisionId: "revision",
        servicePrincipalId: "service",
        lifecycleGeneration: 1,
        runtimeGeneration: 1,
        component: "gateway",
        bindingCondition: "unbound",
        createdAt: "2026-09-15T00:00:00Z",
        providerProfileRef: "provider-profile",
        runtimeProfileRef: "runtime-profile",
        identityProfileRef: "identity-profile",
      },
    },
  };
  const grant = {
    grantId: "grant",
    connectionId: "connection",
    connectionGeneration: "connection-1",
    resource,
    services: [
      {
        serviceId: "github",
        destinationPolicyId: "destination",
        audience: "github",
        authenticationCapability: "read",
        authenticationMode: "protected-material",
        resourceMappingId: "mapping",
        resourceMappingGeneration: "1",
      },
    ],
    operations: operationValue,
    credentialProfile: profile,
    authorityBindingId: "root",
    expiresAt: 70000,
  };
  const entitlement =
    effect === "root-cancel"
      ? {
          kind: "root-cancellation-entitlement",
          action: "work.cancel",
          rootWorkId: "root",
          authorizationId: "cancel-auth",
          authorizedPrincipalId: "canceller",
          dependencyIds: ["dep-1"],
          validUntil: 65000,
        }
      : {
          kind: "external-service-entitlement",
          servicePrincipalId: "service",
          servicePolicyId: "service-policy",
          servicePolicyVersion: "service-policy-1",
          policyVersion: "policy-1",
          immutableCeilingDigest: "a".repeat(64),
          grant,
          callerServiceId: "broker",
          serviceId: "github",
          audienceRef: "github",
          exactAction: "github.read",
          canonicalResource: "github:repo",
          eligibleDataDomains: ["source"],
          requiredDataDomains: ["source"],
          aggregateCharges: [{ name: "calls", amount: 1 }],
          protectedSourceMode: "protected-secrets",
          protectedSourceRefs: [{ kind: "secret", id: "secret", namespaceId: "namespace" }],
          validUntil: 65000,
        };
  const state = new ControlledNativeRootIamStateOwnerV1();
  state.snapshot = {
    installationId: "installation",
    policyEpoch: "epoch-1",
    selectedIam: structuredClone(selection),
    nativePolicy,
    root: record,
    ...(effect === "root-cancel"
      ? { kind: "root-cancel", currentServicePolicy: null, entitlement }
      : { kind: "external", currentServicePolicy: structuredClone(policy), entitlement }),
  };
  const retained = {
    binding: originalData(binding),
    state: "admitted",
    recordVersion: "effect-1",
    originalBundle: effect === "root-cancel" ? null : structuredClone(definition),
    capacity:
      effect === "root-cancel" ? [] : [{ limitName: "calls", currentUnits: 2, requestedUnits: 1 }],
  };
  const effects = new ControlledRootEffectCorrespondenceOwnerV1(state, retained, {
    signal: controller.signal,
    deadline: 75000,
  });
  const driver = new NativeIAMDriver({ loadNativeIAMState: async () => nativePolicy });
  const dependencies = {
    selectedNativeDriver: driver,
    selection,
    core,
    state,
    effects,
    grantOperations,
    now: () => time,
    maximumPrepareMs: 10000,
    maximumEvidenceLifetimeMs: 10000,
    maximumActiveEvidence: 4,
    adoptedEnvelope: "native-root-iam-envelope-v1",
    ...options,
  };
  const owner = createNativeRootIamAdmissionV1(dependencies);
  return {
    owner,
    binding,
    state,
    effects,
    core,
    dependencies,
    controller,
    driver,
    grantOperations,
    setTime: (value) => {
      time = value;
    },
    now: () => time,
    restart: () => createNativeRootIamAdmissionV1(dependencies),
  };
}

let template;
function schemaTemplate() {
  if (template) return template;
  const definition = {
    backendId: "github",
    recipeId: "github-read",
    recipeVersion: 1,
    recipeDigest: "sha256:" + "b".repeat(64),
    contractVersion: "credential-backend-recipe-v1",
    interpreter: primitives.interpreter,
  };
  const canonical = (value) =>
    value === null || typeof value !== "object"
      ? JSON.stringify(value)
      : Array.isArray(value)
        ? "[" + value.map(canonical).join(",") + "]"
        : "{" +
          Object.keys(value)
            .sort()
            .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
            .join(",") +
          "}";
  const registry = createCredentialSchemaRegistryV1([definition], { admittedPrimitives });
  const scope = registry.begin(definition),
    registrations = [];
  for (const [role, name, jsonSchema, value] of [
    [
      "operation",
      "read",
      {
        type: "object",
        properties: {
          action: { type: "string", maxLength: 256 },
          canonicalResource: { type: "string", maxLength: 256 },
        },
        required: ["action", "canonicalResource"],
        additionalProperties: false,
      },
      { action: "github.read", canonicalResource: "github:repo" },
    ],
    [
      "credential-profile",
      "profile",
      {
        type: "object",
        properties: { mode: { type: "string", maxLength: 32 } },
        required: ["mode"],
        additionalProperties: false,
      },
      { mode: "read" },
    ],
    [
      "resource",
      "repository",
      {
        type: "object",
        properties: { canonicalResourceId: { type: "string", maxLength: 256 } },
        required: ["canonicalResourceId"],
        additionalProperties: false,
      },
      { canonicalResourceId: "owner/repo" },
    ],
  ]) {
    const maxBytes = 1024,
      maxDepth = 8,
      canonicalization = primitives.canonicalization;
    const digest =
      "sha256:" +
      createHash("sha256")
        .update(
          "oce-schema-recipe-v1\0" +
            canonical({
              canonicalization,
              jsonSchema,
              maxBytes,
              maxDepth,
              profile: "oce-closed-draft7-v1",
            }),
        )
        .digest("hex");
    const schema = { namespace: "github", name, version: 1, digest };
    const codec = scope.schemas.register({
      binding: { definition, role, schema },
      jsonSchema,
      maxBytes,
      maxDepth,
      canonicalization,
    });
    registrations.push({ codec, schema, value });
  }
  scope.commit();
  const operationValue = registrations[0].codec.retain(
    registrations[0].codec.validate(registrations[0].value),
  );
  const selection = registrations[1].codec.retain(
    registrations[1].codec.validate(registrations[1].value),
  );
  registrations[2].codec.retain(registrations[2].codec.validate(registrations[2].value));
  template = {
    registry,
    operationCodec: registrations[0].codec,
    profileCodec: registrations[1].codec,
    definition,
    schema: registrations[0].schema,
    resourceSchema: registrations[2].schema,
    profile: { schema: registrations[1].schema, selection, selectionDigest: selection.digest },
    operationValue,
  };
  return template;
}
