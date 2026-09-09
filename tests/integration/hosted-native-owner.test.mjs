import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import https from "node:https";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import pg from "pg";
import { HostedNativeOwner } from "../../packages/occ/src/turn-journal/hosted-native-owner.ts";
import {
  deferred,
  digest,
  journalHarness,
  journalValues,
  ref,
  seedJournalOwner,
  storageProvenance,
} from "../fixtures/turn-journal-storage/values.mjs";

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const clientIdentity = "spiffe://example.test/controller";
const nativeIdentity = "spiffe://example.test/native";
const same = (a, b) =>
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));

// Resolve the installed SDK's packaged plugin and its declared dependencies.
// No test loader aliases, source checkout imports or old SDK fallback are used.
async function packagedPlugin() {
  const requireOcc = createRequire(new URL("../../packages/occ/package.json", import.meta.url));
  const sdk = requireOcc.resolve("openclaw/plugin-sdk/codex-hosted-harness");
  const selectedPluginRoot = process.env.OCC_TEST_CODEX_PLUGIN_ROOT;
  assert.ok(
    selectedPluginRoot && path.isAbsolute(selectedPluginRoot),
    "Set OCC_TEST_CODEX_PLUGIN_ROOT to the prepared matching Codex installation",
  );
  const plugin = await fs.realpath(selectedPluginRoot);
  const metadata = JSON.parse(await fs.readFile(path.join(plugin, "package.json"), "utf8"));
  assert.equal(metadata.name, "@openclaw/codex");
  const require = createRequire(path.join(plugin, "package.json"));
  assert.equal(
    await fs.realpath(require.resolve("openclaw/plugin-sdk/codex-hosted-harness")),
    await fs.realpath(sdk),
    "Prepared plugin and OCC must own the same receiving SDK host",
  );
  return {
    plugin,
    grpc: require("@grpc/grpc-js"),
    loader: require("@grpc/proto-loader"),
    ws: require("ws"),
  };
}

