import { createPrivateKey, X509Certificate } from "node:crypto";
import { lstat } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";

type RecordValue = Readonly<Record<string, unknown>>;
export type SpiffeWorkloadIdentityErrorCode =
  | "INVALID_CONFIGURATION"
  | "UNAVAILABLE"
  | "INVALID_RESPONSE"
  | "IDENTITY_MISMATCH"
  | "EXPIRED"
  | "ABORTED"
  | "TIMEOUT"
  | "CLOSED"
  | "BUSY";

/** Messages and codes are safe to report; raw RPC errors and abort reasons are discarded. */
export class SpiffeWorkloadIdentityError extends Error {
  readonly code: SpiffeWorkloadIdentityErrorCode;

  constructor(code: SpiffeWorkloadIdentityErrorCode) {
    super(`SPIFFE Workload API operation failed (${code}).`);
    this.name = "SpiffeWorkloadIdentityError";
    this.code = code;
  }
}

export interface SpiffeWorkloadIdentityOptions {
  /** Trusted, operator-provisioned local SPIRE Agent socket. No environment fallback. */
  readonly socketPath: string;
  readonly expectedSpiffeId: string;
  /** Initial stream response and each complete JWT operation; 1000..60000 ms. */
  readonly timeoutMs?: number;
}

export interface SpiffeX509IdentityMetadata {
  readonly spiffeId: string;
  readonly expiresAt: string;
  readonly certificateCount: number;
  readonly bundleCertificateCount: number;
}

export interface SpiffeX509Identity {
  readonly spiffeId: string;
  readonly expiresAt: string;
  /** Leaf first, individual ASN.1 DER certificates. */
  readonly certificateChain: readonly Buffer[];
  /** Unencrypted PKCS#8 DER. Secret; never serialize or log this snapshot. */
  readonly privateKey: Buffer;
  readonly bundle: readonly Buffer[];
  readonly crls: readonly Buffer[];
  readonly federatedBundles: Readonly<Record<string, readonly Buffer[]>>;
}

export interface SpiffeJwtIdentity {
  readonly spiffeId: string;
  readonly expiresAt: string;
}

export interface SpiffeWorkloadIdentitySource {
  /** The signal controls the source lifetime, including after start resolves. */
  start(options?: { readonly signal?: AbortSignal }): Promise<void>;
  getX509IdentityMetadata(): SpiffeX509IdentityMetadata;
  /** Returns independent copies; replacement/close cannot revoke copies already handed out. */
  getX509Identity(): SpiffeX509Identity;
  fetchJwtSvid(request: {
    readonly audience: string;
    readonly signal?: AbortSignal;
  }): Promise<SpiffeJwtIdentity & { readonly token: string }>;
  validateJwtSvid(request: {
    readonly token: string;
    readonly audience: string;
    readonly expectedSpiffeId: string;
    readonly signal?: AbortSignal;
  }): Promise<SpiffeJwtIdentity>;
  close(): void;
}

interface WorkloadClient extends grpc.Client {
  FetchX509SVID(
    request: RecordValue,
    metadata: grpc.Metadata,
  ): grpc.ClientReadableStream<RecordValue>;
  FetchJWTSVID(
    request: RecordValue,
    metadata: grpc.Metadata,
    options: { deadline: Date },
    callback: (error: grpc.ServiceError | null, response?: RecordValue) => void,
  ): grpc.ClientUnaryCall;
  ValidateJWTSVID(
    request: RecordValue,
    metadata: grpc.Metadata,
    options: { deadline: Date },
    callback: (error: grpc.ServiceError | null, response?: RecordValue) => void,
  ): grpc.ClientUnaryCall;
}

const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 64;
const MAX_TOKEN_BYTES = 64 * 1024;
const MAX_CONCURRENT_REQUESTS = 16;
const MAX_TIMER_MS = 2 ** 31 - 1;

function failure(code: SpiffeWorkloadIdentityErrorCode): SpiffeWorkloadIdentityError {
  return new SpiffeWorkloadIdentityError(code);
}

