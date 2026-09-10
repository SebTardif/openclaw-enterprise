import assert from "node:assert/strict";
import test from "node:test";
import {
  LIFECYCLE_DEPLOY_LIMITS_V2,
  LifecycleDeploySchemasV2,
  LifecycleDeployErrorV2,
  parseLifecycleDeployV2 as parse,
  parseLifecycleDeployJsonV2 as parseJson,
  decodeLifecycleDeployV2 as decode,
  decodeLifecycleDeployJsonV2 as decodeJson,
  bindLifecycleDeployCommandV2 as bind,
  canonicalLifecycleDeployCommandV2 as canonical,
} from "../../packages/contracts/src/lifecycle-deploy-v2.ts";
import { decodeWorkloadProfileSelectionV1 } from "../../packages/contracts/src/workload-profile-v1.ts";

// Synthetic commands exercise the real pure codec, not an endpoint, authority
// check, committed admission, or replay writer. Scope represents accepting input.
const uuid = (n = 1) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const bytes = (value) => new TextEncoder().encode(value);
const plain = (value) => JSON.parse(JSON.stringify(value));
const scope = () => ({
  installationId: `ins_${uuid(1)}`,
  namespaceId: `ns_${uuid(2)}`,
  agentId: `agt_${uuid(3)}`,
});
const command = () => ({
  schemaVersion: 2,
  operationRef: uuid(4),
  expectedLifecycleGeneration: null,
  revisionSource: "saved-draft",
  expectedDraft: {
    configurationId: `cfg_${uuid(5)}`,
    configurationGeneration: 7,
    providerId: null,
    executionMode: "embedded",
    maximumExecutionMs: null,
    serviceAccountId: null,
    workloadProfileSelection: {
      manifestRef: uuid(6),
      manifestDigest: `sha256:${"a".repeat(64)}`,
      admissionRef: uuid(7),
      admissionVersion: 9,
    },
  },
});
const rejected = (fn) =>
  assert.throws(fn, (error) => {
    assert.ok(error instanceof LifecycleDeployErrorV2);
    assert.equal(error.code, "INVALID_REQUEST");
    assert.equal(error.message, "Invalid lifecycle deploy data.");
    return true;
  });

test("saved-draft command roundtrips native nullable refs and both installed execution modes", () => {
  for (const executionMode of ["embedded", "dedicated"]) {
    for (const providerId of [null, "chatgpt", "provider/é😀"]) {
      for (const serviceAccountId of [null, `sa_${uuid(8)}`]) {
        const input = command();
        Object.assign(input.expectedDraft, { executionMode, providerId, serviceAccountId });
        const parsed = parse("command", input);
        assert.deepEqual(plain(parsed), input);
        assert.deepEqual(plain(parseJson("command", JSON.stringify(input))), input);
        assert.deepEqual(plain(parseJson("command", bytes(JSON.stringify(input)))), input);
        assert.equal(decode("command", input).kind, "valid");
        assert.equal(decodeJson("command", bytes(JSON.stringify(input))).kind, "valid");
        assert.equal(
          decodeWorkloadProfileSelectionV1(parsed.expectedDraft.workloadProfileSelection).kind,
          "valid",
        );
      }
    }
  }
});

test("canonical identity has a fixed complete action, scope and command byte vector", () => {
  const expected =
    '{"action":"agent.deploy","command":{"expectedDraft":{"configurationGeneration":7,"configurationId":"cfg_00000000-0000-4000-8000-000000000005","executionMode":"embedded","maximumExecutionMs":null,"providerId":null,"serviceAccountId":null,"workloadProfileSelection":{"admissionRef":"00000000-0000-4000-8000-000000000007","admissionVersion":9,"manifestDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","manifestRef":"00000000-0000-4000-8000-000000000006"}},"expectedLifecycleGeneration":null,"operationRef":"00000000-0000-4000-8000-000000000004","revisionSource":"saved-draft","schemaVersion":2},"scope":{"agentId":"agt_00000000-0000-4000-8000-000000000003","installationId":"ins_00000000-0000-4000-8000-000000000001","namespaceId":"ns_00000000-0000-4000-8000-000000000002"}}';
  assert.equal(canonical(scope(), command()), expected);
  assert.deepEqual(bytes(canonical(scope(), command())), bytes(expected));
  assert.deepEqual(plain(parseJson("binding", expected)), plain(bind(scope(), command())));
  assert.equal(expected.endsWith("\n"), false);
});

