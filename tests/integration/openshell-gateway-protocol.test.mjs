import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { mkdtemp, open, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  GrpcOpenShellGatewayClient,
  toProtobufStruct,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";

const controllerRequire = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
);
const grpc = controllerRequire("@grpc/grpc-js");
const loader = controllerRequire("@grpc/proto-loader");
const definition = loader.loadSync(
  fileURLToPath(
    new URL(
      "../../apps/controller/src/drivers/sandbox/proto/openshell-gateway.proto",
      import.meta.url,
    ),
  ),
  { keepCase: true, enums: String, longs: String, defaults: true, oneofs: true },
);
const service = grpc.loadPackageDefinition(definition).openshell.v1.OpenShell.service;
const request = {
  name: "occ-protocol-sandbox",
  workspace: "occ-protocol-workspace",
  labels: { "occ.example/owner": "agent-protocol" },
  annotations: { "occ.example/revision": "revision-protocol" },
  spec: {
    template: {
      image: "registry.example/runtime@sha256:" + "a".repeat(64),
      driver_config: {
        fields: toProtobufStruct({
          kubernetes: {
            containers: {
              agent: {
                volume_mounts: [
                  { name: "credentials", mount_path: "/run/credentials", read_only: true },
                ],
              },
            },
          },
        }),
      },
    },
    command: ["/bin/sh", "-c", "sleep 60"],
    environment: { OCC_PROTOCOL_TEST: "true" },
    policy: {
      version: 1,
      filesystem: {
        include_workdir: true,
        read_only: ["/app"],
        read_write: ["/home/node", "/dev/null"],
      },
      process: { run_as_user: "1000", run_as_group: "1000" },
      landlock: { compatibility: "best_effort" },
      network_policies: {
        provider: { name: "provider", endpoints: [{ host: "api.openai.com", ports: [443] }] },
      },
    },
  },
};

function sandboxResponse(overrides = {}) {
  return {
    sandbox: {
      metadata: {
        id: "provider-sandbox-id",
        name: request.name,
        workspace: request.workspace,
        labels: request.labels,
        annotations: request.annotations,
      },
      spec: request.spec,
      status: { phase: "SANDBOX_PHASE_READY" },
      ...overrides,
    },
  };
}

async function startServer(t, handlers, credentials = grpc.ServerCredentials.createInsecure()) {
  // This runs the actual grpc-js transport and checked-in wire schema. It does
  // not emulate OpenShell scheduling, authorization, or provider reconciliation.
  const server = new grpc.Server();
  server.addService(service, handlers);
  const port = await new Promise((resolve, reject) => {
    server.bindAsync("127.0.0.1:0", credentials, (error, boundPort) => {
      if (error) reject(error);
      else resolve(boundPort);
    });
  });
  t.after(() => server.forceShutdown());
  return `127.0.0.1:${port}`;
}

function makeClient(t, endpoint, options = {}) {
  const client = new GrpcOpenShellGatewayClient({ endpoint, requestTimeoutMs: 1000, ...options });
  t.after(() => client.close());
  return client;
}

function signal() {
  return new AbortController().signal;
}

test("OpenShell identity and deprecated NetworkBinary harness match fixed protobuf wire vectors", () => {
  // Independent bytes pin upstream field numbers and wire types: length-delimited
  // strings at GetSandbox fields 1/2, and a bool varint at NetworkBinary field 2.
  assert.equal(
    service.GetSandbox.requestSerialize({ name: "n", workspace: "w" }).toString("hex"),
    "0a016e120177",
  );
  assert.equal(
    definition["openshell.v1.NetworkBinary"]
      .serialize({ path: "x", harness: true })
      .toString("hex"),
    "0a01781001",
  );
});

