import { asRecord, immutableCopy } from "@openclaw-enterprise/utils";
import { spawn } from "node:child_process";
import { isAbsolute, normalize } from "node:path";

type RecordValue = Readonly<Record<string, unknown>>;

export interface OpenShellGatewayClientOptions {
  readonly endpoint: string;
  readonly binaryPath?: string;
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
  readonly phase?: string;
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

const MAX_WIRE_BYTES = 4 * 1024 * 1024;
const MAX_PROCESS_MS = 65_000;
const ERROR_CODES = new Set([
  "invalid_configuration",
  "invalid_request",
  "gateway_rpc",
  "invalid_response",
  "launch_mismatch",
  "ownership_mismatch",
  "identity_mismatch",
  "sandbox_deleting",
  "credential_read",
  "credential_invalid",
  "tls_configuration",
  "cancelled",
  "deadline_exceeded",
  "closed",
  "health_unavailable",
  "deletion_unconfirmed",
  "invalid_wire_request",
  "response_too_large",
  "internal_error",
]);

class OpenShellGatewayFailure extends Error {
  readonly code: number | undefined;
  readonly failureCode: string;

  constructor(failureCode: string, code?: number) {
    super(`OpenShell native gateway failed (${failureCode}).`);
    this.failureCode = failureCode;
    this.code = code;
  }
}

function exactKeys(record: RecordValue, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}

function parseWire(text: string): unknown {
  const value: unknown = JSON.parse(text);
  const stack: (Set<string> | undefined)[] = [];
  // JSON.parse checks syntax; scan its validated text to reject duplicate keys
  // instead of accepting its last-value-wins interpretation of the wire.
  for (let index = 0; index < text.length; index += 1) {
    const token = text[index];
    if (token === "{" || token === "[") {
      stack.push(token === "{" ? new Set<string>() : undefined);
      if (stack.length > 128) throw new Error();
    } else if (token === "}" || token === "]") stack.pop();
    else if (token === '"') {
      const start = index;
      index += 1;
      while (index < text.length && text[index] !== '"') {
        if (text[index] === "\\") index += 1;
        index += 1;
      }
      let next = index + 1;
      while (next < text.length && /\s/.test(text[next]!)) next += 1;
      if (text[next] === ":") {
        const keys = stack.at(-1);
        const key = JSON.parse(text.slice(start, index + 1)) as string;
        if (keys === undefined || keys.has(key)) throw new Error();
        keys.add(key);
      }
    }
  }
  return value;
}

function stringMap(value: unknown): boolean {
  const record = asRecord(value);
  return record !== undefined && Object.values(record).every((entry) => typeof entry === "string");
}

// This checks only the subprocess wire shape. The Go component owns protobuf,
// TLS, credentials, persisted launch intent, and provider response validation.
function sandboxResult(value: unknown): OpenShellSandboxResponse {
  const result = asRecord(value);
  if (
    result === undefined ||
    !exactKeys(result, [
      "name",
      "id",
      "workspace",
      "labels",
      "annotations",
      "spec",
      "deletionTimestampMs",
      "phase",
    ]) ||
    ![result.name, result.id, result.workspace, result.deletionTimestampMs].every(
      (entry) => typeof entry === "string",
    ) ||
    !stringMap(result.labels) ||
    !stringMap(result.annotations) ||
    asRecord(result.spec) === undefined ||
    (result.phase !== undefined && typeof result.phase !== "string")
  ) {
    throw new OpenShellGatewayFailure("invalid_native_response");
  }
  return result as unknown as OpenShellSandboxResponse;
}

export class GoOpenShellGatewayClient implements OpenShellGatewayClient {
  private readonly binaryPath: string;
  private readonly gateway: Omit<OpenShellGatewayClientOptions, "binaryPath">;
  private readonly active = new Set<() => void>();
  private closed = false;

  constructor(options: OpenShellGatewayClientOptions) {
    const { binaryPath = "/usr/local/bin/oce-runtime-security", ...gateway } = options;
    if (
      typeof binaryPath !== "string" ||
      !isAbsolute(binaryPath) ||
      normalize(binaryPath) !== binaryPath ||
      binaryPath === "/" ||
      binaryPath.includes("\0")
    ) {
      throw new OpenShellGatewayFailure("invalid_binary_path");
    }
    this.binaryPath = binaryPath;
    this.gateway = immutableCopy(gateway);
  }

