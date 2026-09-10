import { DriverSelection } from "@openclaw-enterprise/occ/application/driver-selection";
import type { ComputeDriver } from "@openclaw-enterprise/contracts";
import type {
  RuntimeCreateCorrelationOperationV1,
  RuntimeCreateCorrelationRequestV1,
} from "@openclaw-enterprise/occ/runtime-preparation/create-correlation";
import {
  resolveRuntimePreparationCreateReferenceV1,
  type RuntimePreparationCreateCorrelationRetainedV1,
} from "@openclaw-enterprise/occ/runtime-preparation/create-reference";
import type { AppsV1Api, CoreV1Api, V1ObjectMeta, V1Pod } from "@kubernetes/client-node";
import {
  parseRuntimeAuthorityV1,
  parseRuntimeEffectsResponseV1,
  parseRuntimeEffectsV1,
  runtimeEffectEvidenceFreshV1,
  RUNTIME_EFFECT_LIMITS_V1,
  type DiscoveryResultV1,
  type ExactCreateEffectV1,
  type RuntimeAuthorityContextFactoryV1,
  type RuntimeAuthorityTransportBindingV1,
  type RuntimeAuthorityVerifiedServiceV1,
  type RuntimeBindingV1,
  type RuntimeEffectsV1,
  type RuntimeEvidenceProvenanceV1,
  type RuntimeObservationInputV1,
  type RuntimeObservationResultV1,
  type RuntimeReadCallV1,
  type RuntimeServiceTrustConfigurationV1,
} from "@openclaw-enterprise/contracts";
import { sha256Hex } from "@openclaw-enterprise/utils";
import { withComputeAbortSignal } from "../operation-context.ts";
import { PREPARED_DEPLOYMENT_ANNOTATIONS } from "./prepared-deployment.ts";

type Method = "discover" | "observe";
type Input = ExactCreateEffectV1 | RuntimeObservationInputV1;
type CompleteObservation = Extract<RuntimeObservationResultV1, { status: "complete" }>;
type ProviderObject = Extract<DiscoveryResultV1, { status: "exact" }>["object"];
type Reason = Exclude<DiscoveryResultV1, { status: "exact" }>["reasonCode"];
type ContextInspector = Pick<RuntimeAuthorityContextFactoryV1<unknown>, "inspect">;
type ProducerKind = "create-correlation" | "execution" | "profiles" | "observation";

export interface KubernetesObservationClock {
  now(): Date;
  monotonicMilliseconds(): number;
}

/** A protected current admission record and original request correspondence, supplied
 * by the existing native/registry owner. This is not a context factory or a grant
 * derived from a role string. The current readOperation/bind profile cannot supply it. */
export interface KubernetesObservationAuthorization {
  readonly configuration: RuntimeServiceTrustConfigurationV1;
  readonly method: Method;
  readonly inputDigest: string;
  readonly requestRef: string;
  readonly recipientRef: string;
  readonly transportBinding: RuntimeAuthorityTransportBindingV1;
}

interface RecordRef {
  readonly recordRef: string;
  readonly recordVersion: number;
}

/** Internal contribution records, not new public IFCs. Their original producer owns
 * authentication, durable record identity/version and source time. A constructor
 * dependency is the trust boundary; parsing these values adds no authenticity. */
export interface KubernetesCreateCorrelation extends RecordRef {
  readonly input: ExactCreateEffectV1;
  readonly namespace: string;
  readonly object: ProviderObject;
  readonly evidence: RuntimeEvidenceProvenanceV1;
}

interface ObjectIdentity {
  readonly name: string;
  readonly uid: string;
  readonly resourceVersion: string;
}

export interface KubernetesRuntimeUidChain {
  readonly namespace: ObjectIdentity;
  readonly deployment: ObjectIdentity;
  readonly replicaSet: ObjectIdentity;
  readonly pod: ObjectIdentity & {
    readonly nodeName: string;
    readonly runtimeClassName: string | null;
    readonly containers: readonly {
      readonly kind: "init" | "main";
      readonly name: string;
      readonly containerId: string;
      readonly imageId: string;
      readonly restartCount: number;
      readonly startedAt: string | null;
    }[];
  };
}

export interface KubernetesRuntimeObservationQuery {
  readonly input: RuntimeObservationInputV1;
  readonly chain: KubernetesRuntimeUidChain;
}

export interface KubernetesExecutionCorrespondence extends RecordRef {
  readonly query: KubernetesRuntimeObservationQuery;
  readonly binding: RuntimeBindingV1;
  readonly evidence: RuntimeEvidenceProvenanceV1;
}

export interface KubernetesProfileObservation extends RecordRef {
  readonly query: KubernetesRuntimeObservationQuery;
  readonly profile: CompleteObservation["profile"];
  readonly evidence: RuntimeEvidenceProvenanceV1;
}

export interface KubernetesObservationSummaryQuery extends KubernetesRuntimeObservationQuery {
  readonly correlation: RecordRef;
  readonly execution: RecordRef;
  readonly profiles: RecordRef;
}

/** The original Compute producer's retained observation over these exact source
 * records and API chain. This is not an attest(arbitraryObject) callback. It cannot
 * be manufactured by this adapter after collecting an otherwise incomplete result. */
export interface KubernetesObservationSummary extends RecordRef {
  readonly query: KubernetesObservationSummaryQuery;
  readonly evidence: RuntimeEvidenceProvenanceV1;
  readonly ownerChainEvidence: RuntimeEvidenceProvenanceV1;
}

export interface KubernetesCurrentProducerRecord extends RecordRef {
  readonly kind: ProducerKind;
  /** SHA-256 of the original record's UTF-8 JSON with recursively sorted object
   * keys (UTF-16 code-unit order), unchanged array order and no whitespace. */
  readonly recordDigest: string;
  readonly configuration: RuntimeServiceTrustConfigurationV1;
  readonly producer: Pick<
    RuntimeEvidenceProvenanceV1,
    | "producerRef"
    | "producerServiceVersion"
    | "producerProfileRef"
    | "producerProfileDigest"
    | "acceptedPortRef"
  >;
}

/** Named protected readers below must supply a live, independently authenticated
 * source exchange and its current original record. They are required integrations
 * from the runtime, identity, profile and observation producers.
 * The source exchange must remain inspectable until this read call completes. */
