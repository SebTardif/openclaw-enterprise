import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  WORKLOAD_PROFILE_CANONICAL_FORMAT,
  WORKLOAD_PROFILE_DIGEST_DOMAINS,
  WORKLOAD_PROFILE_JSON_LIMITS,
  WORKLOAD_PROFILE_OPERATOR_DIGEST_DOMAINS,
  WorkloadProfileJsonError,
  canonicalizeWorkloadProfileJson,
  decodeWorkloadProfileJson,
  operatorIntentDigest,
  operatorOperationDigest,
  workloadProfileDigest,
} from "../../packages/occ/src/workload-profiles/canonical.ts";

// These fixtures exercise the lexical utility, not a complete manifest schema,
// profile admission, authorization, storage, or any runtime producer.
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const bytes = (text) => encoder.encode(text);
const canonical = (value, mode) => decoder.decode(canonicalizeWorkloadProfileJson(value, mode));
const parse = (text, mode) => decodeWorkloadProfileJson(bytes(text), mode);
const rejects = (work, code) =>
  assert.throws(work, (error) => {
    assert.ok(error instanceof WorkloadProfileJsonError);
    if (code !== undefined) assert.equal(error.code, code);
    return true;
  });

test("format identity and finite lexical limits are explicit and immutable", () => {
  assert.equal(WORKLOAD_PROFILE_CANONICAL_FORMAT, "oce.workload-profile.canonical-json.v1");
  assert.deepEqual(WORKLOAD_PROFILE_JSON_LIMITS, {
    maxBytes: 65_536,
    maxDepth: 32,
    maxContainerEntries: 1_024,
    maxNodes: 8_192,
  });
  assert.equal(Object.isFrozen(WORKLOAD_PROFILE_JSON_LIMITS), true);
});

for (const [name, raw] of [
  ["root", '{"a":1,"a":2}'],
  ["nested object", '{"outer":{"a":1,"a":2}}'],
  ["object inside array", '[0,{"outer":[{"a":1,"a":2}]}]'],
  ["escaped decoded key", '{"a":1,"\\u0061":2}'],
  ["escaped nested decoded key", '{"a":[{"\\u0062":1,"b":2}]}'],
  ["prototype-named key", '{"__proto__":1,"__proto__":2}'],
]) {
  test(`duplicate properties reject at ${name}`, () => {
    rejects(() => parse(raw), "duplicate-key");
  });
}

test("separate objects may use the same key and preserve their array order", () => {
  const result = parse('[{"a":2},{"a":1}]');
  assert.equal(decoder.decode(result.canonicalBytes), '[{"a":2},{"a":1}]');
});

for (const raw of [
  "-0",
  "-1",
  "+1",
  "1.0",
  "0.5",
  ".5",
  "1e0",
  "1E0",
  "1e+1",
  "1e-1",
  "1e309",
  "00",
  "01",
  "9007199254740992",
  "9007199254740993",
  "999999999999999999999999",
]) {
  test(`integer grammar rejects raw ${raw} without losing its lexeme`, () => {
    rejects(() => parse(`{"number":${raw}}`), "invalid-number");
  });
}

for (const raw of ["NaN", "Infinity", "-Infinity", "undefined"]) {
  test(`non-JSON numeric/value token ${raw} rejects`, () => {
    rejects(() => parse(raw));
  });
}

test("unsigned safe integers and booleans retain their primitive types", () => {
  const result = parse('[0,1,9007199254740991,true,false,"1"]');
  assert.deepEqual(result.value, [0, 1, Number.MAX_SAFE_INTEGER, true, false, "1"]);
  assert.equal(decoder.decode(result.canonicalBytes), '[0,1,9007199254740991,true,false,"1"]');
});

for (const value of [-0, -1, 0.1, NaN, Infinity, -Infinity, 2 ** 53]) {
  test(`object encoding rejects disallowed number ${Object.is(value, -0) ? "-0" : value}`, () => {
    rejects(() => canonical({ number: value }), "invalid-number");
  });
}