test("OpenShell GetSandbox carries exact identity and returns server metadata and spec", async (t) => {
  assert.equal(service.GetSandbox.path, "/openshell.v1.OpenShell/GetSandbox");
  let received;
  const endpoint = await startServer(t, {
    GetSandbox(call, callback) {
      received = call.request;
      assert.deepEqual(call.metadata.get("authorization"), []);
      callback(null, sandboxResponse());
    },
  });
  const result = await makeClient(t, endpoint).getSandbox(
    { name: request.name, workspace: request.workspace },
    signal(),
  );
  assert.deepEqual(received, { name: request.name, workspace: request.workspace });
  assert.equal(result.id, "provider-sandbox-id");
  assert.equal(result.name, request.name);
  assert.equal(result.workspace, request.workspace);
  assert.deepEqual(result.labels, request.labels);
  assert.deepEqual(result.annotations, request.annotations);
  assert.deepEqual(result.spec.command, request.spec.command);
  assert.equal(result.spec.template.image, request.spec.template.image);
});

test("OpenShell create validates its response and reads back the same immutable sandbox", async (t) => {
  const methods = [];
  const endpoint = await startServer(t, {
    CreateSandbox(call, callback) {
      methods.push("create");
      assert.equal(call.request.name, request.name);
      assert.equal(call.request.workspace, request.workspace);
      assert.deepEqual(call.request.labels, request.labels);
      assert.deepEqual(call.request.annotations, request.annotations);
      assert.deepEqual(call.request.spec.command, request.spec.command);
      assert.deepEqual(call.request.spec.policy.process, request.spec.policy.process);
      assert.deepEqual(call.request.spec.policy.filesystem.read_only, ["/app"]);
      assert.equal(
        call.request.spec.policy.network_policies.provider.endpoints[0].host,
        "api.openai.com",
      );
      const driverFields =
        call.request.spec.template.driver_config.fields.kubernetes.structValue.fields;
      const agentFields = driverFields.containers.structValue.fields.agent.structValue.fields;
      const mount = agentFields.volume_mounts.listValue.values[0].structValue.fields;
      assert.equal(mount.name.stringValue, "credentials");
      assert.equal(mount.read_only.boolValue, true);
      callback(null, sandboxResponse());
    },
    GetSandbox(call, callback) {
      methods.push("get");
      assert.deepEqual(call.request, { name: request.name, workspace: request.workspace });
      callback(null, sandboxResponse());
    },
  });
  const result = await makeClient(t, endpoint).createSandbox(request, signal());
  assert.equal(result.id, "provider-sandbox-id");
  assert.deepEqual(methods, ["create", "get"]);
  assert.deepEqual(
    result.spec.template.driver_config,
    service.CreateSandbox.requestDeserialize(service.CreateSandbox.requestSerialize(request)).spec
      .template.driver_config,
  );
});

test("OpenShell preserves optional user_namespaces false and rejects omitted readback presence", async (t) => {
  for (const omitted of [false, true]) {
    await t.test(
      omitted ? "omitted is different from false" : "explicit false matches",
      async (t) => {
        const explicitSpec = {
          ...request.spec,
          template: { ...request.spec.template, user_namespaces: false },
        };
        const endpoint = await startServer(t, {
          CreateSandbox(call, callback) {
            assert.equal(call.request.spec.template.user_namespaces, false);
            assert.equal(Object.hasOwn(call.request.spec.template, "user_namespaces"), true);
            callback(null, sandboxResponse({ spec: explicitSpec }));
          },
          GetSandbox(_call, callback) {
            callback(null, sandboxResponse({ spec: omitted ? request.spec : explicitSpec }));
          },
        });
        const creation = makeClient(t, endpoint).createSandbox(
          { ...request, spec: explicitSpec },
          signal(),
        );
        if (omitted) await assert.rejects(creation, /OpenShell/);
        else assert.equal((await creation).spec.template.user_namespaces, false);
      },
    );
  }
});