export interface KubernetesObservationProducer<Query, Record extends RecordRef> {
  readonly contextFactory: ContextInspector;
  read(
    query: Query,
    call: RuntimeReadCallV1,
  ): Promise<
    | { readonly status: "unavailable" }
    | {
        readonly status: "observed";
        readonly record: Record;
        readonly sourceCall: RuntimeReadCallV1;
      }
  >;
  readCurrent(
    original: RecordRef,
    call: RuntimeReadCallV1,
  ): Promise<KubernetesCurrentProducerRecord | undefined>;
}

/** Trusted constructor-only dependencies. No Installation JSON, default profile,
 * local timestamp/counter, synthetic context or ordinary readiness can supply them.
 * TODO(runtime observation composition): supply the authenticated producer and
 * admission integrations before enabling positive production observations. */
export interface KubernetesRuntimeObservationDependencies {
  readonly clusterRef: string;
  readonly clock: KubernetesObservationClock;
  readonly contextFactory: ContextInspector;
  readAuthorization(
    method: Method,
    input: Input,
    call: RuntimeReadCallV1,
  ): Promise<KubernetesObservationAuthorization | undefined>;
  readonly correlation: KubernetesObservationProducer<
    ExactCreateEffectV1,
    KubernetesCreateCorrelation
  >;
  readonly execution: KubernetesObservationProducer<
    KubernetesRuntimeObservationQuery,
    KubernetesExecutionCorrespondence
  >;
  readonly profiles: KubernetesObservationProducer<
    KubernetesRuntimeObservationQuery,
    KubernetesProfileObservation
  >;
  readonly observation: KubernetesObservationProducer<
    KubernetesObservationSummaryQuery,
    KubernetesObservationSummary
  >;
}

/** Borrowed only from the owned native listener. This authorizes the original
 * caller exchange; the separately authenticated producer records remain required. */
export interface KubernetesRuntimeObservationAdmission {
  readonly clock: KubernetesObservationClock;
  readonly signal: AbortSignal;
  readonly contextFactory: ContextInspector;
  readonly readAuthorization: KubernetesRuntimeObservationDependencies["readAuthorization"];
}

interface ProviderReads {
  clients(): Promise<{
    readonly core: Pick<CoreV1Api, "readNamespace" | "listNamespacedPod">;
    readonly apps: Pick<AppsV1Api, "readNamespacedDeployment" | "listNamespacedReplicaSet">;
  }>;
  request<T>(operation: () => Promise<T>): Promise<T>;
}

class ObservationUnavailable extends Error {
  readonly reasonCode: Reason;
  readonly status: "incomplete" | "ambiguous" | "unknown" | "conflict";

  constructor(
    reasonCode: Reason,
    status: "incomplete" | "ambiguous" | "unknown" | "conflict" = "incomplete",
  ) {
    super("The exact Kubernetes runtime observation is unavailable.");
    this.reasonCode = reasonCode;
    this.status = status;
  }
}

function requireValue(value: unknown, reason: Reason = "evidence-incomplete"): asserts value {
  if (!value) throw new ObservationUnavailable(reason);
}

function canonical(value: unknown, depth = 0): string {
  requireValue(depth <= RUNTIME_EFFECT_LIMITS_V1.maxDepth);
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    requireValue(value.length <= 1024);
    return `[${value.map((entry) => canonical(entry, depth + 1)).join(",")}]`;
  }
  requireValue(
    typeof value === "object" &&
      value !== null &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null),
  );
  const entries = Object.entries(value).sort(([left], [right]) => {
    if (left < right) return -1;
    return left > right ? 1 : 0;
  });
  requireValue(entries.length <= 1024);
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry, depth + 1)}`).join(",")}}`;
}

function serialized(value: unknown): string {
  const bytes = canonical(value);
  requireValue(Buffer.byteLength(bytes) <= RUNTIME_EFFECT_LIMITS_V1.maxJsonBytes);
  return bytes;
}

function same(left: unknown, right: unknown): boolean {
  return serialized(left) === serialized(right);
}

function detached<T>(value: T): T {
  const result = JSON.parse(serialized(value)) as T;
  const freeze = (entry: unknown): void => {
    if (entry === null || typeof entry !== "object") return;
    for (const child of Object.values(entry)) freeze(child);
    Object.freeze(entry);
  };
  freeze(result);
  return result;
}

function recordRef(record: RecordRef): RecordRef {
  requireValue(
    typeof record.recordRef === "string" && /^[A-Za-z0-9._:/-]{1,200}$/.test(record.recordRef),
  );
  requireValue(Number.isSafeInteger(record.recordVersion) && record.recordVersion > 0);
  return Object.freeze({ recordRef: record.recordRef, recordVersion: record.recordVersion });
}

function scopeOf(input: Input) {
  return "effect" in input ? input.effect.target : input.target;
}

function inScope(service: RuntimeAuthorityVerifiedServiceV1, input: Input): boolean {
  const target = scopeOf(input);
  const scope = service.configuration.allowedScope;
  return (
    service.configuration.installationId === target.installationId &&
    scope.installationId === target.installationId &&
    (scope.kind === "installation" ||
      (scope.namespaceId === target.namespaceId && scope.agentId === target.agentId))
  );
}

function objectIdentity(metadata: V1ObjectMeta | undefined, name?: string): ObjectIdentity {
  requireValue(metadata && metadata.deletionTimestamp === undefined);
  const { uid, resourceVersion } = metadata;
  requireValue(
    typeof metadata.name === "string" &&
      metadata.name.length > 0 &&
      (name === undefined || name === metadata.name),
  );
  requireValue(
    typeof uid === "string" &&
      uid.length > 0 &&
      typeof resourceVersion === "string" &&
      resourceVersion.length > 0,
  );
  return { name: metadata.name, uid, resourceVersion };
}

function controlledBy(
  metadata: V1ObjectMeta | undefined,
  owner: ObjectIdentity,
  kind: string,
): boolean {
  const references = metadata?.ownerReferences ?? [];
  const matching = references.filter((ref) => ref.uid === owner.uid);
  if (matching.length === 0) return false;
  requireValue(
    matching.length === 1 && references.filter((ref) => ref.controller === true).length === 1,
  );
  const reference = matching[0]!;
  requireValue(
    reference.controller === true &&
      reference.apiVersion === "apps/v1" &&
      reference.kind === kind &&
      reference.name === owner.name,
    "ownership-mismatch",
  );
  return true;
}