for (const [name, input] of [
  ["truncated two-byte scalar", [0x22, 0xc2, 0x22]],
  ["lone continuation", [0x22, 0x80, 0x22]],
  ["overlong slash", [0x22, 0xc0, 0xaf, 0x22]],
  ["UTF-8 surrogate", [0x22, 0xed, 0xa0, 0x80, 0x22]],
  ["above Unicode range", [0x22, 0xf4, 0x90, 0x80, 0x80, 0x22]],
  ["truncated four-byte scalar", [0x22, 0xf0, 0x9f]],
]) {
  test(`fatal UTF-8 rejects ${name}`, () => {
    rejects(() => decodeWorkloadProfileJson(Uint8Array.from(input)), "invalid-utf8");
  });
}

test("decoder takes UTF-8 bytes and never an already replacement-decoded string", () => {
  rejects(() => decodeWorkloadProfileJson('{"a":1}'), "invalid-input");
  rejects(() => decodeWorkloadProfileJson(new Uint16Array([1])), "invalid-input");
  rejects(() => decodeWorkloadProfileJson(new DataView(new ArrayBuffer(2))), "invalid-input");
  assert.equal(decoder.decode(decodeWorkloadProfileJson(Buffer.from("1")).canonicalBytes), "1");
  // U+FFFD is a valid scalar when it really was present in the original bytes.
  assert.equal(parse('"�"').value, "�");
});

test("byte-input validation does not invoke overridden getters or iterators", () => {
  const input = bytes('{"a":1}');
  let invoked = 0;
  for (const key of ["byteLength", "buffer", Symbol.iterator]) {
    Object.defineProperty(input, key, {
      get() {
        invoked += 1;
        throw new Error("called");
      },
    });
  }
  assert.equal(decoder.decode(decodeWorkloadProfileJson(input).canonicalBytes), '{"a":1}');
  assert.equal(invoked, 0);
});

test("shared mutable byte storage and proxy input reject", () => {
  rejects(
    () => decodeWorkloadProfileJson(new Uint8Array(new SharedArrayBuffer(8))),
    "invalid-input",
  );
  let invoked = 0;
  const input = new Proxy(bytes("1"), {
    get() {
      invoked += 1;
      throw new Error("called");
    },
  });
  rejects(() => decodeWorkloadProfileJson(input), "invalid-input");
  assert.equal(invoked, 0);
});

for (const raw of [
  '"\\ud800"',
  '"\\udfff"',
  '"\\ud800x"',
  '"\\ud800\\ud800"',
  '"\\udc00\\ud800"',
  '{"\\ud800":1}',
]) {
  test(`unpaired escaped surrogate rejects ${raw}`, () => {
    rejects(() => parse(raw), "invalid-unicode");
  });
}

test("encoding rejects unpaired JavaScript surrogates before UTF-8 replacement", () => {
  for (const value of ["\ud800", "\udc00", "\ud800x", "x\udfff"]) {
    rejects(() => canonical(value), "invalid-unicode");
  }
});

test("paired surrogates, literal scalar values and escaped scalars canonicalize identically", () => {
  const literal = parse('"😀é"');
  const escaped = parse('"\\uD83D\\uDE00\\u00e9"');
  assert.deepEqual(literal.canonicalBytes, escaped.canonicalBytes);
  assert.equal(decoder.decode(literal.canonicalBytes), '"😀é"');
});

test("Unicode values retain normalization, case and line-separator distinctions", () => {
  assert.notDeepEqual(parse('"é"').canonicalBytes, parse('"é"').canonicalBytes);
  assert.notDeepEqual(parse('"A"').canonicalBytes, parse('"a"').canonicalBytes);
  assert.equal(canonical("\u2028\u2029"), '"\u2028\u2029"');
  assert.equal(canonical("\ufeff"), '"\ufeff"');
});

