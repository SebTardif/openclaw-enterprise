import { isDeepStrictEqual } from "node:util";
import { immutableCopy } from "@openclaw-enterprise/utils";
import type {
  CapturedCredentialViewV1,
  CredentialFactsV1,
  OriginalCredentialCaptureConsumerV1,
} from "../../ports/workload-profile-credentials.ts";
import type {
  WorkloadProfileCandidateQualificationV2,
  WorkloadProfileCandidateQualifiersV2,
  WorkloadProfileDeploymentUnitV2,
  WorkloadProfileOwnedOperationV2,
} from "../../workload-profiles/admitted-use.ts";
import { WorkloadProfileSelectionError } from "../../workload-profiles/selection.ts";

/** Original protected policy paired with the SAME source captured before the
 * candidate context. It recognizes its actual held facts/request/unit and checks
 * installed model/provider/audience/transport and material/path membership.
 * It must check actual admission permission and service-owned credential custody;
 * account versions, references and this interface do not authenticate authority.
 *
 * This is a synchronous comparison against the already held original source,
 * including at final COMMIT after acquisition IO closes. No query, acquisition,
 * release, enrollment or enclosing-composite assertion is allowed. The source
 * owns all policy holds before the head. The view preserves its facts identity.
 * TODO(CRD): the original WIF owner must supply this genuine policy together with
 * acquireCapturedLocked; this leaf supplies neither implementation nor default. */
export interface OriginalWifCredentialCandidatePolicyV1 {
  assertCandidate(
    input: WorkloadProfileCandidateQualificationV2,
    captured: CapturedCredentialViewV1,
    unit: WorkloadProfileDeploymentUnitV2,
  ): undefined;
}

type CredentialQualifier = WorkloadProfileCandidateQualifiersV2["credentials"];

function unavailable(): never {
  throw new WorkloadProfileSelectionError("unavailable");
}
function mismatch(): never {
  throw new WorkloadProfileSelectionError("selection-mismatch");
}
/** Do not propagate protected-source exceptions or their arbitrary properties. */
function refusal(error: unknown): WorkloadProfileSelectionError {
  try {
    if (error instanceof WorkloadProfileSelectionError) {
      const code = error.code;
      if (
        code === "unavailable" ||
        code === "invalid-record" ||
        code === "selection-mismatch" ||
        code === "unsupported-capability" ||
        code === "incomplete-accounting"
      )
        return new WorkloadProfileSelectionError(code);
    }
  } catch {
    // Even a thrown object's property access is outside the diagnostic boundary.
  }
  return new WorkloadProfileSelectionError("unavailable");
}

/** This guard owns only its lifetime and malformed asynchronous assertions.
 * Central owns the actual credential lease; borrowed callbacks are never closed.
 * In particular this guard is independent of the composite retaining it. */
function borrowedLifetime(io: WorkloadProfileOwnedOperationV2) {
  const active = io.assertActive.bind(io);
  const poison = io.poison.bind(io);
  const checks: (() => unknown)[] = [];
  const pending = new Set<Promise<unknown>>();
  let closed = false;
  let failure: WorkloadProfileSelectionError | undefined;
  let terminal: Promise<void> | undefined;
  const report = (error: WorkloadProfileSelectionError) => {
    try {
      poison(error);
    } catch {
      // The sanitized refusal remains primary; original cleanup still drains.
    }
  };
  const synchronous = (work: () => unknown): void => {
    const result = work();
    if (result === undefined) return;
    const task = Promise.resolve(result);
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
    unavailable();
  };
  const assertCurrent = (): undefined => {
    if (closed) unavailable();
    if (failure) throw failure;
    try {
      for (const check of checks) synchronous(check);
    } catch (error) {
      failure = refusal(error);
      report(failure);
      throw failure;
    }
    return undefined;
  };
  const acquiring = () => {
    synchronous(active);
    assertCurrent();
  };
  const release = (): Promise<void> => {
    if (terminal) return terminal;
    closed = true;
    // Publish before any continuation can reenter terminal cleanup.
    terminal = Promise.resolve().then(async () => {
      while (pending.size) await Promise.allSettled([...pending]);
    });
    return terminal;
  };
  const reject = async (error: unknown): Promise<never> => {
    failure = refusal(error);
    report(failure);
    await release();
    throw failure;
  };
  return { checks, assertCurrent, acquiring, release, reject };
}