test("whitespace, property order and equivalent escaped strings preserve exact canonical identity", () => {
  const original = command();
  original.expectedDraft.providerId = "provider/é😀";
  const reordered = Object.fromEntries(Object.entries(original).reverse());
  reordered.expectedDraft = Object.fromEntries(Object.entries(original.expectedDraft).reverse());
  reordered.expectedDraft.workloadProfileSelection = Object.fromEntries(
    Object.entries(original.expectedDraft.workloadProfileSelection).reverse(),
  );
  const raw = ` \r\n\t${JSON.stringify(reordered, null, 2)}\t `.replace(
    "é😀",
    "\\u00e9\\ud83d\\ude00",
  );
  const decoded = parseJson("command", raw);
  assert.equal(canonical(scope(), decoded), canonical(scope(), original));
  const decomposed = plain(original);
  decomposed.expectedDraft.providerId = "provider/é😀";
  assert.notEqual(canonical(scope(), decomposed), canonical(scope(), original));
});

test("every command expectation and exact server or route scope field changes identity", () => {
  const original = command();
  const retained = canonical(scope(), original);
  const mutations = [
    (value) => {
      value.operationRef = uuid(10);
    },
    (value) => {
      value.expectedLifecycleGeneration = 1;
    },
    (value) => {
      value.expectedDraft.configurationId = `cfg_${uuid(11)}`;
    },
    (value) => {
      value.expectedDraft.configurationGeneration = 8;
    },
    (value) => {
      value.expectedDraft.providerId = "chatgpt";
    },
    (value) => {
      value.expectedDraft.executionMode = "dedicated";
    },
    (value) => {
      value.expectedDraft.serviceAccountId = `sa_${uuid(12)}`;
    },
    (value) => {
      value.expectedDraft.workloadProfileSelection.manifestRef = uuid(13);
    },
    (value) => {
      value.expectedDraft.workloadProfileSelection.manifestDigest = `sha256:${"b".repeat(64)}`;
    },
    (value) => {
      value.expectedDraft.workloadProfileSelection.admissionRef = uuid(14);
    },
    (value) => {
      value.expectedDraft.workloadProfileSelection.admissionVersion = 10;
    },
  ];
  for (const mutate of mutations) {
    const changed = plain(original);
    mutate(changed);
    assert.notEqual(canonical(scope(), changed), retained);
  }
  for (const [field, prefix] of [
    ["installationId", "ins"],
    ["namespaceId", "ns"],
    ["agentId", "agt"],
  ]) {
    assert.notEqual(
      canonical({ ...scope(), [field]: `${prefix}_${uuid(15)}` }, original),
      retained,
    );
  }
  // An edited draft never reconstructs or mutates the caller's already retained command.
  assert.equal(canonical(scope(), original), retained);
});

test("bodyless, omitted and null operands never silently select a saved snapshot", () => {
  for (const value of [undefined, null, {}, [], "", true]) rejected(() => parse("command", value));
  for (const raw of ["", "null", "{}", "[]", "true"]) rejected(() => parseJson("command", raw));
  for (const field of Object.keys(command())) {
    const input = command();
    delete input[field];
    rejected(() => parse("command", input));
  }
  for (const field of Object.keys(command().expectedDraft)) {
    const input = command();
    delete input.expectedDraft[field];
    rejected(() => parse("command", input));
    if (field !== "providerId" && field !== "serviceAccountId" && field !== "maximumExecutionMs") {
      input.expectedDraft[field] = null;
      rejected(() => parse("command", input));
    }
  }
  for (const field of Object.keys(command().expectedDraft.workloadProfileSelection)) {
    const input = command();
    delete input.expectedDraft.workloadProfileSelection[field];
    rejected(() => parse("command", input));
  }
});

