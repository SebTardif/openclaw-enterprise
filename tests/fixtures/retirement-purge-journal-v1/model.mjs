// Independent in-memory protocol model for interface vectors ONLY. Boolean
// authority and arrays below model decisions; they are not an owner/provider.
import {
  parsePurgeCallableV1,
  encodePurgeCallableV1,
} from "../../../packages/contracts/src/retirement-purge-journal-v1.ts";
import {
  initialPurgeProgressV1,
  comparePurgeProgressV1,
} from "../../../packages/contracts/src/retirement-purge-manifest-v1.ts";

const clone = (value) => structuredClone(value);
const same = (kind, a, b) => encodePurgeCallableV1(kind, a) === encodePurgeCallableV1(kind, b);
export class AtomicRetirementModel {
  headGeneration = 7;
  activeGeneration = 3;
  stoppedTransition = "55555555-5555-4555-8555-555555555555";
  state = {
    barrier: null,
    record: null,
    lifecycle: null,
    audit: null,
    responsibility: null,
  };
  receipts = new Map();
  acceptedExternalOwners = new Set();
  calls = { publish: 0, observe: 0, read: 0, delete: 0, resume: 0 };
  readAuthorized = true;
  readAvailable = true;
  pendingUnits = 0;
  get originalUnitOpen() {
    return this.pendingUnits > 0;
  }

  async publish(transactionRef, untrusted, options = {}) {
    this.calls.publish++;
    if (options.authorized === false) return { kind: "committed", value: { kind: "denied" } };
    const input = parsePurgeCallableV1("retirementInputObservation", untrusted);
    const b = input.binding;
    if (
      transactionRef !== b.originalTransactionRef ||
      this.state.record ||
      b.expectedLifecycleGeneration !== this.headGeneration ||
      b.expectedStoppedTransitionRef !== this.stoppedTransition
    )
      return { kind: "committed", value: { kind: "conflict" } };
    const expectedHead = this.headGeneration;
    const expectedState = this.state;
    const draft = {
      barrier: null,
      record: null,
      lifecycle: null,
      audit: null,
      responsibility: null,
    };
    this.pendingUnits++;
    try {
      // No public phase operation exposes any partially written member.
      for (const step of ["barrier", "record", "lifecycle", "audit", "responsibility"]) {
        if (step === "barrier")
          draft.barrier = {
            barrierRef: b.barrierRef,
            barrierVersion: b.barrierVersion,
          };
        if (step === "record")
          draft.record = parsePurgeCallableV1("record", {
            schemaVersion: 1,
            binding: b,
            progress: initialPurgeProgressV1(input.manifest),
            auditIntentRef: input.auditIntentRef,
            durableProgressResponsibilityRef: input.durableProgressResponsibilityRef,
          });
        if (step === "lifecycle") draft.lifecycle = b.expectedStoppedTransitionRef;
        if (step === "audit") draft.audit = input.auditIntentRef;
        if (step === "responsibility")
          draft.responsibility = input.durableProgressResponsibilityRef;
        if (options.failAfter === step) {
          // Models a caught mutation failure poisoning the original whole unit.
          try {
            throw new Error("synthetic accepted mutation failure");
          } catch {
            /* caught */
          }
          return { kind: "unavailable" };
        }
      }
      const provisional = { kind: "published", record: draft.record };
      await options.beforeCommit?.(provisional);
      if (this.headGeneration !== expectedHead || this.state !== expectedState)
        return { kind: "committed", value: { kind: "conflict" } };
      this.state = draft;
      if (options.loseAcknowledgment) return { kind: "commit-unknown", transactionRef };
      return parsePurgeCallableV1("publicationCommit", {
        kind: "committed",
        value: provisional,
      });
    } catch {
      return { kind: "unavailable" };
    } finally {
      this.pendingUnits--;
    }
  }

