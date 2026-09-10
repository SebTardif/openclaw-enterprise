import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  canonicalRuntimeAuthorityMutationV1,
  parseRuntimeAuthorityV1,
  parseRuntimeMutationResultV1,
} from "@openclaw-enterprise/contracts";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { PostgresCommitOutcomeUnknownError } from "../../packages/occ/src/ports/transaction-errors.ts";
import { acceptInitialRuntimeBindingV1 } from "../../packages/occ/src/runtime-authority/initial-binding.ts";
import { exactRuntimeAuthorityOperation } from "../../packages/occ/src/runtime-authority/repository.ts";
import { RuntimeAuthorityService } from "../../packages/occ/src/runtime-authority/service.ts";
import { seedPreparation } from "../fixtures/runtime-preparation.mjs";
import { trust } from "../fixtures/runtime-authority-v1/vectors.mjs";
import { writer } from "../fixtures/runtime-authority-state/seed.mjs";

const copy = (value) => structuredClone(value);
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const unavailable = (result) => {
  assert.equal(result.result, "rejected-before-effect");
  assert.equal(result.reasonCode, "lookup-unavailable");
};

// Real preparation/authority repositories and the original candidate builder are
// composed here. Source authentication, private locator membership, currentness
// and independent observation proofs are controlled boundary ports. These tests
// establish consumer correspondence, not native or PostgreSQL qualification.
async function fixture() {
  const state = new InMemoryPlatformState();
  const f = await seedPreparation(state);
  await f.append(f.plan);
  await f.append(f.child);
  const retained = await f.candidate();
  await f.append(retained);
  const request = retained.proposal;
  const abort = new AbortController();
  const context = Object.freeze({ controlledContext: randomUUID() });
  const transportBinding = Object.freeze({ controlledTransport: randomUUID() });
  const call = {
    context,
    requestRef: request.requestRef,
    recipientRef: "recipient/occ",
    deadline: "2026-09-09T00:00:02.000Z",
    signal: abort.signal,
  };
  const verified = {
    configuration: {
      ...trust(),
      installationId: f.scope.installationId,
      serviceIdentityRef: writer.acceptedServiceIdentityRef,
      role: "lifecycle-authority",
      allowedScope: { kind: "agent", ...f.scope },
      permittedRecipientRef: call.recipientRef,
    },
    authenticatedAt: "2026-09-09T00:00:00.000Z",
    expiresAt: "2026-09-09T00:00:05.000Z",
    peerEvidenceRef: "controlled/independent-service",
    transportBinding,
  };
  const events = [];
  const hooks = {};
  let currentUnit;
  const owner = {
    async run(captured, service, ownerCall, work) {
      events.push("acquire-source");
      assert.equal(service.transportBinding, transportBinding);
      assert.equal(ownerCall.context, context);
      assert.equal(service.configuration.serviceIdentityRef, writer.acceptedServiceIdentityRef);
      assert.notEqual(service.configuration, verified.configuration);
      if (hooks.acquire) await hooks.acquire(captured, service, ownerCall);
      let active = true;
      try {
        const result = await state.transact(async (platform) => {
          let originalPreparation;
          let qualified = false;
          let checks = 0;
          const unit = {
            assertCurrent() {
              assert.equal(active, true);
              assert.equal(ownerCall.signal.aborted, false);
              if (hooks.current) return hooks.current(++checks);
            },
            retain() {
              throw new Error("The consumer must not transfer an invented lease.");
            },
            async readReplay() {
              events.push("read-replay");
              const stored = await platform.runtimeAuthority.findOperation(
                f.scope,
                captured.operationRef,
              );
              if (!stored) return undefined;
              assert.equal(stored.canonicalPayload, canonicalRuntimeAuthorityMutationV1(captured));
              assert.equal(
                stored.receipt.acceptedServiceIdentityRef,
                writer.acceptedServiceIdentityRef,
              );
              return { schemaVersion: 1, result: "exact-replay", receipt: stored.receipt };
            },
            async readPreparationLocator() {
              events.push("locate-preparation");
              // This controlled private lookup returns the actual original ref;
              // it does not add a public reverse reader to the memory repository.
              return hooks.locator ? hooks.locator() : { preparationRef: retained.preparationRef };
            },
            async findPreparation(ref) {
              events.push("read-preparation");
              assert.equal(ref, retained.preparationRef);
              originalPreparation = await platform.runtimePreparation.findPreparation(f.scope, ref);
              if (hooks.preparation)
                originalPreparation = hooks.preparation(copy(originalPreparation));
              return originalPreparation;
            },
            async requireCurrentProofs(preparation, proposal) {
              events.push("qualify");
              assert.equal(preparation, originalPreparation);
              assert.equal(preparation.bindingProposals.includes(proposal), true);
              if (hooks.qualify) await hooks.qualify(preparation, proposal);
              qualified = true;
            },
            async append() {
              assert.equal(qualified, true);
              events.push("append");
              return platform.runtimeAuthority.appendMutation(captured, writer);
            },
          };
          currentUnit = unit;
          const value = await work(unit);
          if (hooks.beforeCommit) await hooks.beforeCommit(unit, value);
          unit.assertCurrent();
          events.push("memory-commit-fence");
          return value;
        });
        if (hooks.afterCommit) await hooks.afterCommit(result);
        return result;
      } finally {
        active = false;
        events.push("source-release");
      }
    },
  };
  const accept = (input = request, selectedOwner = owner) =>
    acceptInitialRuntimeBindingV1(selectedOwner, input, verified, {
      ...call,
      requestRef: input.requestRef,
    });
  const row = () =>
    state.read((platform) =>
      platform.runtimeAuthority.findOperation(f.scope, request.operationRef),
    );
  const service = (initialBinding = owner) =>
    new RuntimeAuthorityService({
      store: state,
      installationId: f.scope.installationId,
      recipientRef: call.recipientRef,
      clock: {
        now: () => new Date("2026-09-09T00:00:00.000Z"),
        monotonicMilliseconds: () => performance.now(),
      },
      contextFactory: {
        async inspect(received) {
          return received === context ? verified : undefined;
        },
      },
      currentTrust: {
        async readCurrent() {
          return {
            configuration: verified.configuration,
            operationPolicy: "initial-harness-bind-v1",
          };
        },
      },
      requestBinding: {
        matchesRequest(_method, input, received) {
          return received.context === context && input.requestRef === call.requestRef;
        },
      },
      initialBinding: initialBinding === null ? undefined : initialBinding,
    });
  return {
    f,
    state,
    retained,
    request,
    abort,
    call,
    verified,
    events,
    hooks,
    owner,
    accept,
    row,
    service,
    unit: () => currentUnit,
  };
}

