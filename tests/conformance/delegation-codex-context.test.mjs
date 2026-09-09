import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CODEX_CONTEXT_LIMITS,
  parseCodexMediationContextV1,
} from "../../packages/occ/src/delegation/codex-context.ts";

const metadata = (context = "context-a") => ({ openclaw_mediation_context: context });
const envelope = (encoded = JSON.stringify(metadata())) => ({
  model: "model-a",
  input: [],
  client_metadata: { "x-codex-turn-metadata": encoded },
});
const parse = (body = JSON.stringify(envelope()), headers = [], overrides = {}) =>
  parseCodexMediationContextV1({
    method: "POST",
    path: "/v1/responses",
    body: Buffer.from(body),
    headers,
    ...overrides,
  });

test("ordinary Responses body and compatible header yield only the untrusted opaque locator", () => {
  assert.deepEqual(parse(), { result: "context", mediationContextRef: "context-a" });
  const body = JSON.stringify(
    envelope(JSON.stringify({ ...metadata(), tool_namespaces_info: "body-only" })),
  );
  assert.equal(
    parse(body, [["X-Codex-Turn-Metadata", JSON.stringify(metadata())]]).result,
    "context",
  );
  const quoted = JSON.stringify(
    envelope(JSON.stringify({ ...metadata(), note: 'a \\"quoted\\" {"key":1,"key":2}' })),
  );
  assert.equal(parse(quoted).result, "context");
});

test("duplicate decoded keys are refused at every JSON layer", () => {
  for (const inner of [
    '{"openclaw_mediation_context":"a","openclaw_mediation_context":"b"}',
    '{"openclaw_mediation_context":"a","\\u006fpenclaw_mediation_context":"b"}',
    '{"openclaw_mediation_context":"a","nested":{"x":1,"x":2}}',
  ])
    assert.equal(parse(JSON.stringify(envelope(inner))).result, "rejected");
  const member = `"client_metadata":${JSON.stringify(envelope().client_metadata)}`;
  assert.equal(parse(`{${member},${member}}`).result, "rejected");
  assert.equal(
    parse(JSON.stringify(envelope()), [
      [
        "x-codex-turn-metadata",
        '{"openclaw_mediation_context":"a","openclaw_mediation_context":"a"}',
      ],
    ]).result,
    "rejected",
  );
  assert.equal(
    parse(JSON.stringify(envelope('{"\\u006fpenclaw_mediation_context":"context-a"}'))).result,
    "context",
  );
});

test("header folding, conflicts and header-only fallback cannot supply original turn attribution", () => {
  const header = ["x-codex-turn-metadata", JSON.stringify(metadata())];
  assert.equal(parse("{}", [header]).result, "rejected");
  assert.equal(parse(undefined, [header, ["X-CODEX-TURN-METADATA", header[1]]]).result, "rejected");
  for (const value of [JSON.stringify(metadata("other")), "{}", "null", "[]", "not-json"])
    assert.equal(parse(undefined, [[header[0], value]]).result, "rejected");
});

test("required body shapes, exact context grammar and selected route fail closed", () => {
  for (const body of [
    "null",
    "[]",
    "{}",
    '{"client_metadata":null}',
    '{"client_metadata":[]}',
    JSON.stringify(envelope({})),
  ])
    assert.equal(parse(body).result, "rejected");
  for (const context of [
    "",
    "x".repeat(129),
    " context",
    "context\n",
    "ctx/other",
    "ctx%20",
    "日本語",
    1,
    null,
  ])
    assert.equal(
      parse(JSON.stringify(envelope(JSON.stringify(metadata(context))))).result,
      "rejected",
    );
  for (const overrides of [
    { method: "GET" },
    { path: "/v1/responses/compact" },
    { path: "/v1/responses?x=1" },
  ])
    assert.deepEqual(parse(undefined, [], overrides), { result: "rejected", reason: "route" });
});

test("raw UTF-8, body/metadata size and nesting are bounded before use", () => {
  assert.equal(parse(undefined, [], { body: Uint8Array.from([0xc3, 0x28]) }).result, "rejected");
  assert.equal(parse("\ufeff" + JSON.stringify(envelope())).result, "rejected");
  assert.equal(parse(" ".repeat(CODEX_CONTEXT_LIMITS.bodyBytes + 1)).result, "rejected");
  assert.equal(
    parse(JSON.stringify(envelope(" ".repeat(CODEX_CONTEXT_LIMITS.metadataBytes + 1)))).result,
    "rejected",
  );
  const deep =
    "[".repeat(CODEX_CONTEXT_LIMITS.jsonDepth + 1) +
    "0" +
    "]".repeat(CODEX_CONTEXT_LIMITS.jsonDepth + 1);
  assert.equal(
    parse(`{"nested":${deep},"client_metadata":${JSON.stringify(envelope().client_metadata)}}`)
      .result,
    "rejected",
  );
  for (const inner of ["{} trailing", '{"x":"\\', "{", "[]"])
    assert.equal(parse(JSON.stringify(envelope(inner))).result, "rejected");
});

test("larger bodies retain duplicate-key, metadata and JSON complexity checks", () => {
  // Crossing the former byte limit must still reach validation of fields after
  // the large content, including escaped duplicate names and nested metadata.
  const content = `"instructions":"${"x".repeat(1024 * 1024)}",`;
  const tail = JSON.stringify(envelope()).slice(1);
  assert.equal(parse(`{${content}${tail}`).result, "context");
  assert.deepEqual(parse(`{${content}"model":"other",${tail}`), {
    result: "rejected",
    reason: "json",
  });
  assert.deepEqual(parse(`{${content}"\\u006dodel":"other",${tail}`), {
    result: "rejected",
    reason: "json",
  });
  const excessiveValues = Array(CODEX_CONTEXT_LIMITS.jsonValues).fill(0).join(",");
  assert.deepEqual(parse(`{${content}"extra":[${excessiveValues}],${tail}`), {
    result: "rejected",
    reason: "json",
  });
  const oversizedMetadata = JSON.stringify(
    envelope(
      JSON.stringify({ ...metadata(), extra: "x".repeat(CODEX_CONTEXT_LIMITS.metadataBytes) }),
    ),
  ).slice(1);
  assert.deepEqual(parse(`{${content}${oversizedMetadata}`), {
    result: "rejected",
    reason: "json",
  });
});
