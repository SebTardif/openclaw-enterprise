import {
  root,
  testExecutables,
  startFixture,
  encodeFrame,
  decodedResponse,
  protectedSource,
  availableLoopbackAddress,
  startAdmittedReadback,
  readRequest,
  nativeProfile,
  until,
  assertNoBytes,
  applyManagement,
  heldHistoryLock,
  waitHistoryRead,
  assertJoinedHistory,
  ownedNativeChildren,
  boundedCompletion,
} from "../fixtures/runtime-authority-native.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import {
  createRuntimeServiceTrustFixture,
  sourceRequest,
  serviceRequest,
  technicalSource,
  signal,
} from "../fixtures/runtime-service-trust.mjs";
import { startRuntimeAuthorityReadback } from "../../apps/controller/src/composition/runtime-authority-readback.ts";
import { validateNativeRuntimeServiceProfile } from "../../apps/controller/src/admission/runtime-authority-profile.ts";
import { exactRuntimeAuthorityOperation } from "../../packages/occ/src/runtime-authority/repository.ts";
import { seedAuthority } from "../fixtures/runtime-authority-state/seed.mjs";

function historicalReceiptFixture(owner) {
  // Seed only existing persistence transitions. The service identity comes from
  // the real management admission receipt; this helper creates no authenticated
  // context or role. Native/registry integration below must prove access itself.
  return {
    owner,
    async commit(serviceIdentityRef) {
      const writer = {
        acceptedServiceIdentityRef: serviceIdentityRef,
        committedAt: new Date().toISOString(),
      };
      const bound = await owner.append(owner.bind, writer);
      await owner.append(owner.retire, writer);
      assert.equal((await owner.record()).authority.assignmentRecordVersion, 3);
      return { receipt: bound.receipt, exact: exactRuntimeAuthorityOperation(owner.bind) };
    },
  };
}

test(
  "actual native validator rejects malformed trailing child output after a valid first frame",
  { timeout: 60000 },
  async (t) => {
    const binaries = await testExecutables(t);
    const source = await technicalSource({}, binaries.binaryPath);
    const profile = nativeProfile(source, "spiffe://example.test/independent-service");
    // This public validator starts no Source. Its actual Go process is the positive
    // control for the exact same framing consumer exercised by the corrupt output.
    await validateNativeRuntimeServiceProfile(binaries.binaryPath, profile, signal());
    for (const suffix of ["partial-prefix", "partial-body", "json", "oversized", "duplicate"]) {
      await t.test(suffix, async () => {
        const path = join(binaries.directory, `invalid-validator-${suffix}`);
        await copyFile(binaries.fixturePath, path);
        const digest = `sha256:${createHash("sha256")
          .update(await readFile(path))
          .digest("hex")}`;
        // Explicitly named fixture copies only emit protocol-negative output and
        // exit zero. They cannot supply an authenticated connection or context.
        await assert.rejects(
          validateNativeRuntimeServiceProfile(
            path,
            nativeProfile({ ...source, nativeExecutableSha256: digest }, profile.peerSPIFFEId),
            signal(),
          ),
        );
      });
    }
  },
);

async function admittedFixture(t, binaries, databaseUrl) {
  const applicationName = `occ_readback_${randomUUID()}`;
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 8,
    connectionTimeoutMillis: 250,
    application_name: applicationName,
  });
  t.after(() => pool.end());
  const state = new PostgresPlatformState(pool);
  const peer = await startFixture(t, binaries.fixturePath);
  const source = await technicalSource(protectedSource(binaries, peer), binaries.binaryPath);
  const f = await createRuntimeServiceTrustFixture({
    state,
    pool,
    source,
    binaryPath: binaries.binaryPath,
    nativeSourceRoot: root,
  });
  t.after(() => f.close());
  await applyManagement(f, sourceRequest(source.sourceRef));
  const admission = await applyManagement(
    f,
    serviceRequest(f, { peerSPIFFEId: peer.ready.peerSPIFFEId }),
  );
  assert.match(admission.subjectRef, /^runtime-service\/[0-9a-f-]{36}$/);
  assert.equal(admission.configuration.serviceIdentityRef, admission.subjectRef);
  assert.equal(admission.configuration.role, "lifecycle-authority");
  const history = await historicalReceiptFixture(f.owner).commit(admission.subjectRef);
  const readback = await startAdmittedReadback(t, binaries, {
    state,
    trust: f.trust,
    installationId: f.owner.installation.id,
    admission,
  });
  const value = { f, pool, state, peer, source, admission, history, readback, applicationName };
  await positiveReadback(value);
  return value;
}

