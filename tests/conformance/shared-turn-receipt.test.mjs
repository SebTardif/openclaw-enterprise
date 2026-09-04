import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  parseReceiptIdentityV1,
  classifyReceiptV1,
} from "../../apps/controller/src/channels/shared-turn-receipt.ts";

const digest = (character) => `sha256:${character.repeat(64)}`;
function input(overrides = {}) {
  return {
    schemaVersion: 1,
    installationRef: "enterprise-a",
    channelInstallationRef: "channel-install-a",
    platform: "slack",
    providerTenantRef: "workspace-a",
    recipientAppRef: "app-a",
    normalizationProfileRef: "profile-v1",
    providerEventRef: "event-1",
    eventDigest: digest("a"),
    providerMessageRef: "message-1",
    contentDigest: digest("b"),
    providerSubjectRef: "person-a",
    channelRef: "channel-a",
    rootThreadRef: "thread-a",
    ...overrides,
  };
}
function identity(overrides = {}) {
  const parsed = parseReceiptIdentityV1(input(overrides));
  assert.equal("kind" in parsed, false);
  return parsed;
}
function snapshot(parsed = identity(), disposition = "accepted", overrides = {}) {
  return {
    identity: parsed,
    ownerReceiptRef: "receipt-1",
    disposition,
    ...(disposition === "accepted" ? { turnRef: "turn-1" } : {}),
    ...overrides,
  };
}

test("exact replay preserves the canonical accepted owner and turn", () => {
  const current = identity();
  assert.deepEqual(classifyReceiptV1(current, snapshot(), snapshot()), {
    kind: "duplicate",
    ownerReceiptRef: "receipt-1",
    disposition: "accepted",
    turnRef: "turn-1",
  });
  assert.equal(classifyReceiptV1(current).kind, "new-candidate");
});

test("logical twins may change raw event identity and digest", () => {
  const twin = identity({ providerEventRef: "event-2", eventDigest: digest("c") });
  assert.notEqual(twin.eventKey, identity().eventKey);
  assert.equal(twin.logicalMessageKey, identity().logicalMessageKey);
  assert.equal(classifyReceiptV1(twin, undefined, snapshot()).kind, "duplicate");
  // Event aliases retain the original logical owner's reference.
  assert.equal(classifyReceiptV1(twin, snapshot(twin), snapshot()).kind, "duplicate");
});

for (const disposition of ["accepted", "busy", "denied", "ignored", "pending"]) {
  test(`recorded ${disposition} remains final or pending across both lookup paths`, () => {
    const row = snapshot(identity(), disposition);
    for (const args of [
      [row, undefined],
      [undefined, row],
      [row, row],
    ]) {
      const result = classifyReceiptV1(identity(), ...args);
      assert.equal(result.kind, disposition === "pending" ? "existing-pending" : "duplicate");
      assert.equal(result.ownerReceiptRef, "receipt-1");
      if (disposition !== "pending") assert.equal(result.disposition, disposition);
    }
  });
}

for (const field of [
  "normalizationProfileRef",
  "providerSubjectRef",
  "rootThreadRef",
  "contentDigest",
]) {
  test(`${field} disagreement conflicts under the original uniqueness keys`, () => {
    const changed = identity({ [field]: field === "contentDigest" ? digest("c") : "changed" });
    assert.equal(changed.eventKey, identity().eventKey);
    assert.equal(changed.logicalMessageKey, identity().logicalMessageKey);
    assert.equal(classifyReceiptV1(changed, snapshot()).kind, "conflict");
    assert.equal(classifyReceiptV1(changed, undefined, snapshot()).kind, "conflict");
  });
}

test("event digest and message target disagreement cannot become a candidate", () => {
  for (const changed of [
    { eventDigest: digest("c") },
    { providerMessageRef: "another" },
    { channelRef: "another" },
  ]) {
    assert.equal(classifyReceiptV1(identity(changed), snapshot()).kind, "conflict");
  }
});

