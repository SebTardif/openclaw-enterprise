import assert from "node:assert/strict";
import test from "node:test";
import { createNativeRootIamAdmissionV1 } from "../../packages/occ/src/index.ts";
import { evaluateAuthorization } from "../../packages/iam/src/index.ts";
import {
  fixture,
  cloneBinding,
  deferred,
  PEER_PROVENANCE,
} from "../fixtures/root-work-iam/peers.ts";

// Real component/evaluator; peer provenance is a required limit on these results.
assert.match(PEER_PROVENANCE.state, /models future State behavior only/);
const admission = async (f) => {
  const evidence = await f.owner.prepare(f.binding, 60000);
  await f.state.transact((uow) => f.owner.consumeIn(uow, evidence, f.binding));
  return evidence;
};
const denyPrepared = async (f, evidence, binding = f.binding) => {
  await assert.rejects(f.state.transact((uow) => f.owner.consumeIn(uow, evidence, binding)));
};
const paths = (value, prefix = []) =>
  value && typeof value === "object"
    ? Object.entries(value).flatMap(([name, child]) =>
        name === "authentication" || name === "originalPrClaim"
          ? []
          : paths(child, [...prefix, name]),
      )
    : [prefix];
const change = (root, path) => {
  let current = root;
  for (const part of path.slice(0, -1)) current = current[part];
  const field = path.at(-1),
    original = current[field];
  current[field] =
    typeof original === "number"
      ? original + 1
      : typeof original === "boolean"
        ? !original
        : original === null
          ? "changed"
          : String(original) + "-changed";
};

test("original registered grant ceiling requires independently matching action and resource for every external family", async (t) => {
  for (const effect of ["credential", "resource", "pr-create"])
    for (const [name, operation] of Object.entries({
      matching: { action: "github.read", canonicalResource: "github:repo" },
      wrongAction: { action: "github.write", canonicalResource: "github:repo" },
      wrongResource: { action: "github.read", canonicalResource: "github:other-repo" },
    }))
      await t.test(effect + ":" + name, async () => {
        const f = fixture(effect);
        f.state.snapshot.entitlement.grant.operations =
          f.grantOperations.retainOperation(operation);
        if (name === "matching") {
          await admission(f);
          assert.equal(f.grantOperations.calls, 2);
          for (const input of f.grantOperations.inputs) {
            assert.notEqual(input, f.state.snapshot.entitlement.grant);
            assert.equal(Object.isFrozen(input), true);
            assert.equal(Object.isFrozen(input.operations), true);
            assert.equal(Object.hasOwn(input, "authentication"), false);
            assert.deepEqual(JSON.parse(input.operations.canonicalJson), operation);
          }
        } else {
          await assert.rejects(f.owner.prepare(f.binding, 60000));
          assert.equal(f.grantOperations.calls, 1);
          assert.equal(f.state.events.includes("commit"), false);
        }
      });
});

test("registered operation mutations after prepare and inside original lock/read waits deny and remain spent", async (t) => {
  for (const effect of ["credential", "resource", "pr-create"])
    for (const phase of ["afterPrepare", "lockWait", "readWait"])
      for (const operation of [
        { action: "github.write", canonicalResource: "github:repo" },
        { action: "github.read", canonicalResource: "github:other-repo" },
      ])
        await t.test(
          effect + ":" + phase + ":" + operation.action + ":" + operation.canonicalResource,
          async () => {
            const f = fixture(effect),
              evidence = await f.owner.prepare(f.binding, 60000);
            const mutate = () => {
              f.state.snapshot.entitlement.grant.operations =
                f.grantOperations.retainOperation(operation);
            };
            if (phase === "afterPrepare") {
              mutate();
              await denyPrepared(f, evidence);
            } else {
              const gate = deferred();
              if (phase === "lockWait") f.state.lockWait = gate;
              else f.effects.readWait = gate;
              const consuming = f.state.transact((uow) =>
                f.owner.consumeIn(uow, evidence, f.binding).catch(() => {}),
              );
              await new Promise((resolve) => setImmediate(resolve));
              mutate();
              gate.resolve();
              await assert.rejects(consuming, "caught enrolled contradiction poisons outer commit");
            }
            await denyPrepared(f, evidence);
          },
        );
});

