import assert from "node:assert/strict";
import test from "node:test";
import {
  parseGitSnapshotDescriptor,
  parseGitSnapshotRequest,
  snapshotData,
  GitObjectStoreError,
} from "../../packages/occ/src/git-object-store/contract.ts";

const oid = (digit) => digit.repeat(40);
const digest = (digit) => `sha256:${digit.repeat(64)}`;
const refuses = (fn) => assert.throws(fn, GitObjectStoreError);
const request = () => ({
  baseOid: oid("a"),
  proposedOid: oid("b"),
  expectedTarget: { kind: "existing", oid: oid("c") },
});
const graph = () => ({
  version: 1,
  objectFormat: "sha1",
  proposedOid: oid("b"),
  baseOid: oid("a"),
  graphDigest: digest("d"),
  objectCount: 3,
  rawBytes: 200,
  packSha256: digest("e"),
  packBytes: 180,
});

test("snapshot input retains the selected roots independently of caller mutation", () => {
  const input = request();
  const fixed = parseGitSnapshotRequest(input);
  input.baseOid = oid("d");
  input.expectedTarget.oid = oid("e");
  assert.equal(fixed.baseOid, oid("a"));
  assert.equal(fixed.expectedTarget.oid, oid("c"));
  assert.ok(Object.isFrozen(fixed));
  assert.ok(Object.isFrozen(fixed.expectedTarget));
  const creation = parseGitSnapshotRequest({ ...request(), expectedTarget: { kind: "create" } });
  assert.equal(creation.expectedTarget.kind, "create");
  // Retaining an already-current commit is valid; only a later publishing
  // operation decides whether updating a branch would be a no-op.
  const unchanged = request();
  unchanged.expectedTarget.oid = unchanged.proposedOid;
  assert.equal(parseGitSnapshotRequest(unchanged).expectedTarget.oid, unchanged.proposedOid);
});

test("snapshot input rejects malformed roots and unsupported constraints", () => {
  for (const change of [
    (r) => {
      r.baseOid += "\n";
    },
    (r) => {
      r.proposedOid = "0".repeat(40);
    },
    (r) => {
      r.proposedOid = "A".repeat(40);
    },
    (r) => {
      delete r.baseOid;
    },
    (r) => {
      r.repository = "unrelated";
    },
    (r) => {
      r.expectedTarget = { kind: "existing" };
    },
    (r) => {
      r.expectedTarget = { kind: "existing", oid: oid("c") + "\n" };
    },
    (r) => {
      r.expectedTarget = { kind: "create", oid: oid("c") };
    },
    (r) => {
      r.expectedTarget = { kind: "force", oid: oid("c") };
    },
    (r) => {
      r.expectedTarget = null;
    },
  ]) {
    const input = request();
    change(input);
    refuses(() => parseGitSnapshotRequest(input));
  }
});

test("snapshot descriptors require valid digests, object counts and sizes", () => {
  const input = graph();
  const fixed = parseGitSnapshotDescriptor(input);
  input.packSha256 = digest("f");
  assert.equal(fixed.packSha256, digest("e"));
  assert.ok(Object.isFrozen(fixed));
  for (const change of [
    (g) => {
      g.version = 2;
    },
    (g) => {
      g.objectFormat = "sha256";
    },
    (g) => {
      g.baseOid += "\n";
    },
    (g) => {
      g.graphDigest += "\n";
    },
    (g) => {
      g.packSha256 = "sha256:" + "g".repeat(64);
    },
    (g) => {
      g.objectCount = 0;
    },
    (g) => {
      g.rawBytes = -1;
    },
    (g) => {
      g.packBytes = 1.5;
    },
    (g) => {
      g.objectCount = Number.MAX_SAFE_INTEGER + 1;
    },
    (g) => {
      g.extra = true;
    },
  ]) {
    const input = graph();
    change(input);
    refuses(() => parseGitSnapshotDescriptor(input));
  }
});

test("snapshot rejects executable object structure without invoking its accessors or proxy traps", () => {
  let invoked = 0;
  const accessor = Object.defineProperty({}, "field", {
    enumerable: true,
    get() {
      invoked++;
      return "value";
    },
  });
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        invoked++;
        throw Error("must not execute");
      },
      getPrototypeOf() {
        invoked++;
        throw Error("must not execute");
      },
    },
  );
  const withJSON = {
    toJSON() {
      invoked++;
      return {};
    },
  };
  for (const value of [
    accessor,
    proxy,
    withJSON,
    new Date(),
    new Uint8Array([1]),
    Object.create({ inherited: true }),
  ]) {
    refuses(() => snapshotData(value));
  }
  assert.equal(invoked, 0);
  const sparse = [];
  sparse.length = 2;
  refuses(() => snapshotData(sparse));
  const cyclic = {};
  cyclic.self = cyclic;
  refuses(() => snapshotData(cyclic));
  const symbols = { [Symbol("hidden")]: "hidden" };
  refuses(() => snapshotData(symbols));
});

test("snapshot bounds escaped encoded bytes and aggregate shape before accepting data", () => {
  assert.equal(snapshotData("a".repeat(131072)).length, 131072);
  refuses(() => snapshotData("a".repeat(131073)));
  // The raw string fits the per-string limit but JSON escape expansion exceeds
  // the aggregate budget; testing only its unescaped length would miss this.
  refuses(() => snapshotData("\0".repeat(44000)));
  refuses(() => snapshotData(Array.from({ length: 7 }, () => "a".repeat(40000))));
  let deep = null;
  for (let i = 0; i < 34; i++) deep = { child: deep };
  refuses(() => snapshotData(deep));
});