  async health(signal: AbortSignal): Promise<void> {
    await this.invoke("health", undefined, signal);
  }

  async createSandbox(
    request: OpenShellSandboxCreateRequest,
    signal: AbortSignal,
  ): Promise<OpenShellSandboxResponse> {
    return sandboxResult(await this.invoke("create", request, signal));
  }

  async getSandbox(
    request: OpenShellSandboxDeleteRequest,
    signal: AbortSignal,
  ): Promise<OpenShellSandboxResponse> {
    return sandboxResult(await this.invoke("get", request, signal));
  }

  async deleteSandbox(request: OpenShellSandboxDeleteRequest, signal: AbortSignal): Promise<void> {
    await this.invoke("delete", request, signal);
  }

  close(): void {
    this.closed = true;
    for (const stop of this.active) stop();
  }

  private async invoke(
    operation: "health" | "create" | "get" | "delete",
    sandbox: OpenShellSandboxCreateRequest | OpenShellSandboxDeleteRequest | undefined,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (this.closed) throw new OpenShellGatewayFailure("closed");
    if (signal.aborted) throw new OpenShellGatewayFailure("cancelled");
    let input: Buffer;
    try {
      input = Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          operation,
          gateway: this.gateway,
          ...(sandbox === undefined ? {} : { sandbox }),
        }),
      );
    } catch {
      throw new OpenShellGatewayFailure("invalid_wire_request");
    }
    if (input.length > MAX_WIRE_BYTES) throw new OpenShellGatewayFailure("invalid_wire_request");

    return new Promise((resolve, reject) => {
      // Operator configuration selects the executable. No shell, inherited
      // environment, credential argv, or child diagnostics enter the controller.
      const child = spawn(this.binaryPath, ["openshell"], {
        shell: false,
        env: {},
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
      let failure: OpenShellGatewayFailure | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let outputSize = 0;
      const chunks: Buffer[] = [];
      const stop = (code: string) => {
        if (failure !== undefined) return;
        failure = new OpenShellGatewayFailure(code);
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 250);
        killTimer.unref();
      };
      const onAbort = () => stop("cancelled");
      const onClose = () => stop("closed");
      this.active.add(onClose);
      signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => stop("deadline_exceeded"), MAX_PROCESS_MS);
      timer.unref();
      child.on("error", (error: NodeJS.ErrnoException) => {
        failure ??= new OpenShellGatewayFailure(
          error.code === "ENOENT" ? "native_binary_missing" : "native_process_failed",
        );
      });
      child.stdin.on("error", () => stop("native_process_failed"));
      child.stdout.on("data", (chunk: Buffer) => {
        if (failure !== undefined) return;
        outputSize += chunk.length;
        if (outputSize > MAX_WIRE_BYTES) {
          stop("invalid_native_response");
          return;
        }
        chunks.push(chunk);
      });
      child.on("close", (exitCode, exitSignal) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal.removeEventListener("abort", onAbort);
        this.active.delete(onClose);
        if (failure !== undefined) {
          reject(failure);
          return;
        }
        try {
          if (exitSignal !== null || (exitCode !== 0 && exitCode !== 1)) throw new Error();
          const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
          const response = asRecord(parseWire(text));
          if (response?.schemaVersion !== 1 || typeof response.ok !== "boolean") throw new Error();
          if (!response.ok) {
            const error = asRecord(response.error);
            if (
              exitCode !== 1 ||
              !exactKeys(response, ["schemaVersion", "ok", "error"]) ||
              error === undefined ||
              !exactKeys(error, ["code", "grpcCode"]) ||
              typeof error.code !== "string" ||
              !ERROR_CODES.has(error.code) ||
              (error.grpcCode !== undefined &&
                (!Number.isInteger(error.grpcCode) ||
                  Number(error.grpcCode) < 1 ||
                  Number(error.grpcCode) > 16))
            )
              throw new Error();
            reject(new OpenShellGatewayFailure(error.code, error.grpcCode as number | undefined));
            return;
          }
          if (
            exitCode !== 0 ||
            !exactKeys(response, ["schemaVersion", "ok", "result"]) ||
            ((operation === "health" || operation === "delete") && response.result !== undefined)
          )
            throw new Error();
          resolve(response.result);
        } catch {
          reject(new OpenShellGatewayFailure("invalid_native_response"));
        }
      });
      if (signal.aborted) onAbort();
      child.stdin.end(input);
    });
  }
}