test("projection output binds complete originals and never combines crossed tuples", async (t) => {
  const variants = {
    grantId: (p) => {
      p.grantId = "other";
    },
    connectionId: (p) => {
      p.connectionId = "other";
    },
    generation: (p) => {
      p.connectionGeneration = "other";
    },
    definition: (p) => {
      p.definition.recipeVersion += 1;
    },
    schema: (p) => {
      p.originalOperations.schema.version += 1;
    },
    bytes: (p) => {
      p.originalOperations.canonicalJson = "{}";
    },
    digest: (p) => {
      p.originalOperations.digest = "sha256:" + "0".repeat(64);
    },
    profile: (p) => {
      p.originalProfile.selection.canonicalJson = '{"mode":"write"}';
    },
    profileDigest: (p) => {
      p.permitted[0].profileSelectionDigest = "other";
    },
    service: (p) => {
      p.permitted[0].serviceId = "other";
    },
    empty: (p) => {
      p.permitted = [];
    },
    malformed: (p) => {
      delete p.permitted[0].canonicalResource;
    },
    emptyString: (p) => {
      p.permitted[0].exactAction = "";
    },
    stringBytes: (p) => {
      p.permitted[0].serviceId = "😀".repeat(128);
    },
    tooMany: (p) => {
      p.permitted = Array.from({ length: 257 }, () => ({ ...p.permitted[0] }));
    },
    oversized: (p) => {
      p.originalOperations.canonicalJson = "x".repeat(65536);
    },
    extra: (p) => {
      p.unrecognized = true;
    },
    extraTuple: (p) => {
      p.permitted[0].unrecognized = true;
    },
    crossed: (p) => {
      const tuple = p.permitted[0];
      p.permitted = [
        { ...tuple, canonicalResource: "github:other-repo" },
        { ...tuple, exactAction: "github.write" },
      ];
    },
    crossedService: (p) => {
      const tuple = p.permitted[0];
      p.permitted = [
        { ...tuple, serviceId: "other" },
        { ...tuple, profileSelectionDigest: "other" },
      ];
    },
  };
  for (const [name, alter] of Object.entries(variants))
    for (const phase of ["prepare", "consume"])
      await t.test(name + ":" + phase, async () => {
        const f = fixture();
        let enabled = phase === "prepare";
        const original = f.grantOperations.projectRegisteredGrant.bind(f.grantOperations);
        const projector = {
          projectRegisteredGrant(grant) {
            assert.equal(arguments.length, 1);
            const projection = structuredClone(original(grant));
            if (enabled) alter(projection);
            return projection;
          },
        };
        f.owner = createNativeRootIamAdmissionV1({ ...f.dependencies, grantOperations: projector });
        if (phase === "prepare") await assert.rejects(f.owner.prepare(f.binding, 60000));
        else {
          const evidence = await f.owner.prepare(f.binding, 60000);
          enabled = true;
          await assert.rejects(
            f.state.transact((uow) => f.owner.consumeIn(uow, evidence, f.binding).catch(() => {})),
          );
          await denyPrepared(f, evidence);
        }
      });
  const f = fixture();
  let changed = false;
  const original = f.grantOperations.projectRegisteredGrant.bind(f.grantOperations);
  f.owner = createNativeRootIamAdmissionV1({
    ...f.dependencies,
    grantOperations: {
      projectRegisteredGrant(grant) {
        const p = original(grant);
        if (changed) p.permitted.push({ ...p.permitted[0], exactAction: "github.other" });
        return p;
      },
    },
  });
  const evidence = await f.owner.prepare(f.binding, 60000);
  changed = true;
  await denyPrepared(f, evidence); // A still-matching tuple cannot hide a changed full projection.
});

test("original registered codecs refuse foreign identity, malformed bytes, digest and profile", async (t) => {
  for (const [name, alter] of Object.entries({
    definition: (g) => {
      g.operations.definition.recipeVersion += 1;
    },
    schema: (g) => {
      g.operations.schema.name = "unregistered";
    },
    bytes: (g) => {
      g.operations.canonicalJson = '{"action":"github.write","canonicalResource":"github:repo"}';
    },
    digest: (g) => {
      g.operations.digest = "sha256:" + "0".repeat(64);
    },
    profile: (g) => {
      g.credentialProfile.selection.canonicalJson = '{"mode":"write"}';
    },
    profileDigest: (g) => {
      g.credentialProfile.selectionDigest = "other";
    },
  }))
    await t.test(name, async () => {
      const f = fixture();
      alter(f.state.snapshot.entitlement.grant);
      await assert.rejects(f.owner.prepare(f.binding, 60000));
    });
  const f = fixture();
  assert.throws(() =>
    f.grantOperations.registry.assertCodec(
      { ...f.grantOperations.operationCodec },
      f.grantOperations.operationCodec.binding,
    ),
  );
  assert.throws(() =>
    f.grantOperations.profileCodec.retain(
      f.grantOperations.operationCodec.restore(f.state.snapshot.entitlement.grant.operations),
    ),
  );
});