/** Consistency checks AFTER original recognition, never a metadata-to-authority
 * conversion. Versioned account/profile/workspace references are deliberately
 * not equated with unrelated opaque external IDs; the original policy owns those
 * mappings. The account credential name/key is not an OCC Secret lookup. */
function association(input: WorkloadProfileCandidateQualificationV2, facts: CredentialFactsV1) {
  const { request, candidate, records } = input;
  const account = records.serviceAccount;
  const credential = account.credential;
  const provider = records.providerBinding;
  if (
    account.namespaceId !== request.namespaceId ||
    records.agent.id !== request.agentId ||
    records.agent.namespaceId !== request.namespaceId ||
    records.agent.serviceAccountId !== account.id ||
    records.agent.servicePrincipalId !== candidate.servicePrincipalId ||
    candidate.id !== request.revisionId ||
    candidate.agentId !== request.agentId ||
    candidate.namespaceId !== request.namespaceId ||
    candidate.configurationId !== request.configurationRef ||
    candidate.configurationGeneration !== request.configurationVersion ||
    candidate.configurationKind !== "agent" ||
    records.configuration.configurationRef !== request.configurationRef ||
    records.configuration.configurationGeneration !== request.configurationVersion ||
    candidate.serviceAccount?.id !== account.id ||
    !isDeepStrictEqual(candidate.serviceAccount.credential, credential)
  )
    mismatch();
  // This candidate contribution is only the selected WIF/dedicated Codex path.
  // It does not change ordinary ServiceAccount or embedded Agent policy.
  if (
    credential?.kind !== "access_token" ||
    candidate.harness.id !== "codex" ||
    candidate.harness.mode !== "dedicated" ||
    candidate.secretBindings === undefined ||
    candidate.secretBindings.OPENAI_API_KEY !== undefined ||
    provider === undefined ||
    provider.credentialIssued !== true ||
    provider.providerId !== candidate.providerId ||
    provider.providerId !== records.agent.providerId
  )
    mismatch();

  const { model, backend, named } = facts;
  const binding = model.binding;
  const protectedModel = model.modelBinding;
  const partition = model.cachePartition;
  const scope = {
    installationId: request.installationId,
    namespaceId: request.namespaceId,
    agentId: request.agentId,
  };
  if (
    !isDeepStrictEqual(binding.scope, scope) ||
    !isDeepStrictEqual(protectedModel.scope, scope) ||
    !isDeepStrictEqual(protectedModel.profile.scope, scope) ||
    !isDeepStrictEqual(protectedModel.binding, binding) ||
    !isDeepStrictEqual(protectedModel.profile.account, binding.account) ||
    binding.providerId !== provider.providerId ||
    protectedModel.profile.providerId !== provider.providerId ||
    protectedModel.profile.kind !== "model" ||
    protectedModel.profile.mode !== "mediated" ||
    protectedModel.profile.credentialClass !== "workload-federation" ||
    protectedModel.setup.kind !== "workload-federation" ||
    protectedModel.setup.invocationMaterial !== "access-token-and-account-context" ||
    protectedModel.custody !== "external-protected-owner" ||
    partition.purpose !== "model-use" ||
    !isDeepStrictEqual(partition.scope, scope) ||
    !isDeepStrictEqual(partition.binding, binding) ||
    !isDeepStrictEqual(partition.modelBinding, protectedModel) ||
    !isDeepStrictEqual(partition.profile, protectedModel.profile) ||
    !isDeepStrictEqual(backend.cachePartition, partition) ||
    !isDeepStrictEqual(named.partition, partition) ||
    !isDeepStrictEqual(backend.namedSecret.binding, binding) ||
    !isDeepStrictEqual(named.namedSecret, backend.namedSecret) ||
    backend.inventory.installationId !== request.installationId ||
    backend.custody.kind !== "external-protected-adapter" ||
    backend.placement.materialBoundary !== "outside-agent-execution" ||
    backend.placement.handleTransport !== "in-process-only" ||
    backend.namedSecret.versionPolicy !== "immutable-protected-version" ||
    backend.namedSecret.immutableVersionRecord.version !== binding.secretVersion ||
    named.secret.id !== binding.secretId ||
    named.secret.namespaceId !== request.namespaceId ||
    // binding.driverId names the Secret Driver, not the ServiceAccount Driver.
    named.secret.driverId !== binding.driverId ||
    !isDeepStrictEqual(named.secret.backendRef, {
      namespaceName: backend.namedSecret.namespaceName,
      name: backend.namedSecret.name,
      key: backend.namedSecret.key,
      uid: backend.namedSecret.uid,
    }) ||
    !isDeepStrictEqual(credential.secretRef, {
      name: backend.namedSecret.name,
      key: backend.namedSecret.key,
    }) ||
    named.accountKey.namespaceId !== request.namespaceId ||
    named.accountKey.serviceAccountId !== account.id ||
    named.accountKey.providerId !== provider.providerId ||
    named.accountKey.driverId !== provider.driverId ||
    named.accountKey.workspaceId !== provider.workspaceId ||
    named.accountLink.providerId !== provider.providerId ||
    named.accountLink.driverId !== provider.driverId ||
    named.accountLink.workspaceId !== provider.workspaceId
  )
    mismatch();

  return immutableCopy({
    servicePrincipalId: candidate.servicePrincipalId,
    serviceAccount: {
      id: account.id,
      credential: {
        kind: credential.kind,
        secretRef: { name: credential.secretRef.name, key: credential.secretRef.key },
      },
    },
  });
}

