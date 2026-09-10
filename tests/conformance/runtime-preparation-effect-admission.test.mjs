import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  canonicalRuntimeFaultRequestV1,
  canonicalRuntimeFenceRequestV1,
} from "@openclaw-enterprise/contracts";
import { RuntimePreparationEffectAdmissionV1 } from "../../packages/occ/src/runtime-preparation/effect-admission.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { PostgresCommitOutcomeUnknownError } from "../../packages/occ/src/ports/transaction-errors.ts";
import {
  RUNTIME_PREPARATION_MAX_REQUEST_BYTES,
  samePreparationValue,
} from "../../packages/occ/src/runtime-preparation/types.ts";
import { seedPreparation, rebuildPreparationChild } from "../fixtures/runtime-preparation.mjs";
import { trust } from "../fixtures/runtime-authority-v1/vectors.mjs";
import { evidence, fault, fenceState, hash } from "../fixtures/runtime-effects-v1/vectors.mjs";

const copy = (value) => structuredClone(value);
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function within(promise, milliseconds = 1000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Controlled public/join boundary did not settle.")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const timestamp = "2026-09-09T00:00:01.000Z";
const currentEvidence = () => ({
  ...evidence("controlled-admission-observation"),
  clock: {
    sourceObservedAt: "2026-09-09T00:00:00.000Z",
    receivedAt: "2026-09-09T00:00:00.100Z",
    validUntil: "2026-09-09T00:00:15.000Z",
    uncertaintyMs: 100,
  },
});

// The original memory repositories retain actual ownership, plan, history and
// provider bytes. Native purpose/registry membership, retained proof currentness
// and the as-yet unimplemented accepting operations are CONTROLLED ports. An
// open fixture gate or admitted fixture response proves only this real service's
// orchestration; it is not production admission, PostgreSQL or SDK evidence.
async function fixture() {
  const state = new InMemoryPlatformState();
  const original = await seedPreparation(state);
  await original.append(original.plan);
  await original.append(original.child);
  const input = original.child.child;
  const events = [],
    hooks = {},
    retained = [];
  const controller = new AbortController();
  const context = Object.freeze({ controlledContext: randomUUID() });
  const token = Object.freeze({ controlledTransport: randomUUID() });
  const call = {
    context,
    signal: controller.signal,
    requestRef: randomUUID(),
    recipientRef: "recipient/occ",
    deadline: "2026-09-09T00:00:03.000Z",
  };
  const verified = {
    configuration: {
      ...trust(),
      installationId: original.scope.installationId,
      role: "lifecycle-authority",
      allowedScope: { kind: "agent", ...original.scope },
      permittedRecipientRef: call.recipientRef,
    },
    authenticatedAt: "2026-09-09T00:00:00.000Z",
    expiresAt: "2026-09-09T00:00:05.000Z",
    peerEvidenceRef: "controlled/native-service",
    transportBinding: token,
  };
  const inspect = {
    async inspect(actualContext, actualCall) {
      assert.equal(this, inspect);
      events.push("inspect");
      if (hooks.inspect) return hooks.inspect(actualContext, actualCall);
      return actualContext === context && actualCall.signal === controller.signal
        ? verified
        : undefined;
    },
  };
  let releaseCount = 0,
    admitCount = 0,
    sourceCurrentCount = 0,
    capturedUnit;
  const owner = {
    async run(invocation, service, actualCall, work) {
      assert.equal(this, owner);
      assert.equal(actualCall.context, context);
      assert.equal(service.transportBinding, token);
      assert.notEqual(service.configuration, verified.configuration);
      events.push("owner");
      try {
        if (hooks.owner) await hooks.owner();
        const result = await state.transact(async (platform) => {
          let originalRead;
          const unit = {
            async acquireCurrent() {
              events.push("acquire-purpose");
              if (hooks.acquire) await hooks.acquire(invocation, actualCall);
              const lease = {
                release() {
                  assert.equal(this, lease);
                  events.push("source-release");
                  releaseCount++;
                  return hooks.release ? hooks.release(retained[0]) : Promise.resolve();
                },
                assertCurrent() {
                  assert.equal(this, lease);
                  events.push("source-current");
                  sourceCurrentCount++;
                  if (hooks.current) return hooks.current(sourceCurrentCount);
                },
                async prepareCommit() {
                  assert.equal(this, lease);
                  events.push("prepare-commit");
                  if (hooks.prepare) await hooks.prepare();
                },
                async qualifyRetained(value) {
                  assert.equal(this, lease);
                  assert.equal(value, originalRead);
                  events.push("qualify-retained");
                  if (hooks.qualify) await hooks.qualify(value);
                },
                async qualifyRequest(operation) {
                  assert.equal(this, lease);
                  assert.ok(samePreparationValue(operation, invocation.input));
                  events.push("qualify-historical-request");
                  if (hooks.qualifyRequest) await hooks.qualifyRequest();
                },
              };
              if (hooks.lease) hooks.lease(lease);
              return lease;
            },
            retain(lease) {
              assert.equal(this, unit);
              events.push("retain");
              retained.push(lease);
              if (hooks.retain) return hooks.retain(lease);
            },
            assertCurrent() {
              assert.equal(this, unit);
              events.push("unit-current");
              if (hooks.unitCurrent) return hooks.unitCurrent();
            },
            async readRetained() {
              assert.equal(this, unit);
              events.push("read-retained");
              const preparation = await platform.runtimePreparation.findPreparation(
                original.scope,
                original.plan.preparationRef,
              );
              const history = await platform.runtimePreparation.listHistory(
                original.scope,
                original.plan.preparationRef,
              );
              let gate = {
                status: "observed",
                guard: copy(input.guard),
                plan: copy(preparation.plan),
                children: [],
                ordinaryAdmission: "open",
                sealerAdmission: "closed",
                authority: "current",
                evidence: currentEvidence(),
              };
              if (hooks.gate) gate = await hooks.gate(gate, platform);
              originalRead = { preparation, history, gate };
              if (hooks.read) originalRead = hooks.read(copy(originalRead));
              return originalRead;
            },
            async admitChild() {
              assert.equal(this, unit);
              events.push("admit-child");
              admitCount++;
              if (hooks.admit) return hooks.admit(invocation);
              return {
                status: "admitted",
                child: copy(invocation.input),
                evidence: currentEvidence(),
              };
            },
            async completeFence() {
              assert.equal(this, unit);
              events.push("complete-fence");
              return {
                schemaVersion: 1,
                status: "unavailable",
                request: invocation.input.request,
                reasonCode: "authority-unavailable",
              };
            },
            async recordFaultAndRequestStop() {
              assert.equal(this, unit);
              events.push("record-fault");
              return {
                status: "unavailable",
                operation: invocation.input.operation,
                reasonCode: "authority-unavailable",
              };
            },
            async readRequest() {
              assert.equal(this, unit);
              events.push("read-request");
              return {
                status: "not-found",
                operation: invocation.input,
                reasonCode: "unavailable",
              };
            },
          };
          capturedUnit = unit;
          if (hooks.unit) hooks.unit(unit);
          const result = await work(unit);
          for (const lease of retained) await lease.prepareCommit();
          if (hooks.beforeCommit) await hooks.beforeCommit();
          unit.assertCurrent();
          for (const lease of retained) lease.assertCurrent();
          events.push("controlled-memory-final-fence");
          return result;
        });
        return hooks.terminal ? hooks.terminal(result) : result;
      } catch (error) {
        if (hooks.ownerFailure) return hooks.ownerFailure(error, invocation);
        throw error;
      } finally {
        for (const lease of retained) await lease.release();
      }
    },
  };
  const options = {
    installationId: original.scope.installationId,
    recipientRef: call.recipientRef,
    clock: { now: () => new Date(timestamp), monotonicMilliseconds: () => 0 },
    contextFactory: inspect,
    owner,
  };
  return {
    state,
    original,
    input,
    events,
    hooks,
    retained,
    call,
    controller,
    context,
    token,
    verified,
    inspect,
    owner,
    options,
    service: new RuntimePreparationEffectAdmissionV1(options),
    counts: () => ({ releaseCount, admitCount, sourceCurrentCount }),
    unit: () => capturedUnit,
  };
}

test("missing original owner or native inspector refuses before any accepting operation", async () => {
  const f = await fixture();
  for (const absent of ["owner", "contextFactory"]) {
    const service = new RuntimePreparationEffectAdmissionV1({ ...f.options, [absent]: undefined });
    assert.equal((await service.admitChild(f.input, f.call)).status, "unavailable");
  }
  assert.deepEqual(f.events, []);
});

test("real service joins the real retained plan/bytes before its controlled accepting operation", async () => {
  const f = await fixture();
  const result = await f.service.admitChild(f.input, f.call);
  assert.equal(result.status, "admitted");
  assert.ok(samePreparationValue(result.child, f.input));
  assert.equal(f.counts().admitCount, 1);
  assert.equal(f.counts().releaseCount, 1);
  assert.ok(f.events.indexOf("retain") < f.events.indexOf("qualify-retained"));
  assert.ok(f.events.indexOf("qualify-retained") < f.events.indexOf("admit-child"));
  assert.ok(f.events.indexOf("prepare-commit") < f.events.indexOf("controlled-memory-final-fence"));
  assert.ok(f.events.indexOf("controlled-memory-final-fence") < f.events.indexOf("source-release"));
});

test("constructor captures original owner and inspector receivers once", async () => {
  const f = await fixture();
  f.owner.run = () => {
    throw new Error("replacement owner");
  };
  f.inspect.inspect = () => {
    throw new Error("replacement inspector");
  };
  assert.equal((await f.service.admitChild(f.input, f.call)).status, "admitted");
});

test("copied native context and wrong recipient refuse without entering the owner", async () => {
  const f = await fixture();
  assert.equal(
    (await f.service.admitChild(f.input, { ...f.call, context: copy(f.context) })).status,
    "unavailable",
  );
  assert.equal(
    (await f.service.admitChild(f.input, { ...f.call, recipientRef: "other" })).status,
    "unavailable",
  );
  assert.equal(f.events.includes("owner"), false);
});

test("a source rejecting the exact purpose cannot be replaced by inspector success", async () => {
  const f = await fixture();
  f.hooks.acquire = (invocation) => {
    assert.equal(invocation.method, "admitChild");
    throw new Error("original native profile does not admit this purpose");
  };
  assert.equal((await f.service.admitChild(f.input, f.call)).status, "unavailable");
  assert.equal(f.events.includes("read-retained"), false);
  assert.equal(f.counts().admitCount, 0);
});

for (const variant of ["closed", "lost", "unknown", "stale"])
  test(`${variant} gate prevents child admission`, async () => {
    const f = await fixture();
    f.hooks.gate = (gate) => {
      if (variant === "stale") gate.evidence.clock.validUntil = "2026-09-09T00:00:00.500Z";
      else {
        gate.ordinaryAdmission = "closed";
        if (variant !== "closed") gate.authority = variant;
      }
      return gate;
    };
    assert.equal((await f.service.admitChild(f.input, f.call)).status, "unavailable");
    assert.equal(f.counts().admitCount, 0);
    assert.equal(f.counts().releaseCount, 1);
  });

test("readGate returns the exact controlled observation without invoking a child operation", async () => {
  const f = await fixture();
  f.hooks.gate = (gate) => ({ ...gate, ordinaryAdmission: "closed" });
  const result = await f.service.readGate(f.input.guard, f.call);
  assert.equal(result.status, "observed");
  assert.equal(result.ordinaryAdmission, "closed");
  assert.ok(samePreparationValue(result.guard, f.input.guard));
  assert.equal(f.counts().admitCount, 0);
});

for (const variant of ["full-plan", "history", "provider-wire", "preparation-ref"])
  test(`mismatched retained ${variant} refuses before the operation`, async () => {
    const f = await fixture();
    f.hooks.read = (value) => {
      if (variant === "full-plan")
        value.gate.plan.targets[0].desiredSpecDigest = `sha256:${"9".repeat(64)}`;
      if (variant === "history") value.history = value.history.slice(1);
      if (variant === "provider-wire") value.preparation.children[0].providerWireUtf8 += " ";
      if (variant === "preparation-ref") value.preparation.preparationRef = randomUUID();
      return value;
    };
    assert.equal((await f.service.admitChild(f.input, f.call)).status, "unavailable");
    assert.equal(f.counts().admitCount, 0);
  });

test("matching effect ID with changed original request cannot substitute for the retained child", async () => {
  const f = await fixture();
  const changed = copy(f.input);
  changed.request.predicate.resourceVersion = "another-exact-resource-version";
  const rebuilt = rebuildPreparationChild(changed, f.original.providerWireUtf8);
  assert.equal((await f.service.admitChild(rebuilt, f.call)).status, "unavailable");
  assert.equal(f.counts().admitCount, 0);
});

test("missing positive admission operation stays unavailable after genuine data comparison", async () => {
  const f = await fixture();
  f.hooks.unit = (unit) => {
    delete unit.admitChild;
  };
  assert.equal((await f.service.admitChild(f.input, f.call)).status, "unavailable");
  assert.ok(f.events.includes("qualify-retained"));
  assert.equal(f.counts().admitCount, 0);
});

test("currentness lost during qualification is rechecked before accepting entry", async () => {
  const f = await fixture();
  f.hooks.qualify = () => {
    f.controller.abort();
  };
  assert.equal((await f.service.admitChild(f.input, f.call)).status, "unavailable");
  assert.equal(f.counts().admitCount, 0);
});

test("an acquired throwing getter is cleaned up after ownership transfer", async () => {
  const f = await fixture();
  f.hooks.lease = (lease) => {
    Object.defineProperty(lease, "qualifyRetained", {
      get() {
        throw new Error("qualified source getter");
      },
    });
  };
  assert.equal((await f.service.admitChild(f.input, f.call)).status, "unavailable");
  assert.equal(f.counts().releaseCount, 1);
  assert.ok(f.events.indexOf("retain") < f.events.indexOf("source-release"));
});

test("malformed deferred currentness drains before original source cleanup", async () => {
  const f = await fixture(),
    held = deferred(),
    entered = deferred();
  f.hooks.current = (n) => {
    if (n === 1) {
      entered.resolve();
      return held.promise;
    }
  };
  const result = f.service.admitChild(f.input, f.call);
  await entered.promise;
  await Promise.resolve();
  assert.equal(f.counts().releaseCount, 0);
  held.resolve();
  assert.equal((await result).status, "unavailable");
  assert.equal(f.counts().releaseCount, 1);
  await f.service.joinPending();
});

test("retention failure and synchronous reentrant release join one original cleanup", async () => {
  const f = await fixture();
  let reentrant;
  f.hooks.retain = () => {
    throw new Error("owner refused transfer");
  };
  f.hooks.release = (lease) => {
    reentrant = lease.release();
    return Promise.resolve();
  };
  assert.equal((await f.service.admitChild(f.input, f.call)).status, "unavailable");
  assert.equal(f.counts().releaseCount, 1);
  assert.equal(reentrant, f.retained[0].release());
});

test("cleanup refusal after accepting entry cannot become a definite negative or success", async () => {
  const f = await fixture();
  f.hooks.release = () => Promise.reject(new Error("cleanup refused"));
  const result = await f.service.admitChild(f.input, f.call);
  assert.equal(result.status, "commit-unknown");
  assert.equal(f.counts().admitCount, 1);
  assert.equal(f.counts().releaseCount, 1);
});

test("exact owner COMMIT uncertainty survives a prior callback failure", async () => {
  const f = await fixture();
  f.hooks.qualify = () => {
    throw new Error("original qualification failed");
  };
  f.hooks.ownerFailure = (_error, invocation) => ({
    status: "commit-unknown",
    effect: invocation.input.effect,
  });
  assert.equal((await f.service.admitChild(f.input, f.call)).status, "commit-unknown");
  assert.equal(f.counts().admitCount, 0);
});

test("typed unknown terminal is preserved without fabricating an applied child", async () => {
  const f = await fixture();
  f.hooks.terminal = () => {
    throw new PostgresCommitOutcomeUnknownError();
  };
  assert.equal((await f.service.admitChild(f.input, f.call)).status, "commit-unknown");
});

test("caught final-fence currentness failure remains latched through terminal processing", async () => {
  const f = await fixture();
  f.hooks.beforeCommit = () => {
    f.hooks.current = () => {
      throw new Error("one-shot currentness loss");
    };
    assert.throws(() => f.retained[0].assertCurrent(), /one-shot currentness loss/);
    delete f.hooks.current;
  };
  assert.equal((await f.service.admitChild(f.input, f.call)).status, "commit-unknown");
  assert.equal(f.events.includes("controlled-memory-final-fence"), false);
  assert.equal(f.counts().releaseCount, 1);
});

test("a replaced terminal result cannot erase the actual callback result", async () => {
  const f = await fixture();
  f.hooks.terminal = () => ({ status: "unavailable", effect: f.input.effect });
  assert.equal((await f.service.admitChild(f.input, f.call)).status, "commit-unknown");
});

test("historical fault lookup uses exact independent read rights without active preparation", async () => {
  const f = await fixture();
  await f.original.append(f.original.close);
  const operation = { ...fault().operation, scope: f.original.scope };
  f.hooks.read = () => {
    throw new Error("historical read must not reacquire open work");
  };
  const result = await f.service.readRequest(operation, f.call);
  assert.equal(result.status, "not-found");
  assert.ok(f.events.includes("qualify-historical-request"));
  assert.equal(f.events.includes("read-retained"), false);
  assert.equal(f.events.includes("admit-child"), false);
});

test("fault and fence methods retain canonical inputs and refuse missing original owners", async () => {
  const f = await fixture();
  const service = new RuntimePreparationEffectAdmissionV1({ ...f.options, owner: undefined });
  const faultInput = fault();
  const complete = fenceState();
  const proposal = {
    schemaVersion: 1,
    kind: "complete-fence",
    request: complete.request,
    targets: complete.targets,
    children: complete.children,
  };
  const faultResult = await service.recordFaultAndRequestStop(faultInput, f.call);
  const fenceResult = await service.completeFence(proposal, f.call);
  assert.equal(faultResult.status, "unavailable");
  assert.ok(samePreparationValue(faultResult.operation, faultInput.operation));
  assert.equal(fenceResult.status, "unavailable");
  assert.ok(samePreparationValue(fenceResult.request, proposal.request));
  assert.deepEqual(f.events, []);
});

test("independent fault path reaches its exact operation despite affected ordinary authority loss", async () => {
  const f = await fixture();
  const request = { ...fault(), target: f.input.effect.target, guard: f.input.guard };
  request.operation = { ...request.operation, scope: f.original.scope };
  request.operation.requestDigest = hash(canonicalRuntimeFaultRequestV1(request));
  f.hooks.gate = (gate) => ({ ...gate, ordinaryAdmission: "closed", authority: "lost" });
  const result = await f.service.recordFaultAndRequestStop(request, f.call);
  assert.equal(result.status, "unavailable"); // Controlled writer supplies no real durable denial receipt.
  assert.ok(f.events.includes("record-fault"));
  assert.ok(samePreparationValue(result.operation, request.operation));
  assert.equal(f.counts().admitCount, 0);
});

test("fence completion compares the full retained plan and independent current sealer", async () => {
  const f = await fixture();
  const guard = {
    ...f.input.guard,
    responsibility: {
      responsibilityRef: randomUUID(),
      responsibilityVersion: 1,
      kind: "protective-fence",
    },
  };
  const request = {
    schemaVersion: 1,
    fenceRef: randomUUID(),
    requestDigest: `sha256:${"0".repeat(64)}`,
    guard,
    plan: f.input.request.plan,
    children: [],
  };
  request.requestDigest = hash(canonicalRuntimeFenceRequestV1(request));
  const proposal = {
    schemaVersion: 1,
    kind: "complete-fence",
    request,
    targets: request.plan.targets.map(({ target }) => ({
      target,
      status: "settled",
      evidence: currentEvidence(),
    })),
    children: [],
  };
  f.hooks.gate = (gate) => ({
    ...gate,
    guard,
    ordinaryAdmission: "closed",
    sealerAdmission: "open",
  });
  assert.equal((await f.service.completeFence(proposal, f.call)).status, "unavailable");
  assert.ok(f.events.includes("complete-fence"));
  assert.equal(f.counts().admitCount, 0);
});

// EAD-1: public abort/deadline settlement and complete retained ownership are
// observed separately. Deliberately deferred original ports ignore cancellation;
// they remain joined, and their eventual completion cannot start a late write.
for (const phase of ["inspect", "owner", "acquire", "qualify"])
  test(`abort bounds public admission while the original ${phase} remains joined`, async () => {
    const f = await fixture(),
      entered = deferred(),
      held = deferred();
    f.hooks[phase] = async () => {
      entered.resolve();
      await held.promise;
      if (phase === "inspect") return f.verified;
    };
    const result = f.service.admitChild(f.input, f.call);
    let joined = false;
    try {
      await within(entered.promise);
      const joining = f.service.joinPending().then(() => {
        joined = true;
      });
      f.controller.abort();
      assert.equal((await within(result)).status, "unavailable");
      assert.equal(joined, false);
      assert.equal(f.counts().admitCount, 0);
      assert.equal(f.counts().releaseCount, 0);
      held.resolve();
      await within(joining);
      assert.equal(f.counts().admitCount, 0);
      assert.equal(f.events.includes("controlled-memory-final-fence"), false);
      assert.equal(f.counts().releaseCount, phase === "acquire" || phase === "qualify" ? 1 : 0);
    } finally {
      held.resolve();
      await within(f.service.joinPending());
    }
  });

test("absolute deadline bounds a deferred inspector without replacing original call identity", async () => {
  const f = await fixture(),
    entered = deferred(),
    held = deferred();
  f.hooks.inspect = async (context, call) => {
    assert.equal(context, f.context);
    assert.equal(call.signal, f.call.signal);
    entered.resolve();
    await held.promise;
    return f.verified;
  };
  const call = { ...f.call, deadline: new Date(Date.parse(timestamp) + 25).toISOString() };
  const result = f.service.admitChild(f.input, call);
  try {
    await within(entered.promise);
    assert.equal((await within(result)).status, "unavailable");
    assert.equal(f.controller.signal.aborted, false);
    let joined = false;
    const joining = f.service.joinPending().then(() => {
      joined = true;
    });
    await Promise.resolve();
    assert.equal(joined, false);
    held.resolve();
    await within(joining);
    assert.equal(f.events.includes("owner"), false);
  } finally {
    held.resolve();
    await within(f.service.joinPending());
  }
});

test("the three-second authority ceiling bounds a later absolute deadline", async () => {
  const f = await fixture(),
    entered = deferred(),
    held = deferred();
  f.hooks.inspect = async () => {
    entered.resolve();
    await held.promise;
    return f.verified;
  };
  const result = f.service.admitChild(f.input, {
    ...f.call,
    deadline: new Date(Date.parse(timestamp) + 10000).toISOString(),
  });
  try {
    await within(entered.promise);
    assert.equal((await within(result, 4500)).status, "unavailable");
    assert.equal(f.events.includes("owner"), false);
  } finally {
    held.resolve();
    await within(f.service.joinPending());
  }
});

for (const phase of ["admit", "release"])
  test(`abort after accepting entry returns unknown while ${phase} stays owned`, async () => {
    const f = await fixture(),
      entered = deferred(),
      held = deferred();
    f.hooks[phase] = async (invocation) => {
      entered.resolve();
      await held.promise;
      if (phase === "admit")
        return { status: "admitted", child: copy(invocation.input), evidence: currentEvidence() };
    };
    const result = f.service.admitChild(f.input, f.call);
    let joined = false;
    try {
      await within(entered.promise);
      const joining = f.service.joinPending().then(() => {
        joined = true;
      });
      f.controller.abort();
      const outward = await within(result);
      assert.equal(outward.status, "commit-unknown");
      assert.ok(samePreparationValue(outward.effect, f.input.effect));
      assert.equal(joined, false);
      assert.equal(f.counts().admitCount, 1);
      held.resolve();
      await within(joining);
      assert.equal(f.counts().releaseCount, 1);
      assert.equal(f.counts().admitCount, 1);
    } finally {
      held.resolve();
      await within(f.service.joinPending());
    }
  });

// EAD-2: this is the original supported retention behavior, not a no-op sink.
test("retain can immediately assert the complete fence and still release exactly once", async () => {
  const f = await fixture();
  let checked = false;
  f.hooks.retain = (lease) => {
    assert.equal(lease.assertCurrent(), undefined);
    checked = true;
  };
  assert.equal((await f.service.admitChild(f.input, f.call)).status, "admitted");
  assert.equal(checked, true);
  assert.equal(f.counts().releaseCount, 1);
});

test("currentness getter failure before transfer retains local exactly-once cleanup", async () => {
  const f = await fixture();
  f.hooks.lease = (lease) => {
    Object.defineProperty(lease, "assertCurrent", {
      get() {
        throw new Error("original currentness getter failed");
      },
    });
  };
  assert.equal((await f.service.admitChild(f.input, f.call)).status, "unavailable");
  assert.equal(f.events.includes("retain"), false);
  assert.equal(f.counts().releaseCount, 1);
});

// EAD-3: every extra operation is accepted by the real existing repository.
// Only the combined history crosses the single-request limit; no capability or
// provider authenticity is claimed by these retained representation inputs.
test("full valid retained history above one MiB reaches qualification without truncation", async () => {
  const f = await fixture();
  const wire = JSON.stringify({ kind: "controlled-retained-wire", payload: "x".repeat(64000) });
  assert.ok(Buffer.byteLength(wire, "utf8") <= 65536);
  for (let index = 0; index < 17; index++) {
    const child = copy(f.input);
    child.request.effect.effectRef = randomUUID();
    const original = {
      ...copy(f.original.child),
      operationRef: randomUUID(),
      expectedVersion: index + 2,
      child: rebuildPreparationChild(child, wire),
      providerWireUtf8: wire,
    };
    const result = await f.original.append(original);
    assert.equal(result.status, "retained");
    assert.ok(
      Buffer.byteLength(result.operation.canonicalRequest, "utf8") <=
        RUNTIME_PREPARATION_MAX_REQUEST_BYTES,
    );
  }
  const preparation = await f.original.record();
  const history = await f.original.history();
  assert.equal(preparation.children.length, 18);
  assert.equal(history.length, 19);
  assert.ok(
    Buffer.byteLength(JSON.stringify(preparation), "utf8") > RUNTIME_PREPARATION_MAX_REQUEST_BYTES,
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify(history), "utf8") > RUNTIME_PREPARATION_MAX_REQUEST_BYTES,
  );
  let qualified = false;
  f.hooks.qualify = (retained) => {
    assert.equal(retained.preparation.children.length, 18);
    assert.equal(retained.history.length, 19);
    retained.history.forEach((entry, index) =>
      assert.equal(entry.canonicalRequest, history[index].canonicalRequest),
    );
    qualified = true;
  };
  assert.equal((await f.service.admitChild(f.input, f.call)).status, "admitted");
  assert.equal(qualified, true);
  assert.equal(f.counts().admitCount, 1);
  assert.equal(f.counts().releaseCount, 1);
});