test("bounded complete tuple lists can match any one tuple and owner replacement invalidates evidence", async () => {
  const f = fixture();
  const original = f.grantOperations.projectRegisteredGrant.bind(f.grantOperations);
  f.owner = createNativeRootIamAdmissionV1({
    ...f.dependencies,
    grantOperations: {
      projectRegisteredGrant(grant) {
        const p = original(grant);
        const matching = p.permitted[0];
        p.permitted = Array.from({ length: 255 }, () => ({
          serviceId: "other",
          exactAction: "other",
          canonicalResource: "other",
          profileSelectionDigest: "other",
        }));
        p.permitted.push(matching);
        return p;
      },
    },
  });
  await admission(f);
  const replaced = fixture(),
    evidence = await replaced.owner.prepare(replaced.binding, 60000);
  replaced.dependencies.grantOperations = { projectRegisteredGrant: original };
  await denyPrepared(replaced, evidence);
  await denyPrepared(replaced, evidence);
  const method = fixture(),
    token = await method.owner.prepare(method.binding, 60000);
  method.grantOperations.projectRegisteredGrant = original;
  await denyPrepared(method, token);
  await denyPrepared(method, token);
  const profile = fixture();
  const selection = profile.grantOperations.profileCodec.retain(
    profile.grantOperations.profileCodec.validate({ mode: "write" }),
  );
  const fixed = { ...profile.binding.profile, selection, selectionDigest: selection.digest };
  profile.binding.profile = fixed;
  profile.effects.retained.binding.profile = structuredClone(fixed);
  profile.state.snapshot.entitlement.grant.credentialProfile = structuredClone(fixed);
  await assert.rejects(
    profile.owner.prepare(profile.binding, 60000),
    "unknown original registered profile mode denies despite matching candidate correspondence",
  );
});

test("missing, executable, asynchronous and hostile projections deny without fallback", async (t) => {
  for (const grantOperations of [
    undefined,
    null,
    {},
    { projectRegisteredGrant: true },
    new Proxy({}, {}),
  ])
    assert.throws(() => fixture("resource", { grantOperations }));
  for (const [name, output] of Object.entries({
    throw: () => {
      throw new Error("original owner refuses");
    },
    missing: () => undefined,
    null: () => null,
    boolean: () => true,
    promise: (p) => Promise.resolve(p),
    thenable: (p) => ({
      ...p,
      then() {
        throw new Error("then must not execute");
      },
    }),
    proxy: (p) =>
      new Proxy(p, {
        ownKeys() {
          throw new Error("proxy must not execute");
        },
      }),
    accessor: (p) =>
      Object.defineProperty(p, "permitted", {
        enumerable: true,
        get() {
          throw new Error("getter must not execute");
        },
      }),
    cyclic: (p) => {
      p.permitted[0].cycle = p;
      return p;
    },
    deep: (p) => {
      let value = {};
      for (let i = 0; i < 33; i++) value = { value };
      p.permitted[0].deep = value;
      return p;
    },
  }))
    await t.test(name, async () => {
      const f = fixture();
      const original = f.grantOperations.projectRegisteredGrant.bind(f.grantOperations);
      f.owner = createNativeRootIamAdmissionV1({
        ...f.dependencies,
        grantOperations: { projectRegisteredGrant: (grant) => output(original(grant)) },
      });
      await assert.rejects(f.owner.prepare(f.binding, 60000));
    });
  const cancel = fixture("root-cancel", {
    grantOperations: {
      projectRegisteredGrant() {
        throw new Error("cancellation never projects external grants");
      },
    },
  });
  await admission(cancel);
});

test("projection rechecks Core, abort and every intersected deadline immediately in both phases", async (t) => {
  for (const phase of ["prepare", "consume"])
    for (const [name, mutate] of Object.entries({
      Core: (f) => f.core.registry.delete(f.binding.authentication),
      abort: (f) => f.controller.abort(),
      evidence: (f) => f.setTime(11001),
      entitlement: (f) => f.setTime(65000),
      grant: (f) => f.setTime(70000),
      request: (f) => f.setTime(85000),
      root: (f) => f.setTime(100000),
    }))
      await t.test(phase + ":" + name, async () => {
        const f = fixture();
        let enabled = phase === "prepare";
        const original = f.grantOperations.projectRegisteredGrant.bind(f.grantOperations);
        f.owner = createNativeRootIamAdmissionV1({
          ...f.dependencies,
          grantOperations: {
            projectRegisteredGrant(grant) {
              const p = original(grant);
              if (enabled) mutate(f);
              return p;
            },
          },
        });
        if (phase === "prepare") await assert.rejects(f.owner.prepare(f.binding, 60000));
        else {
          const evidence = await f.owner.prepare(f.binding, 60000);
          enabled = true;
          await denyPrepared(f, evidence);
          await denyPrepared(f, evidence);
        }
      });
});