function record(value: unknown): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw failure("INVALID_RESPONSE");
  }
  return value as RecordValue;
}

function entries(value: unknown, optional = false): readonly unknown[] {
  if (optional && value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ENTRIES) throw failure("INVALID_RESPONSE");
  return value;
}

function validSpiffeId(value: unknown): value is string {
  // This component accepts workload IDs with a non-root path, not trust-domain IDs.
  return (
    typeof value === "string" &&
    value.length <= 2048 &&
    /^spiffe:\/\/[a-z0-9._-]+(?:\/[a-zA-Z0-9._~-]+)+$/.test(value) &&
    !value.split("/").some((part) => part === "." || part === "..")
  );
}

function validAudience(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 2048 &&
    !/[\x00-\x20\x7f]/.test(value)
  );
}

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw failure("ABORTED");
}

function bytes(value: unknown): Buffer {
  if (!Buffer.isBuffer(value) || value.length === 0 || value.length > MAX_MESSAGE_BYTES) {
    throw failure("INVALID_RESPONSE");
  }
  return value;
}

/** Split concatenated DER objects, then let Node/OpenSSL parse the certificates. */
function certificates(value: unknown): readonly Buffer[] {
  const data = bytes(value);
  const result: Buffer[] = [];
  let offset = 0;
  while (offset < data.length) {
    if (result.length >= MAX_ENTRIES || data[offset] !== 0x30) throw failure("INVALID_RESPONSE");
    const first = data[offset + 1];
    if (first === undefined) throw failure("INVALID_RESPONSE");
    let header = 2;
    let length = first;
    if (first >= 0x80) {
      const count = first & 0x7f;
      if (count === 0 || count > 4 || offset + 2 + count > data.length || data[offset + 2] === 0) {
        throw failure("INVALID_RESPONSE");
      }
      header += count;
      length = data.readUIntBE(offset + 2, count);
      if (length < 128) throw failure("INVALID_RESPONSE");
    }
    const end = offset + header + length;
    if (length === 0 || end > data.length) throw failure("INVALID_RESPONSE");
    const certificate = Buffer.from(data.subarray(offset, end));
    new X509Certificate(certificate);
    result.push(certificate);
    offset = end;
  }
  return result;
}

function selectIdentity(response: RecordValue, expectedSpiffeId: string): RecordValue {
  const selected = entries(response.svids)
    .map(record)
    .filter((svid) => svid.spiffe_id === expectedSpiffeId);
  if (selected.length !== 1) throw failure("IDENTITY_MISMATCH");
  return selected[0]!;
}

function parseX509(response: RecordValue, expectedSpiffeId: string): SpiffeX509Identity {
  const selected = selectIdentity(response, expectedSpiffeId);
  const certificateChain = certificates(selected.x509_svid);
  const bundle = certificates(selected.bundle);
  const leaf = new X509Certificate(certificateChain[0]!);
  // Support SPIRE's sole-URI leaf profile. Reject other rendered shapes without
  // parsing or unescaping potentially ambiguous SAN strings.
  if (leaf.subjectAltName !== `URI:${expectedSpiffeId}`) throw failure("IDENTITY_MISMATCH");
  const privateKey = bytes(selected.x509_svid_key);
  const key = createPrivateKey({ key: privateKey, type: "pkcs8", format: "der" });
  if (!leaf.checkPrivateKey(key)) throw failure("INVALID_RESPONSE");
  // These are local credential sanity checks, not certificate-path or peer verification.
  const now = Date.now();
  let expires = Infinity;
  for (const encoded of certificateChain) {
    const certificate = new X509Certificate(encoded);
    const validFrom = Date.parse(certificate.validFrom);
    const validTo = Date.parse(certificate.validTo);
    if (!Number.isFinite(validFrom) || !Number.isFinite(validTo) || validFrom > now) {
      throw failure("INVALID_RESPONSE");
    }
    if (validTo <= now) throw failure("EXPIRED");
    expires = Math.min(expires, validTo);
  }
  const crls = entries(response.crl, true).map((value) => Buffer.from(bytes(value)));
  const federated = record(response.federated_bundles ?? {});
  if (Object.keys(federated).length > MAX_ENTRIES) throw failure("INVALID_RESPONSE");
  const federatedBundles = Object.fromEntries(
    Object.entries(federated).map(([id, value]) => {
      if (!/^spiffe:\/\/[a-z0-9._-]+$/.test(id) || id.length > 2048)
        throw failure("INVALID_RESPONSE");
      return [id, certificates(value)];
    }),
  );
  return {
    spiffeId: expectedSpiffeId,
    expiresAt: new Date(expires).toISOString(),
    certificateChain,
    privateKey: Buffer.from(privateKey),
    bundle,
    crls,
    federatedBundles,
  };
}

