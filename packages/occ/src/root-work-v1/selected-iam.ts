import { types } from "node:util";
import type { RootWorkPolicyV1 } from "@openclaw-enterprise/contracts";
import type { PlatformUnitOfWork } from "../state/platform-state.ts";
import { NativeIAMDriver } from "@openclaw-enterprise/iam";
import { snapshotCanonicalJsonV1 } from "../credential-broker-v1/schema-json.ts";
import type { Bounds, CoreAuthenticationBinding } from "../credential-gateway-v1/handles.ts";
import type { AuthorityBinding, IamAdmissionEvidence, SelectedIamAdmissionOwner } from "./ports.ts";
import type { RootEffectLocatorV1, OriginalRootEffectV1, RootCoreFactsV1 } from "./dependencies.ts";
import {
  evaluateProposedEnvelopeV1,
  type NativeRootIamAdmissionDependenciesV1,
  type NativeRootIamSnapshotV1,
  type RegisteredGrantOperationProjectionV1,
} from "./selected-iam-ports.ts";

function deny(): never {
  throw new Error("Native ROOT IAM admission denied.");
}
function requireThat(condition: unknown): asserts condition {
  if (!condition) deny();
}
function finite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}
function text(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}
function canonicalResourceText(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    Buffer.byteLength(value, "utf8") <= 4096
  );
}
function key(value: unknown): string {
  return snapshotCanonicalJsonV1(value, { maxBytes: 65536, maxDepth: 32 }).canonicalJson;
}
/** This assertion detaches validated inert DATA only; opaque owner handles never enter it. */
function data<T>(value: T): T {
  return snapshotCanonicalJsonV1(value, { maxBytes: 65536, maxDepth: 32 }).value as T;
}
function same(left: unknown, right: unknown): boolean {
  return key(left) === key(right);
}
function plain(value: object): void {
  requireThat(value && typeof value === "object" && !types.isProxy(value));
  const prototype = Object.getPrototypeOf(value);
  requireThat(prototype === Object.prototype || prototype === null);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value)))
    requireThat(Object.hasOwn(descriptor, "value") && descriptor.enumerable);
}
function capture(binding: AuthorityBinding): AuthorityBinding {
  plain(binding);
  const base = [
    "authentication",
    "root",
    "grantId",
    "leaseId",
    "operationId",
    "originalAttemptId",
    "inspectionReservationId",
    "inputDigest",
    "factsDigest",
    "bounds",
    "effect",
    "receiver",
    "iam",
  ];
  const extra =
    binding.effect === "root-cancel"
      ? ["requester"]
      : [
          "connection",
          "target",
          "operationSchema",
          "profile",
          "callerServiceId",
          "serviceId",
          "audienceRef",
          ...(binding.effect === "credential" ? ["operation"] : []),
          ...(binding.effect === "pr-create" ? ["originalPrClaim"] : []),
        ];
  requireThat(["credential", "resource", "pr-create", "root-cancel"].includes(binding.effect));
  const keys = Reflect.ownKeys(binding);
  requireThat(
    keys.length === base.length + extra.length &&
      keys.every((k) => typeof k === "string" && [...base, ...extra].includes(k)),
  );
  requireThat(
    binding.authentication &&
      typeof binding.authentication === "object" &&
      !types.isProxy(binding.authentication),
  );
  if (binding.effect === "pr-create") {
    requireThat(
      binding.originalPrClaim &&
        typeof binding.originalPrClaim === "object" &&
        !types.isProxy(binding.originalPrClaim),
    );
    const { authentication, originalPrClaim, ...inert } = binding;
    return Object.freeze({
      ...data(inert),
      root: data(binding.root),
      authentication,
      originalPrClaim,
    });
  }
  const { authentication, ...inert } = binding;
  return Object.freeze({ ...data(inert), root: data(binding.root), authentication });
}
function bindingKey(binding: AuthorityBinding | OriginalRootEffectV1["binding"]): string {
  if (binding.effect === "pr-create") {
    const { originalPrClaim, ...rest } = binding;
    const { authentication: _authentication, ...inert } = rest as typeof rest & {
      authentication?: CoreAuthenticationBinding;
    };
    return key(inert);
  }
  const { authentication: _authentication, ...inert } = binding as typeof binding & {
    authentication?: CoreAuthenticationBinding;
  };
  return key(inert);
}
function locator(binding: AuthorityBinding): RootEffectLocatorV1 {
  return Object.freeze({
    installationId: binding.root.installationId,
    rootWorkId: binding.root.rootWorkId,
    effect: binding.effect,
    operationId: binding.operationId,
    originalAttemptId: binding.originalAttemptId,
    inspectionReservationId: binding.inspectionReservationId,
  });
}
function unique(values: readonly string[]): boolean {
  return Array.isArray(values) && values.every(text) && new Set(values).size === values.length;
}
function policyValid(policy: RootWorkPolicyV1): void {
  requireThat(
    policy.kind === "retained-service-policy" &&
      text(policy.servicePrincipalId) &&
      text(policy.servicePolicyId) &&
      text(policy.servicePolicyVersion) &&
      text(policy.policyVersion),
  );
  requireThat(unique(policy.eligibleDataDomains) && unique(policy.audienceRefs));
  requireThat(
    Array.isArray(policy.scopeCeiling) &&
      policy.scopeCeiling.every(
        (x) =>
          text(x.action) &&
          typeof x.canonicalResource === "string" &&
          x.canonicalResource.length > 0,
      ),
  );
  requireThat(new Set(policy.scopeCeiling.map((x) => key(x))).size === policy.scopeCeiling.length);
  requireThat(
    Array.isArray(policy.aggregateLimits) &&
      unique(policy.aggregateLimits.map((x) => x.name)) &&
      policy.aggregateLimits.every((x) => finite(x.maximum)),
  );
  requireThat(/^[a-f0-9]{64}$/.test(policy.immutableCeilingDigest));
  requireThat(text(policy.durationPolicy.policyId) && text(policy.durationPolicy.policyVersion));
  requireThat(
    policy.durationPolicy.kind === "finite"
      ? finite(policy.durationPolicy.originalDeadline)
      : policy.durationPolicy.kind === "uncapped" &&
          policy.durationPolicy.originalDeadline === null,
  );
  requireThat(
    text(policy.cancellation.ownerPrincipalId) &&
      text(policy.cancellation.authorizationId) &&
      unique(policy.cancellation.dependencyIds),
  );
}
function narrows(current: RootWorkPolicyV1, immutable: RootWorkPolicyV1): void {
  policyValid(current);
  requireThat(
    current.servicePrincipalId === immutable.servicePrincipalId &&
      current.servicePolicyId === immutable.servicePolicyId &&
      current.immutableCeilingDigest === immutable.immutableCeilingDigest,
  );
  requireThat(current.scopeCeiling.every((c) => immutable.scopeCeiling.some((i) => same(c, i))));
  requireThat(
    current.eligibleDataDomains.every((c) => immutable.eligibleDataDomains.includes(c)) &&
      current.audienceRefs.every((c) => immutable.audienceRefs.includes(c)),
  );
  requireThat(
    current.aggregateLimits.every((c) =>
      immutable.aggregateLimits.some((i) => i.name === c.name && c.maximum <= i.maximum),
    ),
  );
  requireThat(same(current.cancellation, immutable.cancellation));
  requireThat(
    current.durationPolicy.kind === "finite"
      ? immutable.durationPolicy.kind === "uncapped" ||
          current.durationPolicy.originalDeadline <= immutable.durationPolicy.originalDeadline
      : immutable.durationPolicy.kind === "uncapped",
  );
}
interface Prepared {
  readonly binding: AuthorityBinding;
  readonly bounds: Bounds;
  readonly core: Readonly<RootCoreFactsV1>;
  readonly expiresAt: number;
  readonly facts: string;
}
/** Trusted startup only. State and original Work own authentication, locks and COMMIT. */
export function createNativeRootIamAdmissionV1(
  dependencies: NativeRootIamAdmissionDependenciesV1,
): SelectedIamAdmissionOwner {
  const { selectedNativeDriver: driver, state, effects, core, now, grantOperations } = dependencies;
  requireThat(
    grantOperations &&
      !types.isProxy(grantOperations) &&
      typeof grantOperations.projectRegisteredGrant === "function",
  );
  const projectRegisteredGrant = grantOperations.projectRegisteredGrant;
  requireThat(
    Object.getPrototypeOf(driver) === NativeIAMDriver.prototype &&
      !types.isProxy(driver) &&
      driver.capability === "iam" &&
      driver.implementation === "native" &&
      driver.id === dependencies.selection.driverId,
  );
  const selection = data(dependencies.selection);
  requireThat(
    text(selection.driverId) &&
      text(selection.configurationGeneration) &&
      dependencies.adoptedEnvelope === "native-root-iam-envelope-v1",
  );
  const { maximumPrepareMs, maximumEvidenceLifetimeMs, maximumActiveEvidence } = dependencies;
  requireThat(
    Number.isSafeInteger(maximumPrepareMs) &&
      maximumPrepareMs > 0 &&
      maximumPrepareMs <= 2147483647 &&
      Number.isSafeInteger(maximumEvidenceLifetimeMs) &&
      maximumEvidenceLifetimeMs > 0 &&
      maximumEvidenceLifetimeMs <= 2147483647 &&
      Number.isSafeInteger(maximumActiveEvidence) &&
      maximumActiveEvidence > 0 &&
      maximumActiveEvidence <= 10000,
  );
  const active = new Map<IamAdmissionEvidence, Prepared>();
  let pending = 0;
  function clock(): number {
    const time = now();
    requireThat(finite(time));
    return time;
  }
  function check(bounds: Bounds): void {
    requireThat(
      bounds &&
        bounds.signal instanceof AbortSignal &&
        !types.isProxy(bounds.signal) &&
        finite(bounds.deadline) &&
        !bounds.signal.aborted &&
        clock() < bounds.deadline,
    );
    requireThat(
      Object.getPrototypeOf(driver) === NativeIAMDriver.prototype &&
        driver.id === selection.driverId &&
        driver.capability === "iam" &&
        driver.implementation === "native" &&
        dependencies.grantOperations === grantOperations &&
        grantOperations.projectRegisteredGrant === projectRegisteredGrant &&
        same(dependencies.selection, selection),
    );
  }
  function recognition(
    binding: AuthorityBinding,
    expected?: Readonly<RootCoreFactsV1>,
  ): Readonly<RootCoreFactsV1> {
    const recognized = core.recognize(binding.authentication);
    requireThat(recognized && same(recognized.identity, binding.root));
    if (expected) requireThat(same(recognized, expected));
    return data(recognized);
  }
  function originalBounds(binding: AuthorityBinding): Bounds {
    const bounds = effects.boundsFor(binding);
    requireThat(bounds);
    check(bounds);
    return Object.freeze({ signal: bounds.signal, deadline: bounds.deadline });
  }
  function recheck(
    binding: AuthorityBinding,
    bounds: Bounds,
    expected: Readonly<RootCoreFactsV1>,
  ): void {
    check(bounds);
    recognition(binding, expected);
    const current = originalBounds(binding);
    requireThat(current.signal === bounds.signal && current.deadline >= bounds.deadline);
  }
  async function wait<T>(operation: () => Promise<T>, bounds: Bounds): Promise<T> {
    check(bounds);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let aborted: (() => void) | undefined;
    try {
      const result = await Promise.race([
        operation(),
        new Promise<never>((_resolve, reject) => {
          const fail = () => reject(new Error("Native ROOT IAM admission expired or aborted."));
          aborted = fail;
          bounds.signal.addEventListener("abort", fail, { once: true });
          timer = setTimeout(fail, Math.min(2147483647, Math.max(1, bounds.deadline - clock())));
          if (bounds.signal.aborted) fail();
        }),
      ]);
      check(bounds);
      return result;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (aborted) bounds.signal.removeEventListener("abort", aborted);
    }
  }
  function cleanup(): void {
    const time = clock();
    for (const [handle, value] of active)
      if (value.expiresAt <= time || value.bounds.signal.aborted) active.delete(handle);
  }
  function validate(
    binding: AuthorityBinding,
    recognized: Readonly<RootCoreFactsV1>,
    snapshot: Readonly<NativeRootIamSnapshotV1>,
    original: Readonly<OriginalRootEffectV1>,
    bounds: Bounds,
  ): {
    readonly expiresAt: number;
    readonly projection: Readonly<RegisteredGrantOperationProjectionV1> | null;
  } {
    let projection: Readonly<RegisteredGrantOperationProjectionV1> | null = null;
    const root = snapshot.root,
      immutable = root.fullPolicy;
    policyValid(immutable);
    requireThat(
      snapshot.installationId === binding.root.installationId &&
        text(snapshot.policyEpoch) &&
        same(snapshot.selectedIam, selection) &&
        same(binding.root.selectedIam, selection) &&
        root.state === "open" &&
        root.closedAt === null &&
        root.closureVersion === recognized.closureVersion &&
        same(root.identity, recognized.identity) &&
        same(immutable, recognized.fullPolicy),
    );
    // Original Work recognition authenticates the complete identity. Canonical record
    // metadata remains independent State DATA and is captured in the prepared facts.
    requireThat(
      binding.root.schemaVersion === "root-work-v1" &&
        typeof root.canonicalIdentity === "string" &&
        root.canonicalIdentity.length > 0 &&
        /^[a-f0-9]{64}$/.test(root.identityDigest),
    );
    requireThat(
      immutable.servicePrincipalId === binding.root.servicePrincipalId &&
        immutable.policyVersion === binding.root.policyVersion &&
        immutable.immutableCeilingDigest === binding.root.immutableCeilingDigest &&
        same(immutable.durationPolicy, binding.root.durationPolicy) &&
        same(immutable.cancellation, binding.root.cancellation),
    );
    for (const field of [
      "installationId",
      "namespaceId",
      "agentId",
      "agentRevisionId",
      "executionId",
      "assignmentId",
      "assignmentGeneration",
      "servicePrincipalId",
    ] as const)
      requireThat(root.assignment[field] === binding.root[field]);
    requireThat(same(root.assignment.selectedIam, selection));
    requireThat(
      original.state === "admitted" &&
        text(original.recordVersion) &&
        bindingKey(original.binding) === bindingKey(binding),
    );
    if (binding.effect === "pr-create")
      requireThat(
        original.binding.effect === "pr-create" &&
          original.binding.originalPrClaim === binding.originalPrClaim,
      );
    requireThat(
      text(binding.grantId) &&
        text(binding.leaseId) &&
        text(binding.operationId) &&
        text(binding.originalAttemptId) &&
        text(binding.inspectionReservationId),
    );
    const b = binding.bounds,
      w = b.withdrawalProfile;
    requireThat(
      [
        b.authorityDeadline,
        b.requestDeadline,
        b.requestedAllowance,
        b.capacityUnits,
        w.maximumObservationLagMs,
        w.maximumDecisionToSendMs,
        w.maximumEnforcementDelayMs,
        w.clockAllowanceMs,
      ].every(finite) &&
        text(w.profileId) &&
        text(w.profileVersion),
    );
    let expiresAt = Math.min(
      b.authorityDeadline,
      b.requestDeadline,
      snapshot.entitlement.validUntil,
    );
    if (immutable.durationPolicy.kind === "finite")
      expiresAt = Math.min(expiresAt, immutable.durationPolicy.originalDeadline);
    requireThat(finite(snapshot.entitlement.validUntil) && clock() < expiresAt);
    if (binding.effect === "root-cancel") {
      requireThat(
        snapshot.kind === "root-cancel" &&
          snapshot.currentServicePolicy === null &&
          snapshot.entitlement.kind === "root-cancellation-entitlement",
      );
      const entitlement = snapshot.entitlement;
      requireThat(
        binding.requester.kind === "authenticated-canceller" &&
          binding.receiver.kind === "root-work" &&
          binding.receiver.rootWorkId === binding.root.rootWorkId &&
          binding.iam.action === "work.cancel" &&
          binding.iam.resource.kind === "root-work" &&
          binding.iam.resource.rootWorkId === binding.root.rootWorkId,
      );
      requireThat(
        entitlement.action === "work.cancel" &&
          entitlement.rootWorkId === binding.root.rootWorkId &&
          entitlement.authorizedPrincipalId === binding.requester.principalId &&
          entitlement.authorizationId === immutable.cancellation.authorizationId &&
          root.cancellationAuthorizationId === entitlement.authorizationId &&
          same(entitlement.dependencyIds, immutable.cancellation.dependencyIds),
      );
      requireThat(
        snapshot.nativePolicy.identities.some(
          (i) => i.kind === "principal" && i.id === binding.requester.principalId,
        ),
      );
      requireThat(
        original.originalBundle === null && original.capacity.length === 0 && b.capacityUnits === 0,
      );
    } else {
      requireThat(
        snapshot.kind === "external" &&
          snapshot.entitlement.kind === "external-service-entitlement",
      );
      const entitlement = snapshot.entitlement,
        current = snapshot.currentServicePolicy,
        grant = entitlement.grant;
      narrows(current, immutable);
      if (current.durationPolicy.kind === "finite")
        expiresAt = Math.min(expiresAt, current.durationPolicy.originalDeadline);
      requireThat(
        clock() < expiresAt &&
          original.originalBundle !== null &&
          same(original.originalBundle, binding.connection.definition),
      );
      requireThat(
        binding.connection.definition.contractVersion === "credential-backend-recipe-v1" &&
          Number.isSafeInteger(binding.connection.definition.recipeVersion) &&
          binding.connection.definition.recipeVersion > 0 &&
          Number.isSafeInteger(binding.connection.definition.interpreter.version) &&
          binding.connection.definition.interpreter.version > 0,
      );
      requireThat(
        snapshot.nativePolicy.identities.some(
          (i) =>
            i.kind === "service_principal" &&
            i.id === binding.root.servicePrincipalId &&
            i.namespaceId === binding.root.namespaceId &&
            i.agentId === binding.root.agentId,
        ),
      );
      requireThat(
        entitlement.servicePrincipalId === current.servicePrincipalId &&
          entitlement.servicePolicyId === current.servicePolicyId &&
          entitlement.servicePolicyVersion === current.servicePolicyVersion &&
          entitlement.policyVersion === current.policyVersion &&
          entitlement.immutableCeilingDigest === current.immutableCeilingDigest,
      );
      requireThat(
        entitlement.exactAction === binding.iam.action &&
          entitlement.canonicalResource === binding.iam.canonicalResource &&
          [immutable, current].every((p) =>
            p.scopeCeiling.some(
              (s) =>
                s.action === binding.iam.action &&
                s.canonicalResource === binding.iam.canonicalResource,
            ),
          ),
      );
      requireThat(
        entitlement.callerServiceId === binding.callerServiceId &&
          entitlement.serviceId === binding.serviceId &&
          entitlement.audienceRef === binding.audienceRef &&
          [immutable, current].every((p) => p.audienceRefs.includes(binding.audienceRef)),
      );
      requireThat(
        unique(entitlement.eligibleDataDomains) &&
          unique(entitlement.requiredDataDomains) &&
          entitlement.eligibleDataDomains.every(
            (d) =>
              immutable.eligibleDataDomains.includes(d) && current.eligibleDataDomains.includes(d),
          ) &&
          entitlement.requiredDataDomains.every((d) => entitlement.eligibleDataDomains.includes(d)),
      );
      requireThat(
        grant.grantId === binding.grantId &&
          grant.authorityBindingId === binding.root.rootWorkId &&
          grant.connectionId === binding.connection.connectionId &&
          grant.connectionGeneration === binding.connection.generation &&
          same(grant.resource, binding.target.resource) &&
          same(grant.credentialProfile, binding.profile),
      );
      requireThat(
        binding.connection.namespaceId === binding.root.namespaceId &&
          binding.target.resource.upstreamInstanceId === binding.connection.upstreamInstanceId &&
          binding.target.holdIdentity.upstreamInstanceId ===
            binding.connection.upstreamInstanceId &&
          binding.target.holdIdentity.canonicalResourceId ===
            binding.target.resource.canonicalResourceId,
      );
      requireThat(
        grant.operations.role === "operation" &&
          same(grant.operations.definition, binding.connection.definition) &&
          same(grant.operations.schema, binding.operationSchema) &&
          same(binding.profile.selection.definition, binding.connection.definition) &&
          binding.profile.selection.role === "credential-profile" &&
          same(binding.profile.selection.schema, binding.profile.schema) &&
          binding.profile.selectionDigest === binding.profile.selection.digest,
      );
      requireThat(
        grant.services.some(
          (s) => s.serviceId === binding.serviceId && s.audience === binding.audienceRef,
        ),
      );
      requireThat(finite(grant.expiresAt) && clock() < grant.expiresAt);
      expiresAt = Math.min(expiresAt, grant.expiresAt);
      requireThat(
        unique(entitlement.protectedSourceRefs.map((s) => s.id)) &&
          entitlement.protectedSourceRefs.every(
            (s) => s.kind === "secret" && s.namespaceId === binding.root.namespaceId,
          ),
      );
      requireThat(
        unique(original.capacity.map((c) => c.limitName)) &&
          unique(entitlement.aggregateCharges.map((c) => c.name)) &&
          original.capacity.length === entitlement.aggregateCharges.length,
      );
      let units = 0;
      for (const capacity of original.capacity) {
        const charge = entitlement.aggregateCharges.find((c) => c.name === capacity.limitName);
        const limit = immutable.aggregateLimits.find((l) => l.name === capacity.limitName);
        const currentLimit = current.aggregateLimits.find((l) => l.name === capacity.limitName);
        requireThat(
          charge &&
            limit &&
            currentLimit &&
            [capacity.currentUnits, capacity.requestedUnits, charge.amount].every(finite) &&
            capacity.requestedUnits === charge.amount &&
            finite(capacity.currentUnits + capacity.requestedUnits) &&
            capacity.currentUnits + capacity.requestedUnits <=
              Math.min(limit.maximum, currentLimit.maximum),
        );
        units += capacity.requestedUnits;
        requireThat(finite(units));
      }
      requireThat(units === b.capacityUnits);
      // The original owner sees only detached independently read grant DATA.
      // Snapshot admission rejects executable/hostile output before any field is read.
      requireThat(grantOperations.projectRegisteredGrant === projectRegisteredGrant);
      projection = data(projectRegisteredGrant.call(grantOperations, data(grant)));
      recheck(binding, bounds, recognized);
      requireThat(
        projection &&
          same(Object.keys(projection).sort(), [
            "connectionGeneration",
            "connectionId",
            "definition",
            "grantId",
            "originalOperations",
            "originalProfile",
            "permitted",
          ]) &&
          projection.grantId === grant.grantId &&
          projection.connectionId === grant.connectionId &&
          projection.connectionGeneration === grant.connectionGeneration &&
          same(projection.definition, grant.operations.definition) &&
          same(projection.originalOperations, grant.operations) &&
          same(projection.originalProfile, grant.credentialProfile) &&
          Array.isArray(projection.permitted) &&
          projection.permitted.length >= 1 &&
          projection.permitted.length <= 256 &&
          projection.permitted.every(
            (tuple) =>
              tuple &&
              same(Object.keys(tuple).sort(), [
                "canonicalResource",
                "exactAction",
                "profileSelectionDigest",
                "serviceId",
              ]) &&
              [tuple.serviceId, tuple.exactAction, tuple.profileSelectionDigest].every(
                (value) => text(value) && Buffer.byteLength(value, "utf8") <= 256,
              ) &&
              canonicalResourceText(tuple.canonicalResource),
          ) &&
          projection.permitted.some(
            (tuple) =>
              tuple.serviceId === binding.serviceId &&
              tuple.exactAction === binding.iam.action &&
              tuple.canonicalResource === binding.iam.canonicalResource &&
              tuple.profileSelectionDigest === binding.profile.selectionDigest,
          ),
      );
    }
    const decisions = evaluateProposedEnvelopeV1(binding, snapshot);
    requireThat(
      decisions.length > 0 &&
        decisions.every(
          (d) =>
            d.allowed &&
            d.driverId === selection.driverId &&
            d.evidence.bindingIds.length > 0 &&
            d.evidence.roleIds.length > 0,
        ),
    );
    recheck(binding, bounds, recognized);
    requireThat(clock() < expiresAt);
    return { expiresAt, projection };
  }
  function facts(
    snapshot: Readonly<NativeRootIamSnapshotV1>,
    original: Readonly<OriginalRootEffectV1>,
    projection: Readonly<RegisteredGrantOperationProjectionV1> | null,
  ): string {
    return key({
      snapshot,
      projection,
      original: {
        binding: bindingKey(original.binding),
        state: original.state,
        recordVersion: original.recordVersion,
        originalBundle: original.originalBundle,
        capacity: original.capacity,
      },
    });
  }
  const owner: SelectedIamAdmissionOwner = Object.freeze({
    async prepare(
      this: SelectedIamAdmissionOwner,
      candidate: AuthorityBinding,
      deadline: number,
    ): Promise<IamAdmissionEvidence> {
      requireThat(this === owner);
      cleanup();
      requireThat(active.size + pending < maximumActiveEvidence);
      const binding = capture(candidate),
        recognized = recognition(binding),
        requestBounds = originalBounds(candidate);
      requireThat(finite(deadline));
      const bounds = Object.freeze({
        signal: requestBounds.signal,
        deadline: Math.min(
          requestBounds.deadline,
          deadline,
          clock() + maximumPrepareMs,
          binding.bounds.authorityDeadline,
          binding.bounds.requestDeadline,
          binding.root.durationPolicy.kind === "finite"
            ? binding.root.durationPolicy.originalDeadline
            : Infinity,
        ),
      });
      check(bounds);
      pending += 1;
      try {
        const prepared = await wait(
          () =>
            state.withPreparationSnapshot(locator(binding), bounds, async (uow, snapshot) => {
              recheck(binding, bounds, recognized);
              const retained = await wait(
                () => effects.readIn(uow, locator(binding), bounds),
                bounds,
              );
              recheck(binding, bounds, recognized);
              requireThat(retained);
              const checked = validate(binding, recognized, snapshot, retained, bounds);
              const expiresAt = Math.min(
                checked.expiresAt,
                requestBounds.deadline,
                deadline,
                clock() + maximumEvidenceLifetimeMs,
              );
              requireThat(clock() < expiresAt);
              return {
                binding,
                bounds: Object.freeze({ signal: requestBounds.signal, deadline: expiresAt }),
                core: recognized,
                expiresAt,
                facts: facts(snapshot, retained, checked.projection),
              };
            }),
          bounds,
        );
        recheck(binding, bounds, recognized);
        recheck(binding, prepared.bounds, recognized);
        // This is the sole original owner mint. The nominal declaration is not a public constructor.
        const evidence = Object.freeze(Object.create(null)) as IamAdmissionEvidence;
        active.set(evidence, prepared);
        return evidence;
      } finally {
        pending -= 1;
      }
    },
    consumeIn(
      this: SelectedIamAdmissionOwner,
      uow: PlatformUnitOfWork,
      evidence: IamAdmissionEvidence,
      candidate: AuthorityBinding,
    ): Promise<void> {
      // TODO(State composition): the genuine State adapter must implement same-guard
      // nonserial enrollment, sticky failure/drain and the all-writer SQL fence.
      return state.retainAdmissionFenceIn(uow, async (scope) => {
        const prepared = active.get(evidence);
        active.delete(evidence); // Synchronously spent before checks or the first await.
        requireThat(this === owner && prepared && evidence && !types.isProxy(evidence));
        const binding = capture(candidate);
        requireThat(
          binding.authentication === prepared.binding.authentication &&
            bindingKey(binding) === bindingKey(prepared.binding),
        );
        if (binding.effect === "pr-create")
          requireThat(
            prepared.binding.effect === "pr-create" &&
              binding.originalPrClaim === prepared.binding.originalPrClaim,
          );
        recheck(binding, prepared.bounds, prepared.core);
        let snapshot = await wait(
          () => scope.lockSnapshot(locator(binding), prepared.bounds),
          prepared.bounds,
        );
        recheck(binding, prepared.bounds, prepared.core);
        const retained = await wait(
          () => effects.readIn(uow, locator(binding), prepared.bounds),
          prepared.bounds,
        );
        recheck(binding, prepared.bounds, prepared.core);
        requireThat(retained);
        // Refresh independent originals after the effect owner's wait, still under
        // this scope's retained policy/selection fence and the original UoW.
        snapshot = await wait(
          () => scope.lockSnapshot(locator(binding), prepared.bounds),
          prepared.bounds,
        );
        recheck(binding, prepared.bounds, prepared.core);
        const checked = validate(binding, prepared.core, snapshot, retained, prepared.bounds);
        requireThat(facts(snapshot, retained, checked.projection) === prepared.facts);
        recheck(binding, prepared.bounds, prepared.core);
      });
    },
  });
  return owner;
}