test("projection enforces independent grant, entitlement and current-policy deadlines before broader request bounds", async (t) => {
  for (const phase of ["prepare", "consume"])
    for (const [name, shorten] of Object.entries({
      grant: (f) => {
        f.state.snapshot.entitlement.grant.expiresAt = 2000;
      },
      entitlement: (f) => {
        f.state.snapshot.entitlement.validUntil = 2000;
      },
      currentPolicy: (f) => {
        f.state.snapshot.currentServicePolicy.durationPolicy.originalDeadline = 2000;
      },
    }))
      await t.test(phase + ":" + name, async () => {
        const f = fixture();
        shorten(f);
        let enabled = phase === "prepare";
        const original = f.grantOperations.projectRegisteredGrant.bind(f.grantOperations);
        f.owner = createNativeRootIamAdmissionV1({
          ...f.dependencies,
          grantOperations: {
            projectRegisteredGrant(grant) {
              const p = original(grant);
              if (enabled) f.setTime(2000);
              return p;
            },
          },
        });
        assert.ok(f.effects.bounds.deadline > 2000);
        assert.ok(f.binding.bounds.authorityDeadline > 2000);
        assert.ok(f.binding.bounds.requestDeadline > 2000);
        if (phase === "prepare") await assert.rejects(f.owner.prepare(f.binding, 60000));
        else {
          const token = await f.owner.prepare(f.binding, 60000);
          enabled = true;
          await denyPrepared(f, token);
          await denyPrepared(f, token);
        }
      });
});

test("selected native IAM grants each exact effect through real policy and independent entitlement", async (t) => {
  for (const effect of ["credential", "resource", "pr-create", "root-cancel"])
    await t.test(effect, async () => {
      const f = fixture(effect);
      const evidence = await admission(f);
      assert.equal(
        f.effects.reads,
        2,
        "preparation and consume independently read original effects",
      );
      assert.ok(f.state.events.indexOf("enrolled") < f.state.events.indexOf("lock"));
      await denyPrepared(f, evidence);
    });
  for (const operation of ["acquire", "exchange", "refresh"])
    await t.test("credential " + operation, async () => {
      const f = fixture("credential");
      f.binding.operation = operation;
      f.effects.retained.binding.operation = operation;
      await admission(f);
    });
  await t.test("explicit source-free bridge", async () => {
    const f = fixture();
    f.state.snapshot.entitlement.protectedSourceMode = "source-free";
    f.state.snapshot.entitlement.protectedSourceRefs = [];
    f.state.snapshot.nativePolicy.bindings = f.state.snapshot.nativePolicy.bindings.filter(
      (b) => b.id !== "service-secret",
    );
    await admission(f);
  });
});