  activate() {
    if (this.state.barrier) return "denied";
    this.headGeneration++;
    this.activeGeneration++;
    return "activated";
  }
  acceptOldGeneration(operation) {
    if (this.state.barrier) return "denied";
    this.acceptedExternalOwners.add(operation);
    return "accepted";
  }
  modelLaterLifecycleHead() {
    this.headGeneration++;
  }
  oldGenerationResume() {
    this.calls.resume++;
    return this.state.barrier ? "denied" : "outside-model";
  }
  // UID mismatch never acts on a successor. This checks only a modeled target;
  // no actual delete call, target authentication or provider proof exists here.
  compareDeleteTarget(deletionOperationRef, actualUid) {
    const entry = this.state.record?.progress.manifest.stores.find(
      (s) => s.deletionOperationRef === deletionOperationRef,
    );
    if (!entry || entry.store.kind !== "kubernetes-volume" || entry.store.claimUid !== actualUid)
      return "conflict";
    return "corresponding-metadata-only";
  }

  async observe(transactionRef, untrusted, options = {}) {
    this.calls.observe++;
    // Authorization intentionally precedes receipt lookup, including duplicates.
    if (options.authorized === false) return { kind: "committed", value: { kind: "denied" } };
    const input = parsePurgeCallableV1("observationInputObservation", untrusted);
    const record = this.state.record;
    if (
      !record ||
      transactionRef !== input.originalTransactionRef ||
      !same("binding", input.binding, record.binding)
    )
      return { kind: "committed", value: { kind: "conflict" } };
    const retained = this.receipts.get(input.observation.observationRef);
    if (retained) {
      const candidate = {
        ...retained,
        originalTransactionRef: input.originalTransactionRef,
        observation: input.observation,
      };
      if (!same("receipt", retained, candidate))
        return { kind: "committed", value: { kind: "conflict" } };
      return parsePurgeCallableV1("observationCommit", {
        kind: "committed",
        value: { kind: "existing", record, receipt: retained },
      });
    }
    const index = record.progress.stores.findIndex(
      (s) => s.entry.deletionOperationRef === input.observation.deletionOperationRef,
    );
    if (index < 0) return { kind: "committed", value: { kind: "conflict" } };
    const progress = clone(record.progress);
    progress.recordVersion++;
    progress.stores[index].state = {
      kind: input.observation.outcome,
      observation: input.observation,
    };
    progress.state = progress.stores.every((s) => s.state.kind === "observed-absent")
      ? "live-objects-absent"
      : "purge-incomplete";
    let comparison;
    try {
      comparison = comparePurgeProgressV1(record.progress, progress, input.expectedRecordVersion);
    } catch {
      return { kind: "committed", value: { kind: "conflict" } };
    }
    if (comparison.kind !== "advance") return { kind: "committed", value: { kind: "conflict" } };
    const next = parsePurgeCallableV1("record", { ...record, progress });
    const receipt = parsePurgeCallableV1("receipt", {
      schemaVersion: 1,
      binding: record.binding,
      originalTransactionRef: transactionRef,
      observation: input.observation,
      recordedAtRecordVersion: progress.recordVersion,
    });
    if (options.failBeforeCommit) return { kind: "unavailable" };
    this.state = { ...this.state, record: next };
    this.receipts.set(input.observation.observationRef, receipt);
    if (options.loseAcknowledgment) return { kind: "commit-unknown", transactionRef };
    return parsePurgeCallableV1("observationCommit", {
      kind: "committed",
      value: { kind: "recorded", record: next, receipt },
    });
  }

  async findRetirementManifest(untrusted) {
    this.calls.read++;
    if (this.originalUnitOpen || !this.readAvailable) return { kind: "unavailable" };
    if (!this.readAuthorized) return { kind: "denied" };
    const query = parsePurgeCallableV1("query", untrusted);
    const record = this.state.record;
    if (!record) return { kind: "not-found" };
    if (
      !same("binding", query.binding, record.binding) ||
      query.auditIntentRef !== record.auditIntentRef ||
      query.durableProgressResponsibilityRef !== record.durableProgressResponsibilityRef
    )
      return { kind: "conflict" };
    let receipt = null;
    if (query.kind === "observation") {
      receipt = this.receipts.get(query.observation.observationRef);
      if (!receipt) return { kind: "not-found" };
      if (
        !same("receipt", receipt, {
          ...receipt,
          originalTransactionRef: query.originalTransactionRef,
          observation: query.observation,
        })
      )
        return { kind: "conflict" };
    }
    return parsePurgeCallableV1("readResult", {
      kind: "found",
      record,
      observationReceipt: receipt,
    });
  }
}
