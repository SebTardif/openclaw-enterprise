import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createGitHubMetadataOperationV1 as create } from "../../packages/occ/src/credential-gateway-v1/github-metadata.ts";

const uuid = "0d2e45d2-b6cc-41e9-b5fa-14fc0767dac9";
const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
function repository() {
  return {
    appId: "101",
    installationId: "202",
    repositoryId: "303",
    canonicalOwner: "octo",
    canonicalName: "demo",
    bindingGeneration: "generation-1",
    repository: {
      upstreamInstanceId: "github",
      canonicalResourceId: "303",
      canonicalPathSegments: ["octo", "demo"],
      resourceSchema: {
        namespace: "github",
        name: "repository",
        version: 1,
        digest: "schema-digest",
      },
    },
  };
}

test("fixed metadata route and original positional digest vector", () => {
  const operation = create(repository(), uuid);
  assert.ok(operation);
  assert.equal(operation.kind, "metadata");
  assert.equal(operation.target.host, "api.github.com");
  assert.equal(operation.target.method, "GET");
  assert.equal(operation.target.pathAndQuery, "/repos/octo/demo");
  assert.equal(operation.bodyDigest, emptyHash);
  const encoding = JSON.stringify([
    "oce.github-metadata-facts.v1",
    uuid,
    "metadata",
    "api.github.com",
    "GET",
    "/repos/octo/demo",
    "101",
    "202",
    "303",
    "octo",
    "demo",
    "generation-1",
    "github",
    "303",
    ["octo", "demo"],
    "github",
    "repository",
    1,
    "schema-digest",
    ["body", 0, emptyHash],
    ["content-encoding", "identity"],
    ["trailers", false],
  ]);
  assert.equal(operation.factsDigest, createHash("sha256").update(encoding).digest("hex"));
  assert.equal(
    operation.factsDigest,
    "79ed33c4b66b3404a039e8f63194f40b47619a942d2f3e5d0db86aa007dae54f",
  );
  const reversed = Object.fromEntries(Object.entries(repository()).reverse());
  assert.deepEqual(create(reversed, uuid), operation);
  assert.deepEqual(Object.keys(operation).sort(), [
    "bodyDigest",
    "factsDigest",
    "kind",
    "requestId",
    "target",
  ]);
});

test("every selected resource/schema/generation field and request identity is bound", () => {
  const original = create(repository(), uuid);
  assert.ok(original);
  const mutations = [
    (r) => {
      r.appId = "102";
    },
    (r) => {
      r.installationId = "203";
    },
    (r) => {
      r.repositoryId = "304";
    },
    (r) => {
      r.canonicalOwner = "other";
      r.repository.canonicalPathSegments[0] = "other";
    },
    (r) => {
      r.canonicalName = "other";
      r.repository.canonicalPathSegments[1] = "other";
    },
    (r) => {
      r.bindingGeneration = "generation-2";
    },
    (r) => {
      r.repository.upstreamInstanceId = "github-2";
    },
    (r) => {
      r.repository.canonicalResourceId = "304";
    },
    (r) => {
      r.repository.resourceSchema.namespace = "other";
    },
    (r) => {
      r.repository.resourceSchema.name = "other";
    },
    (r) => {
      r.repository.resourceSchema.version = 2;
    },
    (r) => {
      r.repository.resourceSchema.digest = "other";
    },
  ];
  for (const mutate of mutations) {
    const candidate = repository();
    mutate(candidate);
    const changed = create(candidate, uuid);
    assert.ok(changed);
    assert.notEqual(changed.factsDigest, original.factsDigest);
    assert.equal(changed.bodyDigest, emptyHash);
  }
  assert.notEqual(
    create(repository(), "1d2e45d2-b6cc-41e9-b5fa-14fc0767dac9").factsDigest,
    original.factsDigest,
  );
});