function validatedJwt(
  response: RecordValue,
  expectedSpiffeId: string,
  audience: string,
): SpiffeJwtIdentity {
  if (response.spiffe_id !== expectedSpiffeId) throw failure("IDENTITY_MISMATCH");
  const claims = record(record(response.claims).fields);
  if (record(claims.sub).stringValue !== expectedSpiffeId) throw failure("IDENTITY_MISMATCH");
  const audiences = entries(record(record(claims.aud).listValue).values);
  if (!audiences.some((value) => record(value).stringValue === audience))
    throw failure("IDENTITY_MISMATCH");
  const exp = record(claims.exp).numberValue;
  if (typeof exp !== "number" || !Number.isSafeInteger(exp) || exp <= 0 || exp * 1000 > 8.64e15) {
    throw failure("INVALID_RESPONSE");
  }
  if (exp * 1000 <= Date.now()) throw failure("EXPIRED");
  return Object.freeze({
    spiffeId: expectedSpiffeId,
    expiresAt: new Date(exp * 1000).toISOString(),
  });
}

function token(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > MAX_TOKEN_BYTES ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw failure("INVALID_RESPONSE");
  }
  return value;
}

function metadata(): grpc.Metadata {
  const result = new grpc.Metadata();
  result.set("workload.spiffe.io", "true");
  return result;
}

class LocalSpiffeWorkloadIdentitySource implements SpiffeWorkloadIdentitySource {
  private readonly options: SpiffeWorkloadIdentityOptions;
  private readonly timeoutMs: number;
  private client: WorkloadClient | undefined;
  private stream: grpc.ClientReadableStream<RecordValue> | undefined;
  private snapshot: SpiffeX509Identity | undefined;
  private startPromise: Promise<void> | undefined;
  private finishStart: ((error?: SpiffeWorkloadIdentityError) => void) | undefined;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private removeAbort: (() => void) | undefined;
  private terminalError: SpiffeWorkloadIdentityError | undefined;
  private readonly calls = new Set<grpc.ClientUnaryCall>();