function podIdentity(pod: V1Pod): KubernetesRuntimeUidChain["pod"] {
  const identity = objectIdentity(pod.metadata);
  requireValue(typeof pod.spec?.nodeName === "string" && pod.spec.nodeName.length > 0);
  requireValue(
    (pod.spec.ephemeralContainers?.length ?? 0) === 0 &&
      (pod.status?.ephemeralContainerStatuses?.length ?? 0) === 0,
    "capability-unsupported",
  );
  const containers: KubernetesRuntimeUidChain["pod"]["containers"][number][] = [];
  for (const [kind, specs, statuses] of [
    ["init", pod.spec.initContainers ?? [], pod.status?.initContainerStatuses ?? []],
    ["main", pod.spec.containers, pod.status?.containerStatuses ?? []],
  ] as const) {
    requireValue(specs.length <= 16 && specs.length === statuses.length);
    for (const spec of specs) {
      const candidates = statuses.filter((status) => status.name === spec.name);
      requireValue(candidates.length === 1);
      const status = candidates[0]!;
      requireValue(
        status.containerID &&
          status.imageID &&
          Number.isSafeInteger(status.restartCount) &&
          status.restartCount >= 0,
      );
      const started = status.state?.running?.startedAt ?? status.state?.terminated?.startedAt;
      containers.push({
        kind,
        name: spec.name,
        containerId: status.containerID,
        imageId: status.imageID,
        restartCount: status.restartCount,
        startedAt: started === undefined ? null : new Date(started).toISOString(),
      });
    }
  }
  requireValue(containers.some(({ kind }) => kind === "main"));
  return {
    ...identity,
    nodeName: pod.spec.nodeName,
    runtimeClassName: pod.spec.runtimeClassName ?? null,
    containers,
  };
}

/** Read-only collaborator of the selected driver. It cannot reserve/materialize,
 * adopt, route, bind, stop, issue identity or create an evidence record. */
export class KubernetesRuntimeObservations implements Pick<
  RuntimeEffectsV1,
  "discover" | "observe"