test("command cannot accept scope, original actor, current authority or receipt fields", () => {
  for (const [field, value] of Object.entries({
    ...scope(),
    action: "agent.deploy",
    kind: "deploy",
    actorId: "caller",
    accountId: "caller",
    principalId: "caller",
    requestId: `req_${uuid(16)}`,
    authorized: true,
    guard: {},
    grant: {},
    receipt: {},
    revisionId: `rev_${uuid(17)}`,
  })) {
    rejected(() => parse("command", { ...command(), [field]: value }));
  }
  for (const [kind, input] of [
    ["expectedDraft", command().expectedDraft],
    ["scope", scope()],
    ["binding", bind(scope(), command())],
  ]) {
    rejected(() => parse(kind, { ...input, authorized: true }));
  }
  rejected(() => parse("binding", { ...bind(scope(), command()), action: "agent.resume" }));
  rejected(() => bind({ ...scope(), actorId: "caller" }, command()));
  assert.deepEqual(Object.keys(bind(scope(), command())).sort(), ["action", "command", "scope"]);
  assert.equal(decode("command", { ...command(), authorized: true }).kind, "invalid");
});

test("unsupported versions, wrong revision sources and nonnative IDs reject", () => {
  for (const schemaVersion of [0, 1, 3, "2", null])
    rejected(() => parse("command", { ...command(), schemaVersion }));
  for (const revisionSource of ["retained", "latest", "savedDraft", null])
    rejected(() => parse("command", { ...command(), revisionSource }));
  for (const operationRef of [
    "ABCDEF01-0000-4000-8000-000000000004",
    "abcdef01-0000-5000-8000-000000000004",
    "abcdef01-0000-4000-7000-000000000004",
    `req_${uuid(4)}`,
    "",
  ]) {
    rejected(() => parse("command", { ...command(), operationRef }));
  }
  assert.equal(
    parse("command", { ...command(), operationRef: "abcdef01-0000-4000-8000-000000000004" })
      .operationRef,
    "abcdef01-0000-4000-8000-000000000004",
  );
  for (const [field, value] of [
    ["configurationId", uuid(5)],
    ["serviceAccountId", `cfg_${uuid(5)}`],
    ["executionMode", "native"],
    ["providerId", ""],
    ["providerId", " chatgpt"],
    ["providerId", "chatgpt\n"],
    ["providerId", "x".repeat(201)],
  ]) {
    const input = command();
    input.expectedDraft[field] = value;
    rejected(() => parse("command", input));
  }
  for (const field of Object.keys(scope())) {
    const input = scope();
    input[field] = uuid();
    rejected(() => bind(input, command()));
  }
  for (const [field, value] of [
    ["manifestRef", `profile_${uuid()}`],
    ["manifestDigest", `SHA256:${"a".repeat(64)}`],
    ["admissionRef", uuid().replace("4000", "5000")],
    ["profileRef", uuid()],
  ]) {
    const input = command();
    input.expectedDraft.workloadProfileSelection[field] = value;
    rejected(() => parse("command", input));
  }
});

test("generations keep independent positive safe integer domains and exact lexical encoding", () => {
  for (const value of [1, Number.MAX_SAFE_INTEGER]) {
    const input = command();
    input.expectedLifecycleGeneration = value;
    input.expectedDraft.configurationGeneration = value;
    input.expectedDraft.workloadProfileSelection.admissionVersion = value;
    assert.deepEqual(plain(parseJson("command", JSON.stringify(input))), input);
  }
  for (const value of [
    0,
    -0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    "1",
    undefined,
  ]) {
    const input = command();
    input.expectedLifecycleGeneration = value;
    rejected(() => parse("command", input));
    input.expectedLifecycleGeneration = null;
    input.expectedDraft.configurationGeneration = value;
    rejected(() => parse("command", input));
    input.expectedDraft.configurationGeneration = 1;
    input.expectedDraft.workloadProfileSelection.admissionVersion = value;
    rejected(() => parse("command", input));
  }
  for (const lexeme of ["7.0", "7e0", "7E+0", "7.0000000000000001", "-0", "9007199254740993"]) {
    const raw = JSON.stringify(command()).replace(
      '"configurationGeneration":7',
      `"configurationGeneration":${lexeme}`,
    );
    rejected(() => parseJson("command", raw));
  }
  rejected(() =>
    parseJson(
      "command",
      JSON.stringify(command()).replace('"schemaVersion":2', '"schemaVersion":2.0'),
    ),
  );
});