test("initial bind joins the original retained proposal and authority append on one memory unit", async () => {
  const h = await fixture();
  assert.notEqual(h.retained.operationRef, h.request.operationRef);
  const result = await h.accept();
  assert.equal(result.result, "applied");
  // The service's strict decoder returns detached null-prototype DTOs. Decode
  // the independently stored expectation while retaining every field check.
  assert.deepEqual(
    result,
    parseRuntimeMutationResultV1("bind", {
      schemaVersion: 1,
      result: "applied",
      receipt: (await h.row()).receipt,
    }),
  );
  assert.deepEqual(
    result.receipt.outcome.binding,
    parseRuntimeAuthorityV1("binding", h.request.binding),
  );
  assert.deepEqual(h.events, [
    "acquire-source",
    "read-replay",
    "locate-preparation",
    "read-preparation",
    "qualify",
    "append",
    "memory-commit-fence",
    "source-release",
  ]);
  assert.equal((await h.f.assignment()).binding.status, "bound");
  assert.equal((await h.f.record()).bindingProposals.length, 1);
  assert.throws(() => h.unit().assertCurrent());
});

test("the accepting service preserves exact native identities and invokes its captured owner", async () => {
  const h = await fixture();
  const accepting = h.service();
  h.owner.run = () => {
    throw new Error("replacement must not be selected");
  };
  const result = await accepting.bind(h.request, h.call);
  assert.equal(result.result, "applied");
  await accepting.joinPendingReadbacks();
  assert.equal(h.events.filter((entry) => entry === "source-release").length, 1);
  assert.equal((await h.row()).receipt.operationRef, h.request.operationRef);
});