/** Candidate-only contribution. Construct once from original process-owned
 * instances; construction performs no acquisition. Neither argument is supplied
 * from request/profile data. Absence refuses rather than creating a positive
 * source. Definition and persisted-revision contributors remain separate. */
export function createWifServiceAccountCredentialQualifierV1(
  original?: OriginalCredentialCaptureConsumerV1,
  policy?: OriginalWifCredentialCandidatePolicyV1,
): CredentialQualifier {
  let consume: OriginalCredentialCaptureConsumerV1["consumeCapturedCredentialV1"] | undefined;
  let qualify: OriginalWifCredentialCandidatePolicyV1["assertCandidate"] | undefined;
  try {
    consume = original?.consumeCapturedCredentialV1?.bind(original);
    qualify = policy?.assertCandidate?.bind(policy);
  } catch {
    unavailable();
  }
  const qualifier: CredentialQualifier = {
    async resolveLocked(input, originalRecords, unit, io) {
      if (!consume || !qualify) unavailable();
      const recognize = consume;
      const assertPolicy = qualify;
      let held: ReturnType<typeof borrowedLifetime>;
      try {
        held = borrowedLifetime(io);
      } catch {
        unavailable();
      }
      try {
        // Borrow only the independent record guard, never the enclosing lease.
        held.checks.push(originalRecords.assertCurrent.bind(originalRecords));
        held.acquiring();
        const qualification = immutableCopy(input);
        held.checks.push(() => {
          const request = qualification.request;
          if (
            unit.kind !== "deployment" ||
            unit.signal.aborted ||
            unit.installationId !== request.installationId ||
            unit.namespaceId !== request.namespaceId ||
            unit.agentId !== request.agentId
          )
            unavailable();
        });
        held.acquiring();
        const captured = await recognize(qualification.request, originalRecords, unit, io);
        // Central already owns cleanup. Capture this method once before facts.
        held.checks.push(captured.assertCurrent.bind(captured));
        held.acquiring();
        if (!isDeepStrictEqual(qualification.records, originalRecords.records)) mismatch();
        const facts = immutableCopy(captured.facts);
        const projected = association(qualification, facts);
        // Preserve the genuine borrowed view/facts identity for the paired owner.
        // The policy must not acquire or call back into the enclosing composite.
        held.checks.push(() => assertPolicy(qualification, captured, unit));
        held.acquiring();
        return Object.freeze({
          association: projected,
          assertCurrent: held.assertCurrent,
          release: held.release,
        });
      } catch (error) {
        return held.reject(error);
      }
    },
  };
  return Object.freeze(qualifier);
}
