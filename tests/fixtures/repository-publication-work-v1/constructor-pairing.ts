import {
  RepositoryPublicationWorkOwnerV1,
  type PublicationWorkSourcesV1,
  type OriginalPublicationWorkV1,
  type PublicationWorkPolicyV1,
  type PublicationWorkStateSourceV1,
  type PublicationWorkClockV1,
} from "../../../packages/occ/src/lifecycle/repository-publication-work-v1.ts";
import type {
  PublicationCallV1,
  PublicationRequestV1,
  PublicationWorkSourceV1,
  PublicationClockV1,
} from "../../../packages/occ/src/repository-publication-v1/contract.ts";

// Compile-only constructor correspondence; declarations do not mint originals.
declare const actorBrand: unique symbol;
declare const invocationBrand: unique symbol;
declare const admissionBrand: unique symbol;
declare const useBrand: unique symbol;
type Actor = { readonly [actorBrand]: true };
type Invocation = { readonly [invocationBrand]: true };
type Admission = { readonly [admissionBrand]: true };
type Use = { readonly [useBrand]: true };
type Bindings = { actor: Actor; invocation: Invocation; admission: Admission; use: Use };
declare const sources: PublicationWorkSourcesV1<Bindings>;
declare const actor: Actor;
declare const invocation: Invocation;
declare const originalUse: Use;
declare const request: PublicationRequestV1;
declare const call: PublicationCallV1;
declare const work: OriginalPublicationWorkV1;
declare const state: PublicationWorkStateSourceV1<Invocation, Admission, Use>;

export function pairing() {
  const owner = new RepositoryPublicationWorkOwnerV1<Bindings>(sources, { maximumActive: 2 });
  const pending: Promise<OriginalPublicationWorkV1 | undefined> = owner.acquire(
    actor,
    request,
    call,
  );
  const current: undefined = owner.assertCurrent(work, call);
  const admission: Admission = owner.recognize(work, call);
  const use = state.acquireUse(admission, invocation, request, call);
  void pending;
  void current;
  void use;
  // @ts-expect-error a lookalike actor has no original private membership type
  owner.acquire({}, request, call);
  // @ts-expect-error a Work handle is not its State admission
  const falseAdmission: Admission = work;
  // @ts-expect-error unrelated State use is not a known admission
  const falseUse: Admission = originalUse;
  void falseAdmission;
  void falseUse;
}
export function missingDefaults(s: PublicationWorkSourcesV1) {
  const owner = new RepositoryPublicationWorkOwnerV1(s, { maximumActive: 2 });
  // @ts-expect-error default-never cannot manufacture a genuine actor
  owner.acquire(actor, request, call);
}
// This selects the exact Work source methods without supplying unrelated
// publication candidate/approval/dispatcher private types.
type PublisherBindings = {
  actor: Actor;
  work: OriginalPublicationWorkV1;
  publisher: never;
  candidate: never;
  approval: never;
  effect: never;
  use: never;
  prepared: never;
  outcome: never;
};
export function consumer(owner: RepositoryPublicationWorkOwnerV1<Bindings>) {
  const source: PublicationWorkSourceV1<PublisherBindings> = owner;
  return source;
}
declare const policy: PublicationWorkPolicyV1;
// @ts-expect-error metadata read is a different authority arm
const metadataPolicy: PublicationWorkPolicyV1 = { ...policy, permission: "metadata:read" };
// @ts-expect-error Git read cannot be publication
const readOperation: PublicationWorkPolicyV1 = { ...policy, operation: "work.repository.use" };
void metadataPolicy;
void readOperation;

// Qualified time is mandatory at the actual Work constructor boundary. These
// are type correspondence checks, not proof of an original protected producer.
declare const unqualifiedClock: PublicationClockV1;
export function clockPairing() {
  // @ts-expect-error old wall/uncertainty-only clocks omit mandatory qualification
  new RepositoryPublicationWorkOwnerV1<Bindings>(
    { ...sources, clock: unqualifiedClock },
    { maximumActive: 2 },
  );
}
type QualifiedClockSample = ReturnType<PublicationWorkClockV1["read"]>;
// @ts-expect-error a reading without its maximum wall-advance rate is incomplete
const missingRate: QualifiedClockSample = { wallMs: 1, uncertaintyMs: 0, validForMonotonicMs: 1 };
// @ts-expect-error a reading without its original monotonic validity is incomplete
const missingValidity: QualifiedClockSample = { wallMs: 1, uncertaintyMs: 0, maxWallAdvancePpm: 1 };
// @ts-expect-error the rate operand is a checked number, not a string
const wrongRate: QualifiedClockSample = {
  wallMs: 1,
  uncertaintyMs: 0,
  maxWallAdvancePpm: "1",
  validForMonotonicMs: 1,
};
// @ts-expect-error validity is in numeric milliseconds, not a bigint nanosecond operand
const wrongValidity: QualifiedClockSample = {
  wallMs: 1,
  uncertaintyMs: 0,
  maxWallAdvancePpm: 1,
  validForMonotonicMs: 1n,
};
void missingRate;
void missingValidity;
void wrongRate;
void wrongValidity;