test("literal and escaped duplicate names reject at every command nesting level", () => {
  const raw = JSON.stringify(command());
  for (const [needle, replacement] of [
    ['"schemaVersion":2', '"schemaVersion":2,"schemaVersion":2'],
    ['"schemaVersion":2', '"schemaVersion":2,"schema\\u0056ersion":2'],
    ['"providerId":null', '"providerId":null,"providerId":"chatgpt"'],
    ['"serviceAccountId":null', '"serviceAccountId":null,"serviceAccount\\u0049d":null'],
    ['"admissionVersion":9', '"admissionVersion":9,"admissionVersion":10'],
  ]) {
    const duplicate = raw.replace(needle, replacement);
    rejected(() => parseJson("command", duplicate));
    assert.equal(decodeJson("command", bytes(duplicate)).kind, "invalid");
  }
  const binding = canonical(scope(), command());
  rejected(() =>
    parseJson(
      "binding",
      binding.replace('"action":"agent.deploy"', '"action":"agent.deploy","action":"agent.deploy"'),
    ),
  );
  rejected(() => parseJson("binding", binding.replace('"scope":{', '"scope":{},"scope":{')));
  rejected(() =>
    parseJson(
      "binding",
      binding.replace(
        `"agentId":"agt_${uuid(3)}"`,
        `"agentId":"agt_${uuid(3)}","agentId":"agt_${uuid(3)}"`,
      ),
    ),
  );
});

test("malformed JSON and encoding fail without replacement or normalization", () => {
  const raw = JSON.stringify(command());
  for (const text of [
    raw + "null",
    raw + ",",
    "\ufeff" + raw,
    "\u00a0" + raw,
    raw.replace('"schemaVersion":2', '"schemaVersion":02'),
    raw.replace('"schemaVersion":2', '"schemaVersion":+2'),
    raw.replace('"schemaVersion":2', '"schemaVersion":2,'),
    raw.replace('"providerId":null', '"providerId":"\\ud800"'),
    raw.replace('"providerId":null', '"providerId":"\\udfff"'),
    raw.slice(0, -1),
  ]) {
    rejected(() => parseJson("command", text));
  }
  for (const malformed of [
    new Uint8Array([0xc0, 0xaf]),
    new Uint8Array([0xed, 0xa0, 0x80]),
    new Uint8Array([0xf0, 0x9f, 0x98]),
    new Uint8Array([0xef, 0xbb, 0xbf, ...bytes(raw)]),
  ]) {
    rejected(() => parseJson("command", malformed));
  }
  const input = command();
  input.expectedDraft.providerId = "\ud800";
  rejected(() => parse("command", input));
});

test("bounded transport accepts the exact byte ceiling and rejects oversized or excessive graphs", () => {
  const raw = JSON.stringify(command());
  const padding = " ".repeat(LIFECYCLE_DEPLOY_LIMITS_V2.maxJsonBytes - bytes(raw).byteLength);
  assert.deepEqual(plain(parseJson("command", bytes(raw + padding))), command());
  rejected(() => parseJson("command", raw + padding + " "));
  rejected(() => parseJson("command", bytes(raw + padding + " ")));
  const huge = command();
  huge.expectedDraft.providerId = "é".repeat(LIFECYCLE_DEPLOY_LIMITS_V2.maxJsonBytes);
  rejected(() => parse("command", huge));
  const wide = Object.fromEntries(
    Array.from({ length: LIFECYCLE_DEPLOY_LIMITS_V2.maxContainerEntries + 1 }, (_, n) => [
      `field${n}`,
      n,
    ]),
  );
  rejected(() => parse("command", wide));
  rejected(() => parseJson("command", JSON.stringify(wide)));
  let deep = null;
  for (let n = 0; n <= LIFECYCLE_DEPLOY_LIMITS_V2.maxDepth; n++) deep = { child: deep };
  rejected(() => parse("command", deep));
  rejected(() => parseJson("command", JSON.stringify(deep)));
  const many = Array.from({ length: 64 }, () => Array.from({ length: 64 }, () => 0));
  rejected(() => parseJson("command", JSON.stringify(many)));
});