> {
  private readonly provider: ProviderReads;
  private readonly dependencies: KubernetesRuntimeObservationDependencies | undefined;
  private readonly isolationProfile: "gvisor-systrap" | undefined;
  private nativeAdmission: KubernetesRuntimeObservationAdmission | undefined;

  constructor(
    provider: ProviderReads,
    dependencies: KubernetesRuntimeObservationDependencies | undefined,
    isolationProfile: "gvisor-systrap" | undefined,
  ) {
    this.provider = provider;
    this.dependencies = dependencies;
    this.isolationProfile = isolationProfile;
  }

  /** Captured by the original native constructor through the SAME Driver.
   * This owns physical reads only; native owns operation/State recognition. */
  createCorrelationObservationOwner(
    driver: ComputeDriver,
    selection: DriverSelection,
  ): KubernetesCreateCorrelationObservationOwnerV1 {
    const held = DriverSelection.prototype.acquireGuardedSelection.call(
      selection,
      "compute",
      driver,
    );
    try {
      held.assertCurrent();
      requireValue(selection.selectedDriver("compute") === driver, "authority-unavailable");
      // This association is an original constructor input, never a request field.
      const clusterRef = this.dependencies?.clusterRef;
      requireValue(
        typeof clusterRef === "string" && clusterRef.length > 0,
        "authority-unavailable",
      );
      const owner = new CreateCorrelationPhysicalOwner(this.provider, clusterRef, held);
      held.assertCurrent();
      return owner;
    } catch (error) {
      held.release();
      throw error;
    }
  }

  /** One listener owns this slot until disposal. A replacement cannot revive its
   * earlier exchanges: disposal aborts their captured lifetime before releasing it. */
  bindNativeAdmission(admission: KubernetesRuntimeObservationAdmission): () => void {
    if (this.nativeAdmission || admission.signal.aborted)
      throw new Error("Runtime observation admission is already selected or unavailable.");
    const lifetime = new AbortController();
    const selected = Object.freeze({
      ...admission,
      signal: AbortSignal.any([admission.signal, lifetime.signal]),
    });
    this.nativeAdmission = selected;
    return () => {
      lifetime.abort();
      if (this.nativeAdmission === selected) this.nativeAdmission = undefined;
    };
  }

  private async bounded<T>(
    call: RuntimeReadCallV1,
    ceiling: number,
    work: (boundedCall: RuntimeReadCallV1) => Promise<T>,
  ): Promise<T> {
    const admission = this.nativeAdmission;
    const clock = admission?.clock ?? this.dependencies?.clock;
    requireValue(clock, "authority-unavailable");
    requireValue(
      call &&
        call.signal instanceof AbortSignal &&
        typeof call.deadline === "string" &&
        typeof call.requestRef === "string" &&
        call.requestRef.length > 0 &&
        typeof call.recipientRef === "string" &&
        call.recipientRef.length > 0,
      "authority-unavailable",
    );
    const now = clock.now().getTime();
    const deadline = Date.parse(call.deadline);
    requireValue(
      Number.isFinite(now) &&
        Number.isFinite(deadline) &&
        new Date(deadline).toISOString() === call.deadline,
      "source-time-invalid",
    );
    if (call.signal.aborted) throw new ObservationUnavailable("cancelled", "unknown");
    const milliseconds = Math.min(ceiling, deadline - now);
    requireValue(milliseconds > 0, "deadline-exceeded");
    const started = clock.monotonicMilliseconds();
    requireValue(Number.isFinite(started), "source-time-invalid");
    const cancellation = new AbortController();
    const callerSignal = AbortSignal.any([
      call.signal,
      ...(admission === undefined ? [] : [admission.signal]),
    ]);
    const signal = AbortSignal.any([callerSignal, cancellation.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let aborted: (() => void) | undefined;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => {
          signal.throwIfAborted();
          return withComputeAbortSignal(signal, () => work({ ...call, signal }));
        }),
        new Promise<never>((_resolve, reject) => {
          aborted = () => {
            cancellation.abort();
            reject(new ObservationUnavailable("cancelled", "unknown"));
          };
          callerSignal.addEventListener("abort", aborted, { once: true });
          timer = setTimeout(() => {
            cancellation.abort();
            reject(new ObservationUnavailable("deadline-exceeded", "unknown"));
          }, milliseconds);
        }),
      ]);
      const elapsed = clock.monotonicMilliseconds() - started;
      requireValue(
        Number.isFinite(elapsed) &&
          elapsed >= 0 &&
          elapsed < milliseconds &&
          clock.now().getTime() < deadline &&
          !signal.aborted &&
          this.nativeAdmission === admission,
        "deadline-exceeded",
      );
      return result;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (aborted) callerSignal.removeEventListener("abort", aborted);
      cancellation.abort();
    }
  }

  private serviceSnapshot(
    service: RuntimeAuthorityVerifiedServiceV1 | undefined,
    call: RuntimeReadCallV1,
    input: Input,
  ): RuntimeAuthorityVerifiedServiceV1 {
    requireValue(service, "authority-unavailable");
    const snapshot = {
      ...service,
      configuration: parseRuntimeAuthorityV1("serviceTrust", service.configuration),
    };
    requireValue(inScope(snapshot, input), "authority-unavailable");
    requireValue(
      snapshot.transportBinding !== null &&
        typeof snapshot.transportBinding === "object" &&
        typeof snapshot.peerEvidenceRef === "string" &&
        snapshot.peerEvidenceRef.length > 0,
      "authority-unavailable",
    );
    const now = (this.nativeAdmission?.clock ?? this.dependencies!.clock).now().getTime();
    requireValue(
      !call.signal.aborted &&
        now < Date.parse(call.deadline) &&
        snapshot.configuration.permittedRecipientRef === call.recipientRef &&
        Date.parse(snapshot.authenticatedAt) <= now &&
        Date.parse(snapshot.expiresAt) > now,
      "authority-unavailable",
    );
    return Object.freeze(snapshot);
  }

  private async authorize(
    method: Method,
    input: Input,
    call: RuntimeReadCallV1,
    original?: KubernetesObservationAuthorization,
  ): Promise<KubernetesObservationAuthorization> {
    const dependencies = this.nativeAdmission ?? this.dependencies;
    requireValue(dependencies, "authority-unavailable");
    return this.bounded(call, 3000, async (currentCall) => {
      const service = this.serviceSnapshot(
        await dependencies.contextFactory.inspect(currentCall.context, currentCall),
        currentCall,
        input,
      );
      const value = await dependencies.readAuthorization(method, input, currentCall);
      const authorization =
        value === undefined
          ? undefined
          : {
              ...value,
              configuration: parseRuntimeAuthorityV1("serviceTrust", value.configuration),
            };
      currentCall.signal.throwIfAborted();
      const again = this.serviceSnapshot(
        await dependencies.contextFactory.inspect(currentCall.context, currentCall),
        currentCall,
        input,
      );
      requireValue(
        authorization &&
          authorization.transportBinding === service.transportBinding &&
          again.transportBinding === service.transportBinding,
        "authority-unavailable",
      );
      requireValue(
        same(authorization.configuration, service.configuration) &&
          same(again.configuration, service.configuration),
        "authority-lost",
      );
      requireValue(
        authorization.method === method &&
          authorization.requestRef === call.requestRef &&
          authorization.recipientRef === call.recipientRef &&
          authorization.inputDigest === `sha256:${sha256Hex(serialized(input))}`,
        "denied",
      );
      if (original)
        requireValue(
          original.transportBinding === authorization.transportBinding &&
            same(original.configuration, authorization.configuration),
          "authority-lost",
        );
      return {
        ...authorization,
        configuration: parseRuntimeAuthorityV1("serviceTrust", authorization.configuration),
      };
    });
  }

  private fresh(
    evidence: RuntimeEvidenceProvenanceV1,
    producer?: KubernetesCurrentProducerRecord["producer"],
  ): void {
    const value = parseRuntimeEffectsV1("provenance", evidence);
    requireValue(
      runtimeEffectEvidenceFreshV1(value, this.dependencies!.clock.now().toISOString(), null),
      "evidence-stale",
    );
    if (producer) {
      const {
        producerRef,
        producerServiceVersion,
        producerProfileRef,
        producerProfileDigest,
        acceptedPortRef,
      } = value;
      requireValue(
        same(
          {
            producerRef,
            producerServiceVersion,
            producerProfileRef,
            producerProfileDigest,
            acceptedPortRef,
          },
          producer,
        ),
        "authority-unavailable",
      );
    }
  }

  private async contribution<Query, Record extends RecordRef>(
    kind: ProducerKind,
    reader: KubernetesObservationProducer<Query, Record>,
    query: Query,
    input: Input,
    call: RuntimeReadCallV1,
    evidence: (record: Record) => readonly RuntimeEvidenceProvenanceV1[],
  ): Promise<{ record: Record; recheck(): Promise<void> }> {
    const contribution = await this.bounded(call, 10_000, (boundedCall) =>
      reader.read(detached(query), boundedCall),
    );
    requireValue(contribution.status === "observed", "evidence-incomplete");
    const bytes = serialized(contribution.record);
    const record = detached(JSON.parse(bytes) as Record);
    const reference = recordRef(record);
    const source = contribution.sourceCall;
    const sourceCall: RuntimeReadCallV1 = {
      ...source,
      // The native source context binds its exact original request/deadline.
      // Caller cancellation and the enclosing bounded call impose the earlier
      // limit without rewriting that independently authenticated exchange.
      signal: AbortSignal.any([call.signal, source.signal]),
    };
    let original: KubernetesCurrentProducerRecord | undefined;
    let transport: RuntimeAuthorityTransportBindingV1 | undefined;
    const recheck = async () => {
      await this.bounded(sourceCall, 3000, async (boundedCall) => {
        const service = this.serviceSnapshot(
          await reader.contextFactory.inspect(boundedCall.context, boundedCall),
          boundedCall,
          input,
        );
        const value = await reader.readCurrent(reference, boundedCall);
        const current = value === undefined ? undefined : detached(value);
        boundedCall.signal.throwIfAborted();
        const again = this.serviceSnapshot(
          await reader.contextFactory.inspect(boundedCall.context, boundedCall),
          boundedCall,
          input,
        );
        requireValue(
          current &&
            current.kind === kind &&
            same(recordRef(current), reference) &&
            current.recordDigest === `sha256:${sha256Hex(bytes)}`,
          "evidence-incomplete",
        );
        requireValue(
          same(current.configuration, service.configuration) &&
            same(again.configuration, service.configuration) &&
            service.transportBinding === again.transportBinding,
          "authority-lost",
        );
        if (original)
          requireValue(
            same(current, original) && transport === again.transportBinding,
            "authority-lost",
          );
        for (const item of evidence(record)) this.fresh(item, current.producer);
        original = JSON.parse(serialized(current)) as KubernetesCurrentProducerRecord;
        transport = again.transportBinding;
      });
    };
    await recheck();
    return { record, recheck };
  }

  private async correlation(input: ExactCreateEffectV1, call: RuntimeReadCallV1) {
    const value = await this.contribution(
      "create-correlation",
      this.dependencies!.correlation,
      input,
      input,
      call,
      (record) => [record.evidence],
    );
    requireValue(same(value.record.input, input), "precondition-failed");
    requireValue(
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value.record.namespace),
      "ownership-mismatch",
    );
    parseRuntimeEffectsResponseV1("discover", input, {
      schemaVersion: 1,
      status: "exact",
      input,
      object: value.record.object,
      correlationEvidence: value.record.evidence,
    });
    requireValue(
      value.record.object.target.clusterRef === this.dependencies!.clusterRef,
      "ownership-mismatch",
    );
    return value;
  }

  private async root(correlation: KubernetesCreateCorrelation, call: RuntimeReadCallV1) {
    const clients = await this.bounded(call, 10_000, () => this.provider.clients());
    const namespace = await this.bounded(call, 10_000, () =>
      this.provider.request(() => clients.core.readNamespace({ name: correlation.namespace })),
    );
    requireValue(
      namespace.kind === "Namespace" && namespace.apiVersion === "v1",
      "ownership-mismatch",
    );
    const namespaceIdentity = objectIdentity(namespace.metadata, correlation.namespace);
    requireValue(
      namespaceIdentity.uid === correlation.object.target.kubernetesNamespaceUid,
      "ownership-mismatch",
    );
    const deployment = await this.bounded(call, 10_000, () =>
      this.provider.request(() =>
        clients.apps.readNamespacedDeployment({
          name: correlation.object.target.name,
          namespace: correlation.namespace,
        }),
      ),
    );
    requireValue(
      deployment.kind === "Deployment" &&
        deployment.apiVersion === "apps/v1" &&
        deployment.metadata?.namespace === correlation.namespace,
      "ownership-mismatch",
    );
    const identity = objectIdentity(deployment.metadata, correlation.object.target.name);
    requireValue(
      identity.uid === correlation.object.uid &&
        identity.resourceVersion === correlation.object.resourceVersion,
      "ownership-mismatch",
    );
    return { namespace: namespaceIdentity, deployment: identity };
  }

  private async chain(
    correlation: KubernetesCreateCorrelation,
    call: RuntimeReadCallV1,
  ): Promise<KubernetesRuntimeUidChain> {
    const root = await this.root(correlation, call);
    const clients = await this.bounded(call, 10_000, () => this.provider.clients());
    const limit = RUNTIME_EFFECT_LIMITS_V1.maxChildren;
    const replicaSets = await this.bounded(call, 10_000, () =>
      this.provider.request(() =>
        clients.apps.listNamespacedReplicaSet({
          namespace: correlation.namespace,
          limit: limit + 1,
        }),
      ),
    );
    const pods = await this.bounded(call, 10_000, () =>
      this.provider.request(() =>
        clients.core.listNamespacedPod({ namespace: correlation.namespace, limit: limit + 1 }),
      ),
    );
    for (const [list, kind, version] of [
      [replicaSets, "ReplicaSetList", "apps/v1"],
      [pods, "PodList", "v1"],
    ] as const) {
      const metadata = list.metadata as
        (NonNullable<typeof list.metadata> & { continue?: unknown }) | undefined;
      requireValue(
        Array.isArray(list.items) &&
          list.items.length <= limit &&
          (list.kind === undefined || list.kind === kind) &&
          (list.apiVersion === undefined || list.apiVersion === version) &&
          (metadata === undefined ||
            (metadata !== null && typeof metadata === "object" && !Array.isArray(metadata))) &&
          (metadata?.continue === undefined || metadata.continue === "") &&
          (metadata?._continue === undefined || metadata._continue === "") &&
          (metadata?.remainingItemCount === undefined || metadata.remainingItemCount === 0),
        "evidence-incomplete",
      );
    }
    const descendants = replicaSets.items.filter((item) =>
      controlledBy(item.metadata, root.deployment, "Deployment"),
    );
    const candidates: { replicaSet: ObjectIdentity; pod: V1Pod }[] = [];
    for (const descendant of descendants) {
      requireValue(
        (descendant.kind === undefined || descendant.kind === "ReplicaSet") &&
          (descendant.apiVersion === undefined || descendant.apiVersion === "apps/v1") &&
          descendant.metadata?.namespace === correlation.namespace,
        "ownership-mismatch",
      );
      const replicaSet = objectIdentity(descendant.metadata);
      for (const pod of pods.items) {
        if (!controlledBy(pod.metadata, replicaSet, "ReplicaSet")) continue;
        requireValue(
          (pod.kind === undefined || pod.kind === "Pod") &&
            (pod.apiVersion === undefined || pod.apiVersion === "v1") &&
            pod.metadata?.namespace === correlation.namespace,
          "ownership-mismatch",
        );
        if (!["Succeeded", "Failed"].includes(pod.status?.phase ?? ""))
          candidates.push({ replicaSet, pod });
      }
    }
    if (candidates.length > 1) throw new ObservationUnavailable("evidence-incomplete", "ambiguous");
    requireValue(candidates.length === 1);
    const candidate = candidates[0]!;
    return { ...root, replicaSet: candidate.replicaSet, pod: podIdentity(candidate.pod) };
  }

  async discover(value: ExactCreateEffectV1, call: RuntimeReadCallV1): Promise<DiscoveryResultV1> {
    const input = parseRuntimeEffectsV1("exactCreate", value);
    try {
      return await this.bounded(call, 10_000, async (call) => {
        const authorization = await this.authorize("discover", input, call);
        requireValue(this.dependencies, "authority-unavailable");
        const correlation = await this.correlation(input, call);
        const before = await this.root(correlation.record, call);
        await correlation.recheck();
        requireValue(
          same(before, await this.root(correlation.record, call)),
          "evidence-incomplete",
        );
        await this.authorize("discover", input, call, authorization);
        this.fresh(correlation.record.evidence);
        return parseRuntimeEffectsResponseV1("discover", input, {
          schemaVersion: 1,
          status: "exact",
          input,
          object: correlation.record.object,
          correlationEvidence: correlation.record.evidence,
        });
      });
    } catch (error) {
      const unavailable = this.failure(error, call);
      return parseRuntimeEffectsResponseV1("discover", input, {
        schemaVersion: 1,
        status: unavailable.status,
        input,
        reasonCode: unavailable.reasonCode,
      });
    }
  }

  async observe(
    value: RuntimeObservationInputV1,
    call: RuntimeReadCallV1,
  ): Promise<RuntimeObservationResultV1> {
    const input = parseRuntimeEffectsV1("observationInput", value);
    try {
      return await this.bounded(call, 10_000, async (call) => {
        const authorization = await this.authorize("observe", input, call);
        requireValue(this.dependencies, "authority-unavailable");
        requireValue(input.kind === "preallocated-candidate", "capability-unsupported");
        requireValue(
          input.target.component !== "harness" || this.isolationProfile === "gvisor-systrap",
          "capability-unsupported",
        );
        const dependencies = this.dependencies!;
        const correlation = await this.correlation(input.createEffect, call);
        const chain = await this.chain(correlation.record, call);
        const query = { input, chain };
        const execution = await this.contribution(
          "execution",
          dependencies.execution,
          query,
          input,
          call,
          (record) => [record.evidence],
        );
        requireValue(same(execution.record.query, query), "precondition-failed");
        const binding = execution.record.binding;
        requireValue(
          binding.clusterRef === dependencies.clusterRef &&
            binding.kubernetesNamespaceUid === chain.namespace.uid &&
            binding.deploymentUid === chain.deployment.uid &&
            binding.replicaSetUid === chain.replicaSet.uid &&
            binding.podUid === chain.pod.uid,
          "ownership-mismatch",
        );
        if (input.target.component === "harness")
          requireValue(
            binding.provider === "occ/kubernetes-gvisor" &&
              chain.pod.runtimeClassName === "oce-gvisor-systrap",
            "ownership-mismatch",
          );
        else requireValue(binding.provider === "occ/kubernetes-gateway", "ownership-mismatch");
        const profiles = await this.contribution(
          "profiles",
          dependencies.profiles,
          query,
          input,
          call,
          (record) => [
            record.evidence,
            record.profile.delivered.evidence,
            record.profile.effective.evidence,
          ],
        );
        requireValue(same(profiles.record.query, query), "precondition-failed");
        const summaryQuery = {
          ...query,
          correlation: recordRef(correlation.record),
          execution: recordRef(execution.record),
          profiles: recordRef(profiles.record),
        };
        const summary = await this.contribution(
          "observation",
          dependencies.observation,
          summaryQuery,
          input,
          call,
          (record) => [record.evidence, record.ownerChainEvidence],
        );
        requireValue(same(summary.record.query, summaryQuery), "precondition-failed");
        requireValue(
          same(chain, await this.chain(correlation.record, call)),
          "evidence-incomplete",
        );
        for (const contribution of [correlation, execution, profiles, summary])
          await contribution.recheck();
        await this.authorize("observe", input, call, authorization);
        for (const evidence of [
          correlation.record.evidence,
          execution.record.evidence,
          profiles.record.evidence,
          profiles.record.profile.delivered.evidence,
          profiles.record.profile.effective.evidence,
          summary.record.evidence,
          summary.record.ownerChainEvidence,
        ])
          this.fresh(evidence);
        return parseRuntimeEffectsResponseV1("observe", input, {
          schemaVersion: 1,
          status: "complete",
          input,
          object: correlation.record.object,
          binding,
          observation: summary.record.evidence,
          ownerChainEvidence: summary.record.ownerChainEvidence,
          executionCorrespondenceEvidence: execution.record.evidence,
          profile: profiles.record.profile,
          identityEvidence: null,
          eligibility: "observation-only",
        });
      });
    } catch (error) {
      const unavailable = this.failure(error, call);
      return parseRuntimeEffectsResponseV1("observe", input, {
        schemaVersion: 1,
        status: unavailable.status === "conflict" ? "incomplete" : unavailable.status,
        input,
        reasonCode: unavailable.reasonCode,
      });
    }
  }

  private failure(error: unknown, call: RuntimeReadCallV1): ObservationUnavailable {
    if (call?.signal?.aborted) return new ObservationUnavailable("cancelled", "unknown");
    if (error instanceof ObservationUnavailable) return error;
    return new ObservationUnavailable("unavailable", "unknown");
  }
}