test("OpenShell GetSandbox preserves NOT_FOUND without exposing gateway details", async (t) => {
  const endpoint = await startServer(t, {
    GetSandbox(_call, callback) {
      callback({ code: grpc.status.NOT_FOUND, details: "private-provider-diagnostic" });
    },
  });
  await assert.rejects(makeClient(t, endpoint).getSandbox(request, signal()), (error) => {
    assert.equal(error.code, grpc.status.NOT_FOUND);
    assert.match(error.message, /OpenShell.*GetSandbox.*NOT_FOUND/);
    assert.ok(!error.stack.includes("private-provider-diagnostic"));
    return true;
  });
});

test("OpenShell ambiguous create outcomes reconcile only an exact matching readback", async (t) => {
  for (const code of [
    grpc.status.ALREADY_EXISTS,
    grpc.status.UNAVAILABLE,
    grpc.status.DEADLINE_EXCEEDED,
    grpc.status.UNKNOWN,
  ]) {
    await t.test(grpc.status[code], async (t) => {
      let reads = 0;
      const endpoint = await startServer(t, {
        CreateSandbox(_call, callback) {
          callback({ code, details: "ambiguous result" });
        },
        GetSandbox(_call, callback) {
          reads++;
          callback(null, sandboxResponse());
        },
      });
      const result = await makeClient(t, endpoint).createSandbox(request, signal());
      assert.equal(result.id, "provider-sandbox-id");
      assert.equal(reads, 1);
    });
  }
});

test("OpenShell rejects readback drift and changed provider identity", async (t) => {
  const uninspectedCredentialsSpec = structuredClone(request.spec);
  uninspectedCredentialsSpec.policy.network_policies.provider.endpoints[0].allow_uninspected_credentials = true;
  const cases = [
    [
      "provider identity",
      { metadata: { ...sandboxResponse().sandbox.metadata, id: "replacement-id" } },
    ],
    [
      "owner",
      {
        metadata: {
          ...sandboxResponse().sandbox.metadata,
          labels: { "occ.example/owner": "someone-else" },
        },
      },
    ],
    ["annotations", { metadata: { ...sandboxResponse().sandbox.metadata, annotations: {} } }],
    [
      "workspace",
      { metadata: { ...sandboxResponse().sandbox.metadata, workspace: "another-workspace" } },
    ],
    ["spec", { spec: { ...request.spec, command: ["unrequested-command"] } }],
    ["unrequested allow_uninspected_credentials", { spec: uninspectedCredentialsSpec }],
  ];
  for (const [name, changed] of cases) {
    await t.test(name, async (t) => {
      const endpoint = await startServer(t, {
        CreateSandbox(_call, callback) {
          callback(null, sandboxResponse());
        },
        GetSandbox(_call, callback) {
          callback(null, sandboxResponse(changed));
        },
      });
      await assert.rejects(makeClient(t, endpoint).createSandbox(request, signal()), /OpenShell/);
    });
  }
});

test("OpenShell duplicate create fails on mismatching or missing readback without deleting", async (t) => {
  for (const outcome of ["wrong owner", "wrong spec", "not found"]) {
    await t.test(outcome, async (t) => {
      let reads = 0;
      let deletes = 0;
      const endpoint = await startServer(t, {
        CreateSandbox(_call, callback) {
          callback({ code: grpc.status.ALREADY_EXISTS, details: "duplicate name" });
        },
        GetSandbox(_call, callback) {
          reads++;
          if (outcome === "not found") {
            callback({ code: grpc.status.NOT_FOUND, details: "missing after duplicate" });
          } else if (outcome === "wrong owner") {
            callback(
              null,
              sandboxResponse({
                metadata: {
                  ...sandboxResponse().sandbox.metadata,
                  labels: { "occ.example/owner": "another-agent" },
                },
              }),
            );
          } else {
            callback(null, sandboxResponse({ spec: { ...request.spec, command: ["unexpected"] } }));
          }
        },
        DeleteSandbox(_call, callback) {
          deletes++;
          callback(null, { deleted: true });
        },
      });
      // A name collision or uncertain provider outcome never authorizes deleting
      // a sandbox whose ownership and immutable launch intent were not established.
      await assert.rejects(makeClient(t, endpoint).createSandbox(request, signal()), /OpenShell/);
      assert.equal(reads, 1);
      assert.equal(deletes, 0);
    });
  }
});

