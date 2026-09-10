import assert from "node:assert/strict";
import test from "node:test";
import {
  bindingFrom,
  createBrokerPeers,
  deferredGate,
  metadataBytes,
  readRequest,
  sha256,
} from "../fixtures/read-mvp/broker-peers.mjs";

// READ-02 covers the actual broker at its declared component ports. Transport
// identity and owner operands are controlled inputs; these cases do not prove
// native TLS, original Work authorization, custody, Git bytes, or publication.
const options = { timeout: 10_000 };
const uploadBody = new TextEncoder().encode("0014command=ls-refs\n00010009peel\n0000");
const eventsOf = (f, kind) => f.events.filter((event) => event.kind === kind);
const dispatchFrame = (opened) => ({
  ...bindingFrom(opened),
  sequence: 2,
  method: "dispatch-read",
  dns_binding_ref: opened.dns_binding_ref,
  upstream_ipv4: opened.upstream_ipv4,
  peer_certificate_sha256: `sha256:${"c".repeat(64)}`,
});
const checkFrame = (released, sequence = 3) => ({
  ...bindingFrom(released),
  sequence,
  method: "check-read",
  release_ref: released.release_ref,
});
const completeFrame = (released, sequence = 4) => ({
  ...bindingFrom(released),
  sequence,
  method: "complete-read",
  release_ref: released.release_ref,
  outcome: "completed",
});
async function open(f) {
  await f.send(f.request);
  assert.equal(f.replies.length, 1);
  assert.equal(f.replies[0].phase, "opened");
  return f.replies[0];
}
async function dispatch(f) {
  const opened = await open(f);
  await f.send(dispatchFrame(opened));
  assert.equal(f.releaseWrites.length, 1);
  assert.equal(f.releaseWrites[0].reply.phase, "dispatch-once");
  return f.releaseWrites[0].reply;
}
function assertSettlement(f, outcome, release) {
  assert.deepEqual(eventsOf(f, "settle"), [
    {
      kind: "settle",
      preparation: f.preparation,
      release,
      outcome,
    },
  ]);
  assert.equal(eventsOf(f, "settle")[0].preparation, f.preparation);
  assert.equal(eventsOf(f, "settle")[0].release, release);
}

test(
  "READ broker composes discovery and upload-pack through one exact release and receipt",
  options,
  async (t) => {
    for (const operation of ["discovery", "upload-pack"]) {
      await t.test(operation, async (t) => {
        const request = readRequest({
          operation,
          body: operation === "discovery" ? new Uint8Array(0) : uploadBody,
        });
        const f = createBrokerPeers(t, { request });
        const opened = await open(f);
        const sent = [request, dispatchFrame(opened)];
        await f.send(sent[1]);
        assert.equal(f.releaseWrites.length, 1);
        const released = f.releaseWrites[0].reply;
        sent.push(checkFrame(released));
        await f.send(sent[2]);
        sent.push(completeFrame(released));
        await f.send(sent[3]);
        await f.service.join();

        // Dispatch metadata must travel with custody through writeRelease, and
        // completion is visible only after the original owner's settlement reply.
        assert.deepEqual(
          f.replies.map((reply) => reply.phase),
          ["opened", "current", "recorded"],
        );
        assert.equal(released.phase, "dispatch-once");
        assert.deepEqual(
          f.events.map((event) => event.kind),
          [
            "inspect",
            "prepare",
            "inspect",
            "writeMetadata",
            "inspect",
            "dispatch",
            "inspect",
            "writeRelease",
            "inspect",
            "check",
            "inspect",
            "writeMetadata",
            "inspect",
            "settle",
            "writeMetadata",
            "close",
          ],
        );
        assert.deepEqual(
          eventsOf(f, "inspect").map((event) => event.metadataSha256),
          sent.flatMap((frame, index) =>
            Array(index === 3 ? 1 : 2).fill(sha256(metadataBytes(frame))),
          ),
        );
        const preparedInput = eventsOf(f, "prepare")[0].request;
        assert.deepEqual({ ...preparedInput }, request);
        assert.equal(Object.isFrozen(preparedInput), true);
        assert.equal(eventsOf(f, "dispatch")[0].preparation, f.preparation);
        assert.deepEqual({ ...eventsOf(f, "dispatch")[0].request }, sent[1]);
        assert.equal(eventsOf(f, "check")[0].preparation, f.preparation);
        assert.equal(eventsOf(f, "check")[0].release, f.release);
        assert.equal(f.releaseWrites[0].release, f.release);
        assert.equal(released.dns_binding_ref, sent[1].dns_binding_ref);
        assert.equal(released.upstream_ipv4, sent[1].upstream_ipv4);
        assert.equal(released.peer_certificate_sha256, sent[1].peer_certificate_sha256);
        for (const event of f.events.filter((event) => event.call)) {
          assert.equal(event.call.context, f.call.context);
          assert.equal(event.call.requestRef, f.call.requestRef);
          assert.equal(event.call.recipientRef, f.call.recipientRef);
        }
        for (const reply of [...f.replies, released])
          assert.deepEqual(bindingFrom(reply), bindingFrom(opened));
        assert.deepEqual(
          [opened.sequence, released.sequence, f.replies[1].sequence, f.replies[2].sequence],
          [1, 2, 3, 4],
        );
        assert.equal(f.replies[1].operation_until_ms, opened.operation_until_ms);
        assertSettlement(f, "completed", f.release);
      });
    }
  },
);