for (const raw of ['{"é":1}', '{"\\u00e9":1}', '{"a":{"😀":1}}']) {
  test(`non-ASCII decoded schema key rejects ${raw}`, () => {
    rejects(() => parse(raw), "non-ascii-key");
  });
}

test("object encoder also enforces ASCII schema keys", () => {
  rejects(() => canonical({ é: 1 }), "non-ascii-key");
});

test("canonical strings use the specified escapes and no trailing newline", () => {
  const value = String.fromCharCode(...Array.from({ length: 32 }, (_, index) => index)) + '"\\/é😀';
  const expected =
    '"\\u0000\\u0001\\u0002\\u0003\\u0004\\u0005\\u0006\\u0007\\b\\t\\n\\u000b\\f\\r\\u000e\\u000f\\u0010\\u0011\\u0012\\u0013\\u0014\\u0015\\u0016\\u0017\\u0018\\u0019\\u001a\\u001b\\u001c\\u001d\\u001e\\u001f\\"\\\\/é😀"';
  assert.equal(canonical(value), expected);
  assert.equal(decoder.decode(parse(expected).canonicalBytes), expected);
  assert.equal(decoder.decode(parse('"\\/"').canonicalBytes), '"/"');
  assert.notEqual(canonicalizeWorkloadProfileJson(value).at(-1), 0x0a);
});

test("ASCII property sorting does not use insertion or numeric enumeration order", () => {
  const raw = '{"z":0,"2":2,"a":{"b":2,"A":1},"10":10,"_":0,"A":0}';
  assert.equal(
    decoder.decode(parse(raw).canonicalBytes),
    '{"10":10,"2":2,"A":0,"_":0,"a":{"A":1,"b":2},"z":0}',
  );
});

test("object reordering preserves digest but ordered-array reordering changes it", () => {
  assert.equal(
    workloadProfileDigest("manifestDigest", { z: 0, a: [2, 1] }),
    workloadProfileDigest("manifestDigest", { a: [2, 1], z: 0 }),
  );
  assert.notEqual(
    workloadProfileDigest("manifestDigest", { a: [2, 1] }),
    workloadProfileDigest("manifestDigest", { a: [1, 2] }),
  );
  // Schema-defined sets need their own normalizer; this utility preserves repeats.
  assert.equal(canonical(["role", "role"]), '["role","role"]');
});

for (const raw of [
  "",
  " ",
  "\ufeff{}",
  "\u00a0{}",
  "\v{}",
  "{}\ufeff",
  "{}{}",
  "true false",
  '{"a":1,}',
  "[1,]",
  "[,1]",
  '{"a" 1}',
  "{a:1}",
  "/* comment */1",
  '"line\nfeed"',
  '"\\x41"',
  '"\\u123"',
  '"\\uZZZZ"',
  '"unterminated',
  "[",
  "{",
]) {
  test(`JSON grammar rejects ${JSON.stringify(raw)}`, () => {
    rejects(() => parse(raw), "invalid-json");
  });
}

test("only JSON whitespace is ignored before canonical serialization", () => {
  assert.equal(
    decoder.decode(parse(' \r\n\t{ "a" : [ true , false ] } \t\n').canonicalBytes),
    '{"a":[true,false]}',
  );
});

test("manifest content rejects null at every depth and operator mode is explicit", () => {
  for (const raw of ["null", '{"expectedAdmission":null}', '[{"a":null}]']) {
    rejects(() => parse(raw), "null-forbidden");
    rejects(() => canonical(JSON.parse(raw)), "null-forbidden");
    assert.equal(canonical(parse(raw, "operator-envelope").value, "operator-envelope"), raw);
  }
  const envelope = parse('{"expectedAdmission":null}', "operator-envelope");
  rejects(() => workloadProfileDigest("manifestDigest", envelope.value), "null-forbidden");
  rejects(() => workloadProfileDigest("artifactSetDigest", envelope.value), "null-forbidden");
  // Only a schema owner can decide where an envelope permits null.
  assert.deepEqual(Object.keys(envelope), ["value", "canonicalBytes"]);
});

