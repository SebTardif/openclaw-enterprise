import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import {
  InMemoryPlatformState,
  PostgresPlatformState,
  RuntimeAuthorityService,
} from "../../packages/occ/src/index.ts";
import { parseRuntimeAuthorityV1 } from "../../packages/contracts/src/runtime-authority-v1.ts";
import { exactRuntimeAuthorityOperation } from "../../packages/occ/src/runtime-authority/repository.ts";
import {
  createRuntimeServiceTrustFixture,
  sourceRequest,
  serviceRequest,
  technicalSource,
} from "../fixtures/runtime-service-trust.mjs";
import {
  root,
  testExecutables,
  startFixture,
  protectedSource,
  startAdmittedReadback,
  decodedResponse,
  readRequest,
  applyManagement,
  assertNoBytes,
  heldHistoryLock,
  waitHistoryRead,
  assertJoinedHistory,
  boundedCompletion,
} from "../fixtures/runtime-authority-native.mjs";

const clone = (value) => JSON.parse(JSON.stringify(value));
const unavailable = {
  schemaVersion: 1,
  result: "rejected-before-effect",
  reasonCode: "lookup-unavailable",
};
const hidden = { schemaVersion: 1, result: "rejected-before-effect", reasonCode: "scope-hidden" };

async function admitted(t, binaries, { policy = "initial-harness-bind-v1", databaseUrl } = {}) {
  let pool;
  const applicationName = `occ_initial_bind_${randomUUID()}`;
  if (databaseUrl) {
    pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 8,
      connectionTimeoutMillis: 250,
      application_name: applicationName,
    });
    t.after(() => pool.end());
  }
  const state = pool ? new PostgresPlatformState(pool) : new InMemoryPlatformState();
  const peer = await startFixture(t, binaries.fixturePath);
  const source = await technicalSource(
    {
      ...protectedSource(binaries, peer),
      transportProfileRef:
        policy === "initial-harness-bind-v1"
          ? "owned-child-stdio-initial-harness-bind-v1"
          : "owned-child-stdio-readback-v1",
    },
    binaries.binaryPath,
  );
  const f = await createRuntimeServiceTrustFixture({
    state,
    ...(pool ? { pool } : {}),
    source,
    binaryPath: binaries.binaryPath,
    nativeSourceRoot: root,
  });
  t.after(() => f.close());
  await applyManagement(f, sourceRequest(source.sourceRef));
  const admission = await applyManagement(
    f,
    serviceRequest(f, {
      peerSPIFFEId: peer.ready.peerSPIFFEId,
      ...(policy === "initial-harness-bind-v1" ? { operationPolicy: policy } : {}),
    }),
  );
  assert.equal(admission.profile.operationPolicy, policy);
  assert.equal(admission.profile.peerSPIFFEId, peer.ready.peerSPIFFEId);
  assert.equal(admission.configuration.role, "lifecycle-authority");
  assert.deepEqual(admission.configuration.allowedScope, {
    kind: "agent",
    installationId: f.owner.installation.id,
    namespaceId: f.owner.namespace.id,
    agentId: f.owner.agent.id,
  });
  const readback = await startAdmittedReadback(t, binaries, {
    state,
    trust: f.trust,
    installationId: f.owner.installation.id,
    admission,
  });
  return { f, state, pool, applicationName, peer, source, admission, readback };
}

function bindRequest(value, input = value.f.owner.bind, durationMs = 2800) {
  // These are realistic unbound allocation and interface-shaped observation
  // values. They are not current preparation or independent Compute evidence.
  const operation = parseRuntimeAuthorityV1("bind", {
    ...input,
    requestRef: `request/${randomUUID()}`,
  });
  return {
    schemaVersion: 1,
    method: "bind",
    deadline: new Date(Date.now() + durationMs).toISOString(),
    operation,
  };
}

async function unchanged(value, operationRef = value.f.owner.bind.operationRef) {
  const record = await value.f.owner.record();
  assert.equal(record.authority.assignmentRecordVersion, 1);
  assert.equal(record.authority.state, "allocated");
  assert.deepEqual(clone(record.binding), { status: "unbound" });
  assert.equal(await value.f.owner.operation(operationRef), undefined);
}

