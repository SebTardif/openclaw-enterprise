import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { Client, ClientUnaryCall, Metadata, ServiceClientConstructor } from "@grpc/grpc-js";
import type { MessageTypeDefinition, PackageDefinition } from "@grpc/proto-loader";

type RecordValue = Readonly<Record<string, unknown>>;

export interface OpenShellGatewayClientOptions {
  readonly endpoint: string;
  readonly auth?:
    | { readonly mode: "unauthenticated" }
    | { readonly mode: "bearerTokenFile"; readonly path: string };
  readonly requestTimeoutMs?: number;
  readonly rootCertificatePath?: string;
  readonly clientCertificatePath?: string;
  readonly clientPrivateKeyPath?: string;
}

export interface OpenShellSandboxCreateRequest {
  readonly name: string;
  readonly workspace: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly annotations: Readonly<Record<string, string>>;
  readonly spec: RecordValue;
}

export interface OpenShellSandboxDeleteRequest {
  readonly name: string;
  readonly workspace: string;
}

export interface OpenShellSandboxResponse {
  readonly name: string;
  readonly id: string;
  readonly workspace: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly annotations: Readonly<Record<string, string>>;
  readonly spec: RecordValue;
  readonly deletionTimestampMs: string;
  readonly phase?: string | number;
}

export interface OpenShellGatewayClient {
  health(signal: AbortSignal): Promise<void>;
  createSandbox(
    request: OpenShellSandboxCreateRequest,
    signal: AbortSignal,
  ): Promise<OpenShellSandboxResponse>;
  getSandbox(
    request: OpenShellSandboxDeleteRequest,
    signal: AbortSignal,
  ): Promise<OpenShellSandboxResponse>;
  deleteSandbox(request: OpenShellSandboxDeleteRequest, signal: AbortSignal): Promise<void>;
  close(): void;
}

interface OpenShellGrpcClient extends Client {
  Health(
    request: RecordValue,
    metadata: Metadata,
    options: { deadline: Date },
    callback: (error: Error | null, response?: RecordValue) => void,
  ): ClientUnaryCall;
  CreateSandbox(
    request: RecordValue,
    metadata: Metadata,
    options: { deadline: Date },
    callback: (error: Error | null, response?: RecordValue) => void,
  ): ClientUnaryCall;
  DeleteSandbox(
    request: RecordValue,
    metadata: Metadata,
    options: { deadline: Date },
    callback: (error: Error | null, response?: RecordValue) => void,
  ): ClientUnaryCall;
  GetSandbox(
    request: RecordValue,
    metadata: Metadata,
    options: { deadline: Date },
    callback: (error: Error | null, response?: RecordValue) => void,
  ): ClientUnaryCall;
}

class OpenShellGatewayFailure extends Error {
  readonly code: number | undefined;

  constructor(message: string, code?: number) {
    super(message);
    this.code = code;
  }
}

const CLIENT_MODULE = "@grpc/grpc-js";
const LOADER_MODULE = "@grpc/proto-loader";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

function nonempty(value: unknown, description: string): string {
  if (!isNonEmptyString(value)) {
    throw new OpenShellGatewayFailure(`${description} must be a nonempty string.`);
  }
  return value;
}

function deadline(timeoutMs: number): Date {
  return new Date(Date.now() + timeoutMs);
}

function statusCode(error: unknown): number | undefined {
  const candidate = asRecord(error)?.code;
  return typeof candidate === "number" ? candidate : undefined;
}

function stringMap(value: unknown, description: string): Readonly<Record<string, string>> {
  const record = asRecord(value);
  if (record === undefined || Object.values(record).some((entry) => typeof entry !== "string")) {
    throw new OpenShellGatewayFailure(`OpenShell ${description} must be a string map.`);
  }
  return Object.freeze({ ...record } as Record<string, string>);
}