test("native allow alone cannot bypass current service, Secret, principal, Namespace or policy denial", async (t) => {
  const variants = {
    "withdrawn service entitlement": (f) => {
      f.state.snapshot.entitlement.exactAction = "github.write";
    },
    "missing full current policy": (f) => {
      f.state.snapshot.currentServicePolicy = null;
    },
    "current policy removes scope": (f) => {
      f.state.snapshot.currentServicePolicy.scopeCeiling = [];
    },
    "current policy widens immutable ceiling": (f) => {
      f.state.snapshot.currentServicePolicy.scopeCeiling.push({
        action: "github.write",
        canonicalResource: "github:repo",
      });
    },
    "current audience withdrawal": (f) => {
      f.state.snapshot.currentServicePolicy.audienceRefs = [];
    },
    "required domain withdrawal": (f) => {
      f.state.snapshot.currentServicePolicy.eligibleDataDomains = [];
    },
    "requester allow cannot replace service": (f) => {
      f.state.snapshot.nativePolicy.bindings[0].subjectId = "requester";
    },
    "service becomes human": (f) => {
      f.state.snapshot.nativePolicy.identities[0] = {
        kind: "principal",
        id: "service",
        issuer: "https://identity.example",
        subject: "service-human",
      };
    },
    "foreign service Namespace": (f) => {
      f.state.snapshot.nativePolicy.identities[0].namespaceId = "foreign";
    },
    "wrong Agent owner": (f) => {
      f.state.snapshot.nativePolicy.identities[0].agentId = "foreign";
    },
    "Role action mismatch": (f) => {
      f.state.snapshot.nativePolicy.roles[0].permissions[0].action = "read";
    },
    "removed service binding": (f) => {
      f.state.snapshot.nativePolicy.bindings = f.state.snapshot.nativePolicy.bindings.filter(
        (b) => b.id !== "service-agent",
      );
    },
    "scoped Agent restriction": (f) => {
      f.state.snapshot.nativePolicy.restrictions.push({
        id: "deny",
        namespaceId: "namespace",
        action: "operate",
        resourceKind: "agent",
        resourceId: "agent",
        effect: "deny",
      });
    },
    "invalid native policy": (f) => {
      f.state.snapshot.nativePolicy.roles.push(
        structuredClone(f.state.snapshot.nativePolicy.roles[0]),
      );
    },
    "unknown durable driver": (f) => {
      f.state.snapshot.selectedIam.driverId = "remote";
    },
    "wrong durable generation": (f) => {
      f.state.snapshot.selectedIam.configurationGeneration = "generation-2";
    },
    "missing protected sources": (f) => {
      f.state.snapshot.entitlement.protectedSourceRefs = [];
    },
    "source-free has sources": (f) => {
      f.state.snapshot.entitlement.protectedSourceMode = "source-free";
    },
    "unsupported source mode": (f) => {
      f.state.snapshot.entitlement.protectedSourceMode = "missing";
    },
    "missing Secret binding": (f) => {
      f.state.snapshot.nativePolicy.bindings = f.state.snapshot.nativePolicy.bindings.filter(
        (b) => b.id !== "service-secret",
      );
    },
    "foreign protected Secret": (f) => {
      f.state.snapshot.entitlement.protectedSourceRefs[0].namespaceId = "foreign";
    },
    "scoped Secret restriction": (f) => {
      f.state.snapshot.nativePolicy.restrictions.push({
        id: "deny",
        namespaceId: "namespace",
        action: "operate",
        resourceKind: "secret",
        resourceId: "secret",
        effect: "deny",
      });
    },
  };
  for (const [name, alter] of Object.entries(variants))
    await t.test(name, async () => {
      const f = fixture();
      alter(f);
      await assert.rejects(f.owner.prepare(f.binding, 60000));
    });
  // The real evaluator's group evidence is used in the cancellation envelope.
  const cancel = fixture("root-cancel");
  const decision = evaluateAuthorization(
    {
      principalId: "canceller",
      action: "operate",
      resource: { kind: "agent", id: "agent", namespaceId: "namespace" },
    },
    cancel.state.snapshot.nativePolicy,
  );
  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.evidence.groupIds, ["cancel-group"]);
  cancel.state.snapshot.nativePolicy.memberships = [];
  await assert.rejects(cancel.owner.prepare(cancel.binding, 60000));
  for (const effect of ["credential", "resource", "pr-create"])
    await t.test(effect + " requires every Secret", async () => {
      const f = fixture(effect);
      f.state.snapshot.entitlement.protectedSourceRefs.push({
        kind: "secret",
        id: "second-secret",
        namespaceId: "namespace",
      });
      await assert.rejects(f.owner.prepare(f.binding, 60000));
    });
});

test("every binding leaf rejects changed candidate against independently retained originals", async (t) => {
  for (const effect of ["credential", "resource", "pr-create", "root-cancel"]) {
    for (const path of paths(fixture(effect).binding))
      await t.test(effect + ":" + path.join("."), async () => {
        const f = fixture(effect),
          candidate = cloneBinding(f.binding);
        change(candidate, path);
        await assert.rejects(f.owner.prepare(candidate, 60000));
        const evidence = await f.owner.prepare(f.binding, 60000);
        await denyPrepared(f, evidence, candidate);
        await denyPrepared(f, evidence);
      });
  }
});

test("all retained policy and entitlement leaves are re-read after preparation", async (t) => {
  for (const effect of ["resource", "root-cancel"]) {
    for (const path of paths(fixture(effect).state.snapshot))
      await t.test(effect + ":" + path.join("."), async () => {
        const f = fixture(effect),
          evidence = await f.owner.prepare(f.binding, 60000);
        change(f.state.snapshot, path);
        await denyPrepared(f, evidence);
      });
  }
});

