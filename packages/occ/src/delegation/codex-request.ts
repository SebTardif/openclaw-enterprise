import {
  CODEX_CONTEXT_LIMITS,
  parseCodexMediationContextV1,
  type CodexContextInput,
  type CodexContextResult,
} from "./codex-context.ts";
import { reference } from "./validation.ts";

export type CodexModelRequestResult =
  | Readonly<{ result: "model-request"; mediationContextRef: string; modelId: string }>
  | Extract<CodexContextResult, { result: "rejected" }>
  | Readonly<{ result: "rejected"; reason: "profile" }>;

type RecordValue = Record<string, unknown>;
type Validator = (value: unknown) => boolean;

function record(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shape(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is RecordValue {
  return (
    record(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}

const string: Validator = (value) => typeof value === "string";
const boolean: Validator = (value) => typeof value === "boolean";
const nullableString: Validator = (value) => value === null || string(value);
const oneOf =
  (...allowed: readonly string[]): Validator =>
  (value) =>
    typeof value === "string" && allowed.includes(value);
const optional = (value: RecordValue, key: string, validate: Validator): boolean =>
  !Object.hasOwn(value, key) || validate(value[key]);
const list = (value: unknown, validate: Validator, limit = 4096): boolean =>
  Array.isArray(value) && value.length <= limit && value.every(validate);

// Schemas are data, but this profile does not admit external schema references.
function localSchema(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(localSchema);
  if (!record(value)) return true;
  return Object.entries(value).every(([key, child]) =>
    key === "$ref" || key === "$dynamicRef"
      ? typeof child === "string" && (child === "#" || child.startsWith("#/"))
      : localSchema(child),
  );
}

function tool(value: unknown, nested = false): boolean {
  if (!record(value)) return false;
  if (value.type === "function") {
    return (
      shape(value, ["type", "name", "description", "strict", "parameters"], ["defer_loading"]) &&
      reference(value.name) &&
      string(value.description) &&
      boolean(value.strict) &&
      record(value.parameters) &&
      localSchema(value.parameters) &&
      optional(value, "defer_loading", boolean)
    );
  }
  if (value.type === "custom") {
    return (
      shape(value, ["type", "name", "description", "format"], ["defer_loading"]) &&
      reference(value.name) &&
      string(value.description) &&
      optional(value, "defer_loading", boolean) &&
      shape(value.format, ["type", "syntax", "definition"]) &&
      value.format.type === "grammar" &&
      value.format.syntax === "lark" &&
      string(value.format.definition)
    );
  }
  if (!nested && value.type === "namespace") {
    return (
      shape(value, ["type", "name", "description", "tools"]) &&
      reference(value.name) &&
      string(value.description) &&
      list(value.tools, (entry) => tool(entry, true), 128)
    );
  }
  if (!nested && value.type === "tool_search") {
    return (
      shape(value, ["type", "execution", "description", "parameters"]) &&
      value.execution === "client" &&
      string(value.description) &&
      record(value.parameters) &&
      localSchema(value.parameters)
    );
  }
  return false;
}

const textContent: Validator = (value) =>
  shape(value, ["type", "text"]) &&
  oneOf("input_text", "output_text")(value.type) &&
  string(value.text);
const output: Validator = (value) =>
  string(value) ||
  list(
    value,
    (entry) => shape(entry, ["type", "text"]) && entry.type === "input_text" && string(entry.text),
  );

function item(value: unknown): boolean {
  if (!record(value) || !optional(value, "id", reference)) return false;
  if (value.type === "message") {
    return (
      shape(value, ["type", "role", "content"], ["id", "phase"]) &&
      oneOf("system", "developer", "user", "assistant")(value.role) &&
      list(value.content, textContent) &&
      optional(value, "phase", oneOf("commentary", "final_answer"))
    );
  }
  if (value.type === "reasoning") {
    return (
      shape(value, ["type", "summary", "encrypted_content"], ["id", "content"]) &&
      nullableString(value.encrypted_content) &&
      list(
        value.summary,
        (entry) =>
          shape(entry, ["type", "text"]) && entry.type === "summary_text" && string(entry.text),
      ) &&
      optional(
        value,
        "content",
        (content) =>
          content === null ||
          list(
            content,
            (entry) =>
              shape(entry, ["type", "text"]) &&
              oneOf("reasoning_text", "text")(entry.type) &&
              string(entry.text),
          ),
      )
    );
  }
  if (value.type === "function_call") {
    return (
      shape(value, ["type", "name", "arguments", "call_id"], ["id", "namespace"]) &&
      reference(value.name) &&
      reference(value.call_id) &&
      string(value.arguments) &&
      optional(value, "namespace", reference)
    );
  }
  if (value.type === "custom_tool_call") {
    return (
      shape(value, ["type", "name", "input", "call_id"], ["id", "namespace", "status"]) &&
      reference(value.name) &&
      reference(value.call_id) &&
      string(value.input) &&
      optional(value, "namespace", reference) &&
      optional(value, "status", string)
    );
  }
  if (value.type === "function_call_output" || value.type === "custom_tool_call_output") {
    const extra =
      value.type === "function_call_output" ? ["id", "name", "namespace"] : ["id", "name"];
    return (
      shape(value, ["type", "call_id", "output"], extra) &&
      reference(value.call_id) &&
      output(value.output) &&
      optional(value, "name", reference) &&
      optional(value, "namespace", reference)
    );
  }
  if (value.type === "tool_search_call") {
    return (
      shape(value, ["type", "call_id", "execution", "arguments"], ["id", "status"]) &&
      reference(value.call_id) &&
      value.execution === "client" &&
      optional(value, "status", string) &&
      shape(value.arguments, ["query"], ["limit"]) &&
      string(value.arguments.query) &&
      optional(
        value.arguments,
        "limit",
        (limit) => typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0,
      )
    );
  }
  if (value.type === "tool_search_output") {
    return (
      shape(value, ["type", "call_id", "status", "execution", "tools"], ["id"]) &&
      reference(value.call_id) &&
      string(value.status) &&
      value.execution === "client" &&
      list(value.tools, (entry) => tool(entry), 128)
    );
  }
  // Intentional text/local-tool profile: no media, remote item references, Lite tool
  // injection, agent messages, legacy shell, or compaction/control items.
  return false;
}

function controls(body: RecordValue): boolean {
  return (
    optional(body, "instructions", string) &&
    optional(body, "tools", (tools) => list(tools, (entry) => tool(entry), 128)) &&
    optional(
      body,
      "reasoning",
      (value) =>
        value === null ||
        (shape(value, [], ["effort", "summary", "context"]) &&
          optional(value, "effort", reference) &&
          optional(value, "summary", oneOf("auto", "concise", "detailed", "none")) &&
          optional(value, "context", oneOf("auto", "current_turn", "all_turns"))),
    ) &&
    optional(
      body,
      "stream_options",
      (value) =>
        shape(value, ["reasoning_summary_delivery"]) &&
        value.reasoning_summary_delivery === "sequential_cutoff",
    ) &&
    optional(body, "include", (value) => list(value, oneOf("reasoning.encrypted_content"), 1)) &&
    optional(body, "service_tier", reference) &&
    optional(body, "prompt_cache_key", nullableString) &&
    optional(
      body,
      "text",
      (value) =>
        shape(value, [], ["verbosity", "format"]) &&
        optional(value, "verbosity", oneOf("low", "medium", "high")) &&
        optional(
          value,
          "format",
          (format) =>
            shape(format, ["type", "strict", "schema", "name"]) &&
            format.type === "json_schema" &&
            boolean(format.strict) &&
            reference(format.name) &&
            record(format.schema) &&
            localSchema(format.schema),
        ),
    )
  );
}

/**
 * Narrow Codex 0.153.0 ordinary HTTP text/local-tool profile, from codex-api/common.rs,
 * tools/{tool_spec,responses_api}.rs and protocol/models.rs at 41e22fee.
 * Inline reasoning ciphertext is opaque replay content, not verified provenance.
 * A successful parse establishes neither execution authority nor native compatibility.
 */
export function parseCodexModelRequestV1(input: CodexContextInput): CodexModelRequestResult {
  const rejected = Object.freeze({ result: "rejected", reason: "profile" } as const);
  const rawBody = input.body;
  if (!(rawBody instanceof Uint8Array) || rawBody.byteLength > CODEX_CONTEXT_LIMITS.bodyBytes)
    return Object.freeze({ result: "rejected", reason: "limits" });
  // Both parsers consume the same private bytes; callers cannot swap the model after context validation.
  const bodySnapshot = Buffer.from(rawBody);
  const selected = parseCodexMediationContextV1({
    method: input.method,
    path: input.path,
    headers: input.headers,
    body: bodySnapshot,
  });
  if (selected.result === "rejected") return selected;
  const body: unknown = JSON.parse(bodySnapshot.toString("utf8"));
  if (
    !shape(
      body,
      [
        "model",
        "input",
        "tool_choice",
        "parallel_tool_calls",
        "store",
        "stream",
        "client_metadata",
      ],
      [
        "instructions",
        "tools",
        "reasoning",
        "stream_options",
        "include",
        "service_tier",
        "prompt_cache_key",
        "text",
      ],
    ) ||
    !reference(body.model) ||
    body.store !== false ||
    body.stream !== true ||
    !oneOf("auto", "none")(body.tool_choice) ||
    !boolean(body.parallel_tool_calls) ||
    !list(body.input, item) ||
    !record(body.client_metadata) ||
    !Object.values(body.client_metadata).every(string) ||
    !controls(body)
  )
    return rejected;
  return Object.freeze({
    result: "model-request",
    mediationContextRef: selected.mediationContextRef,
    modelId: body.model,
  });
}