test(
  "READ broker rejects altered repository/body or write intent before any owner effect",
  options,
  async (t) => {
    const request = readRequest({ operation: "upload-pack", body: uploadBody });
    const mutations = [
      ["repository owner", { repository_owner: "another" }],
      ["repository name", { repository_name: "another" }],
      ["retained body length", { body_bytes: request.body_bytes + 1 }],
      ["retained body digest", { body_sha256: `sha256:${"d".repeat(64)}` }],
      ["receive-pack operation", { git_operation: "receive-pack" }],
      ["publication method", { method: "publish" }],
      ["receive-pack route override", { path: "/example/project.git/git-receive-pack" }],
    ];
    for (const [name, mutation] of mutations) {
      await t.test(name, async (t) => {
        const f = createBrokerPeers(t, { request });
        await f.send({ ...request, ...mutation });
        await f.service.join();
        assert.deepEqual(
          f.events.map((event) => event.kind),
          ["close"],
        );
        assert.deepEqual(f.releaseWrites, []);
      });
    }
  },
);

test(
  "READ broker copies exact metadata before an asynchronous transport inspection",
  options,
  async (t) => {
    const gate = deferredGate();
    let inspections = 0;
    const request = readRequest({ operation: "upload-pack", body: uploadBody });
    const f = createBrokerPeers(t, {
      request,
      steps: {
        async inspect(f) {
          if (++inspections === 1) await gate.wait();
          return f.peer.observation;
        },
      },
    });
    f.hold(gate);
    const bytes = metadataBytes(request);
    const handling = f.service.handle(bytes, f.call);
    await gate.entered;
    bytes.fill(0);
    gate.resolve();
    await handling;
    assert.equal(f.replies[0].phase, "opened");
    assert.deepEqual({ ...eventsOf(f, "prepare")[0].request }, request);
    assert.deepEqual(
      eventsOf(f, "inspect").map((event) => event.metadataSha256),
      [sha256(metadataBytes(request)), sha256(metadataBytes(request))],
    );
    await f.service.close(f.call);
    assertSettlement(f, "not-dispatched", undefined);
  },
);

test(
  "READ broker refuses crossed session/request/Work/DNS bindings after a valid open",
  options,
  async (t) => {
    const mutations = [
      ["session", { session_ref: "d".repeat(32) }],
      ["request", { request_sha256: `sha256:${"d".repeat(64)}` }],
      ["Work", { work_binding_sha256: `sha256:${"d".repeat(64)}` }],
      ["effect", { effect_ref: "effect/another" }],
      ["correlation", { request_ref: "d".repeat(32) }],
      ["DNS binding", { dns_binding_ref: "dns/another" }],
      ["upstream address", { upstream_ipv4: "140.82.114.6" }],
    ];
    for (const [name, mutation] of mutations) {
      await t.test(name, async (t) => {
        const f = createBrokerPeers(t);
        const opened = await open(f);
        await f.send({ ...dispatchFrame(opened), ...mutation });
        assert.equal(eventsOf(f, "dispatch").length, 0);
        assert.equal(f.releaseWrites.length, 0);
        assert.equal(f.replies.length, 1);
        assertSettlement(f, "not-dispatched", undefined);
        assert.equal(eventsOf(f, "close").length, 1);
      });
    }
  },
);