test("original owner identity, opaque PR custody and restart cannot be copied", async (t) => {
  for (const effect of ["resource", "pr-create"])
    await t.test(effect, async () => {
      const f = fixture(effect);
      for (const authentication of [
        { ...f.binding.authentication },
        new Proxy(f.binding.authentication, {}),
        JSON.parse(JSON.stringify(f.binding.authentication)),
      ]) {
        const candidate = cloneBinding(f.binding);
        candidate.authentication = authentication;
        await assert.rejects(f.owner.prepare(candidate, 60000));
      }
      if (effect === "pr-create") {
        const candidate = cloneBinding(f.binding);
        candidate.originalPrClaim = Object.freeze({});
        await assert.rejects(f.owner.prepare(candidate, 60000));
      }
      const evidence = await f.owner.prepare(f.binding, 60000);
      for (const copied of [
        { ...evidence },
        new Proxy(evidence, {}),
        JSON.parse(JSON.stringify(evidence)),
      ])
        await denyPrepared(f, copied);
      const other = fixture(effect);
      await assert.rejects(
        other.state.transact((uow) => other.owner.consumeIn(uow, evidence, other.binding)),
      );
      const restarted = f.restart();
      await assert.rejects(
        f.state.transact((uow) => restarted.consumeIn(uow, evidence, f.binding)),
      );
      await f.state.transact((uow) => f.owner.consumeIn(uow, evidence, f.binding));
    });
  const f = fixture();
  await assert.rejects(f.owner.prepare(new Proxy(f.binding, {}), 60000));
  const accessor = cloneBinding(f.binding);
  Object.defineProperty(accessor, "serviceId", {
    get() {
      throw new Error("getter must not run");
    },
    enumerable: true,
  });
  await assert.rejects(f.owner.prepare(accessor, 60000));
  for (const driver of [{ ...f.driver }, new Proxy(f.driver, {})])
    assert.throws(() =>
      createNativeRootIamAdmissionV1({ ...f.dependencies, selectedNativeDriver: driver }),
    );
});

test("one-use race spends before lock waits and rollback or uncertainty cannot restore evidence", async () => {
  const f = fixture(),
    evidence = await f.owner.prepare(f.binding, 60000),
    gate = deferred();
  f.state.lockWait = gate;
  const result = f.state.transact(async (uow) => {
    const first = f.owner.consumeIn(uow, evidence, f.binding);
    const second = f.owner.consumeIn(uow, evidence, f.binding);
    gate.resolve();
    const outcomes = await Promise.allSettled([first, second]);
    assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
  });
  await assert.rejects(result, "second consume poisons the same outer transaction");
  await denyPrepared(f, evidence);
  for (const outcome of ["rollback", "unknown COMMIT"]) {
    const f = fixture(),
      evidence = await f.owner.prepare(f.binding, 60000);
    f.state.outcome = outcome;
    await denyPrepared(f, evidence);
    f.state.outcome = "commit";
    await denyPrepared(f, evidence);
  }
});

test("finite evidence retention, pending cap, caller deadline, abort and timeout are enforced", async () => {
  const f = fixture("resource", { maximumActiveEvidence: 1 });
  const evidence = await f.owner.prepare(f.binding, 60000);
  await assert.rejects(f.owner.prepare(f.binding, 60000));
  f.setTime(11001);
  await denyPrepared(f, evidence);
  const fresh = await f.owner.prepare(f.binding, 60000);
  await f.state.transact((uow) => f.owner.consumeIn(uow, fresh, f.binding));
  const cap = fixture("resource", { maximumActiveEvidence: 1 });
  cap.effects.readWait = deferred();
  const first = cap.owner.prepare(cap.binding, 60000);
  await assert.rejects(cap.owner.prepare(cap.binding, 60000));
  cap.effects.readWait.resolve();
  await first;
  const caller = fixture();
  const short = await caller.owner.prepare(caller.binding, 1002);
  caller.setTime(1002);
  await denyPrepared(caller, short);
  const abort = fixture();
  abort.controller.abort();
  await assert.rejects(abort.owner.prepare(abort.binding, 60000));
  const timeout = fixture("resource", { maximumPrepareMs: 5 });
  timeout.effects.readWait = deferred();
  const preparing = timeout.owner.prepare(timeout.binding, 60000);
  await assert.rejects(preparing);
  timeout.setTime(1006);
  timeout.effects.readWait.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timeout.effects.reads, 1);
  for (const value of [0, -1, Infinity, NaN])
    assert.throws(() => fixture("resource", { maximumEvidenceLifetimeMs: value }));
});