async function withdraw(value, kind = "service-withdraw") {
  return applyManagement(value.f, {
    schemaVersion: 1,
    kind,
    operationRef: randomUUID(),
    expectedVersion: 1,
    ...(kind === "service-withdraw"
      ? { serviceIdentityRef: value.admission.subjectRef }
      : { sourceRef: value.source.sourceRef }),
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const realBind = RuntimeAuthorityService.prototype.bind;
const realRead = RuntimeAuthorityService.prototype.readOperation;
const realRecordEvidence = RuntimeAuthorityService.prototype.recordEvidence;
const realRetire = RuntimeAuthorityService.prototype.retire;

test(
  "actual admitted initial-bind custody reaches the real unavailable service",
  { timeout: 180000 },
  async (t) => {
    const binaries = await testExecutables(t);
    await t.test(
      "original bytes, real service identity and exact readback remain separate",
      async (t) => {
        const value = await admitted(t, binaries);
        const request = bindRequest(value);
        const calls = [];
        t.mock.method(RuntimeAuthorityService.prototype, "bind", async function (input, call) {
          // Observe the actual production factory and delegate unchanged. This wrapper
          // supplies neither a context nor an authorization/binding result.
          const verified = await this.options.contextFactory.inspect(call.context, call);
          assert.ok(verified);
          assert.equal(this.options.requestBinding.matchesRequest("bind", input, call), true);
          assert.deepEqual(clone(verified.configuration), clone(value.admission.configuration));
          assert.match(verified.peerEvidenceRef, /^native-peer\/[0-9a-f]{32}$/);
          calls.push({ service: this, input, call });
          return realBind.call(this, input, call);
        });
        const result = decodedResponse(
          await value.peer.request(value.readback.address, request).result(),
        );
        assert.deepEqual(clone(result), unavailable);
        assert.equal(calls.length, 1, "one original TLS request did not reach bind exactly once");
        assert.deepEqual(clone(calls[0].input), clone(request.operation));
        assert.equal(calls[0].call.requestRef, request.operation.requestRef);
        assert.equal(calls[0].call.recipientRef, value.admission.profile.recipientRef);
        assert.ok(Date.parse(calls[0].call.deadline) <= Date.parse(request.deadline));
        assert.notEqual(calls[0].call.context, undefined);
        await unchanged(value);
        const read = decodedResponse(
          await value.peer
            .request(
              value.readback.address,
              readRequest(exactRuntimeAuthorityOperation(request.operation)),
            )
            .result(),
        );
        assert.equal(
          read.result,
          "not-found",
          "rejected bind must not manufacture a historical receipt",
        );
        await value.readback.close();
        assert.equal(
          await calls[0].service.options.contextFactory.inspect(
            calls[0].call.context,
            calls[0].call,
          ),
          undefined,
          "a closed original connection retained an inspectable context",
        );
        assert.equal(
          calls[0].service.options.requestBinding.matchesRequest(
            "bind",
            calls[0].input,
            calls[0].call,
          ),
          false,
        );
        assert.deepEqual(
          clone(await realBind.call(calls[0].service, calls[0].input, calls[0].call)),
          unavailable,
          "an expired or cancelled original call must reject before effect",
        );
        await unchanged(value);
      },
    );

    await t.test(
      "captured real context denies changed method, input and call correspondence",
      async (t) => {
        const value = await admitted(t, binaries);
        const changes = [
          [
            "changed bind payload",
            async (service, input, call) =>
              realBind.call(service, { ...input, responsibilityRef: randomUUID() }, call),
            hidden,
          ],
          [
            "changed image-digest array element",
            async (service, input, call) =>
              realBind.call(
                service,
                {
                  ...input,
                  binding: {
                    ...input.binding,
                    imageDigests: input.binding.imageDigests.map((entry) => ({
                      ...entry,
                      digest: `sha256:${entry.digest.endsWith("a") ? "b".repeat(64) : "a".repeat(64)}`,
                    })),
                  },
                },
                call,
              ),
            hidden,
          ],
          [
            "changed operation reference",
            async (service, input, call) =>
              realBind.call(service, { ...input, operationRef: randomUUID() }, call),
            hidden,
          ],
          [
            "changed request reference",
            async (service, input, call) =>
              realBind.call(
                service,
                { ...input, requestRef: "request/other" },
                { ...call, requestRef: "request/other" },
              ),
            hidden,
          ],
          [
            "changed recipient",
            async (service, input, call) =>
              realBind.call(service, input, { ...call, recipientRef: "recipient/other" }),
            hidden,
          ],
          [
            "changed deadline",
            async (service, input, call) =>
              realBind.call(service, input, {
                ...call,
                deadline: new Date(Date.parse(call.deadline) + 1).toISOString(),
              }),
            hidden,
          ],
          [
            "copied structural context",
            async (service, input, call) =>
              realBind.call(service, input, { ...call, context: { schemaVersion: 1 } }),
            hidden,
          ],
          [
            "changed method",
            async (service, input, call) =>
              realRead.call(service, exactRuntimeAuthorityOperation(input), call),
            { schemaVersion: 1, result: "not-visible", reasonCode: "scope-hidden" },
          ],
          [
            "bind bytes through the recordEvidence entrypoint",
            async (service, input, call) => realRecordEvidence.call(service, input, call),
            { schemaVersion: 1, result: "rejected-before-effect", reasonCode: "operation-denied" },
          ],
          [
            "bind bytes through the retire entrypoint",
            async (service, input, call) => realRetire.call(service, input, call),
            { schemaVersion: 1, result: "rejected-before-effect", reasonCode: "operation-denied" },
          ],
          [
            "retire payload through the bind entrypoint",
            async (service, input, call) =>
              realBind.call(
                service,
                {
                  ...value.f.owner.retire,
                  requestRef: input.requestRef,
                },
                call,
              ),
            { schemaVersion: 1, result: "rejected-before-effect", reasonCode: "operation-denied" },
          ],
        ];
        for (const [name, attempt, expected] of changes) {
          await t.test(name, async (t) => {
            let count = 0;
            t.mock.method(RuntimeAuthorityService.prototype, "bind", async function (input, call) {
              count++;
              const result = await realBind.call(this, input, call);
              assert.deepEqual(clone(result), unavailable);
              assert.deepEqual(clone(await attempt(this, input, call)), expected);
              return result;
            });
            assert.deepEqual(
              decodedResponse(
                await value.peer.request(value.readback.address, bindRequest(value)).result(),
              ),
              unavailable,
            );
            assert.equal(count, 1);
            await unchanged(value);
          });
        }
      },
    );

    await t.test("both profiles enforce the native method ceiling", async (t) => {
      for (const policy of ["read-operation-only-v1", "initial-harness-bind-v1"]) {
        await t.test(policy, async (t) => {
          const value = await admitted(t, binaries, { policy });
          let calls = 0;
          t.mock.method(RuntimeAuthorityService.prototype, "bind", async function (input, call) {
            calls++;
            return realBind.call(this, input, call);
          });
          const deniedMethods = [
            "recordEvidence",
            "retire",
            "resolve",
            "restore",
            "importCompletedContext",
            "readImportedContext",
            "register",
            "serve",
          ];
          if (policy === "read-operation-only-v1") deniedMethods.push("bind");
          for (const method of deniedMethods) {
            const request = { ...bindRequest(value), method };
            assertNoBytes(await value.peer.request(value.readback.address, request).result());
          }
          assert.equal(calls, 0, "a denied method crossed the native dispatcher");
          let originalReads = 0;
          t.mock.method(
            RuntimeAuthorityService.prototype,
            "readOperation",
            async function (input, call) {
              originalReads++;
              // The original real read context is deliberately reused at the existing
              // service boundary. Neither this observer nor the caller supplies a grant.
              assert.deepEqual(clone(await realBind.call(this, value.f.owner.bind, call)), {
                schemaVersion: 1,
                result: "rejected-before-effect",
                reasonCode:
                  policy === "read-operation-only-v1" ? "operation-denied" : "scope-hidden",
              });
              return realRead.call(this, input, call);
            },
          );
          const result = decodedResponse(
            await value.peer
              .request(
                value.readback.address,
                readRequest(exactRuntimeAuthorityOperation(value.f.owner.bind)),
              )
              .result(),
          );
          assert.equal(result.result, "not-found");
          assert.equal(originalReads, 1);
          await unchanged(value);
        });
      }
    });

    await t.test(
      "closed bind parsing and exact initial-Harness limits precede context creation",
      async (t) => {
        const value = await admitted(t, binaries);
        let calls = 0;
        t.mock.method(RuntimeAuthorityService.prototype, "bind", async function (input, call) {
          calls++;
          return realBind.call(this, input, call);
        });
        for (const change of [
          (r) => {
            r.operation.expectedBindingVersion = 1;
          },
          (r) => {
            r.operation.target.component = "gateway";
          },
          (r) => {
            r.operation.binding.component = "gateway";
          },
          (r) => {
            r.operation.binding.provider = "occ/kubernetes-gateway";
          },
          (r) => {
            r.operation.kind = "retire";
          },
          (r) => {
            r.operation.Binding = r.operation.binding;
            delete r.operation.binding;
          },
          (r) => {
            r.operation.observation.extra = true;
          },
          (r) => {
            r.operation.expectedResponsibilityVersion = 0;
          },
          (r) => {
            delete r.operation.observation;
          },
          (r) => {
            r.operation.binding.imageDigests = [];
          },
          (r) => {
            r.context = { schemaVersion: 1 };
          },
        ]) {
          const request = clone(bindRequest(value));
          change(request);
          assertNoBytes(await value.peer.request(value.readback.address, request).result());
        }
        const duplicate = JSON.stringify(bindRequest(value)).replace(
          '"schemaVersion":1',
          '"schemaVersion":1,"schemaVersion":1',
        );
        assertNoBytes(await value.peer.request(value.readback.address, duplicate).result());
        assert.equal(calls, 0);
        const foreign = clone(bindRequest(value));
        foreign.operation.target.agentId = `agt_${randomUUID()}`;
        assert.deepEqual(
          decodedResponse(await value.peer.request(value.readback.address, foreign).result()),
          hidden,
        );
        assert.equal(
          calls,
          1,
          "valid but foreign scope should reach the actual service's scope denial",
        );
        await unchanged(value);
      },
    );

    for (const kind of ["service-withdraw", "source-withdraw"]) {
      await t.test(
        `${kind} suppresses a real bind result held before response delivery`,
        async (t) => {
          const value = await admitted(t, binaries);
          const reached = deferred(),
            release = deferred();
          t.after(() => release.resolve());
          let calls = 0;
          t.mock.method(RuntimeAuthorityService.prototype, "bind", async function (input, call) {
            calls++;
            const result = await realBind.call(this, input, call);
            assert.deepEqual(clone(result), unavailable);
            reached.resolve();
            await release.promise;
            return result;
          });
          const pending = value.peer.request(value.readback.address, bindRequest(value));
          await boundedCompletion(reached.promise, 1500, "the actual bind service was not reached");
          await withdraw(value, kind);
          release.resolve();
          assertNoBytes(await pending.result());
          await boundedCompletion(
            value.readback.closed,
            4000,
            "withdrawn native child did not settle",
          );
          assert.equal(calls, 1);
          await unchanged(value);
        },
      );
    }

    await t.test(
      "connection cancellation cannot disclose a late actual service result",
      async (t) => {
        const value = await admitted(t, binaries);
        const reached = deferred(),
          release = deferred();
        t.after(() => release.resolve());
        t.mock.method(RuntimeAuthorityService.prototype, "bind", async function (input, call) {
          const result = await realBind.call(this, input, call);
          reached.resolve();
          await release.promise;
          return result;
        });
        const pending = value.peer.request(value.readback.address, bindRequest(value));
        await boundedCompletion(reached.promise, 1500, "actual bind not reached before cancel");
        pending.cancel();
        assertNoBytes(await pending.result());
        release.resolve();
        await boundedCompletion(
          value.readback.close(),
          4000,
          "cancelled child/request did not join",
        );
        await unchanged(value);
      },
    );
  },
);

const databaseUrl = process.env.OCC_RUNTIME_SERVICE_TRUST_DATABASE_URL;
const migratorUrl = process.env.OCC_RUNTIME_SERVICE_TRUST_MIGRATOR_DATABASE_URL;

test(
  "initial-bind current lookup owns actual PostgreSQL cancellation through native closure",
  {
    skip:
      databaseUrl && migratorUrl
        ? false
        : "Select the isolated application and migrator PostgreSQL fixture URLs.",
    timeout: 180000,
  },
  async (t) => {
    const app = new URL(databaseUrl),
      migration = new URL(migratorUrl);
    assert.ok(["127.0.0.1", "[::1]"].includes(app.hostname));
    assert.equal(app.hostname, migration.hostname);
    assert.equal(app.port, migration.port);
    assert.equal(app.pathname, migration.pathname);
    const binaries = await testExecutables(t);
    for (const reason of ["remote cancellation", "source withdrawal", "deadline"]) {
      await t.test(reason, async (t) => {
        const value = await admitted(t, binaries, { databaseUrl });
        assert.deepEqual(
          decodedResponse(
            await value.peer.request(value.readback.address, bindRequest(value)).result(),
          ),
          unavailable,
        );
        await unchanged(value);
        const lock = await heldHistoryLock(t, migratorUrl, "runtime_service_trust_records");
        const pending = value.peer.request(value.readback.address, bindRequest(value));
        await pending.sent();
        const pids = await waitHistoryRead(value, "runtime_service_trust_records");
        if (reason === "remote cancellation") pending.cancel();
        if (reason === "source withdrawal") await value.peer.change("withdraw");
        assertNoBytes(await pending.result());
        await boundedCompletion(
          value.readback.close(),
          4000,
          "native current-read cleanup did not join",
        );
        await assertJoinedHistory(value, pids, "runtime_service_trust_records");
        await lock.retained();
        await lock.release();
        await unchanged(value);
      });
    }
  },
);