test("unknown codec mode rejects rather than enabling null", () => {
  rejects(() => parse("null", "anything"), "invalid-mode");
  rejects(() => canonical(null, { allowNull: true }), "invalid-mode");
});

test("decoded data is deeply frozen and prototype-named own data is inert", () => {
  const result = parse('{"__proto__":{"safe":1},"constructor":{"prototype":2},"items":[{"a":1}]}');
  assert.equal(Object.getPrototypeOf(result.value), null);
  assert.equal(Object.getPrototypeOf(result.value.__proto__), null);
  assert.equal(Object.getPrototypeOf(result.value.items[0]), null);
  for (const item of [
    result,
    result.value,
    result.value.__proto__,
    result.value.constructor,
    result.value.items,
    result.value.items[0],
  ]) {
    assert.equal(Object.isFrozen(item), true);
  }
  assert.equal(Object.hasOwn(result.value, "__proto__"), true);
  assert.equal(result.value.__proto__.safe, 1);
  assert.equal(Object.prototype.safe, undefined);
  assert.throws(() => {
    result.value.items[0].a = 2;
  }, TypeError);
  assert.equal(
    decoder.decode(result.canonicalBytes),
    '{"__proto__":{"safe":1},"constructor":{"prototype":2},"items":[{"a":1}]}',
  );
});

test("input and output bytes cannot mutate the independently frozen value", () => {
  const input = bytes('{"a":[1]}');
  const result = decodeWorkloadProfileJson(input);
  input.fill(0);
  assert.equal(decoder.decode(result.canonicalBytes), '{"a":[1]}');
  result.canonicalBytes.fill(0);
  assert.equal(canonical(result.value), '{"a":[1]}');
});

test("accessors, coercion hooks and proxy traps never execute", () => {
  let invoked = 0;
  const called = () => {
    invoked += 1;
    throw new Error("must not execute");
  };
  const getter = Object.defineProperty({}, "a", { enumerable: true, get: called });
  const arrayGetter = Object.defineProperty([1], "0", { enumerable: true, get: called });
  const toJson = { toJSON: called };
  const toPrimitive = { [Symbol.toPrimitive]: called };
  const proxy = new Proxy(
    {},
    { get: called, ownKeys: called, getPrototypeOf: called, getOwnPropertyDescriptor: called },
  );
  for (const value of [getter, arrayGetter, toJson, toPrimitive, proxy, [proxy]]) {
    rejects(() => canonical(value), "unsupported-value");
  }
  assert.equal(invoked, 0);
});

test("only data-only plain objects and dense ordinary arrays are encodable", () => {
  const sparse = Array(1);
  const extraArray = Object.assign([1], { extra: 2 });
  const symbolArray = [1];
  symbolArray[Symbol("extra")] = 2;
  const nonenumerable = Object.defineProperty({}, "hidden", { value: 1 });
  const nonenumerableArray = Object.defineProperty([1], "0", { enumerable: false });
  const cycle = {};
  cycle.self = cycle;
  for (const value of [
    undefined,
    () => 1,
    1n,
    Symbol("s"),
    new Date(0),
    new Map(),
    new Set(),
    new Number(1),
    new String("x"),
    new Boolean(false),
    new Uint8Array([1]),
    Object.create({ inherited: 1 }),
    Object.assign(
      Object.create({
        toJSON() {
          throw new Error("called");
        },
      }),
      { a: 1 },
    ),
    sparse,
    extraArray,
    symbolArray,
    nonenumerable,
    nonenumerableArray,
    { [Symbol("key")]: 1 },
    cycle,
    Object.setPrototypeOf([1], null),
  ]) {
    rejects(() => canonical(value), "unsupported-value");
  }
  const shared = Object.freeze({ value: 1 });
  assert.equal(canonical([shared, shared]), '[{"value":1},{"value":1}]');
  const data = Object.assign(Object.create(null), { a: 1 });
  assert.equal(canonical(data), '{"a":1}');
});