test("policy, selection, closure, bounds and abort change during awaits deny and remain spent", async (t) => {
  for (const [name, change] of Object.entries({
    policy: (f) => {
      f.state.snapshot.policyEpoch = "epoch-2";
    },
    selection: (f) => {
      f.state.snapshot.selectedIam.configurationGeneration = "generation-2";
    },
    closure: (f) => {
      f.state.snapshot.root.state = "closed";
    },
    bounds: (f) => {
      f.effects.bounds = { ...f.effects.bounds, deadline: 1001 };
    },
    signal: (f) => {
      f.effects.bounds = { ...f.effects.bounds, signal: new AbortController().signal };
    },
    abort: (f) => f.controller.abort(),
    expiry: (f) => f.setTime(11001),
    Core: (f) => {
      f.core.registry.delete(f.binding.authentication);
    },
  }))
    await t.test(name, async () => {
      const f = fixture(),
        evidence = await f.owner.prepare(f.binding, 60000),
        gate = deferred();
      f.state.lockWait = gate;
      const consuming = f.state.transact((uow) => f.owner.consumeIn(uow, evidence, f.binding));
      change(f);
      gate.resolve();
      await assert.rejects(consuming);
      await denyPrepared(f, evidence);
    });
  const f = fixture(),
    gate = deferred();
  f.effects.readWait = gate;
  const preparing = f.owner.prepare(f.binding, 60000);
  f.controller.abort();
  gate.resolve();
  await assert.rejects(preparing);
});

test("independent cancellation remains available after external withdrawal and requires actual authorization", async (t) => {
  const cancelled = fixture("root-cancel");
  cancelled.state.snapshot.nativePolicy.bindings =
    cancelled.state.snapshot.nativePolicy.bindings.filter((b) => !b.id.startsWith("service-"));
  cancelled.state.snapshot.nativePolicy.identities =
    cancelled.state.snapshot.nativePolicy.identities.filter((i) => i.id !== "service");
  await admission(cancelled);
  for (const [name, change] of Object.entries({
    subject: (f) => {
      f.state.snapshot.entitlement.authorizedPrincipalId = "requester";
    },
    authorization: (f) => {
      f.state.snapshot.entitlement.authorizationId = "other-auth";
    },
    root: (f) => {
      f.state.snapshot.entitlement.rootWorkId = "other-root";
    },
    dependency: (f) => {
      f.state.snapshot.entitlement.dependencyIds = [];
    },
    ownerMetadata: (f) => {
      f.binding.requester.principalId = "requester";
    },
    noIngressOriginal: (f) => {
      f.effects.retained.state = "closed";
    },
  }))
    await t.test(name, async () => {
      const f = fixture("root-cancel");
      change(f);
      await assert.rejects(f.owner.prepare(f.binding, 60000));
    });
});

test("exact named finite capacities have no absent-limit, duplicate or overflow fallback", async (t) => {
  for (const [name, change] of Object.entries({
    missingLimit: (f) => {
      f.state.snapshot.currentServicePolicy.aggregateLimits = [];
    },
    duplicateLimit: (f) => {
      f.state.snapshot.currentServicePolicy.aggregateLimits.push({
        ...f.state.snapshot.currentServicePolicy.aggregateLimits[0],
      });
    },
    duplicateCapacity: (f) => {
      f.effects.retained.capacity.push({ ...f.effects.retained.capacity[0] });
    },
    duplicateCharge: (f) => {
      f.state.snapshot.entitlement.aggregateCharges.push({ name: "calls", amount: 1 });
    },
    negative: (f) => {
      f.effects.retained.capacity[0].currentUnits = -1;
    },
    nonfinite: (f) => {
      f.effects.retained.capacity[0].requestedUnits = Infinity;
    },
    overLimit: (f) => {
      f.effects.retained.capacity[0].currentUnits = 10;
    },
    wrongCharge: (f) => {
      f.state.snapshot.entitlement.aggregateCharges[0].amount = 2;
    },
    absentCharge: (f) => {
      f.state.snapshot.entitlement.aggregateCharges = [];
    },
    noBundle: (f) => {
      f.effects.retained.originalBundle = null;
    },
    wrongRecipe: (f) => {
      f.effects.retained.originalBundle.recipeVersion = 2;
    },
  }))
    await t.test(name, async () => {
      const f = fixture();
      change(f);
      await assert.rejects(f.owner.prepare(f.binding, 60000));
    });
});

