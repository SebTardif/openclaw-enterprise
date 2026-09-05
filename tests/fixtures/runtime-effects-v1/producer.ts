import {
  parseRuntimeEffectsV1,
  parseRuntimeEffectExchangeV1,
  parseRuntimeEffectsResponseV1,
  type RuntimeEffectsV1,
  type WorkspaceHandoffEvidenceV1,
  type RuntimeFaultSinkV1,
  type RuntimeCreateV1,
  type ExactCreateEffectV1,
  type RuntimeObservationInputV1,
  type ConditionalRouteV1,
  type ExactCleanupV1,
  type ExactEffectLocatorV1,
  type RuntimeFenceRequestV1,
  type ExactHandoffV1,
  type ExactStoreBindingV1,
  type ExactRuntimeFaultV1,
  type ExactRuntimeFaultOperationV1,
  type AuthorityCallV1,
  type RuntimeEffectAdmissionV1,
  type RuntimeGateGuardV1,
  type RuntimePreparedChildV1,
  type RuntimeFenceCompletionProposalV1,
} from "@openclaw-enterprise/contracts";

/** Independently compiling producer adapter. These are injected actual accepting
 * ports, not a fixture provider, mutex or replacement OCC journal. In particular
 * validation does not authenticate a caller or make source time/provider facts true.
 */
export class ValidatedRuntimeProducer
  implements RuntimeEffectsV1, WorkspaceHandoffEvidenceV1, RuntimeFaultSinkV1
{
  private readonly effects: RuntimeEffectsV1;
  private readonly writers: WorkspaceHandoffEvidenceV1;
  private readonly faults: RuntimeFaultSinkV1;
  constructor(
    effects: RuntimeEffectsV1,
    writers: WorkspaceHandoffEvidenceV1,
    faults: RuntimeFaultSinkV1,
  ) {
    this.effects = effects;
    this.writers = writers;
    this.faults = faults;
  }
  async create(input: RuntimeCreateV1, call: AuthorityCallV1) {
    const value = parseRuntimeEffectsV1("create", input);
    return parseRuntimeEffectExchangeV1(value, await this.effects.create(value, call));
  }
  async discover(input: ExactCreateEffectV1, call: AuthorityCallV1) {
    const value = parseRuntimeEffectsV1("exactCreate", input);
    return parseRuntimeEffectsResponseV1(
      "discover",
      value,
      await this.effects.discover(value, call),
    );
  }
  async observe(input: RuntimeObservationInputV1, call: AuthorityCallV1) {
    const value = parseRuntimeEffectsV1("observationInput", input);
    return parseRuntimeEffectsResponseV1("observe", value, await this.effects.observe(value, call));
  }
  async setRoute(input: ConditionalRouteV1, call: AuthorityCallV1) {
    const value = parseRuntimeEffectsV1("setRoute", input);
    return parseRuntimeEffectExchangeV1(value, await this.effects.setRoute(value, call));
  }
  async stopRetainingState(input: ExactCleanupV1, call: AuthorityCallV1) {
    const value = parseRuntimeEffectsV1("stopRetainingState", input);
    return parseRuntimeEffectExchangeV1(value, await this.effects.stopRetainingState(value, call));
  }
  async readEffect(input: ExactEffectLocatorV1, call: AuthorityCallV1) {
    const value = parseRuntimeEffectsV1("effectLocator", input);
    return parseRuntimeEffectsResponseV1(
      "readEffect",
      value,
      await this.effects.readEffect(value, call),
    );
  }
  async advanceFence(input: RuntimeFenceRequestV1, call: AuthorityCallV1) {
    const value = parseRuntimeEffectsV1("fenceRequest", input);
    return parseRuntimeEffectsResponseV1(
      "advanceFence",
      value,
      await this.effects.advanceFence(value, call),
    );
  }
  async readFence(input: RuntimeFenceRequestV1, call: AuthorityCallV1) {
    const value = parseRuntimeEffectsV1("fenceRequest", input);
    return parseRuntimeEffectsResponseV1(
      "readFence",
      value,
      await this.effects.readFence(value, call),
    );
  }
  async observePriorWriters(input: ExactHandoffV1, call: AuthorityCallV1) {
    const value = parseRuntimeEffectsV1("exactHandoff", input);
    return parseRuntimeEffectsResponseV1(
      "observePriorWriters",
      value,
      await this.writers.observePriorWriters(value, call),
    );
  }
  async verifyStoreBinding(input: ExactStoreBindingV1, call: AuthorityCallV1) {
    const value = parseRuntimeEffectsV1("exactStore", input);
    return parseRuntimeEffectsResponseV1(
      "verifyStoreBinding",
      value,
      await this.writers.verifyStoreBinding(value, call),
    );
  }
  async recordFaultAndRequestStop(input: ExactRuntimeFaultV1, call: AuthorityCallV1) {
    const value = parseRuntimeEffectsV1("fault", input);
    return parseRuntimeEffectsResponseV1(
      "recordFaultAndRequestStop",
      value,
      await this.faults.recordFaultAndRequestStop(value, call),
    );
  }
  async readRequest(input: ExactRuntimeFaultOperationV1, call: AuthorityCallV1) {
    const value = parseRuntimeEffectsV1("faultOperation", input);
    return parseRuntimeEffectsResponseV1(
      "readRequest",
      value,
      await this.faults.readRequest(value, call),
    );
  }
}

/** Separate canonical-admission producer example. Its implementation remains the
 * existing protected OCC writer; no in-memory admission or fabricated receipt. */
export class ValidatedAdmissionProducer implements RuntimeEffectAdmissionV1 {
  private readonly admission: RuntimeEffectAdmissionV1;
  constructor(admission: RuntimeEffectAdmissionV1) {
    this.admission = admission;
  }
  async readGate(input: RuntimeGateGuardV1, call: AuthorityCallV1) {
    return parseRuntimeEffectsV1(
      "gateState",
      await this.admission.readGate(parseRuntimeEffectsV1("gateGuard", input), call),
    );
  }
  async admitChild(input: RuntimePreparedChildV1, call: AuthorityCallV1) {
    const value = parseRuntimeEffectsV1("preparedChild", input);
    return parseRuntimeEffectsResponseV1(
      "admitChild",
      value,
      await this.admission.admitChild(value, call),
    );
  }
  async completeFence(input: RuntimeFenceCompletionProposalV1, call: AuthorityCallV1) {
    const value = parseRuntimeEffectsV1("fenceCompletion", input);
    return parseRuntimeEffectsResponseV1(
      "advanceFence",
      value.request,
      await this.admission.completeFence(value, call),
    );
  }
  async recordFaultAndRequestStop(input: ExactRuntimeFaultV1, call: AuthorityCallV1) {
    const value = parseRuntimeEffectsV1("fault", input);
    return parseRuntimeEffectsResponseV1(
      "recordFaultAndRequestStop",
      value,
      await this.admission.recordFaultAndRequestStop(value, call),
    );
  }
  async readRequest(input: ExactRuntimeFaultOperationV1, call: AuthorityCallV1) {
    const value = parseRuntimeEffectsV1("faultOperation", input);
    return parseRuntimeEffectsResponseV1(
      "readRequest",
      value,
      await this.admission.readRequest(value, call),
    );
  }
}