test("exact historical replay precedes fresh preparation and profile acquisition", async () => {
  const h = await fixture();
  const first = await h.accept();
  await h.f.advance();
  h.events.length = 0;
  h.hooks.locator = () => {
    throw new Error("replay must not acquire a fresh preparation");
  };
  h.hooks.qualify = () => {
    throw new Error("replay must not acquire fresh profiles");
  };
  const replay = await h.accept();
  assert.equal(replay.result, "exact-replay");
  assert.deepEqual(replay.receipt, first.receipt);
  assert.deepEqual(h.events, [
    "acquire-source",
    "read-replay",
    "memory-commit-fence",
    "source-release",
  ]);
});

for (const [name, change] of [
  [
    "different original request ref despite identical canonical bytes",
    (record) => {
      record.bindingProposals[0].proposal.requestRef = "request/different";
    },
  ],
  [
    "wrong canonical proposal",
    (record) => {
      record.bindingProposals[0].canonicalProposalJson += " ";
    },
  ],
  [
    "different exact operation request ref",
    (record) => {
      record.bindingProposals[0].operation.requestRef = "request/different";
    },
  ],
  [
    "different operation identity",
    (record) => {
      record.bindingProposals[0].operation.operationRef = randomUUID();
    },
  ],
  [
    "duplicate retained proposal",
    (record) => {
      record.bindingProposals.push(copy(record.bindingProposals[0]));
    },
  ],
  [
    "different preparation locator identity",
    (record) => {
      record.preparationRef = randomUUID();
    },
  ],
  [
    "foreign preparation target",
    (record) => {
      record.target.agentId = "agent/foreign";
    },
  ],
]) {
  test(`initial binding refuses ${name} before independent proof or append`, async () => {
    const h = await fixture();
    h.hooks.preparation = (record) => {
      change(record);
      return record;
    };
    unavailable(await h.accept());
    assert.equal(h.events.includes("qualify"), false);
    assert.equal(h.events.includes("append"), false);
    assert.equal(await h.row(), undefined);
    assert.equal((await h.f.assignment()).binding.status, "unbound");
    assert.equal(h.events.at(-1), "source-release");
  });
}

test("an actually closed retained preparation cannot qualify a new bind", async () => {
  const h = await fixture();
  await h.f.append({ ...h.f.close, expectedVersion: 3 });
  assert.equal((await h.f.record()).localState, "closed");
  unavailable(await h.accept());
  assert.equal(h.events.includes("qualify"), false);
  assert.equal(await h.row(), undefined);
});

test("matching proposal data cannot replace the independent proof supplier", async () => {
  const h = await fixture();
  h.hooks.qualify = () => {
    throw new Error("authentic profile or observation is missing");
  };
  unavailable(await h.accept());
  assert.equal(h.events.includes("qualify"), true);
  assert.equal(h.events.includes("append"), false);
  assert.equal(await h.row(), undefined);
});

test("absence of the private locator refuses without an inferred preparation", async () => {
  const h = await fixture();
  h.hooks.locator = () => undefined;
  unavailable(await h.accept());
  assert.equal(h.events.includes("read-preparation"), false);
  assert.equal(await h.row(), undefined);
});

test("deferred currentness is refused and joined before releasing the controlled source", async () => {
  const h = await fixture();
  const pending = deferred();
  const observed = deferred();
  h.hooks.current = () => {
    observed.resolve();
    return pending.promise;
  };
  let settled = false;
  const running = h.accept().then((value) => {
    settled = true;
    return value;
  });
  await observed.promise;
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(h.events.includes("source-release"), false);
  pending.resolve();
  unavailable(await running);
  assert.equal(h.events.at(-1), "source-release");
  assert.equal(await h.row(), undefined);
});