/** Original Compute physical-observation contribution. It is not a Runtime
 * correlation record, native enrollment or fence/provenance qualification. */
export interface KubernetesCreateCorrelationPhysicalReadV1 {
  readonly input: ExactCreateEffectV1;
  readonly namespace: Readonly<ObjectIdentity>;
  readonly deployment: Readonly<ObjectIdentity>;
  /** Observed bytes under the original renderer encoding. These are physical
   * data, not an exclusive-writer proof or qualified Runtime fence evidence. */
  readonly encoding: Readonly<{
    ownerAssignmentRef: string;
    ownerCreateEffectRef: string;
    fenceEpoch: number;
  }>;
}
export interface KubernetesCreateCorrelationPhysicalOperationV1 {
  /** The original native accept lease has already recognized this exact State
   * read before entering its privately captured Compute operation. */
  qualifyRetained(
    retained: RuntimePreparationCreateCorrelationRetainedV1,
  ): Promise<KubernetesCreateCorrelationPhysicalReadV1>;
  prepareCommit(): Promise<void>;
  assertCurrent(): undefined;
  release(): Promise<void>;
}
/** Captured only by the original native constructor from the same selected
 * Driver. begin associates the original operation; it cannot authenticate an
 * arbitrary object or create State/native/fence authority. Native registers its
 * operation/exchange and authenticates the request before invoking begin.
 * Production construction also requires the original protected effect owner's
 * writer-custody/encoding qualification for this call and destination, before
 * provider entry. That original supplier is not implemented by this physical
 * operation, Driver membership, State history or matching annotation values. */