test(
  "READ broker never retries uncertain, denied, or failed dispatch responsibility",
  options,
  async (t) => {
    const canary = "private-owner-error-read-mvp";
    const cases = [
      [
        "unknown commit",
        { dispatch: () => ({ kind: "unknown" }) },
        "unknown",
        false,
        "unavailable",
      ],
      [
        "not released",
        { dispatch: () => ({ kind: "not-released", code: "denied" }) },
        "not-dispatched",
        false,
        "denied",
      ],
      [
        "dispatch error",
        {
          dispatch: () => {
            throw new Error(canary);
          },
        },
        "unknown",
        false,
        undefined,
      ],
      [
        "release write error",
        {
          writeRelease: () => {
            throw new Error(canary);
          },
        },
        "unknown",
        true,
        undefined,
      ],
    ];
    for (const [name, steps, outcome, acquired, refusal] of cases) {
      await t.test(name, async (t) => {
        const f = createBrokerPeers(t, { steps });
        const opened = await open(f);
        const frame = dispatchFrame(opened);
        await f.send(frame);
        assert.equal(f.replies.length, refusal ? 2 : 1);
        if (refusal)
          assert.deepEqual(f.replies[1], {
            version: 3,
            sequence: 2,
            request_ref: f.request.request_ref,
            ok: false,
            code: refusal,
          });
        await f.send(frame);
        await f.send(f.request);
        await f.service.join();
        assert.equal(eventsOf(f, "prepare").length, 1);
        assert.equal(eventsOf(f, "dispatch").length, 1);
        assert.equal(f.releaseWrites.length, acquired ? 1 : 0);
        assert.equal(eventsOf(f, "check").length, 0);
        assertSettlement(f, outcome, acquired ? f.release : undefined);
        assert.equal(JSON.stringify(f.replies).includes(canary), false);
        assert.equal(eventsOf(f, "close").length, 1);
      });
    }
  },
);

test(
  "READ broker rechecks exact transport identity after release acquisition",
  options,
  async (t) => {
    const mutations = [
      [
        "binding incarnation",
        (observation) => ({ ...observation, transportBinding: Object.freeze({}) }),
      ],
      [
        "configuration version",
        (observation) => ({
          ...observation,
          configuration: { ...observation.configuration, configurationVersion: 2 },
        }),
      ],
      [
        "identity horizon",
        (observation) => ({
          ...observation,
          expiresAt: new Date(Date.parse(observation.expiresAt) + 1).toISOString(),
        }),
      ],
      ["withdrawn observation", () => undefined],
    ];
    for (const [name, mutate] of mutations) {
      await t.test(name, async (t) => {
        const f = createBrokerPeers(t, {
          steps: {
            dispatch(f) {
              f.peer.observation = mutate(f.peer.observation);
              return f.released();
            },
          },
        });
        const opened = await open(f);
        await f.send(dispatchFrame(opened));
        assert.equal(eventsOf(f, "dispatch").length, 1);
        assert.equal(f.releaseWrites.length, 0);
        assert.equal(f.replies.length, 1);
        assertSettlement(f, "unknown", f.release);
        assert.equal(eventsOf(f, "close").length, 1);
      });
    }
  },
);

