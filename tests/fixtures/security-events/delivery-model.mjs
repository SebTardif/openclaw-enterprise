import {
  SECURITY_EVENT_POLICY,
  canDeleteExpiredSecurityEvent,
  parseSecurityEventJson,
  serializeSecurityEvent,
} from "../../../packages/contracts/src/security-events.ts";

/**
 * Executable specification only: committed frames are an in-memory simulated
 * disk. This is not a production sink, WAL, filesystem or durability test.
 */
export class SyntheticSecurityEventDelivery {
  constructor({
    disk = new Map(),
    retryState = { attempts: 0 },
    maxEvents = SECURITY_EVENT_POLICY.spoolMaxEvents,
    maxBytes = SECURITY_EVENT_POLICY.spoolMaxBytes,
  } = {}) {
    this.disk = disk;
    this.maxEvents = maxEvents;
    this.maxBytes = maxBytes;
    this.available = true;
    this.exportAvailable = true;
    this.receipts = new Map();
    this.exported = new Map();
    this.retryState = retryState;
    this.diagnostics = [];
  }
  get attempts() {
    return this.retryState.attempts;
  }
  set attempts(value) {
    this.retryState.attempts = value;
  }
  append(input, { fault, operation = "grant" } = {}) {
    const bytes = serializeSecurityEvent(input);
    const event = parseSecurityEventJson(bytes);
    const prior = this.disk.get(event.id);
    if (prior !== undefined && prior !== bytes) return this.failure(operation, "EventConflict");
    if (prior !== undefined) return { committed: true, duplicate: true, owner: "sink" };
    const byteCount = [...this.disk.values()].reduce(
      (total, frame) => total + Buffer.byteLength(frame),
      0,
    );
    if (
      !this.available ||
      fault === "before_commit" ||
      this.disk.size >= this.maxEvents ||
      byteCount + Buffer.byteLength(bytes) > this.maxBytes
    )
      return this.failure(operation, "AuditUnavailable");
    // The only transfer point. A partial frame is never put in committed disk.
    this.disk.set(event.id, bytes);
    if (fault === "after_commit_before_ack") return this.failure(operation, "CommitUnknown");
    return { committed: true, duplicate: false, owner: "sink" };
  }
  failure(operation, code) {
    this.diagnostics.push({ code });
    return {
      committed: false,
      owner: "producer",
      outcome: "unknown",
      authority: operation === "restrict" ? "continue_restriction" : "deny_new_authority",
      requiredEvidence: "missing",
    };
  }
  exportBatch() {
    if (this.attempts >= SECURITY_EVENT_POLICY.exportMaxAttempts)
      return { state: "quarantined", pending: this.pending().length };
    this.attempts++;
    if (!this.exportAvailable) {
      this.diagnostics.push({ code: "ExporterUnavailable" });
      return { state: "retry", pending: this.pending().length };
    }
    for (const [id, bytes] of this.pending().slice(0, SECURITY_EVENT_POLICY.exportBatchMaxEvents)) {
      this.exported.set(id, bytes);
      this.receipts.set(id, true);
    }
    this.attempts = 0;
    return { state: "delivered", pending: this.pending().length };
  }
  pending() {
    return [...this.disk].filter(([id]) => !this.receipts.has(id));
  }
  reopen() {
    return new SyntheticSecurityEventDelivery({
      disk: this.disk,
      retryState: this.retryState,
      maxEvents: this.maxEvents,
      maxBytes: this.maxBytes,
    });
  }
  purgeExpired(access, now) {
    let purged = 0;
    let missing = 0;
    for (const [id, bytes] of this.disk) {
      const event = parseSecurityEventJson(bytes);
      if (!canDeleteExpiredSecurityEvent(event, access, now)) continue;
      if (!this.receipts.has(id)) missing++;
      this.disk.delete(id);
      this.receipts.delete(id);
      this.exported.delete(id);
      purged++;
    }
    if (missing > 0) this.diagnostics.push({ code: "MandatoryEvidenceExpired", count: missing });
    return { purged, missing };
  }
  evidence() {
    return {
      committed: this.disk.size,
      pending: this.pending().length,
      attempts: this.attempts,
      diagnostics: [...this.diagnostics],
    };
  }
}