test("raw and canonical UTF-8 byte limits accept exactly 64 KiB", () => {
  const text = '"' + "a".repeat(65_534) + '"';
  assert.equal(parse(text).canonicalBytes.byteLength, 65_536);
  assert.equal(canonicalizeWorkloadProfileJson("a".repeat(65_534)).byteLength, 65_536);
  rejects(() => parse(text + " "), "byte-limit");
  rejects(() => parse('"' + "a".repeat(65_535) + '"'), "byte-limit");
  rejects(() => canonical("a".repeat(65_535)), "byte-limit");
  rejects(() => canonical({ ["a".repeat(65_537)]: 0 }), "byte-limit");
});

test("byte limits count multibyte scalars and canonical control escapes", () => {
  const value = "😀".repeat(16_383) + "é";
  assert.equal(canonicalizeWorkloadProfileJson(value).byteLength, 65_536);
  assert.equal(parse(JSON.stringify(value)).canonicalBytes.byteLength, 65_536);
  rejects(() => canonical(value + "a"), "byte-limit");
  rejects(() => parse(JSON.stringify(value + "a")), "byte-limit");
  const controls = "\0".repeat(10_922) + "aa";
  assert.equal(canonicalizeWorkloadProfileJson(controls).byteLength, 65_536);
  rejects(() => canonical(controls + "a"), "byte-limit");
});

function nestedContainers(depth) {
  let value = 0;
  for (let index = 0; index < depth; index += 1) {
    value = index % 2 === 0 ? [value] : { a: value };
  }
  return value;
}

test("both lexical and object paths enforce container depth 32 inclusively", () => {
  const permitted = nestedContainers(32);
  const excessive = nestedContainers(33);
  assert.equal(canonical(permitted), JSON.stringify(permitted));
  assert.equal(
    decoder.decode(parse(JSON.stringify(permitted)).canonicalBytes),
    JSON.stringify(permitted),
  );
  rejects(() => canonical(excessive), "depth-limit");
  rejects(() => parse(JSON.stringify(excessive)), "depth-limit");
});

test("both paths enforce 1024 entries per array and object inclusively", () => {
  for (const make of [
    (count) => Array(count).fill(0),
    (count) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`k${index}`, 0])),
  ]) {
    const permitted = make(1_024);
    const excessive = make(1_025);
    assert.deepEqual(
      parse(JSON.stringify(permitted)).canonicalBytes,
      canonicalizeWorkloadProfileJson(permitted),
    );
    rejects(() => canonical(excessive), "container-limit");
    rejects(() => parse(JSON.stringify(excessive)), "container-limit");
  }
});

test("both paths enforce 8192 value nodes independently of per-container limits", () => {
  // One root + eight child arrays + 8183 scalar values = 8192 nodes.
  const permitted = [
    ...Array.from({ length: 7 }, () => Array(1_024).fill(0)),
    Array(1_015).fill(0),
  ];
  const excessive = [...permitted.slice(0, 7), Array(1_016).fill(0)];
  assert.deepEqual(
    parse(JSON.stringify(permitted)).canonicalBytes,
    canonicalizeWorkloadProfileJson(permitted),
  );
  rejects(() => canonical(excessive), "node-limit");
  rejects(() => parse(JSON.stringify(excessive)), "node-limit");
});

test("fixed independent canonical and domain digest vectors agree", () => {
  const value = { z: 0, a: ["é", "😀"] };
  assert.equal(canonical(value), '{"a":["é","😀"],"z":0}');
  assert.equal(
    workloadProfileDigest("manifestDigest", value),
    "sha256:50c64e0b22501389e536d3e0e64a471cd2474cb45099c90ba75f27b186e38b97",
  );
  assert.equal(
    operatorIntentDigest(value),
    "sha256:01b8b10be7926b60683afaee31bd6681819a205293f544bea8cb1e36154b1d2b",
  );
  assert.equal(
    operatorOperationDigest(value),
    "sha256:1c79a23dc575fff6020e0e6c6870a66c910a70866eff1bf06732e72a946e1e19",
  );
});