test("a swallowed callback failure cannot be changed to positive acceptance", async () => {
  const h = await fixture();
  h.hooks.qualify = () => {
    throw new Error("missing independent proof");
  };
  const { requestRef: _requestRef, ...key } = exactRuntimeAuthorityOperation(h.request);
  // Deliberately forged, schema-valid data from a broken boundary owner must not
  // erase the actual callback failure or become a stored receipt.
  const forged = {
    schemaVersion: 1,
    result: "applied",
    receipt: {
      ...key,
      assignmentRef: h.request.target.assignmentRef,
      ...writer,
      assignmentRecordVersion: h.request.expectedAssignmentRecordVersion + 1,
      outcome: { kind: "bind", binding: h.request.binding },
    },
  };
  const swallowing = {
    async run(...args) {
      try {
        return await h.owner.run(...args);
      } catch {
        return forged;
      }
    },
  };
  unavailable(await h.accept(h.request, swallowing));
  assert.equal(await h.row(), undefined);
});

test("unknown acknowledgment retains the exact operation and permits historical readback only", async () => {
  const h = await fixture();
  h.hooks.afterCommit = () => {
    throw new PostgresCommitOutcomeUnknownError();
  };
  const result = await h.accept();
  assert.equal(result.result, "commit-unknown");
  assert.equal(result.nextAction, "exact-readback-only");
  assert.deepEqual(result.operation, exactRuntimeAuthorityOperation(h.request));
  assert.ok(await h.row());
  delete h.hooks.afterCommit;
  const replay = await h.accept();
  assert.equal(replay.result, "exact-replay");
  assert.deepEqual(
    replay,
    parseRuntimeMutationResultV1("bind", {
      schemaVersion: 1,
      result: "exact-replay",
      receipt: (await h.row()).receipt,
    }),
  );
});

test("an exact owner terminal unknown takes precedence over a failed callback", async () => {
  const h = await fixture();
  h.hooks.qualify = () => {
    throw new Error("qualification failed");
  };
  const terminal = {
    schemaVersion: 1,
    result: "commit-unknown",
    operation: exactRuntimeAuthorityOperation(h.request),
    nextAction: "exact-readback-only",
  };
  const uncertain = {
    async run(...args) {
      try {
        return await h.owner.run(...args);
      } catch {
        return terminal;
      }
    },
  };
  assert.deepEqual(
    await h.accept(h.request, uncertain),
    parseRuntimeMutationResultV1("bind", terminal),
  );
  assert.equal(h.events.includes("append"), false);
  assert.equal(await h.row(), undefined);
});

test("public cancellation retains the actual owner drain until terminal rollback", async () => {
  const h = await fixture();
  const entered = deferred();
  const held = deferred();
  h.hooks.qualify = async () => {
    entered.resolve();
    await held.promise;
  };
  const accepting = h.service();
  const running = accepting.bind(h.request, h.call);
  await entered.promise;
  h.abort.abort();
  const result = await running;
  assert.equal(result.result, "commit-unknown");
  assert.deepEqual(result.operation, exactRuntimeAuthorityOperation(h.request));
  let joined = false;
  const drain = accepting.joinPendingReadbacks().then(() => {
    joined = true;
  });
  await Promise.resolve();
  assert.equal(joined, false);
  assert.equal(h.events.includes("source-release"), false);
  held.resolve();
  await drain;
  assert.equal(h.events.at(-1), "source-release");
  assert.equal(h.events.includes("append"), false);
  assert.equal(await h.row(), undefined);
});

test("service without an accepting owner refuses even matching controlled authenticated data", async () => {
  const h = await fixture();
  const accepting = h.service(null);
  unavailable(await accepting.bind(h.request, h.call));
  await accepting.joinPendingReadbacks();
  assert.deepEqual(h.events, []);
  assert.equal(await h.row(), undefined);
});