test("plain snapshots reject accessors, proxies, cycles, symbols and exotic input without invoking them", () => {
  let calls = 0;
  const accessor = command();
  Object.defineProperty(accessor.expectedDraft, "providerId", {
    enumerable: true,
    get() {
      calls++;
      return null;
    },
  });
  rejected(() => parse("command", accessor));
  const proxy = new Proxy(command(), {
    ownKeys() {
      calls++;
      throw new Error("caller detail");
    },
  });
  rejected(() => parse("command", proxy));
  assert.equal(calls, 0);
  const cyclic = command();
  cyclic.expectedDraft.workloadProfileSelection = cyclic;
  rejected(() => parse("command", cyclic));
  for (const input of [
    new Date(),
    new Map(),
    Object.assign(Object.create({ inherited: true }), command()),
    { ...command(), [Symbol("field")]: true },
  ])
    rejected(() => parse("command", input));
  const hidden = command();
  Object.defineProperty(hidden, "hidden", { value: true, enumerable: false });
  rejected(() => parse("command", hidden));
  const input = command();
  Object.setPrototypeOf(input, null);
  assert.deepEqual(plain(parse("command", input)), command());
});

test("byte transport reads intrinsic slots and rejects proxies and shared buffers", () => {
  const input = bytes(JSON.stringify(command()));
  let calls = 0;
  for (const key of ["byteLength", "byteOffset", "buffer", Symbol.iterator])
    Object.defineProperty(input, key, {
      get() {
        calls++;
        throw new Error("caller detail");
      },
    });
  assert.deepEqual(plain(parseJson("command", input)), command());
  assert.equal(calls, 0);
  rejected(() => parseJson("command", new Proxy(input, {})));
  rejected(() => parseJson("command", new Uint8Array(new SharedArrayBuffer(10))));
  for (const value of [null, {}, new ArrayBuffer(10), new Uint16Array(10), undefined])
    rejected(() => parseJson("command", value));
});

test("returned command, scope and selection are independent frozen data with closed registries", () => {
  const input = command();
  const target = scope();
  const result = bind(target, input);
  const retained = canonical(target, input);
  input.expectedDraft.configurationGeneration = 100;
  input.expectedDraft.workloadProfileSelection.admissionVersion = 100;
  target.agentId = `agt_${uuid(20)}`;
  assert.equal(canonical(result.scope, result.command), retained);
  for (const value of [
    result,
    result.scope,
    result.command,
    result.command.expectedDraft,
    result.command.expectedDraft.workloadProfileSelection,
    LifecycleDeploySchemasV2,
    LifecycleDeploySchemasV2.command,
    LifecycleDeploySchemasV2.expectedDraft.properties.workloadProfileSelection,
  ])
    assert.ok(Object.isFrozen(value));
  assert.throws(() => {
    result.command.expectedDraft.providerId = "changed";
  }, TypeError);
  for (const name of ["__proto__", "constructor", "receipt", "useV2", undefined]) {
    rejected(() => parse(name, command()));
    assert.equal(decode(name, command()).kind, "invalid");
  }
});

test("execution limit is an explicit immutable command operand with no fifteen-minute ceiling", () => {
  for (const maximumExecutionMs of [null, 1, 7_200_000, Number.MAX_SAFE_INTEGER]) {
    const value = command();
    value.expectedDraft.maximumExecutionMs = maximumExecutionMs;
    assert.equal(parse("command", value).expectedDraft.maximumExecutionMs, maximumExecutionMs);
    if (maximumExecutionMs !== null)
      assert.notEqual(canonical(scope(), value), canonical(scope(), command()));
  }
  for (const maximumExecutionMs of [undefined, 0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1, "1000"]) {
    const value = command();
    value.expectedDraft.maximumExecutionMs = maximumExecutionMs;
    rejected(() => parse("command", value));
  }
});