test("controlled original UoW enrolls whole callback synchronously and keeps caught failures sticky", async () => {
  const f = fixture(),
    evidence = await f.owner.prepare(f.binding, 60000);
  await assert.rejects(
    f.state.transact(async (uow) => {
      const bad = cloneBinding(f.binding);
      bad.serviceId = "wrong";
      await f.owner.consumeIn(uow, evidence, bad).catch(() => {});
    }),
  );
  const unawaited = fixture(),
    token = await unawaited.owner.prepare(unawaited.binding, 60000);
  unawaited.state.beforeLock = async () => {
    throw new Error("controlled lock failure");
  };
  await assert.rejects(
    unawaited.state.transact((uow) => {
      unawaited.owner.consumeIn(uow, token, unawaited.binding);
      return Promise.resolve();
    }),
  );
  const scopeFailure = fixture();
  scopeFailure.state.beforeLock = async () => {
    throw new Error("lock denial");
  };
  await assert.rejects(
    scopeFailure.state.transact((uow) =>
      scopeFailure.state.retainAdmissionFenceIn(uow, async (scope) => {
        await scope.lockSnapshot({}, scopeFailure.effects.bounds).catch(() => {});
      }),
    ),
    "caught scope failure poisons even a successful participant callback",
  );
  const foreign = fixture(),
    foreignToken = await foreign.owner.prepare(foreign.binding, 60000);
  await assert.rejects(
    foreign.state.store.transact((uow) =>
      foreign.owner.consumeIn(uow, foreignToken, foreign.binding),
    ),
  );
  let closed;
  await foreign.state.transact(async (uow) => {
    closed = uow;
  });
  await assert.rejects(foreign.owner.consumeIn(closed, foreignToken, foreign.binding));
  const sync = fixture();
  await sync.state.transact(async (uow) => {
    let invoked = false;
    const participant = sync.state.retainAdmissionFenceIn(uow, async () => {
      invoked = true;
    });
    assert.equal(invoked, true, "complete callback starts before the return Promise");
    await participant;
  });
  await assert.rejects(sync.state.scopes[0].lockSnapshot({}, sync.effects.bounds));
});

test("controlled same guard drains nested serial owner reads without a serial participant deadlock", async () => {
  const f = fixture(),
    evidence = await f.owner.prepare(f.binding, 60000),
    gate = deferred();
  f.state.lockWait = gate;
  let unit;
  const outcome = f.state.transact((uow) => {
    unit = uow;
    f.owner.consumeIn(uow, evidence, f.binding);
    return Promise.resolve();
  });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    f.state.retainAdmissionFenceIn(unit, async () => {}),
    "new top-level registration denied during drain",
  );
  gate.resolve();
  await outcome;
  assert.equal(
    f.effects.reads,
    2,
    "already enrolled callback can run original serial owner read during drain",
  );
});

test("preparation detaches DATA before waits and requires separately enrolled resource or PR evidence", async () => {
  const f = fixture(),
    candidate = cloneBinding(f.binding),
    expected = cloneBinding(candidate),
    gate = deferred();
  f.effects.readWait = gate;
  const preparing = f.owner.prepare(candidate, 60000);
  candidate.profile.selection.canonicalJson = '{"mode":"write"}';
  candidate.connection.definition.recipeVersion = 2;
  candidate.bounds.authorityDeadline = 999999;
  gate.resolve();
  const token = await preparing;
  await f.state.transact((uow) => f.owner.consumeIn(uow, token, expected));
  for (const family of ["resource", "pr-create"]) {
    const credential = fixture("credential"),
      evidence = await credential.owner.prepare(credential.binding, 60000);
    const dispatch = cloneBinding(credential.binding);
    delete dispatch.operation;
    dispatch.effect = family;
    dispatch.receiver.kind = family;
    if (family === "pr-create") dispatch.originalPrClaim = Object.freeze(Object.create(null));
    await denyPrepared(credential, evidence, dispatch);
    await denyPrepared(credential, evidence);
  }
  const missing = fixture();
  missing.effects.bounds = undefined;
  await assert.rejects(missing.owner.prepare(missing.binding, 60000));
  const wrongOwner = fixture(),
    evidence = await wrongOwner.owner.prepare(wrongOwner.binding, 60000);
  await assert.rejects(
    wrongOwner.state.transact((uow) =>
      wrongOwner.owner.consumeIn.call({}, uow, evidence, wrongOwner.binding),
    ),
  );
  await denyPrepared(wrongOwner, evidence);
});