  constructor(options: SpiffeWorkloadIdentityOptions) {
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (
      typeof options.socketPath !== "string" ||
      !isAbsolute(options.socketPath) ||
      normalize(options.socketPath) !== options.socketPath ||
      Buffer.byteLength(options.socketPath) > 103 ||
      /[\x00-\x20\x7f?#]/.test(options.socketPath) ||
      !validSpiffeId(options.expectedSpiffeId) ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1000 ||
      timeoutMs > 60_000
    )
      throw failure("INVALID_CONFIGURATION");
    this.options = Object.freeze({ ...options });
    this.timeoutMs = timeoutMs;
  }

  start(options: { readonly signal?: AbortSignal } = {}): Promise<void> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (options.signal?.aborted) return Promise.reject(failure("ABORTED"));
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.invalidate(failure("TIMEOUT")), this.timeoutMs);
      this.finishStart = (error) => {
        clearTimeout(timer);
        this.finishStart = undefined;
        if (error) reject(error);
        else resolve();
      };
      const abort = () => this.invalidate(failure("ABORTED"));
      options.signal?.addEventListener("abort", abort, { once: true });
      this.removeAbort = () => options.signal?.removeEventListener("abort", abort);
      void this.openStream().catch(() => this.invalidate(failure("UNAVAILABLE")));
    });
    return this.startPromise;
  }

  getX509IdentityMetadata(): SpiffeX509IdentityMetadata {
    const snapshot = this.current();
    return Object.freeze({
      spiffeId: snapshot.spiffeId,
      expiresAt: snapshot.expiresAt,
      certificateCount: snapshot.certificateChain.length,
      bundleCertificateCount: snapshot.bundle.length,
    });
  }

  getX509Identity(): SpiffeX509Identity {
    const snapshot = this.current();
    return Object.freeze({
      ...snapshot,
      certificateChain: Object.freeze(snapshot.certificateChain.map((value) => Buffer.from(value))),
      privateKey: Buffer.from(snapshot.privateKey),
      bundle: Object.freeze(snapshot.bundle.map((value) => Buffer.from(value))),
      crls: Object.freeze(snapshot.crls.map((value) => Buffer.from(value))),
      federatedBundles: Object.freeze(
        Object.fromEntries(
          Object.entries(snapshot.federatedBundles).map(([id, values]) => [
            id,
            Object.freeze(values.map((value) => Buffer.from(value))),
          ]),
        ),
      ),
    });
  }

  async fetchJwtSvid(request: {
    readonly audience: string;
    readonly signal?: AbortSignal;
  }): Promise<SpiffeJwtIdentity & { readonly token: string }> {
    if (!validAudience(request.audience)) throw failure("INVALID_CONFIGURATION");
    const deadline = new Date(Date.now() + this.timeoutMs);
    const response = await this.unary(
      "FetchJWTSVID",
      {
        audience: [request.audience],
        spiffe_id: this.options.expectedSpiffeId,
      },
      deadline,
      request.signal,
    );
    const selected = selectIdentity(response, this.options.expectedSpiffeId);
    const issued = token(selected.svid);
    // The trusted local API verifies signature and claims, including on newly fetched tokens.
    const identity = await this.validate(
      issued,
      request.audience,
      this.options.expectedSpiffeId,
      deadline,
      request.signal,
    );
    return Object.freeze({ ...identity, token: issued });
  }

  async validateJwtSvid(request: {
    readonly token: string;
    readonly audience: string;
    readonly expectedSpiffeId: string;
    readonly signal?: AbortSignal;
  }): Promise<SpiffeJwtIdentity> {
    if (!validAudience(request.audience) || !validSpiffeId(request.expectedSpiffeId))
      throw failure("INVALID_CONFIGURATION");
    return this.validate(
      token(request.token),
      request.audience,
      request.expectedSpiffeId,
      new Date(Date.now() + this.timeoutMs),
      request.signal,
    );
  }

  close(): void {
    this.invalidate(failure("CLOSED"));
  }

  private current(): SpiffeX509Identity {
    if (this.terminalError) throw this.terminalError;
    if (!this.snapshot) throw failure("UNAVAILABLE");
    if (Date.parse(this.snapshot.expiresAt) <= Date.now()) {
      this.invalidate(failure("EXPIRED"));
      throw this.terminalError!;
    }
    return this.snapshot;
  }

  private async openStream(): Promise<void> {
    if (!(await lstat(this.options.socketPath)).isSocket()) throw failure("UNAVAILABLE");
    if (this.terminalError) return;
    const definition = loadSync(fileURLToPath(new URL("./proto/workload.proto", import.meta.url)), {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: false,
      oneofs: true,
    });
    const loaded = grpc.loadPackageDefinition(definition) as unknown as {
      SpiffeWorkloadAPI: grpc.ServiceClientConstructor;
    };
    this.client = new loaded.SpiffeWorkloadAPI(
      `unix:${this.options.socketPath}`,
      grpc.credentials.createInsecure(),
      {
        "grpc.max_receive_message_length": MAX_MESSAGE_BYTES,
        "grpc.max_send_message_length": MAX_TOKEN_BYTES + 8192,
        "grpc.enable_retries": 0,
      },
    ) as unknown as WorkloadClient;
    this.stream = this.client.FetchX509SVID({}, metadata());
    this.stream.on("data", (value: unknown) => {
      if (this.terminalError) return;
      try {
        const next = parseX509(record(value), this.options.expectedSpiffeId);
        this.snapshot?.privateKey.fill(0);
        this.snapshot = next;
        this.armExpiry();
        this.finishStart?.();
      } catch (error) {
        this.invalidate(
          error instanceof SpiffeWorkloadIdentityError ? error : failure("INVALID_RESPONSE"),
        );
      }
    });
    this.stream.on("error", () => this.invalidate(failure("UNAVAILABLE")));
    this.stream.on("end", () => this.invalidate(failure("UNAVAILABLE")));
    this.stream.on("close", () => this.invalidate(failure("UNAVAILABLE")));
  }

  private armExpiry(): void {
    clearTimeout(this.expiryTimer);
    if (!this.snapshot || this.terminalError) return;
    const remaining = Date.parse(this.snapshot.expiresAt) - Date.now();
    if (remaining <= 0) {
      this.invalidate(failure("EXPIRED"));
      return;
    }
    this.expiryTimer = setTimeout(() => this.armExpiry(), Math.min(remaining, MAX_TIMER_MS));
    this.expiryTimer.unref();
  }

  private invalidate(error: SpiffeWorkloadIdentityError): void {
    if (this.terminalError) return;
    this.terminalError = error;
    this.snapshot?.privateKey.fill(0);
    this.snapshot = undefined;
    clearTimeout(this.expiryTimer);
    this.removeAbort?.();
    this.removeAbort = undefined;
    this.finishStart?.(error);
    this.stream?.cancel();
    this.stream = undefined;
    for (const call of this.calls) call.cancel();
    this.client?.close();
    this.client = undefined;
  }

  private async validate(
    value: string,
    audience: string,
    expectedSpiffeId: string,
    deadline: Date,
    signal: AbortSignal | undefined,
  ): Promise<SpiffeJwtIdentity> {
    const response = await this.unary(
      "ValidateJWTSVID",
      { audience, svid: value },
      deadline,
      signal,
    );
    return validatedJwt(response, expectedSpiffeId, audience);
  }

  private unary(
    method: "FetchJWTSVID" | "ValidateJWTSVID",
    request: RecordValue,
    deadline: Date,
    signal: AbortSignal | undefined,
  ): Promise<RecordValue> {
    checkAbort(signal);
    this.current();
    if (this.calls.size >= MAX_CONCURRENT_REQUESTS) throw failure("BUSY");
    const client = this.client!;
    return new Promise<RecordValue>((resolve, reject) => {
      let call: grpc.ClientUnaryCall | undefined;
      const abort = () => call?.cancel();
      signal?.addEventListener("abort", abort, { once: true });
      try {
        call = client[method](request, metadata(), { deadline }, (error, response) => {
          signal?.removeEventListener("abort", abort);
          if (call) this.calls.delete(call);
          try {
            checkAbort(signal);
            this.current();
            if (error)
              throw failure(
                error.code === grpc.status.DEADLINE_EXCEEDED ? "TIMEOUT" : "UNAVAILABLE",
              );
            resolve(record(response));
          } catch (error) {
            reject(
              error instanceof SpiffeWorkloadIdentityError ? error : failure("INVALID_RESPONSE"),
            );
          }
        });
        this.calls.add(call);
      } catch {
        signal?.removeEventListener("abort", abort);
        reject(failure("UNAVAILABLE"));
      }
    });
  }
}

/** Verification component only; construction does not activate any OCC runtime authority. */
export function createSpiffeWorkloadIdentitySource(
  options: SpiffeWorkloadIdentityOptions,
): SpiffeWorkloadIdentitySource {
  return new LocalSpiffeWorkloadIdentitySource(options);
}
