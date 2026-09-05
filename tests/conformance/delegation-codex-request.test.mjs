import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCodexModelRequestV1 } from "../../packages/occ/src/delegation/codex-request.ts";

const fn = () => ({
  type: "function",
  name: "read_file",
  description: "Read a local file",
  strict: false,
  parameters: { type: "object", properties: { path: { type: "string" } } },
});
const custom = () => ({
  type: "custom",
  name: "apply_patch",
  description: "Apply a local patch",
  format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
});
const body = (overrides = {}) => ({
  model: "gpt-5.1",
  input: [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Read the local file." }],
    },
  ],
  tools: [fn(), custom()],
  tool_choice: "auto",
  parallel_tool_calls: true,
  reasoning: { effort: "medium", summary: "auto" },
  store: false,
  stream: true,
  include: ["reasoning.encrypted_content"],
  prompt_cache_key: "thread-local",
  client_metadata: {
    "x-codex-turn-metadata": JSON.stringify({ openclaw_mediation_context: "context-a" }),
  },
  ...overrides,
});
const parse = (value) =>
  parseCodexModelRequestV1({
    method: "POST",
    path: "/v1/responses",
    headers: [],
    body: Buffer.from(typeof value === "string" ? value : JSON.stringify(value)),
  });

test("selected text/local-tool request exposes only model and untrusted context", () => {
  const result = parse(body());
  assert.deepEqual(result, {
    result: "model-request",
    mediationContextRef: "context-a",
    modelId: "gpt-5.1",
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(
    parse(
      body({
        tools: [],
        tool_choice: "none",
        text: {
          verbosity: "low",
          format: { type: "json_schema", strict: true, name: "answer", schema: { type: "object" } },
        },
        stream_options: { reasoning_summary_delivery: "sequential_cutoff" },
      }),
    ).result,
    "model-request",
  );
});

test("ordinary local function/custom and client discovery history remains usable", () => {
  const search = {
    type: "tool_search",
    execution: "client",
    description: "Find local tools",
    parameters: { type: "object" },
  };
  const namespace = {
    type: "namespace",
    name: "functions",
    description: "Local tools",
    tools: [fn(), custom()],
  };
  const input = [
    ...body().input,
    {
      type: "reasoning",
      id: "rs_1",
      summary: [{ type: "summary_text", text: "Read file" }],
      encrypted_content: "opaque-inline",
    },
    {
      type: "function_call",
      name: "read_file",
      arguments: '{"path":"README.md"}',
      call_id: "call_1",
    },
    {
      type: "function_call_output",
      call_id: "call_1",
      output: [{ type: "input_text", text: "File contents" }],
    },
    { type: "custom_tool_call", name: "apply_patch", input: "patch text", call_id: "call_2" },
    { type: "custom_tool_call_output", call_id: "call_2", output: "Applied" },
    {
      type: "tool_search_call",
      call_id: "call_3",
      execution: "client",
      arguments: { query: "files", limit: 2 },
    },
    {
      type: "tool_search_output",
      call_id: "call_3",
      execution: "client",
      status: "completed",
      tools: [namespace],
    },
    {
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text: "Done." }],
    },
  ];
  assert.equal(parse(body({ input, tools: [namespace, search] })).result, "model-request");
});

test("background, stored response linkage and extra provider controls are refused", () => {
  for (const extra of [
    { background: true },
    { background: false },
    { previous_response_id: "resp-other" },
    { conversation: "conv-other" },
    { access_programs: { cyber: "standard" } },
    { store: true },
    { stream: false },
    { tool_choice: { type: "function", name: "x" } },
    { model: "bad model" },
  ])
    assert.equal(parse(body(extra)).result, "rejected");
});

test("remote tools cannot enter through top-level, namespace or discovery results", () => {
  for (const remote of [
    { type: "web_search" },
    { type: "mcp", server_url: "https://remote.example" },
    { type: "file_search", vector_store_ids: ["vs_other"] },
    { type: "code_interpreter", container: "auto" },
    { type: "tool_search", execution: "server", description: "Remote", parameters: {} },
  ]) {
    for (const tools of [
      [remote],
      [{ type: "namespace", name: "local", description: "Local", tools: [remote] }],
    ]) {
      assert.equal(parse(body({ tools })).result, "rejected");
      assert.equal(
        parse(
          body({
            input: [
              {
                type: "tool_search_output",
                call_id: "call_1",
                execution: "client",
                status: "completed",
                tools,
              },
            ],
          }),
        ).result,
        "rejected",
      );
    }
  }
  assert.equal(
    parse(body({ tools: [{ ...fn(), server_url: "https://remote.example" }] })).result,
    "rejected",
  );
  assert.equal(
    parse(body({ tools: [{ ...fn(), parameters: { $ref: "https://remote.example/schema" } }] }))
      .result,
    "rejected",
  );
});

test("resource references, media and unsupported alternate tool/control paths fail closed", () => {
  for (const item of [
    { type: "item_reference", id: "msg_other" },
    { type: "additional_tools", role: "developer", tools: [{ type: "web_search" }] },
    { type: "compaction_trigger" },
    { type: "compaction", encrypted_content: "other" },
    { type: "agent_message", author: "a", recipient: "b", content: [] },
    ...[
      { type: "input_image", image_url: "https://remote.example/image" },
      { type: "input_file", file_id: "file_other" },
      { type: "input_audio", audio_url: "https://remote.example/audio" },
    ].map((content) => ({ type: "message", role: "user", content: [content] })),
    {
      type: "function_call_output",
      call_id: "call_1",
      output: [{ type: "input_image", image_url: "https://remote.example/image" }],
    },
  ])
    assert.equal(parse(body({ input: [item] })).result, "rejected");
});

test("duplicate keys and missing context cannot be hidden by profile parsing", () => {
  const valid = JSON.stringify(body());
  assert.equal(
    parse(valid.replace('"model":"gpt-5.1"', '"model":"gpt-5.1","\\u006dodel":"other"')).result,
    "rejected",
  );
  assert.equal(parse(body({ client_metadata: {} })).result, "rejected");
  const mutable = Buffer.from(valid);
  const result = parseCodexModelRequestV1({
    method: "POST",
    path: "/v1/responses",
    headers: [],
    body: mutable,
  });
  mutable.fill(0);
  assert.deepEqual(result, {
    result: "model-request",
    mediationContextRef: "context-a",
    modelId: "gpt-5.1",
  });
});