test("READ broker joins late original responsibility after native closure", options, async (t) => {
  for (const phase of ["prepare", "dispatch", "writeRelease"]) {
    await t.test(phase, async (t) => {
      const gate = deferredGate();
      const settlementGate = deferredGate();
      let settlementCompleted = false;
      const f = createBrokerPeers(t, {
        steps: {
          async [phase](f, ...args) {
            await gate.wait(args.at(-1));
            if (phase === "prepare") return f.prepared();
            if (phase === "dispatch") return f.released();
          },
          async settle() {
            await settlementGate.wait();
            settlementCompleted = true;
            return "recorded";
          },
        },
      });
      f.hold(gate);
      f.hold(settlementGate);
      const handling =
        phase === "prepare" ? f.send(f.request) : f.send(dispatchFrame(await open(f)));
      const ownerCall = await gate.entered;
      await f.service.close(f.call);
      assert.equal(ownerCall.signal.aborted, true);
      assert.equal(eventsOf(f, "close").length, 1);
      assert.equal(eventsOf(f, "settle").length, 0);
      let joined = false;
      const joining = f.service.join().then(() => {
        assert.equal(settlementCompleted, true);
        assertSettlement(
          f,
          phase === "prepare" ? "not-dispatched" : "unknown",
          phase === "prepare" ? undefined : f.release,
        );
        joined = true;
      });
      // Observe rejection immediately; the original promise is awaited below
      // so a premature join assertion still fails this test.
      void joining.catch(() => {});
      await Promise.resolve();
      assert.equal(joined, false);

      // The owner may acquire responsibility despite cancellation. Returning it
      // late must cause settlement, never a fresh dispatch or release write.
      gate.resolve();
      await settlementGate.entered;
      assert.equal(settlementCompleted, false);
      assert.equal(joined, false);
      settlementGate.resolve();
      await joining;
      await handling;
      assert.equal(joined, true);
      assert.equal(f.releaseWrites.length, phase === "writeRelease" ? 1 : 0);
      assert.equal(f.replies.length, phase === "prepare" ? 0 : 1);
      assertSettlement(
        f,
        phase === "prepare" ? "not-dispatched" : "unknown",
        phase === "prepare" ? undefined : f.release,
      );
      await f.send(f.request);
      assert.equal(eventsOf(f, "prepare").length, 1);
    });
  }
});

test(
  "READ broker retires a dispatched session on replay, wrong sequence, or crossed release/context",
  options,
  async (t) => {
    const cases = [
      ["duplicate dispatch", (released) => dispatchFrame(released)],
      ["skipped sequence", (released) => checkFrame(released, 4)],
      [
        "wrong release",
        (released) => ({ ...checkFrame(released), release_ref: "release/another" }),
      ],
      ["other connection context", (released) => checkFrame(released)],
    ];
    for (const [name, frame] of cases) {
      await t.test(name, async (t) => {
        const f = createBrokerPeers(t);
        const released = await dispatch(f);
        const call =
          name === "other connection context" ? { ...f.call, context: Object.freeze({}) } : f.call;
        await f.send(frame(released), call);
        assert.equal(eventsOf(f, "dispatch").length, 1);
        assert.equal(eventsOf(f, "check").length, 0);
        assert.equal(f.releaseWrites.length, 1);
        assert.equal(f.replies.length, 1);
        assertSettlement(f, "unknown", f.release);
      });
    }
  },
);

test(
  "READ broker refuses owner check failure or operation-horizon renewal after dispatch",
  options,
  async (t) => {
    const cases = [
      ["owner withdrawal", () => ({ kind: "refused", code: "expired" }), "expired"],
      [
        "renewed operation horizon",
        (f) => ({
          kind: "current",
          times: { ...f.times(), operation_until_ms: f.times().operation_until_ms + 1 },
        }),
        undefined,
      ],
    ];
    for (const [name, check, refusal] of cases) {
      await t.test(name, async (t) => {
        const f = createBrokerPeers(t, { steps: { check } });
        const released = await dispatch(f);
        await f.send(checkFrame(released));
        assert.equal(eventsOf(f, "check").length, 1);
        assert.equal(eventsOf(f, "dispatch").length, 1);
        assert.equal(
          f.replies.some((reply) => reply.phase === "current"),
          false,
        );
        if (refusal) assert.equal(f.replies.at(-1).code, refusal);
        else assert.equal(f.replies.length, 1);
        assertSettlement(f, "unknown", f.release);
      });
    }
  },
);

test(
  "READ completion waits for settlement and loses its receipt when native closure wins",
  options,
  async (t) => {
    const gate = deferredGate();
    const f = createBrokerPeers(t, {
      steps: {
        async settle() {
          await gate.wait();
          return "recorded";
        },
      },
    });
    f.hold(gate);
    const released = await dispatch(f);
    const completing = f.send(completeFrame(released, 3));
    await gate.entered;
    assert.equal(
      f.replies.some((reply) => reply.phase === "recorded"),
      false,
    );
    await f.service.close(f.call);
    gate.resolve();
    await completing;
    await f.service.join();
    assert.equal(
      f.replies.some((reply) => reply.phase === "recorded"),
      false,
    );
    assertSettlement(f, "completed", f.release);
    assert.equal(eventsOf(f, "close").length, 1);
  },
);
