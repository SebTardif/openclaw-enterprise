import type { AuditEvent } from "@openclaw-enterprise/contracts/identity/audit";

export interface PlatformAuditReadRepository {
  list(): Promise<readonly Readonly<AuditEvent>[]>;
}

export interface PlatformAuditRepository extends PlatformAuditReadRepository {
  append(event: AuditEvent): Promise<void>;
}

export interface TransactionalAuditWriter {
  append(event: AuditEvent): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface PlatformAuditSink {
  append(event: AuditEvent): Promise<void>;
  beginTransaction?(): TransactionalAuditWriter;
  checkpoint?(): number;
  restore?(checkpoint: number): void;
}