function sandboxResponse(response: RecordValue, method: string): OpenShellSandboxResponse {
  const sandbox = asRecord(response.sandbox);
  const metadata = asRecord(sandbox?.metadata);
  const spec = asRecord(sandbox?.spec);
  if (metadata === undefined || spec === undefined) {
    throw new OpenShellGatewayFailure(`OpenShell ${method} returned no Sandbox metadata or spec.`);
  }
  const deletionTimestampMs = metadata.deletion_timestamp_ms;
  if (typeof deletionTimestampMs !== "string" || !/^\d+$/.test(deletionTimestampMs)) {
    throw new OpenShellGatewayFailure(
      `OpenShell ${method} returned an invalid deletion timestamp.`,
    );
  }
  const phase = asRecord(sandbox?.status)?.phase;
  return Object.freeze({
    name: nonempty(metadata.name, `OpenShell ${method} Sandbox name`),
    id: nonempty(metadata.id, `OpenShell ${method} Sandbox ID`),
    workspace: nonempty(metadata.workspace, `OpenShell ${method} Sandbox workspace`),
    labels: stringMap(metadata.labels, `${method} labels`),
    annotations: stringMap(metadata.annotations, `${method} annotations`),
    spec,
    deletionTimestampMs,
    ...(typeof phase === "string" || typeof phase === "number" ? { phase } : {}),
  });
}

function validateSandbox(
  observed: OpenShellSandboxResponse,
  expected: OpenShellSandboxCreateRequest,
): void {
  if (observed.name !== expected.name || observed.workspace !== expected.workspace) {
    throw new OpenShellGatewayFailure(
      "OpenShell Sandbox name or workspace does not match the launch request.",
    );
  }
  // Upstream may add its own annotations. Every caller-supplied ownership key
  // must still match; provider metadata cannot substitute for these bindings.
  for (const field of ["labels", "annotations"] as const) {
    if (Object.entries(expected[field]).some(([key, value]) => observed[field][key] !== value)) {
      throw new OpenShellGatewayFailure(
        "OpenShell Sandbox ownership does not match the launch request.",
      );
    }
  }
  if (
    observed.deletionTimestampMs !== "0" ||
    observed.phase === "SANDBOX_PHASE_DELETING" ||
    observed.phase === 4
  ) {
    throw new OpenShellGatewayFailure("OpenShell Sandbox is being deleted.");
  }
  if (!isDeepStrictEqual(observed.spec, expected.spec)) {
    throw new OpenShellGatewayFailure(
      "OpenShell Sandbox spec does not match the immutable launch request.",
    );
  }
}

function normalizeEndpoint(endpoint: string): {
  readonly target: string;
  readonly secure: boolean;
} {
  const value = nonempty(endpoint, "OpenShell gateway endpoint");
  if (!value.includes("://")) return { target: value, secure: false };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new OpenShellGatewayFailure("OpenShell gateway endpoint is not a valid URL.");
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new OpenShellGatewayFailure(
      "OpenShell gateway endpoint must not include credentials, path, query, or fragment.",
    );
  }
  if (parsed.protocol === "http:") return { target: parsed.host, secure: false };
  if (parsed.protocol === "https:") return { target: parsed.host, secure: true };
  throw new OpenShellGatewayFailure("OpenShell gateway endpoint must use http or https.");
}

function toStructValue(value: unknown): Record<string, unknown> {
  if (value === null) return { nullValue: 0 };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new OpenShellGatewayFailure("Struct numbers must be finite.");
    return { numberValue: value };
  }
  if (typeof value === "boolean") return { boolValue: value };
  if (Array.isArray(value)) {
    return { listValue: { values: value.map((entry) => toStructValue(entry)) } };
  }
  const object = asRecord(value);
  if (object === undefined) {
    throw new OpenShellGatewayFailure("Struct values must be JSON-compatible.");
  }
  return {
    structValue: {
      fields: Object.fromEntries(
        Object.entries(object).map(([key, entry]) => [key, toStructValue(entry)]),
      ),
    },
  };
}