for (const field of [
  "installationRef",
  "channelInstallationRef",
  "platform",
  "providerTenantRef",
  "recipientAppRef",
]) {
  test(`${field} separates scopes and rejects foreign snapshots`, () => {
    const changed = identity({ [field]: field === "platform" ? "msteams" : "other-scope" });
    assert.notEqual(changed.eventKey, identity().eventKey);
    assert.notEqual(changed.logicalMessageKey, identity().logicalMessageKey);
    assert.deepEqual(classifyReceiptV1(changed, snapshot()), {
      kind: "invalid",
      reason: "snapshot-key",
    });
    assert.deepEqual(classifyReceiptV1(changed, undefined, snapshot()), {
      kind: "invalid",
      reason: "snapshot-key",
    });
  });
}

test("channels isolate logical identity and foreign exact-key rows are invalid", () => {
  const changed = identity({ channelRef: "other-channel" });
  assert.notEqual(changed.logicalMessageKey, identity().logicalMessageKey);
  assert.equal(classifyReceiptV1(changed, undefined, snapshot()).kind, "invalid");
});

test("conflicting owner, decision and accepted turn cannot win by argument order", () => {
  const original = snapshot();
  for (const other of [
    snapshot(identity(), "accepted", { ownerReceiptRef: "receipt-2" }),
    snapshot(identity(), "busy"),
    snapshot(identity(), "pending"),
    snapshot(identity(), "accepted", { turnRef: "turn-2" }),
  ]) {
    assert.equal(classifyReceiptV1(identity(), original, other).kind, "conflict");
    assert.equal(classifyReceiptV1(identity(), other, original).kind, "conflict");
  }
});

test("identical content on a genuinely new message stays new", () => {
  const fresh = identity({ providerMessageRef: "message-2", providerEventRef: "event-2" });
  assert.equal(fresh.contentDigest, identity().contentDigest);
  assert.notEqual(fresh.logicalMessageKey, identity().logicalMessageKey);
  assert.equal(classifyReceiptV1(fresh).kind, "new-candidate");
});