export interface KubernetesCreateCorrelationObservationOwnerV1 {
  begin(
    originalOperation: RuntimeCreateCorrelationOperationV1,
    request: RuntimeCreateCorrelationRequestV1,
    originalSourceCall: RuntimeReadCallV1,
  ): KubernetesCreateCorrelationPhysicalOperationV1;
  close(): Promise<void>;
}

/** Internal physical-read custody. The original native constructor alone captures
 * this owner. None of its outputs authenticates a native operation or State read. */
class CreateCorrelationPhysicalOwner implements KubernetesCreateCorrelationObservationOwnerV1 {
  readonly clusterRef: string;
  readonly selection: ReturnType<DriverSelection["acquireGuardedSelection"]>;
  readonly #originals = new WeakMap<object, CreateCorrelationPhysicalOperation>();
  readonly #operations = new Set<CreateCorrelationPhysicalOperation>();
  readonly #provider: ProviderReads;
  #closed = false;
  #closing: Promise<void> | undefined;

  constructor(
    provider: ProviderReads,
    clusterRef: string,
    selection: ReturnType<DriverSelection["acquireGuardedSelection"]>,
  ) {
    this.clusterRef = clusterRef;
    this.selection = selection;
    this.#provider = Object.freeze({
      clients: provider.clients.bind(provider),
      request: provider.request.bind(provider),
    });
  }
  assertCurrent(): undefined {
    requireValue(!this.#closed, "authority-lost");
    this.selection.assertCurrent();
    requireValue(!this.#closed, "authority-lost");
    return undefined;
  }
  begin(
    originalOperation: RuntimeCreateCorrelationOperationV1,
    request: RuntimeCreateCorrelationRequestV1,
    originalSourceCall: RuntimeReadCallV1,
  ): KubernetesCreateCorrelationPhysicalOperationV1 {
    this.assertCurrent();
    requireValue(
      originalOperation !== null && typeof originalOperation === "object",
      "authority-unavailable",
    );
    requireValue(!this.#originals.has(originalOperation), "precondition-failed");
    const operation = new CreateCorrelationPhysicalOperation(this, this.#provider);
    // Retain this exact private association before getters or external work.
    // Membership here is not recognition of a native operation by Compute.
    this.#originals.set(originalOperation, operation);
    this.#operations.add(operation);
    try {
      operation.capture(request, originalSourceCall);
      this.assertCurrent();
      return operation;
    } catch (error) {
      operation.poison(error);
      void operation.release().catch(() => {});
      throw error;
    }
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    // Publish the exact join before release can invoke abort listeners.
    this.#closing = Promise.resolve().then(async () => {
      let failed = false,
        failure: unknown;
      try {
        // Start every local release before awaiting any hung SDK read. Each
        // operation independently aborts its own wait and retains its late work.
        const releases = [...this.#operations].map((operation) => operation.release());
        for (const result of await Promise.allSettled(releases)) {
          if (result.status === "rejected" && !failed) {
            failed = true;
            failure = result.reason;
          }
        }
      } finally {
        this.selection.release();
      }
      if (failed) throw failure;
    });
    void this.#closing.catch(() => {});
    return this.#closing;
  }
}

class CreateCorrelationPhysicalOperation implements KubernetesCreateCorrelationPhysicalOperationV1 {
  readonly owner: CreateCorrelationPhysicalOwner;
  readonly provider: ProviderReads;
  readonly #pending = new Set<Promise<unknown>>();
  readonly #lifetime = new AbortController();
  readonly #responses: unknown[] = [];
  #request: RuntimeCreateCorrelationRequestV1 | undefined;
  #call: RuntimeReadCallV1 | undefined;
  #signal: AbortSignal | undefined;
  #deadline = 0;
  #began = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #failed = false;
  #failure: unknown;
  #entered = false;
  #released = false;
  #release: Promise<void> | undefined;
  #prepare: Promise<void> | undefined;
  #retained: RuntimePreparationCreateCorrelationRetainedV1 | undefined;
  #snapshot: KubernetesCreateCorrelationPhysicalReadV1 | undefined;
  #clients:
    | Promise<
        Readonly<{
          namespace: CoreV1Api["readNamespace"];
          deployment: AppsV1Api["readNamespacedDeployment"];
        }>
      >
    | undefined;

  constructor(owner: CreateCorrelationPhysicalOwner, provider: ProviderReads) {
    this.owner = owner;
    this.provider = provider;
  }
  poison(error: unknown): void {
    if (!this.#failed) {
      this.#failed = true;
      this.#failure = error;
    }
  }
  capture(request: RuntimeCreateCorrelationRequestV1, call: RuntimeReadCallV1): void {
    // Native has already authenticated this operation/request. These copies are
    // fixed comparison operands; their fields confer no transport membership.
    this.#request = detached(request);
    this.#call = Object.freeze({
      requestRef: call.requestRef,
      recipientRef: call.recipientRef,
      deadline: call.deadline,
      signal: call.signal,
      context: call.context,
    });
    this.#signal = AbortSignal.any([this.#call.signal, this.#lifetime.signal]);
    this.#deadline = Date.parse(this.#call.deadline);
    this.#began = performance.now();
    requireValue(
      Number.isFinite(this.#deadline) && this.#deadline > Date.now(),
      "deadline-exceeded",
    );
    // Capture getters may have synchronously closed the original owner. Refuse
    // before installing a timer that an already-published release would miss.
    this.assertCurrent();
    this.#timer = setTimeout(
      () => {
        this.poison(new ObservationUnavailable("deadline-exceeded", "unknown"));
        this.#lifetime.abort();
      },
      Math.min(10_000, this.#deadline - Date.now()),
    );
    this.assertCurrent();
  }
  assertCurrent(): undefined {
    if (this.#failed) throw this.#failure;
    try {
      requireValue(
        !this.#released && this.#request && this.#call && this.#signal,
        "authority-lost",
      );
      requireValue(!this.#signal.aborted, "cancelled");
      requireValue(
        Date.now() < this.#deadline && performance.now() - this.#began < 10_000,
        "deadline-exceeded",
      );
      this.owner.assertCurrent();
      // The original Driver fence can invoke getters. Keep the final local
      // lifetime check after it, without another callback or provider query.
      if (this.#failed) throw this.#failure;
      requireValue(!this.#released && !this.#signal.aborted, "authority-lost");
      requireValue(
        Date.now() < this.#deadline && performance.now() - this.#began < 10_000,
        "deadline-exceeded",
      );
      return undefined;
    } catch (error) {
      this.poison(error);
      throw error;
    }
  }
  private refused<T>(error: unknown): Promise<T> {
    this.poison(error);
    const result = Promise.reject<T>(error);
    void result.catch(() => {});
    return result;
  }
  private track<T>(work: () => Promise<T>): Promise<T> {
    const promise = Promise.resolve().then(work);
    this.#pending.add(promise);
    void promise.then(
      () => this.#pending.delete(promise),
      (error: unknown) => {
        this.poison(error);
        this.#pending.delete(promise);
      },
    );
    return promise;
  }
  private outward<T>(work: Promise<T>): Promise<T> {
    const signal = this.#signal!;
    const result = new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (accept: boolean, value: T | unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        if (accept) resolve(value as T);
        else reject(value);
      };
      const abort = () => {
        const error = new ObservationUnavailable("cancelled", "unknown");
        this.poison(error);
        finish(false, error);
      };
      signal.addEventListener("abort", abort, { once: true });
      void work.then(
        (value) => finish(true, value),
        (error) => finish(false, error),
      );
      if (signal.aborted) abort();
    });
    void result.catch(() => {});
    return result;
  }
  private async originalRead<T>(read: () => Promise<T>): Promise<T> {
    this.assertCurrent();
    const value = await this.track(async () => {
      this.assertCurrent();
      const response = await withComputeAbortSignal(this.#signal!, () =>
        this.provider.request(read),
      );
      // Retain the actual response even when it arrives after outward abort.
      this.#responses.push(response);
      this.assertCurrent();
      return response;
    });
    this.assertCurrent();
    return value;
  }
  private clients() {
    if (this.#clients) return this.#clients;
    // Capture the original SDK receivers once for this operation. Later client
    // replacement cannot silently rebase its destination during preparation.
    this.#clients = this.track(async () => {
      this.assertCurrent();
      const clients = await this.provider.clients();
      this.assertCurrent();
      const core = clients.core,
        apps = clients.apps;
      const namespace = core.readNamespace.bind(core);
      const deployment = apps.readNamespacedDeployment.bind(apps);
      this.assertCurrent();
      return Object.freeze({ namespace, deployment });
    });
    return this.#clients;
  }
  private async physical(): Promise<KubernetesCreateCorrelationPhysicalReadV1> {
    const request = this.#request!,
      retained = this.#retained!;
    const located = resolveRuntimePreparationCreateReferenceV1(
      request.scope,
      request.locator,
      retained,
    );
    requireValue(
      located.status === "located" && same(located.input, request.input),
      "precondition-failed",
    );
    const response = located.retained.response;
    requireValue(response, "evidence-incomplete");
    const target = located.input.providerTarget;
    requireValue(target.clusterRef === this.owner.clusterRef, "ownership-mismatch");
    const clients = await this.clients();
    this.assertCurrent();
    const namespace = await this.originalRead(() =>
      clients.namespace({ name: response.namespace }),
    );
    requireValue(
      namespace.kind === "Namespace" && namespace.apiVersion === "v1",
      "ownership-mismatch",
    );
    const namespaceIdentity = objectIdentity(namespace.metadata, response.namespace);
    requireValue(namespaceIdentity.uid === target.kubernetesNamespaceUid, "ownership-mismatch");
    const deployment = await this.originalRead(() =>
      clients.deployment({ name: target.name, namespace: response.namespace }),
    );
    requireValue(
      deployment.kind === "Deployment" &&
        deployment.apiVersion === "apps/v1" &&
        deployment.metadata?.namespace === response.namespace,
      "ownership-mismatch",
    );
    const deploymentIdentity = objectIdentity(deployment.metadata, target.name);
    requireValue(
      deploymentIdentity.uid === response.uid &&
        deploymentIdentity.resourceVersion === response.resourceVersion,
      "ownership-mismatch",
    );
    this.assertCurrent();
    const annotations = deployment.metadata?.annotations;
    const assignment = annotations?.[PREPARED_DEPLOYMENT_ANNOTATIONS.assignment];
    const create = annotations?.[PREPARED_DEPLOYMENT_ANNOTATIONS.create];
    const fence = annotations?.[PREPARED_DEPLOYMENT_ANNOTATIONS.fence];
    requireValue(
      assignment === target.ownerAssignmentRef.id && create === target.ownerCreateEffectRef,
      "ownership-mismatch",
    );
    requireValue(typeof fence === "string" && /^[1-9][0-9]*$/.test(fence), "evidence-incomplete");
    const fenceEpoch = Number(fence);
    requireValue(Number.isSafeInteger(fenceEpoch) && fenceEpoch >= 1, "evidence-incomplete");
    this.assertCurrent();
    // Read the actual encoding, never the requested guard or historical
    // predicate. This snapshot has no provenance or qualified writer authority.
    return detached({
      input: located.input,
      namespace: namespaceIdentity,
      deployment: deploymentIdentity,
      encoding: { ownerAssignmentRef: assignment, ownerCreateEffectRef: create, fenceEpoch },
    });
  }
  qualifyRetained(
    retained: RuntimePreparationCreateCorrelationRetainedV1,
  ): Promise<KubernetesCreateCorrelationPhysicalReadV1> {
    if (this.#entered || this.#released) {
      const error = new ObservationUnavailable("precondition-failed");
      return this.refused(error);
    }
    this.#entered = true;
    const work = this.track(async () => {
      this.assertCurrent();
      // Only the native State-qualified continuation supplies this original
      // object. Keeping its identity is correspondence, not a State brand test.
      this.#retained = retained;
      const snapshot = await this.physical();
      this.assertCurrent();
      this.#snapshot = snapshot;
      return snapshot;
    });
    return this.outward(work);
  }
  prepareCommit(): Promise<void> {
    if (this.#released) return this.refused(new ObservationUnavailable("authority-lost"));
    if (this.#prepare) {
      try {
        this.assertCurrent();
      } catch (error) {
        return this.refused(error);
      }
      return this.#prepare;
    }
    const work = this.track(async () => {
      this.assertCurrent();
      requireValue(this.#snapshot, "evidence-incomplete");
      const again = await this.physical();
      requireValue(same(again, this.#snapshot), "ownership-mismatch");
      this.assertCurrent();
    });
    this.#prepare = this.outward(work);
    return this.#prepare;
  }
  release(): Promise<void> {
    if (this.#release) return this.#release;
    this.#released = true;
    this.#release = Promise.resolve().then(async () => {
      if (this.#timer !== undefined) clearTimeout(this.#timer);
      this.#lifetime.abort();
      while (this.#pending.size) await Promise.allSettled([...this.#pending]);
      if (this.#failed) throw this.#failure;
    });
    void this.#release.catch(() => {});
    return this.#release;
  }
}
