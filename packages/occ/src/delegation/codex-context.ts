import { isMediationContextRef } from "./grant-contract.ts";

export const CODEX_CONTEXT_LIMITS = Object.freeze({
  bodyBytes: 16_777_216,
  metadataBytes: 8_192,
  jsonDepth: 64,
  jsonValues: 20_000,
  headerEntries: 128,
});

export interface CodexContextInput {
  readonly method: string;
  readonly path: string;
  readonly body: Uint8Array;
  /** Lossless name/value pairs from the HTTP parser, before duplicate-header folding. */
  readonly headers: readonly (readonly [string, string])[];
}

export type CodexContextResult =
  | Readonly<{ result: "context"; mediationContextRef: string }>
  | Readonly<{ result: "rejected"; reason: "route" | "limits" | "json" | "context" | "headers" }>;

/** JSON.parse owns grammar/materialization; this bounded walk rejects overwritten decoded keys. */
function uniqueJson(text: string, byteLimit: number): unknown {
  if (Buffer.byteLength(text, "utf8") > byteLimit) throw new Error("limit");
  const value: unknown = JSON.parse(text);
  let offset = 0;
  let values = 0;
  const whitespace = () => {
    while (/[\x20\t\r\n]/.test(text[offset] ?? "x")) offset++;
  };
  const string = (): string => {
    const start = offset++;
    while (offset < text.length) {
      const character = text[offset++];
      if (character === "\\") offset++;
      else if (character === '"') return JSON.parse(text.slice(start, offset)) as string;
    }
    throw new Error("json");
  };
  const walk = (depth: number): void => {
    if (depth > CODEX_CONTEXT_LIMITS.jsonDepth || ++values > CODEX_CONTEXT_LIMITS.jsonValues)
      throw new Error("limit");
    whitespace();
    const first = text[offset];
    if (first === '"') {
      string();
      return;
    }
    if (first !== "{" && first !== "[") {
      while (offset < text.length && !/[\x20\t\r\n,}\]]/.test(text[offset]!)) offset++;
      return;
    }
    const object = first === "{";
    const end = object ? "}" : "]";
    const keys = new Set<string>();
    offset++;
    whitespace();
    if (text[offset] === end) {
      offset++;
      return;
    }
    for (;;) {
      if (object) {
        whitespace();
        const key = string();
        if (keys.has(key)) throw new Error("duplicate");
        keys.add(key);
        whitespace();
        offset++; // JSON.parse already validated the colon.
      }
      walk(depth + 1);
      whitespace();
      if (text[offset++] === end) return;
    }
  };
  walk(0);
  return value;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function context(metadata: unknown): string | undefined {
  if (!object(metadata) || !Object.hasOwn(metadata, "openclaw_mediation_context")) return undefined;
  const value = metadata.openclaw_mediation_context;
  return isMediationContextRef(value) ? value : undefined;
}

/** Extracts an untrusted locator only; route parsing and a valid context never grant permission. */
export function parseCodexMediationContextV1(input: CodexContextInput): CodexContextResult {
  const reject = (
    reason: Extract<CodexContextResult, { result: "rejected" }>["reason"],
  ): CodexContextResult => Object.freeze({ result: "rejected", reason });
  if (input.method !== "POST" || input.path !== "/v1/responses") return reject("route");
  if (
    !(input.body instanceof Uint8Array) ||
    input.body.byteLength > CODEX_CONTEXT_LIMITS.bodyBytes ||
    !Array.isArray(input.headers) ||
    input.headers.length > CODEX_CONTEXT_LIMITS.headerEntries
  )
    return reject("limits");
  let metadataHeader: string | undefined;
  for (const entry of input.headers) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      entry.some((value) => typeof value !== "string")
    )
      return reject("headers");
    if (entry[0].toLowerCase() !== "x-codex-turn-metadata") continue;
    if (
      metadataHeader !== undefined ||
      Buffer.byteLength(entry[1], "utf8") > CODEX_CONTEXT_LIMITS.metadataBytes
    )
      return reject("headers");
    metadataHeader = entry[1];
  }
  try {
    // Fatal decoding prevents two different invalid byte sequences collapsing to replacement text.
    const bodyText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input.body);
    const body = uniqueJson(bodyText, CODEX_CONTEXT_LIMITS.bodyBytes);
    if (!object(body) || !Object.hasOwn(body, "client_metadata") || !object(body.client_metadata))
      return reject("context");
    const clientMetadata = body.client_metadata;
    if (!Object.hasOwn(clientMetadata, "x-codex-turn-metadata")) return reject("context");
    const encoded = clientMetadata["x-codex-turn-metadata"];
    if (typeof encoded !== "string") return reject("context");
    const selected = context(uniqueJson(encoded, CODEX_CONTEXT_LIMITS.metadataBytes));
    if (!selected) return reject("context");
    if (metadataHeader !== undefined) {
      const headerContext = context(uniqueJson(metadataHeader, CODEX_CONTEXT_LIMITS.metadataBytes));
      // Codex omits some tool metadata in its compatibility header: compare only the consumed field.
      if (headerContext !== selected) return reject("headers");
    }
    return Object.freeze({ result: "context", mediationContextRef: selected });
  } catch {
    return reject("json");
  }
}