test("keys use exact full domain-separated fixed-position JSON encoding", () => {
  const raw = input();
  const scope = [
    raw.installationRef,
    raw.channelInstallationRef,
    raw.platform,
    raw.providerTenantRef,
    raw.recipientAppRef,
  ];
  const sha = (parts) =>
    `sha256:${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
  const parsed = identity();
  assert.equal(parsed.eventKey, sha(["oce.shared-turn.event.v1", ...scope, raw.providerEventRef]));
  assert.equal(
    parsed.logicalMessageKey,
    sha(["oce.shared-turn.message.v1", ...scope, raw.channelRef, raw.providerMessageRef]),
  );
  assert.match(parsed.eventKey, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(parsed.eventKey, parsed.logicalMessageKey);
  assert.deepEqual(
    parseReceiptIdentityV1(Object.fromEntries(Object.entries(raw).reverse())),
    parsed,
  );
});

test("opaque delimiter, whitespace, case and Unicode IDs never alias", () => {
  assert.notEqual(
    identity({ installationRef: "a|b", channelInstallationRef: "c" }).eventKey,
    identity({ installationRef: "a", channelInstallationRef: "b|c" }).eventKey,
  );
  const ids = ["a", "A", " a", "a ", "é", "e\u0301", "😀", '[",]'];
  assert.equal(
    new Set(ids.map((providerEventRef) => identity({ providerEventRef }).eventKey)).size,
    ids.length,
  );
});

test("all missing, extra and malformed normalized fields return bounded invalid results", () => {
  const bad = [null, undefined, [], "body", 1, Object.create(input())];
  for (const field of Object.keys(input())) {
    const absent = input();
    delete absent[field];
    bad.push(absent);
    bad.push(input({ [field]: undefined }), input({ [field]: 23 }), input({ [field]: {} }));
  }
  for (const value of [
    "",
    "x".repeat(1025),
    "😀".repeat(257),
    "a\0b",
    "a\nb",
    "\u007f",
    "\u0085",
    "\ud800",
    "\udc00",
    "\ud800x\udc00",
  ])
    bad.push(input({ providerEventRef: value }));
  for (const value of [digest("A"), digest("g"), "sha256:" + "a".repeat(63), "a".repeat(64)])
    bad.push(input({ eventDigest: value }), input({ contentDigest: value }));
  bad.push(
    input({ schemaVersion: 2 }),
    input({ platform: "teams" }),
    input({ eventKey: "override" }),
    input({ logicalMessageKey: "override" }),
    input({ retryId: "transport-only" }),
    input({ [Symbol("hidden")]: "hidden" }),
  );
  for (const value of bad)
    assert.deepEqual(parseReceiptIdentityV1(value), { kind: "invalid", reason: "identity" });
  assert.equal("kind" in identity({ providerEventRef: "😀".repeat(256) }), false);
  assert.equal(
    "kind" in parseReceiptIdentityV1(Object.assign(Object.create(null), input())),
    false,
  );
});

test("accessors and proxy traps are rejected without executing user code", () => {
  let calls = 0;
  const accessor = input();
  Object.defineProperty(accessor, "providerEventRef", {
    get() {
      calls++;
      throw new Error("secret");
    },
  });
  const proxy = new Proxy(input(), {
    getPrototypeOf() {
      calls++;
      throw new Error("secret");
    },
    ownKeys() {
      calls++;
      throw new Error("secret");
    },
  });
  const revoked = Proxy.revocable(input(), {});
  revoked.revoke();
  for (const value of [accessor, proxy, revoked.proxy])
    assert.equal(parseReceiptIdentityV1(value).kind, "invalid");
  const row = snapshot();
  Object.defineProperty(row, "identity", {
    get() {
      calls++;
      throw new Error("secret");
    },
  });
  assert.equal(classifyReceiptV1(identity(), row).kind, "invalid");
  assert.equal(classifyReceiptV1(proxy).kind, "invalid");
  assert.equal(calls, 0);
});

test("snapshots are closed and normalized keys cannot be forged", () => {
  for (const row of [
    null,
    [],
    {},
    { ...snapshot(), extra: true },
    snapshot(identity(), "unknown"),
    snapshot(identity(), "busy", { turnRef: "forbidden" }),
    snapshot(identity(), "accepted", { turnRef: undefined }),
    snapshot(identity(), "pending", { ownerReceiptRef: "" }),
    snapshot({ ...identity(), eventKey: digest("f") }),
    snapshot({ ...identity(), logicalMessageKey: digest("f") }),
    snapshot(input()),
  ]) {
    assert.deepEqual(classifyReceiptV1(identity(), row), { kind: "invalid", reason: "snapshot" });
  }
  assert.deepEqual(classifyReceiptV1(input()), { kind: "invalid", reason: "identity" });
});

test("parsing and classification copy values and never mutate snapshots", () => {
  const raw = input();
  const parsed = parseReceiptIdentityV1(raw);
  const before = { ...parsed };
  raw.providerSubjectRef = "changed";
  assert.deepEqual(parsed, before);
  assert.ok(Object.isFrozen(parsed));
  const mutableIdentity = { ...parsed };
  const row = snapshot(mutableIdentity);
  const original = structuredClone(row);
  const result = classifyReceiptV1(parsed, row);
  assert.deepEqual(row, original);
  row.ownerReceiptRef = "changed";
  row.turnRef = "changed";
  mutableIdentity.contentDigest = digest("c");
  assert.equal(result.ownerReceiptRef, "receipt-1");
  assert.equal(result.turnRef, "turn-1");
  assert.ok(Object.isFrozen(result));
});

test("a logical row carrying the same event must preserve its event digest", () => {
  const changed = identity({ eventDigest: digest("c") });
  assert.equal(classifyReceiptV1(changed, undefined, snapshot()).kind, "conflict");
  assert.equal(classifyReceiptV1(changed, snapshot(changed), snapshot()).kind, "conflict");
});

test("digest syntax rejects trailing line terminators and oversized values", () => {
  for (const value of [
    digest("a") + "\n",
    digest("a") + "\r",
    digest("a") + "\u2028",
    "a".repeat(100000),
  ]) {
    assert.deepEqual(parseReceiptIdentityV1(input({ eventDigest: value })), {
      kind: "invalid",
      reason: "identity",
    });
    assert.deepEqual(parseReceiptIdentityV1(input({ contentDigest: value })), {
      kind: "invalid",
      reason: "identity",
    });
  }
});