test("canonical safe positive decimal IDs retain original numeric limits", () => {
  for (const field of ["appId", "installationId", "repositoryId"]) {
    for (const value of [
      null,
      303,
      0,
      NaN,
      Infinity,
      "",
      "0",
      "01",
      "+1",
      "-1",
      " 1",
      "1 ",
      "1e2",
      "1.0",
      "1.5",
      "9007199254740992",
      "9999999999999999",
      "10000000000000000",
      "1\n",
    ]) {
      assert.equal(
        create({ ...repository(), [field]: value }, uuid),
        null,
        `${field}:${String(value)}`,
      );
    }
    assert.ok(create({ ...repository(), [field]: "9007199254740991" }, uuid));
    assert.ok(create({ ...repository(), [field]: "1" }, uuid));
  }
});

test("only lowercase UUIDv4 raw correlation candidates are accepted", () => {
  for (const value of [
    null,
    1,
    {},
    "",
    "candidate",
    uuid.toUpperCase(),
    `${uuid}\n`,
    uuid.replace("41e9", "31e9"),
    uuid.replace("b5fa", "75fa"),
  ]) {
    assert.equal(create(repository(), value), null);
  }
});

test("malformed selection/resource/schema/path data returns null", () => {
  for (const value of [null, undefined, 1, "x", {}, []]) assert.equal(create(value, uuid), null);
  for (const field of ["canonicalOwner", "canonicalName"]) {
    for (const value of ["", ".", "..", "a/b", "a b", "a?b", "a%b", "é", "x".repeat(101), null]) {
      assert.equal(create({ ...repository(), [field]: value }, uuid), null);
    }
  }
  const paths = [
    [],
    ["octo"],
    ["octo", "demo", "extra"],
    ["other", "demo"],
    ["octo", "other"],
    "octo/demo",
    null,
  ];
  for (const path of paths) {
    const candidate = repository();
    candidate.repository.canonicalPathSegments = path;
    assert.equal(create(candidate, uuid), null);
  }
  for (const value of [null, undefined, 1, "x", {}])
    assert.equal(create({ ...repository(), repository: value }, uuid), null);
  const fields = [
    ["bindingGeneration"],
    ["repository", "upstreamInstanceId"],
    ["repository", "canonicalResourceId"],
    ...["namespace", "name", "digest"].map((field) => ["repository", "resourceSchema", field]),
  ];
  for (const path of fields) {
    for (const value of ["", "x".repeat(1025), "x\u0000", "x\u007f", 1, null]) {
      const candidate = repository();
      const parent = path.slice(0, -1).reduce((object, key) => object[key], candidate);
      parent[path.at(-1)] = value;
      assert.equal(create(candidate, uuid), null);
    }
  }
  for (const value of [0, -1, 1.5, NaN, Infinity, "1", null, Number.MAX_SAFE_INTEGER + 1]) {
    const candidate = repository();
    candidate.repository.resourceSchema.version = value;
    assert.equal(create(candidate, uuid), null);
  }
  for (const schema of [null, undefined, 1, "x", {}]) {
    const candidate = repository();
    candidate.repository.resourceSchema = schema;
    assert.equal(create(candidate, uuid), null);
  }
  const boundary = repository();
  boundary.bindingGeneration = "x".repeat(1024);
  boundary.repository.resourceSchema.version = Number.MAX_SAFE_INTEGER;
  assert.ok(create(boundary, uuid));
});

function counted(value, counts, prefix = "") {
  if (value === null || typeof value !== "object") return value;
  const target = Array.isArray(value) ? [] : {};
  for (const key of Object.keys(value)) {
    const child = counted(value[key], counts, `${prefix}${key}.`);
    Object.defineProperty(target, key, {
      enumerable: true,
      configurable: true,
      get() {
        const path = `${prefix}${key}`;
        counts.set(path, (counts.get(path) ?? 0) + 1);
        assert.equal(counts.get(path), 1, `repeated read: ${path}`);
        return child;
      },
    });
  }
  if (!Array.isArray(value)) return target;
  return new Proxy(target, {
    get(array, key, receiver) {
      if (key === "length") {
        const path = `${prefix}length`;
        counts.set(path, (counts.get(path) ?? 0) + 1);
        assert.equal(counts.get(path), 1, `repeated read: ${path}`);
      }
      return Reflect.get(array, key, receiver);
    },
  });
}