async function socketFixture() {
  const { plugin, grpc, loader, ws } = await packagedPlugin();
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "native-journal-")));
  let client, native, source, web, websocket;
  const cleanup = async () => {
    if (websocket) {
      for (const remote of websocket.clients) remote.terminate();
      websocket.close();
    }
    if (web) {
      web.closeAllConnections();
      await new Promise((resolve) => {
        web.close(() => resolve());
      });
    }
    source?.forceShutdown();
    for (const identity of [client, native]) {
      identity?.key.fill(0);
      identity?.keyDer.fill(0);
    }
    await fs.rm(directory, { recursive: true, force: true });
  };
  try {
    const openssl = (...args) => execFileSync("openssl", args, { cwd: directory, stdio: "ignore" });
    const generate = async (name, identity) => {
      openssl(
        "req",
        "-new",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:P-256",
        "-nodes",
        "-keyout",
        `${name}.key`,
        "-out",
        `${name}.csr`,
        "-subj",
        `/CN=Synthetic ${name}`,
      );
      await fs.writeFile(
        path.join(directory, `${name}.ext`),
        `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth,serverAuth\nsubjectAltName=URI:${identity}\n`,
      );
      openssl(
        "x509",
        "-req",
        "-in",
        `${name}.csr`,
        "-CA",
        "ca.pem",
        "-CAkey",
        "ca.key",
        "-CAcreateserial",
        "-out",
        `${name}.pem`,
        "-days",
        "1",
        "-extfile",
        `${name}.ext`,
      );
      openssl(
        "pkcs8",
        "-topk8",
        "-nocrypt",
        "-in",
        `${name}.key`,
        "-outform",
        "DER",
        "-out",
        `${name}.der`,
      );
      return {
        key: await fs.readFile(path.join(directory, `${name}.key`)),
        keyDer: await fs.readFile(path.join(directory, `${name}.der`)),
        cert: await fs.readFile(path.join(directory, `${name}.pem`)),
      };
    };
    openssl(
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-keyout",
      "ca.key",
      "-out",
      "ca.pem",
      "-subj",
      "/CN=Synthetic journal fixture CA",
      "-days",
      "2",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
    );
    const ca = await fs.readFile(path.join(directory, "ca.pem"));
    client = await generate("controller", clientIdentity);
    native = await generate("native", nativeIdentity);
    source = new grpc.Server();
    source.addService(
      loader.loadSync(path.join(plugin, "workload.proto"), {
        defaults: true,
        bytes: Buffer,
        longs: String,
      }).SpiffeWorkloadAPI,
      {
        FetchX509SVID(call) {
          assert.deepEqual(call.metadata.get("workload.spiffe.io"), ["true"]);
          call.write({
            svids: [
              {
                spiffeId: clientIdentity,
                x509Svid: new X509Certificate(client.cert).raw,
                x509SvidKey: client.keyDer,
                bundle: new X509Certificate(ca).raw,
                hint: "",
              },
            ],
            crl: [],
            federatedBundles: {},
          });
        },
      },
    );
    const sourceSocket = path.join(directory, "workload.sock");
    await new Promise((resolve, reject) => {
      source.bindAsync(`unix:${sourceSocket}`, grpc.ServerCredentials.createInsecure(), (error) =>
        error ? reject(error) : resolve(),
      );
    });
    web = https.createServer({
      key: native.key,
      cert: native.cert,
      ca,
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
    });
    websocket = new ws.WebSocketServer({
      server: web,
      path: "/native",
      perMessageDeflate: false,
      handleProtocols: (protocols) =>
        protocols.has("codex-hosted-v1") ? "codex-hosted-v1" : false,
    });
    web.listen(0, "127.0.0.1");
    await once(web, "listening");
    const signal = new AbortController();
    return {
      websocket,
      peer: {
        endpoint: `wss://127.0.0.1:${web.address().port}/native`,
        workloadApiSocketPath: sourceSocket,
        ownSPIFFEId: clientIdentity,
        peerSPIFFEId: nativeIdentity,
        maxFrameBytes: 262144,
        maxConnectionAgeMs: 15000,
        signal: signal.signal,
        assertCurrent() {},
      },
      close: cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

// Real PostgreSQL, original known-COMMIT guard and real mTLS/socket custody.
// Initial admission/current calls use the repository's controlled storage
// provenance fixture. The native endpoint is synthetic: no Rust Core, SPIRE
// enrollment, production human grant, model output or physical task join is claimed.
test(
  "original journal retains deadline control before the hosted native constructor",
  {
    skip: databaseUrl ? false : "Set OCC_TEST_DATABASE_URL for migrated limited-role PostgreSQL.",
    timeout: 20000,
  },
  async () => {
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 6,
      connectionTimeoutMillis: 250,
    });
    let sockets, owner;
    const failure = deferred();
    const handlers = new Set();
    let fixtureError;
    const failed = (error) => {
      fixtureError ??= error;
      failure.resolve(error);
    };
    const checked = async (promise) => {
      let timer;
      try {
        return await Promise.race([
          promise,
          failure.promise.then((error) => {
            throw error;
          }),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Hosted journal fixture checkpoint timed out")),
              8000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      const provenance = storageProvenance();
      const bind = provenance.options.bind;
      provenance.options.bind = (context) => {
        const ports = bind(context);
        return {
          ...ports,
          evidence: {
            ...ports.evidence,
            inspectExecutionStart: (handle, call) =>
              owner.evidence.inspectExecutionStart(handle, call),
            inspectExecutionInterruption: (handle, call) =>
              owner.evidence.inspectExecutionInterruption(handle, call),
          },
        };
      };
      const h = journalHarness(pool, { provenance });
      const v = journalValues(await seedJournalOwner(h.state));
      const admission = await h.write((j) => j.admit(h.issue("admission", v.observation), h.call));
      assert.equal(admission.kind, "committed");
      assert.equal(admission.value.kind, "recorded");
      const execution = {
        attempt: v.attempt,
        dispatchOperationRef: v.binding.dispatchOperationRef,
        consumption: v.consumption,
        executionRef: ref("execution"),
        recipientRef: ref("recipient"),
      };
      const selection = {
        execution,
        operationRef: ref("intent"),
        operationDigest: digest(),
        executionLimitRef: ref("limit"),
        executionLimitVersion: 1,
        maximumExecutionMs: 2500,
      };
      const incarnation = ref("incarnation"),
        construction = ref("construction");
      const stopped = deferred();
      let accepts = 0,
        constructors = 0,
        confirmations = 0,
        stopRequests = 0,
        controlChecks = 0;
      let intent, control, start, acceptId;
      let continuationDenied = false;
      sockets = await socketFixture();
      sockets.websocket.on("connection", (remote, request) => {
        assert.equal(request.socket.authorized, true);
        assert.equal(request.socket.getPeerCertificate().subjectaltname, `URI:${clientIdentity}`);
        remote.on("message", (raw) => {
          const handling = (async () => {
            assert.ok(Buffer.isBuffer(raw));
            const frame = JSON.parse(raw.toString("utf8"));
            const reply = (result) => remote.send(JSON.stringify({ id: frame.id, result }));
            if (frame.method === "initialize") reply({ userAgent: "codex/0.153.0" });
            else if (frame.method === "native/establish")
              reply({
                ...frame.params,
                nativeIncarnationRef: incarnation,
                nativeVersion: "0.153.0",
                protocolVersion: 1,
              });
            else if (frame.method === "native/accept") {
              accepts++;
              acceptId = frame.id;
              intent = frame.params.intent;
              same(intent.execution, execution);
              assert.equal(intent.dispatchClock.kind, "pre-commit-monotonic-v1");
              assert.equal(
                intent.dispatchClock.deadlineAtMs - intent.dispatchClock.anchorAtMs,
                900000,
              );
              assert.equal(frame.params.originalInput.input[0].text, "original admitted text");
              remote.send(
                JSON.stringify({
                  id: "arm-original",
                  method: "journal/armExecution",
                  params: {
                    execution,
                    nativeIncarnationRef: incarnation,
                    nativeConstructionRef: construction,
                    challengeRef: ref("challenge"),
                  },
                }),
              );
            } else if (frame.id === "arm-original" && frame.result) {
              control = frame.result.deadlineControl;
              same(control.intent, intent);
              assert.equal(
                control.deadlineAtMs,
                intent.dispatchClock.anchorAtMs + selection.maximumExecutionMs,
              );
              const retained = await h.read((j) => j.findDeadlineControl(execution, h.call));
              assert.equal(retained.kind, "found");
              same(retained.control, control);
              const consumed = await h.read((j) => j.findAttempt(v.attempt, h.call));
              assert.equal(consumed.record.version, 3);
              same(consumed.record.consumption.operation, v.consumption);
              constructors++;
              start = {
                kind: "host-controlled-v1",
                intent,
                operationRef: ref("start"),
                operationDigest: digest(),
                nativeExecutionRef: ref("native-execution"),
                nativeIncarnationRef: incarnation,
                nativeReservationRef: ref("native-reservation"),
                nativeSessionRef: ref("session"),
                nativeTurnRef: ref("turn"),
                acceptanceEvidenceRef: ref("acceptance"),
                deadlineControl: control,
              };
              remote.send(
                JSON.stringify({
                  id: acceptId,
                  result: { start, nativeThreadId: "native-thread" },
                }),
              );
            } else if (frame.method === "native/confirmRetainedStart") {
              const rows = await pool.query(
                "SELECT record FROM occ.turn_journal_operations WHERE attempt_ref=$1 AND operation_kind='execution-start'",
                [v.attempt.attemptRef],
              );
              assert.equal(rows.rows.length, 1);
              same(rows.rows[0].record, start);
              confirmations++;
              reply({ start, nativeThreadId: "native-thread", state: "start-retained" });
            } else if (frame.method === "native/cancelConstruction") {
              assert.equal(
                continuationDenied,
                true,
                "Deadline stop follows continuing-authority denial",
              );
              stopRequests++;
              same(frame.params.deadlineControl, control);
              assert.equal(constructors, 1);
              reply({ deadlineControl: control, state: "stopping", settled: false });
              stopped.resolve();
            } else if (frame.method !== "initialized")
              assert.fail(`Unexpected selected method: ${frame.method}`);
          })();
          handlers.add(handling);
          void handling.catch(failed).finally(() => handlers.delete(handling));
        });
      });
      const ports = provenance.options.bind({});
      const sourceSignal = new AbortController();
      owner = await HostedNativeOwner.connect(
        {
          protocolVersion: 1,
          assignment: {
            installationRef: v.attempt.installationRef,
            namespaceRef: v.attempt.namespaceRef,
            agentRef: v.attempt.agentRef,
            revisionRef: "revision",
            assignmentRef: "assignment",
            gatewayAssignmentRef: "gateway",
            lifecycleGeneration: 1,
            runtimeGeneration: 1,
            peerIdentity: nativeIdentity,
            transportRef: "transport",
          },
          peer: sockets.peer,
          onEvent() {
            assert.fail("No native event was produced by this fixture");
          },
        },
        {
          signal: sourceSignal.signal,
          async acquire() {
            return provenance.call();
          },
          async assertCurrent(selected, selectedStart, _purpose, call) {
            controlChecks++;
            same(selected, execution);
            same(selectedStart.intent.execution, execution);
            assert.equal((await ports.authorization.authorize({}, call)).kind, "authorized");
          },
        },
      );
      owner.bindJournal(h.store);
      const dispatch = h.issue("dispatch", v.binding);
      const consumption = h.issue("consumption", {
        operation: v.consumption,
        binding: v.binding,
        executionSelection: selection,
      });
      const turn = {
        requestRef: ref("request"),
        conversationRef: v.attempt.conversationRef,
        attemptRef: v.attempt.attemptRef,
        text: "original admitted text",
        mediationContextRef: ref("mediation"),
      };
      const result = await checked(
        owner.dispatchAndConsumeAndInitiate(dispatch, consumption, turn, h.call),
      );
      assert.equal(result.kind, "initiated");
      assert.equal(accepts, 1);
      assert.equal(constructors, 1);
      assert.equal(confirmations, 1);
      await assert.rejects(
        owner.dispatchAndConsumeAndInitiate(dispatch, consumption, turn, h.call),
      );
      const checksBeforeDeadline = controlChecks;
      assert.equal(stopRequests, 0);
      provenance.setAllowed(false);
      continuationDenied = true;
      await checked(stopped.promise);
      assert.equal(controlChecks, checksBeforeDeadline);
      assert.equal(stopRequests, 1);
      const rows = await pool.query(
        "SELECT count(*)::int n FROM occ.turn_journal_reservations WHERE attempt_ref=$1",
        [v.attempt.attemptRef],
      );
      assert.equal(
        rows.rows[0].n,
        1,
        "The original reservation remains held after the observed stop request",
      );
    } finally {
      if (owner) {
        owner.close();
        await owner.closed;
      }
      if (sockets) await sockets.close();
      while (handlers.size) await Promise.allSettled([...handlers]);
      await pool.end();
      if (fixtureError) throw fixtureError;
    }
  },
);