export function toProtobufStruct(value: RecordValue): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, toStructValue(entry)]),
  );
}

function metadataValue(token: string): string {
  const value = token.trim();
  if (value.length === 0 || /[^\x21-\x7e]/.test(value)) {
    throw new OpenShellGatewayFailure("OpenShell bearer token file is empty or invalid.");
  }
  return `Bearer ${value}`;
}

async function metadata(
  grpc: typeof import("@grpc/grpc-js"),
  auth: OpenShellGatewayClientOptions["auth"],
): Promise<Metadata> {
  const value = new grpc.Metadata();
  if (auth === undefined || auth.mode === "unauthenticated") return value;
  if (!isAbsolute(auth.path)) {
    throw new OpenShellGatewayFailure("OpenShell bearer token file path must be absolute.");
  }
  let token: string;
  try {
    token = await readFile(auth.path, "utf8");
  } catch {
    throw new OpenShellGatewayFailure("OpenShell bearer token file could not be read.");
  }
  value.set("authorization", metadataValue(token));
  return value;
}

async function loadGrpc(): Promise<{
  readonly grpc: typeof import("@grpc/grpc-js");
  readonly loader: typeof import("@grpc/proto-loader");
}> {
  try {
    const [grpc, loader] = await Promise.all([import(CLIENT_MODULE), import(LOADER_MODULE)]);
    return { grpc, loader };
  } catch {
    throw new OpenShellGatewayFailure(
      `The OpenShell Sandbox Driver requires ${CLIENT_MODULE} and ${LOADER_MODULE}.`,
    );
  }
}

export class GrpcOpenShellGatewayClient implements OpenShellGatewayClient {
  private readonly options: OpenShellGatewayClientOptions;
  private readonly requestTimeoutMs: number;
  private client:
    | Promise<{
        readonly grpc: typeof import("@grpc/grpc-js");
        readonly client: OpenShellGrpcClient;
        readonly specType: MessageTypeDefinition<RecordValue, RecordValue>;
      }>
    | undefined;