test("all content domains have exactly one LF and distinct digest meanings", () => {
  const expected = {
    manifestDigest: "manifest",
    artifactSetDigest: "artifact-set",
    launchConfigurationDigest: "launch-configuration",
    containmentDigest: "containment",
    endpointsDigest: "endpoints",
    evidenceRequirementsDigest: "evidence-requirements",
    providerProfileDigest: "provider-profile",
    runtimeProfileDigest: "runtime-profile",
    identityProfileDigest: "identity-profile",
    storageProfileDigest: "storage-profile",
    imageSetDigest: "image-set",
    mountPolicyDigest: "mount-policy",
    resourceEnvelopeDigest: "resource-envelope",
    runtimeFlagsDigest: "runtime-flags",
    admittedConfigurationDigest: "admitted-configuration",
  };
  assert.deepEqual(Object.keys(WORKLOAD_PROFILE_DIGEST_DOMAINS), Object.keys(expected));
  const hashes = new Set();
  for (const [key, suffix] of Object.entries(expected)) {
    const prefix = `oce.workload-profile.${suffix}.v1\n`;
    assert.equal(WORKLOAD_PROFILE_DIGEST_DOMAINS[key], prefix);
    const actual = workloadProfileDigest(key, { a: 1 });
    assert.equal(
      actual,
      `sha256:${createHash("sha256")
        .update(prefix + '{"a":1}', "utf8")
        .digest("hex")}`,
    );
    assert.match(actual, /^sha256:[0-9a-f]{64}$/);
    assert.notEqual(actual, workloadProfileDigest(key, { a: 2 }));
    hashes.add(actual);
  }
  assert.equal(hashes.size, 15);
  assert.equal(Object.isFrozen(WORKLOAD_PROFILE_DIGEST_DOMAINS), true);
  const canonicalBytes = bytes('{"a":1}');
  for (const prefix of [
    "",
    "oce.workload-profile.manifest.v1",
    "oce.workload-profile.manifest.v1\\n",
    "oce.workload-profile.manifest.v1\n\n",
  ]) {
    assert.notEqual(
      workloadProfileDigest("manifestDigest", { a: 1 }),
      `sha256:${createHash("sha256").update(prefix).update(canonicalBytes).digest("hex")}`,
    );
  }
});

test("operator domains separate ordinary client intent from allocated operation content", () => {
  assert.deepEqual(WORKLOAD_PROFILE_OPERATOR_DIGEST_DOMAINS, {
    clientIntentDigest: "oce.workload-profile.operator-intent.v1\n",
    operationDigest: "oce.workload-profile.operator-operation.v1\n",
  });
  assert.equal(Object.isFrozen(WORKLOAD_PROFILE_OPERATOR_DIGEST_DOMAINS), true);
  const intent = { action: "admit", expectedAdmission: null };
  const clientIntentDigest = operatorIntentDigest(intent);
  assert.notEqual(clientIntentDigest, operatorOperationDigest(intent));
  const operation = { clientIntentDigest, allocatedIdentity: "first" };
  assert.notEqual(
    operatorOperationDigest(operation),
    operatorOperationDigest({ ...operation, allocatedIdentity: "second" }),
  );
  assert.equal(operatorIntentDigest(intent), clientIntentDigest);
  assert.notEqual(clientIntentDigest, operatorIntentDigest({ ...intent, action: "replace" }));
});

test("unknown or coerced digest domain names reject", () => {
  let invoked = 0;
  for (const domain of [
    "toString",
    "__proto__",
    "clientIntentDigest",
    "manifest",
    {
      toString() {
        invoked += 1;
        return "manifestDigest";
      },
    },
  ]) {
    rejects(() => workloadProfileDigest(domain, {}), "invalid-domain");
  }
  assert.equal(invoked, 0);
});