test("OpenShell malformed create identity fails before any readback", async (t) => {
  let reads = 0;
  const endpoint = await startServer(t, {
    CreateSandbox(_call, callback) {
      callback(
        null,
        sandboxResponse({ metadata: { ...sandboxResponse().sandbox.metadata, id: "" } }),
      );
    },
    GetSandbox(_call, callback) {
      reads++;
      callback(null, sandboxResponse());
    },
  });
  await assert.rejects(makeClient(t, endpoint).createSandbox(request, signal()), /OpenShell/);
  assert.equal(reads, 0);
});

test("OpenShell delete requires affirmative deletion or provider NOT_FOUND", async (t) => {
  for (const outcome of ["deleted", "not-found", "false", "absent"]) {
    await t.test(outcome, async (t) => {
      const endpoint = await startServer(t, {
        DeleteSandbox(call, callback) {
          assert.deepEqual(call.request, { name: request.name, workspace: request.workspace });
          if (outcome === "not-found") callback({ code: grpc.status.NOT_FOUND, details: "gone" });
          else callback(null, outcome === "absent" ? {} : { deleted: outcome === "deleted" });
        },
      });
      const deletion = makeClient(t, endpoint).deleteSandbox(request, signal());
      if (outcome === "deleted" || outcome === "not-found") await deletion;
      else await assert.rejects(deletion, /OpenShell/);
    });
  }
});

test(
  "OpenShell cancellation during fresh client preparation sends no RPC",
  { timeout: 5000 },
  async (t) => {
    let reads = 0;
    const endpoint = await startServer(t, {
      GetSandbox(_call, callback) {
        reads++;
        callback(null, sandboxResponse());
      },
    });
    const client = makeClient(t, endpoint);
    const controller = new AbortController();
    // A fresh client must await its real module/schema initialization. Aborting
    // in this turn exercises cancellation after entry but before RPC issuance.
    const pending = client.getSandbox(request, controller.signal);
    controller.abort(new Error("cancelled-during-client-preparation"));
    await assert.rejects(pending, /cancelled-during-client-preparation|aborted|cancelled/i);
    assert.equal(reads, 0);
  },
);

test("OpenShell pre-aborted and in-flight canceled requests never reconcile", async (t) => {
  let creates = 0;
  let reads = 0;
  let notifyStarted;
  const started = new Promise((resolve) => {
    notifyStarted = resolve;
  });
  let notifyCancelled;
  const cancelled = new Promise((resolve) => {
    notifyCancelled = resolve;
  });
  const endpoint = await startServer(t, {
    CreateSandbox(call, _callback) {
      creates++;
      call.on("cancelled", notifyCancelled);
      notifyStarted();
    },
    GetSandbox(_call, callback) {
      reads++;
      callback(null, sandboxResponse());
    },
  });
  const client = makeClient(t, endpoint);
  const before = new AbortController();
  before.abort(new Error("lease-cancelled"));
  await assert.rejects(
    client.createSandbox(request, before.signal),
    /lease-cancelled|aborted|cancelled/i,
  );
  assert.equal(creates, 0);
  const during = new AbortController();
  const pending = client.createSandbox(request, during.signal);
  const rejected = assert.rejects(pending, /lease-cancelled|aborted|cancelled/i);
  await started;
  during.abort(new Error("lease-cancelled"));
  await rejected;
  await cancelled;
  assert.equal(creates, 1);
  assert.equal(reads, 0);
});