test("nested getters are read once and no caller objects remain", () => {
  const counts = new Map();
  const input = counted(repository(), counts);
  const operation = create(input, uuid);
  assert.ok(operation);
  assert.equal(counts.size, 18);
  for (const reads of counts.values()) assert.equal(reads, 1);
  assert.notEqual(operation.target.repository, input);
  assert.deepEqual(operation.target.repository, repository());
});

test("every required throwing getter fails closed, including proxied path access", () => {
  const paths = [
    ["appId"],
    ["installationId"],
    ["repositoryId"],
    ["canonicalOwner"],
    ["canonicalName"],
    ["bindingGeneration"],
    ["repository"],
    ...["upstreamInstanceId", "canonicalResourceId", "resourceSchema", "canonicalPathSegments"].map(
      (key) => ["repository", key],
    ),
    ...["namespace", "name", "version", "digest"].map((key) => [
      "repository",
      "resourceSchema",
      key,
    ]),
    ...["0", "1"].map((key) => ["repository", "canonicalPathSegments", key]),
  ];
  for (const path of paths) {
    const input = repository();
    const parent = path.slice(0, -1).reduce((object, key) => object[key], input);
    Object.defineProperty(parent, path.at(-1), {
      get() {
        throw new Error("throwing operand");
      },
    });
    assert.equal(create(input, uuid), null, path.join("."));
  }
  const input = repository();
  input.repository.canonicalPathSegments = new Proxy(input.repository.canonicalPathSegments, {
    get(target, key, receiver) {
      if (key === "length") throw new Error("length");
      return Reflect.get(target, key, receiver);
    },
  });
  assert.equal(create(input, uuid), null);
  const revocable = Proxy.revocable(repository(), {});
  revocable.revoke();
  assert.equal(create(revocable.proxy, uuid), null);
});

test("reentrant getters cannot replace another construction snapshot", () => {
  const input = repository();
  const independent = repository();
  independent.repositoryId = "404";
  let inner;
  Object.defineProperty(input, "appId", {
    get() {
      inner = create(independent, uuid);
      return "101";
    },
  });
  const outer = create(input, uuid);
  assert.ok(outer);
  assert.ok(inner);
  assert.equal(outer.target.repository.repositoryId, "303");
  assert.equal(inner.target.repository.repositoryId, "404");
  assert.notEqual(inner.factsDigest, outer.factsDigest);
});

test("construction tolerates mutations during getters and owns complete deep immutability", () => {
  const input = repository();
  const originalSchema = input.repository.resourceSchema;
  Object.defineProperty(originalSchema, "digest", {
    get() {
      input.appId = "999";
      return "schema-digest";
    },
  });
  const operation = create(input, uuid);
  assert.ok(operation);
  assert.equal(operation.target.repository.appId, "101");
  const before = JSON.stringify(operation);
  input.repository.canonicalPathSegments[0] = "changed";
  input.repository.canonicalResourceId = "changed";
  input.repository.resourceSchema = {};
  assert.equal(JSON.stringify(operation), before);
  const objects = [
    operation,
    operation.target,
    operation.target.repository,
    operation.target.repository.repository,
    operation.target.repository.repository.resourceSchema,
    operation.target.repository.repository.canonicalPathSegments,
  ];
  for (const object of objects) {
    assert.ok(Object.isFrozen(object));
    for (const key of Object.keys(object))
      assert.throws(() => {
        object[key] = "changed";
      }, TypeError);
    assert.throws(() => {
      object.extra = true;
    }, TypeError);
    assert.throws(() => Object.setPrototypeOf(object, {}), TypeError);
  }
  assert.throws(
    () => operation.target.repository.repository.canonicalPathSegments.push("extra"),
    TypeError,
  );
  assert.equal(JSON.stringify(operation), before);
});