async function positiveReadback(value) {
  const response = decodedResponse(
    await value.peer.request(value.readback.address, readRequest(value.history.exact)).result(),
  );
  assert.equal(response.result, "committed");
  // Network JSON has ordinary object prototypes; compare every retained value
  // after the same JSON serialization, rather than the parser's null prototype.
  assert.deepEqual(
    response.receipt,
    JSON.parse(JSON.stringify(value.history.receipt)),
    "readback did not return the exact retained original receipt",
  );
  assert.equal(
    (await value.f.owner.record()).authority.assignmentRecordVersion,
    3,
    "readback changed current state",
  );
}

const databaseUrl = process.env.OCC_RUNTIME_SERVICE_TRUST_DATABASE_URL;
const migratorUrl = process.env.OCC_RUNTIME_SERVICE_TRUST_MIGRATOR_DATABASE_URL;

test(
  "authenticated readback uses real child, TLS, management admission and PostgreSQL history",
  {
    skip:
      databaseUrl && migratorUrl
        ? false
        : "Select the isolated application and migrator PostgreSQL fixture URLs.",
    timeout: 180000,
  },
  async (t) => {
    const appURL = new URL(databaseUrl),
      lockURL = new URL(migratorUrl);
    assert.ok(["127.0.0.1", "[::1]"].includes(appURL.hostname));
    assert.equal(lockURL.hostname, appURL.hostname);
    assert.equal(lockURL.port, appURL.port);
    assert.equal(lockURL.pathname, appURL.pathname);
    const binaries = await testExecutables(t);
    await t.test(
      "historical exact receipt survives head advance, restart, conflicts and foreign scope",
      async (t) => {
        const value = await admittedFixture(t, binaries, databaseUrl);
        for (const operation of [
          { ...value.history.exact, canonicalPayloadDigest: `sha256:${"f".repeat(64)}` },
          { ...value.history.exact, operationKind: "retire" },
        ]) {
          assert.equal(
            decodedResponse(
              await value.peer.request(value.readback.address, readRequest(operation)).result(),
            ).result,
            "conflict",
          );
        }
        const foreign = await seedAuthority(value.state);
        const foreignExact = exactRuntimeAuthorityOperation(foreign.bind);
        assert.equal(
          decodedResponse(
            await value.peer.request(value.readback.address, readRequest(foreignExact)).result(),
          ).result,
          "not-visible",
        );
        const absent = { ...value.history.exact, operationRef: randomUUID() };
        assert.equal(
          decodedResponse(
            await value.peer.request(value.readback.address, readRequest(absent)).result(),
          ).result,
          "not-found",
        );
        await value.readback.close();
        await value.readback.closed;
        value.readback = await startAdmittedReadback(t, binaries, {
          state: value.state,
          trust: value.f.trust,
          installationId: value.f.owner.installation.id,
          admission: value.admission,
        });
        await positiveReadback(value);
        const second = await applyManagement(
          value.f,
          serviceRequest(value.f, { peerSPIFFEId: value.peer.ready.peerSPIFFEId }),
        );
        assert.notEqual(second.subjectRef, value.admission.subjectRef);
        await value.readback.close();
        value.readback = await startAdmittedReadback(t, binaries, {
          state: value.state,
          trust: value.f.trust,
          installationId: value.f.owner.installation.id,
          admission: second,
        });
        assert.equal(
          decodedResponse(
            await value.peer
              .request(value.readback.address, readRequest(value.history.exact))
              .result(),
          ).result,
          "not-visible",
        );
      },
    );
    await t.test(
      "startup rejects changed recipient, executable selection, digest and exact peer",
      async (t) => {
        const value = await admittedFixture(t, binaries, databaseUrl);
        await value.readback.close();
        await value.readback.closed;
        const wrongDigestPath = join(binaries.directory, `wrong-digest-${randomUUID()}`);
        await writeFile(
          wrongDigestPath,
          Buffer.concat([
            await readFile(binaries.binaryPath),
            Buffer.from("changed-test-artifact"),
          ]),
          { mode: 0o555 },
        );
        for (const mismatch of ["recipient", "selection", "digest"]) {
          const listenAddress = await availableLoopbackAddress();
          const binaryPath = mismatch === "digest" ? wrongDigestPath : binaries.binaryPath;
          const configPath = join(binaries.directory, `invalid-${mismatch}.json`);
          await writeFile(
            configPath,
            JSON.stringify({
              schemaVersion: 1,
              binaryPath: mismatch === "selection" ? binaries.fixturePath : binaryPath,
              listenAddress,
              recipientRef:
                mismatch === "recipient" ? "recipient/wrong" : value.admission.profile.recipientRef,
              serviceIdentityRef: value.admission.subjectRef,
            }),
            { mode: 0o600 },
          );
          await assert.rejects(
            startRuntimeAuthorityReadback({
              state: value.state,
              trust: value.f.trust,
              installationId: value.f.owner.installation.id,
              configPath,
              binaryPath,
            }),
          );
          if (process.platform === "linux") {
            assert.deepEqual(await ownedNativeChildren(binaryPath), []);
          }
        }
        const wrongPeer = await applyManagement(
          value.f,
          serviceRequest(value.f, {
            peerSPIFFEId: "spiffe://readback.test/service/different-reader",
          }),
        );
        value.readback = await startAdmittedReadback(t, binaries, {
          state: value.state,
          trust: value.f.trust,
          installationId: value.f.owner.installation.id,
          admission: wrongPeer,
        });
        const denied = await value.peer
          .request(value.readback.address, readRequest(value.history.exact))
          .result();
        assertNoBytes(denied);
        assert.ok(
          ["tls", "write", "read"].includes(denied.error),
          "wrong exact peer did not fail actual TLS exchange",
        );
        await value.readback.close();
        value.readback = await startAdmittedReadback(t, binaries, {
          state: value.state,
          trust: value.f.trust,
          installationId: value.f.owner.installation.id,
          admission: value.admission,
        });
        await positiveReadback(value);
      },
    );
    await t.test(
      "public forged, copied and malformed inputs do not create authority",
      async (t) => {
        const value = await admittedFixture(t, binaries, databaseUrl);
        const request = readRequest(value.history.exact);
        const json = JSON.stringify(request);
        for (const raw of [
          "{",
          json.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
          { ...request, method: "bind" },
          { ...request, role: "lifecycle-authority" },
          { ...request, deadline: new Date(Date.now() - 1000).toISOString() },
          { ...request, context: JSON.parse(JSON.stringify(value.admission)) },
          {
            ...request,
            transport: {
              connectionId: "a".repeat(32),
              exchangeId: "b".repeat(32),
              requestDigest: "sha256:" + "c".repeat(64),
            },
          },
          {
            schemaVersion: 1,
            kind: "request",
            incarnation: "a".repeat(32),
            sequence: 1,
            payloadBase64: Buffer.from(json).toString("base64"),
          },
        ])
          assertNoBytes(await value.peer.request(value.readback.address, raw).result());
        for (const wire of [
          Buffer.from([0, 1, 0, 1]),
          Buffer.concat([encodeFrame(Buffer.from(json)), encodeFrame(Buffer.from(json))]),
        ]) {
          assertNoBytes(
            await value.peer
              .request(value.readback.address, wire, { alreadyFramed: true })
              .result(),
          );
        }
        await positiveReadback(value);
      },
    );
    await t.test(
      "remote close during blocked current registry read then reconnect joins all work",
      async (t) => {
        const value = await admittedFixture(t, binaries, databaseUrl);
        const table = "runtime_service_trust_records";
        const lock = await heldHistoryLock(t, migratorUrl, table);
        try {
          const request = value.peer.request(
            value.readback.address,
            readRequest(value.history.exact, 2800),
          );
          await request.sent();
          const pids = await waitHistoryRead(value, table);
          request.cancel();
          const reconnect = value.peer.request(
            value.readback.address,
            readRequest(value.history.exact),
          );
          await boundedCompletion(
            value.readback.close(),
            2500,
            "close retained blocked current registry read",
          );
          await value.readback.closed;
          assertNoBytes(await request.result());
          assertNoBytes(await reconnect.result());
          await assertJoinedHistory(value, pids, table);
          await lock.retained();
        } finally {
          await lock.release();
          await value.readback.close();
        }
      },
    );
    for (const action of [
      "service-withdraw",
      "service-replace",
      "source-withdraw",
      "source-replace",
      "withdraw",
      "rotate-own",
      "rotate-bundle",
      "deadline",
      "remote-close-reconnect",
      "unexpected-child-loss",
    ]) {
      await t.test(
        `${action} during actual blocked history read prevents disclosure and joins`,
        async (t) => {
          const value = await admittedFixture(t, binaries, databaseUrl);
          const lock = await heldHistoryLock(t, migratorUrl);
          try {
            const request = value.peer.request(
              value.readback.address,
              readRequest(value.history.exact, action === "deadline" ? 1000 : 2800),
            );
            await request.sent();
            const pids = await waitHistoryRead(value);
            if (action === "service-withdraw") {
              await applyManagement(value.f, {
                schemaVersion: 1,
                kind: action,
                operationRef: randomUUID(),
                serviceIdentityRef: value.admission.subjectRef,
                expectedVersion: 1,
              });
            } else if (action === "service-replace") {
              await applyManagement(
                value.f,
                serviceRequest(value.f, {
                  peerSPIFFEId: value.peer.ready.peerSPIFFEId,
                  serviceIdentityRef: value.admission.subjectRef,
                  expectedVersion: 1,
                }),
              );
            } else if (action === "source-withdraw") {
              await applyManagement(value.f, {
                schemaVersion: 1,
                kind: action,
                operationRef: randomUUID(),
                sourceRef: value.source.sourceRef,
                expectedVersion: 1,
              });
            } else if (action === "source-replace") {
              await applyManagement(value.f, sourceRequest(value.source.sourceRef, 1));
            } else if (["withdraw", "rotate-own", "rotate-bundle"].includes(action)) {
              await value.peer.change(action);
            } else if (action === "unexpected-child-loss") {
              const children = await ownedNativeChildren(binaries.binaryPath);
              assert.equal(
                children.length,
                1,
                "did not identify exactly this test's existing native child",
              );
              process.kill(children[0], "SIGTERM");
              await boundedCompletion(
                value.readback.closed,
                2500,
                "unexpected native exit did not join readback work",
              );
            } else if (action === "remote-close-reconnect") {
              request.cancel();
              // Immediately drive a second real TLS handshake while the prior actual
              // blocked database read is cancelling. Closing must join every started read.
              const reconnect = value.peer.request(
                value.readback.address,
                readRequest(value.history.exact),
              );
              await value.readback.close();
              await value.readback.closed;
              assertNoBytes(await reconnect.result());
            }
            if (
              ["service-withdraw", "service-replace", "source-withdraw", "source-replace"].includes(
                action,
              )
            ) {
              // Let the real query finish: fresh registry checks at disclosure must
              // suppress its otherwise committed historical result.
              await lock.release();
              assertNoBytes(await request.result());
              await value.readback.close();
              await value.readback.closed;
            } else {
              assertNoBytes(await request.result());
              await value.readback.close();
              await value.readback.closed;
              await assertJoinedHistory(value, pids);
              await lock.retained();
              await lock.release();
            }
          } finally {
            // Release the blocker before pool cleanup even when an assertion fails.
            await lock.release();
            await value.readback.close();
          }
        },
      );
    }
  },
);