async function certificates(t) {
  const directory = await mkdtemp(join(tmpdir(), "occ-openshell-grpc-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = (name) => join(directory, name);
  const openssl = (...args) => execFileSync("openssl", args, { cwd: directory, stdio: "pipe" });
  for (const name of ["ca", "untrusted-ca"]) {
    openssl(
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      `/CN=${name}`,
      "-keyout",
      `${name}.key`,
      "-out",
      `${name}.crt`,
    );
  }
  for (const name of ["server", "client"]) {
    openssl(
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      `/CN=${name}`,
      "-keyout",
      `${name}.key`,
      "-out",
      `${name}.csr`,
    );
    await writeFile(
      path(`${name}.ext`),
      name === "server"
        ? "subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n"
        : "extendedKeyUsage=clientAuth\n",
    );
    openssl(
      "x509",
      "-req",
      "-in",
      `${name}.csr`,
      "-CA",
      "ca.crt",
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-days",
      "1",
      "-extfile",
      `${name}.ext`,
      "-out",
      `${name}.crt`,
    );
  }
  const bearer = "protocol-bearer-value-must-not-leak";
  await writeFile(path("bearer-token"), `${bearer}\n`, { mode: 0o600 });
  return {
    path,
    bearer,
    credentials: grpc.ServerCredentials.createSsl(
      await readFile(path("ca.crt")),
      [
        {
          private_key: await readFile(path("server.key")),
          cert_chain: await readFile(path("server.crt")),
        },
      ],
      true,
    ),
    options: {
      rootCertificatePath: path("ca.crt"),
      clientCertificatePath: path("client.crt"),
      clientPrivateKeyPath: path("client.key"),
      auth: { mode: "bearerTokenFile", path: path("bearer-token") },
    },
  };
}

test("OpenShell mTLS authenticates transport while bearer authorization reaches the server", async (t) => {
  const tls = await certificates(t);
  let calls = 0;
  const endpoint = await startServer(
    t,
    {
      Health(call, callback) {
        calls++;
        assert.deepEqual(call.metadata.get("authorization"), [`Bearer ${tls.bearer}`]);
        callback(null, { status: "SERVICE_STATUS_HEALTHY" });
      },
      GetSandbox(_call, callback) {
        // The server can return hostile details and metadata; neither may become
        // controller-visible error text or an attached raw error cause.
        const metadata = new grpc.Metadata();
        metadata.set("secret-debug", tls.bearer);
        callback({
          code: grpc.status.PERMISSION_DENIED,
          details: `${tls.bearer} ${tls.path("client.key")}`,
          metadata,
        });
      },
    },
    tls.credentials,
  );
  const client = makeClient(t, `https://${endpoint}`, tls.options);
  await client.health(signal());
  assert.equal(calls, 1);
  await t.test(
    "cancellation while reading bearer credentials sends no RPC",
    { timeout: 5000 },
    async (t) => {
      const tokenPath = tls.path("blocked-bearer-fifo");
      execFileSync("mkfifo", ["-m", "600", tokenPath]);
      let writer;
      const controller = new AbortController();
      let cleanup;
      const releaseFifo = () => {
        cleanup ??= (async () => {
          controller.abort(new Error("cancelled-during-credential-read"));
          await writer?.close();
          writer = undefined;
          // A nonblocking read/write open releases a reader even if normal
          // writer acquisition failed. Removing this path prevents later opens.
          const release = await open(tokenPath, constants.O_RDWR | constants.O_NONBLOCK);
          try {
            await release.writeFile(tls.bearer);
          } finally {
            await release.close();
            await unlink(tokenPath);
          }
        })();
        return cleanup;
      };
      t.after(releaseFifo);
      const pending = makeClient(t, `https://${endpoint}`, {
        ...tls.options,
        auth: { mode: "bearerTokenFile", path: tokenPath },
      }).health(controller.signal);
      // Capture early failure immediately, including when no FIFO reader opens.
      const outcome = pending.then(
        () => ({ ok: true }),
        (error) => ({ ok: false, error }),
      );
      try {
        // Opening the FIFO writer rendezvous with the real readFile reader. Keep
        // it open until cancellation so credential loading cannot finish early.
        // NONBLOCK avoids a stuck libuv open if a regression skips the reader.
        const deadline = Date.now() + 2000;
        while (writer === undefined) {
          try {
            writer = await open(tokenPath, constants.O_WRONLY | constants.O_NONBLOCK);
          } catch (error) {
            if (error.code !== "ENXIO") throw error;
            if (Date.now() >= deadline)
              throw new Error("Credential FIFO reader did not open within 2 seconds.");
            await delay(10);
          }
        }
        controller.abort(new Error("cancelled-during-credential-read"));
        await writer.writeFile(tls.bearer);
      } finally {
        await releaseFifo();
      }
      const result = await outcome;
      assert.equal(result.ok, false, "credential read must reject after cancellation");
      assert.match(result.error.message, /cancelled-during-credential-read|aborted|cancelled/i);
      assert.equal(calls, 1, "cancellation during credential loading must prevent the RPC");
    },
  );
  await assert.rejects(client.getSandbox(request, signal()), (error) => {
    assert.equal(error.code, grpc.status.PERMISSION_DENIED);
    assert.match(error.message, /OpenShell.*GetSandbox/);
    assert.equal(error.cause, undefined);
    assert.equal(error.metadata, undefined);
    assert.ok(!`${error.stack} ${JSON.stringify(error)}`.includes(tls.bearer));
    assert.ok(!`${error.stack} ${JSON.stringify(error)}`.includes(tls.path("client.key")));
    return true;
  });
  for (const kind of ["missing client certificate", "wrong server CA"]) {
    await t.test(kind, async (t) => {
      const options = { ...tls.options };
      if (kind === "missing client certificate") {
        delete options.clientCertificatePath;
        delete options.clientPrivateKeyPath;
      } else options.rootCertificatePath = tls.path("untrusted-ca.crt");
      await assert.rejects(
        makeClient(t, `https://${endpoint}`, options).health(signal()),
        /OpenShell/,
      );
      assert.equal(calls, 1, "failed TLS handshake must never reach a gateway RPC handler");
    });
  }
  for (const [kind, content] of [
    ["unreadable token", undefined],
    ["newline token", `${tls.bearer}\nextra-header-value`],
    ["NUL token", `${tls.bearer}\u0000`],
    ["non-ASCII token", `${tls.bearer}\u00e9`],
  ]) {
    await t.test(kind, async (t) => {
      const tokenPath = tls.path(kind);
      if (content !== undefined) {
        await writeFile(tokenPath, content);
      }
      const options = { ...tls.options, auth: { mode: "bearerTokenFile", path: tokenPath } };
      await assert.rejects(
        makeClient(t, `https://${endpoint}`, options).health(signal()),
        (error) => {
          assert.match(error.message, /OpenShell/);
          assert.equal(error.cause, undefined);
          assert.ok(!`${error.stack} ${JSON.stringify(error)}`.includes(tokenPath));
          assert.ok(!`${error.stack} ${JSON.stringify(error)}`.includes(tls.bearer));
          return true;
        },
      );
      assert.equal(calls, 1, "invalid credentials must fail before issuing the RPC");
    });
  }
});

test("OpenShell rejects credential-bearing cleartext and incomplete certificate pairs", () => {
  for (const endpoint of ["127.0.0.1:1", "http://127.0.0.1:1"]) {
    assert.throws(
      () =>
        new GrpcOpenShellGatewayClient({
          endpoint,
          auth: { mode: "bearerTokenFile", path: "/not-read/token" },
        }),
      /OpenShell/,
    );
    assert.throws(
      () =>
        new GrpcOpenShellGatewayClient({
          endpoint,
          clientCertificatePath: "/not-read/client.crt",
          clientPrivateKeyPath: "/not-read/client.key",
        }),
      /OpenShell/,
    );
  }
  for (const certificate of [
    { clientCertificatePath: "/not-read/client.crt" },
    { clientPrivateKeyPath: "/not-read/client.key" },
  ]) {
    assert.throws(
      () => new GrpcOpenShellGatewayClient({ endpoint: "https://127.0.0.1:1", ...certificate }),
      /OpenShell/,
    );
  }
});