  constructor(options: OpenShellGatewayClientOptions) {
    this.options = options;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 1000) {
      throw new OpenShellGatewayFailure("OpenShell request timeout must be at least 1000 ms.");
    }
    if (
      options.auth?.mode === "bearerTokenFile" &&
      (typeof options.auth.path !== "string" || !isAbsolute(options.auth.path))
    ) {
      throw new OpenShellGatewayFailure("OpenShell bearer token file path must be absolute.");
    }
    if (
      options.rootCertificatePath !== undefined &&
      (typeof options.rootCertificatePath !== "string" || !isAbsolute(options.rootCertificatePath))
    ) {
      throw new OpenShellGatewayFailure("OpenShell root certificate path must be absolute.");
    }
    for (const path of [options.clientCertificatePath, options.clientPrivateKeyPath]) {
      if (path !== undefined && (typeof path !== "string" || !isAbsolute(path))) {
        throw new OpenShellGatewayFailure("OpenShell client TLS file paths must be absolute.");
      }
    }
    if (
      (options.clientCertificatePath === undefined) !==
      (options.clientPrivateKeyPath === undefined)
    ) {
      throw new OpenShellGatewayFailure(
        "OpenShell client certificate and private key must be configured together.",
      );
    }
    if (
      options.auth !== undefined &&
      options.auth.mode !== "unauthenticated" &&
      options.auth.mode !== "bearerTokenFile"
    ) {
      throw new OpenShellGatewayFailure("OpenShell gateway authentication mode is unsupported.");
    }
    if (
      !normalizeEndpoint(options.endpoint).secure &&
      (options.auth?.mode === "bearerTokenFile" ||
        options.rootCertificatePath !== undefined ||
        options.clientCertificatePath !== undefined)
    ) {
      throw new OpenShellGatewayFailure(
        "OpenShell gateway credentials and certificates require an https endpoint.",
      );
    }
  }

  async health(signal: AbortSignal): Promise<void> {
    const response = await this.unary("Health", {}, signal);
    const status = response.status;
    if (status !== "SERVICE_STATUS_HEALTHY" && status !== 1) {
      throw new OpenShellGatewayFailure("OpenShell gateway is not healthy.");
    }
  }

  async createSandbox(
    request: OpenShellSandboxCreateRequest,
    signal: AbortSignal,
  ): Promise<OpenShellSandboxResponse> {
    signal.throwIfAborted();
    const { grpc, specType } = await this.ensureClient();
    signal.throwIfAborted();
    // Use the wire schema to normalize omitted protobuf defaults, including
    // optional-field presence and Struct values, before comparing launch intent.
    let spec: RecordValue;
    try {
      spec = specType.deserialize(specType.serialize(request.spec));
    } catch {
      throw new OpenShellGatewayFailure("OpenShell Sandbox launch request has an invalid spec.");
    }
    const expected: OpenShellSandboxCreateRequest = {
      name: nonempty(request.name, "OpenShell Sandbox name"),
      workspace: nonempty(request.workspace, "OpenShell Sandbox workspace"),
      labels: stringMap(request.labels, "request labels"),
      annotations: stringMap(request.annotations, "request annotations"),
      spec,
    };
    let response: RecordValue;
    try {
      response = await this.unary("CreateSandbox", { ...expected }, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (
        ![
          grpc.status.ALREADY_EXISTS,
          grpc.status.UNAVAILABLE,
          grpc.status.DEADLINE_EXCEEDED,
          grpc.status.UNKNOWN,
        ].includes(statusCode(error) ?? -1)
      ) {
        throw error;
      }
      // A read can establish matching persisted intent after an uncertain write.
      // NOT_FOUND remains a failure; it does not prove no provider effect occurred.
      const existing = await this.getSandbox(expected, signal);
      validateSandbox(existing, expected);
      return existing;
    }
    // Malformed or mismatching success envelopes are errors, never recovery cues.
    const created = sandboxResponse(response, "CreateSandbox");
    validateSandbox(created, expected);
    const observed = await this.getSandbox(expected, signal);
    validateSandbox(observed, expected);
    if (observed.id !== created.id) {
      throw new OpenShellGatewayFailure("OpenShell Sandbox identity changed during creation.");
    }
    return observed;
  }

  async getSandbox(
    request: OpenShellSandboxDeleteRequest,
    signal: AbortSignal,
  ): Promise<OpenShellSandboxResponse> {
    const response = sandboxResponse(
      await this.unary(
        "GetSandbox",
        {
          name: nonempty(request.name, "OpenShell Sandbox name"),
          workspace: nonempty(request.workspace, "OpenShell Sandbox workspace"),
        },
        signal,
      ),
      "GetSandbox",
    );
    if (response.name !== request.name || response.workspace !== request.workspace) {
      throw new OpenShellGatewayFailure(
        "OpenShell GetSandbox returned a different name or workspace.",
      );
    }
    return response;
  }

  async deleteSandbox(request: OpenShellSandboxDeleteRequest, signal: AbortSignal): Promise<void> {
    try {
      const response = await this.unary(
        "DeleteSandbox",
        { name: request.name, workspace: request.workspace },
        signal,
      );
      if (response.deleted !== true) {
        throw new OpenShellGatewayFailure("OpenShell DeleteSandbox did not confirm deletion.");
      }
    } catch (error) {
      signal.throwIfAborted();
      const { grpc } = await this.ensureClient();
      if (statusCode(error) === grpc.status.NOT_FOUND) return;
      throw error;
    }
  }

  close(): void {
    const current = this.client;
    this.client = undefined;
    current
      ?.then(({ client }) => client.close())
      .catch(() => {
        // Nothing useful can be done after close; future calls create a fresh client.
      });
  }

  private async unary(
    method: "Health" | "CreateSandbox" | "GetSandbox" | "DeleteSandbox",
    request: RecordValue,
    signal: AbortSignal,
  ): Promise<RecordValue> {
    signal.throwIfAborted();
    const { grpc, client } = await this.ensureClient();
    signal.throwIfAborted();
    const headers = await metadata(grpc, this.options.auth);
    signal.throwIfAborted();
    return new Promise<RecordValue>((resolve, reject) => {
      let call: ClientUnaryCall | undefined;
      const abort = () => {
        call?.cancel();
        reject(signal.reason ?? new Error("OpenShell gateway request aborted."));
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        call = client[method](
          request,
          headers,
          { deadline: deadline(this.requestTimeoutMs) },
          (error, response) => {
            signal.removeEventListener("abort", abort);
            if (signal.aborted) {
              reject(signal.reason ?? new Error("OpenShell gateway request aborted."));
              return;
            }
            if (error !== null) {
              const code = statusCode(error);
              const label = code === undefined ? "UNKNOWN" : (grpc.status[code] ?? "UNKNOWN");
              reject(new OpenShellGatewayFailure(`OpenShell ${method} failed (${label}).`, code));
              return;
            }
            const record = asRecord(response);
            if (record === undefined) {
              reject(
                new OpenShellGatewayFailure(`OpenShell ${method} returned a malformed response.`),
              );
              return;
            }
            resolve(record);
          },
        );
      } catch {
        signal.removeEventListener("abort", abort);
        reject(new OpenShellGatewayFailure(`OpenShell ${method} request could not be sent.`));
      }
    });
  }

  private async ensureClient(): Promise<{
    readonly grpc: typeof import("@grpc/grpc-js");
    readonly client: OpenShellGrpcClient;
    readonly specType: MessageTypeDefinition<RecordValue, RecordValue>;
  }> {
    if (this.client !== undefined) return this.client;
    this.client = this.createClient();
    return this.client;
  }

  private async createClient(): Promise<{
    readonly grpc: typeof import("@grpc/grpc-js");
    readonly client: OpenShellGrpcClient;
    readonly specType: MessageTypeDefinition<RecordValue, RecordValue>;
  }> {
    const { grpc, loader } = await loadGrpc();
    const protoPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "proto",
      "openshell-gateway.proto",
    );
    const packageDefinition: PackageDefinition = await loader.load(protoPath, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const loaded = grpc.loadPackageDefinition(packageDefinition) as unknown as {
      readonly openshell?: { readonly v1?: { readonly OpenShell?: ServiceClientConstructor } };
    };
    const OpenShell = loaded.openshell?.v1?.OpenShell;
    if (OpenShell === undefined) {
      throw new OpenShellGatewayFailure("OpenShell gRPC service was not found in the proto.");
    }
    const endpoint = normalizeEndpoint(this.options.endpoint);
    let credentials;
    try {
      credentials = endpoint.secure
        ? grpc.credentials.createSsl(
            this.options.rootCertificatePath === undefined
              ? undefined
              : readFileSync(this.options.rootCertificatePath),
            this.options.clientPrivateKeyPath === undefined
              ? undefined
              : readFileSync(this.options.clientPrivateKeyPath),
            this.options.clientCertificatePath === undefined
              ? undefined
              : readFileSync(this.options.clientCertificatePath),
          )
        : grpc.credentials.createInsecure();
    } catch {
      throw new OpenShellGatewayFailure("OpenShell TLS credentials could not be loaded.");
    }
    const specType = packageDefinition["openshell.v1.SandboxSpec"] as MessageTypeDefinition<
      RecordValue,
      RecordValue
    >;

    return {
      grpc,
      specType,
      client: new OpenShell(endpoint.target, credentials) as unknown as OpenShellGrpcClient,
    };
  }
}
