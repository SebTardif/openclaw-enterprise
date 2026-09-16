import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import { createServer } from "node:http";
import { connect } from "node:net";
import test from "node:test";
import { inspectGitHubMetadataRequestV1 } from "../../apps/credential-gateway/src/github/metadata-http.ts";

const requestId = "4d0ba4ee-d95a-4f20-89bc-605807a6e8aa";

// Observe adapter-owned timers through Node's public lifecycle hooks. Fixture
// timers are created outside start(), and deadline rearming inherits its timer ID.
async function auditTimers(start) {
  const owned = new Set();
  const active = new Set();
  let capturing = false;
  const hook = createHook({
    init(id, type, trigger) {
      if (type === "Timeout" && (capturing || owned.has(trigger))) {
        owned.add(id);
        active.add(id);
      }
    },
    destroy(id) {
      active.delete(id);
    },
  });
  hook.enable();
  try {
    capturing = true;
    const pending = start();
    capturing = false;
    const result = await pending;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(active.size, 0, "every owned timer is destroyed at settlement");
    return result;
  } finally {
    capturing = false;
    hook.disable();
  }
}
const selection = () => ({
  appId: "101",
  installationId: "202",
  repositoryId: "303",
  canonicalOwner: "Owner",
  canonicalName: "repo.git",
  bindingGeneration: "binding-v1",
  repository: {
    upstreamInstanceId: "github-instance",
    canonicalResourceId: "303",
    canonicalPathSegments: ["Owner", "repo.git"],
    resourceSchema: {
      namespace: "github",
      name: "repository",
      version: 1,
      digest: "reviewed-schema-v1",
    },
  },
});

// Real Node parsing invokes the production request consumer. This protocol harness
// has no authentication, broker or access slot, and proves no dispatch admission.
async function exchange({
  target = "/repos/Owner/repo.git",
  host = "api.github.com",
  method = "GET",
  headers = [],
  repository = selection(),
  id = requestId,
  bounds = { signal: new AbortController().signal, deadline: Date.now() + 1500 },
  mutate,
  configure,
} = {}) {
  const sockets = new Set();
  let invoked = false;
  let observed;
  const server = createServer({ insecureHTTPParser: false, maxHeaderSize: 32768 });
  server.maxHeadersCount = 0;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("request", async (request, response) => {
    invoked = true;
    configure?.(request);
    const pending = auditTimers(() =>
      inspectGitHubMetadataRequestV1(request, repository, id, bounds),
    );
    mutate?.(repository, bounds);
    observed = await pending;
    assert.equal(request.listenerCount("data"), 0);
    assert.equal(request.listenerCount("end"), 0);
    if (!response.destroyed) response.end("checked");
  });
  server.on("clientError", (_error, socket) =>
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"),
  );
  let client;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    await new Promise((resolve, reject) => {
      client = connect(server.address().port, "127.0.0.1");
      client.setTimeout(2000, () => client.destroy(new Error("bounded fixture timeout")));
      client.on("error", reject);
      client.on("data", () => {});
      client.on("close", resolve);
      client.on("connect", () =>
        client.write(
          `${method} ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n${headers.map(([name, value]) => `${name}: ${value}\r\n`).join("")}\r\n`,
        ),
      );
    });
    return { invoked, result: observed };
  } finally {
    client?.destroy();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("native metadata requests yield frozen supplier DATA and canonical credential-free digests", async () => {
  const first = (
    await exchange({
      headers: [
        ["Authorization", "Bearer request-canary"],
        ["Accept-Encoding", "gzip"],
      ],
    })
  ).result;
  const second = (
    await exchange({ host: "API.GITHUB.COM:443", headers: [["Content-Length", "0"]] })
  ).result;
  assert.equal(first.kind, "inspected");
  assert.deepEqual(
    first,
    second,
    "fixed metadata semantics ignore client credential/display headers and empty framing",
  );
  const { operation } = first;
  assert.equal(operation.kind, "metadata");
  assert.equal(operation.requestId, requestId);
  assert.equal(operation.target.host, "api.github.com");
  assert.equal(operation.target.method, "GET");
  assert.equal(operation.target.pathAndQuery, "/repos/Owner/repo.git");
  assert.equal(operation.bodyDigest, createHash("sha256").update("").digest("hex"));
  assert.match(operation.factsDigest, /^[a-f0-9]{64}$/);
  for (const value of [
    first,
    operation,
    operation.target,
    operation.target.repository,
    operation.target.repository.repository,
    operation.target.repository.repository.resourceSchema,
    operation.target.repository.repository.canonicalPathSegments,
  ])
    assert.ok(Object.isFrozen(value));
  assert.doesNotMatch(JSON.stringify(first), /request-canary|Authorization|accessProfile|permit/);
});

test("request identity snapshots resist mutation during native EOF and bind changed selections", async () => {
  const original = selection();
  const first = (
    await exchange({
      repository: original,
      mutate: (repository) => {
        repository.canonicalOwner = "Other";
        repository.repositoryId = "404";
        repository.repository.canonicalPathSegments[0] = "Other";
        repository.repository.resourceSchema.digest = "changed-schema";
        repository.repository.extra = "selection-canary";
      },
    })
  ).result;
  assert.equal(first.kind, "inspected");
  assert.equal(first.operation.target.repository.repositoryId, "303");
  assert.equal(
    first.operation.target.repository.repository.resourceSchema.digest,
    "reviewed-schema-v1",
  );
  assert.doesNotMatch(JSON.stringify(first), /Other|selection-canary/);
  const other = selection();
  other.bindingGeneration = "binding-v2";
  assert.notEqual(
    (await exchange({ repository: other })).result.operation.factsDigest,
    first.operation.factsDigest,
  );
});

test("native malformed routes, mismatched enrollment, body headers and unrelated operations deny", async () => {
  const vectors = [
    { target: "/repos/Owner/repo.git?x=1" },
    { target: "/repos/Owner/%72epo.git" },
    { target: "/repos/Owner/repo.git/" },
    { target: "/repos/Owner/other" },
    { target: "/repos/owner/repo.git" },
    { host: "api.github.com:444" },
    { target: "https://api.github.com/repos/Owner/repo.git" },
    { headers: [["Content-Length", "1"]] },
    { headers: [["Transfer-Encoding", "chunked"]] },
    { headers: [["Trailer", "X-Canary"]] },
    { headers: [["Content-Encoding", "identity"]] },
    { headers: [["Cookie", "request-canary"]] },
    { target: "/Owner/repo.git.git/info/refs?service=git-upload-pack", host: "github.com" },
    {
      target: "/repos/Owner/repo.git/pulls",
      method: "POST",
      headers: [
        ["Content-Type", "application/json"],
        ["Content-Length", "0"],
        ["X-OCE-Operation-Id", requestId],
      ],
    },
  ];
  for (const vector of vectors) {
    const actual = await exchange(vector);
    if (actual.invoked)
      assert.deepEqual(actual.result, { kind: "invalid-request" }, JSON.stringify(vector));
    else
      assert.ok(
        vector.headers?.some(([key]) => key === "Transfer-Encoding"),
        "only strict native framing rejection may bypass the adapter",
      );
  }
  for (const repositoryId of ["0", "0303", "9007199254740992", 303]) {
    const repository = selection();
    repository.repositoryId = repositoryId;
    assert.deepEqual((await exchange({ repository })).result, { kind: "invalid-request" });
  }
  assert.deepEqual((await exchange({ id: "arbitrary" })).result, { kind: "invalid-request" });
});

test("original request bounds are enforced again after await", async () => {
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(
    (await exchange({ bounds: { signal: controller.signal, deadline: Date.now() + 1000 } })).result,
    { kind: "aborted" },
  );
  assert.deepEqual(
    (await exchange({ bounds: { signal: new AbortController().signal, deadline: Date.now() - 1 } }))
      .result,
    { kind: "expired" },
  );
  assert.deepEqual(
    (
      await exchange({
        mutate: (_repository, bounds) => {
          bounds.deadline = Date.now() - 1;
        },
      })
    ).result,
    { kind: "expired" },
  );
  assert.deepEqual(
    (
      await exchange({
        mutate: (_repository, bounds) => {
          bounds.signal = new AbortController().signal;
        },
      })
    ).result,
    { kind: "unavailable" },
  );
});

test("malformed native operands produce finite safe denials", async () => {
  for (const request of [null, undefined, false, {}, "request-canary"])
    assert.deepEqual(
      await inspectGitHubMetadataRequestV1(request, selection(), requestId, {
        signal: new AbortController().signal,
        deadline: Date.now() + 1000,
      }),
      { kind: "invalid-request" },
    );
});

test("native request bounds keep original cancellation and refuse unsupported shadows without getters", async () => {
  const stopped = new AbortController();
  stopped.abort();
  Object.defineProperty(stopped.signal, "aborted", { value: false });
  assert.equal(
    (await exchange({ bounds: { signal: stopped.signal, deadline: Date.now() + 1000 } })).result
      .kind,
    "aborted",
  );
  let reads = 0;
  assert.equal(
    (
      await exchange({
        bounds: {
          get signal() {
            reads++;
            return reads === 1 ? stopped.signal : new AbortController().signal;
          },
          deadline: Date.now() + 1000,
        },
      })
    ).result.kind,
    "aborted",
  );
  assert.equal(reads, 1, "the first native signal is retained before further reflection");
  for (const name of ["addEventListener", "removeEventListener", "aborted"]) {
    const controller = new AbortController();
    let methodReads = 0;
    Object.defineProperty(controller.signal, name, {
      get() {
        methodReads++;
        throw Error("operand-canary");
      },
    });
    const actual = await exchange({
      bounds: { signal: controller.signal, deadline: Date.now() + 1000 },
    });
    assert.equal(actual.result.kind, "unavailable");
    assert.equal(methodReads, 0);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  }
  for (const field of ["signal", "deadline"]) {
    const bounds = { signal: new AbortController().signal, deadline: Date.now() + 1000 };
    Object.defineProperty(bounds, field, {
      get() {
        throw Error("operand-canary");
      },
    });
    assert.deepEqual((await exchange({ bounds })).result, { kind: "invalid-request" });
  }
});

test("request final bounds reflection cannot publish after abort or elapsed deadline", async () => {
  for (const mode of ["abort", "expire", "throw"]) {
    const controller = new AbortController();
    const deadline = Date.now() + 150;
    let message;
    let finalRead = false;
    let signalReads = 0;
    let deadlineReads = 0;
    const bounds = {
      get signal() {
        signalReads++;
        return controller.signal;
      },
      get deadline() {
        deadlineReads++;
        // EOF and removal of the owned abort callback identify the final adapter
        // checkpoint independently of how many earlier checks collection needs.
        if (message?.readableEnded && getEventListeners(controller.signal, "abort").length === 0) {
          finalRead = true;
          if (mode === "abort") controller.abort();
          if (mode === "expire")
            while (Date.now() < deadline) {
              /* synchronous operand */
            }
          if (mode === "throw") throw Error("operand-canary");
        }
        return deadline;
      },
    };
    const actual = await exchange({
      bounds,
      configure: (request) => {
        message = request;
      },
    });
    assert.equal(finalRead, true);
    assert.equal(
      actual.result.kind,
      { abort: "aborted", expire: "expired", throw: "unavailable" }[mode],
    );
    assert.equal(signalReads, deadlineReads);
    assert.ok(signalReads <= 6, "one read per bounded request checkpoint");
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  }
});

test("request stream setup and cleanup exceptions settle without owned listeners or timers", async () => {
  for (const stage of ["setup", "cleanup"]) {
    let injected = false;
    const result = await exchange({
      configure: (message) => {
        const event = stage === "setup" ? "newListener" : "removeListener";
        message.on(event, (name) => {
          if (!injected && name === (stage === "setup" ? "end" : "data")) {
            injected = true;
            throw Error("stream-operand-canary");
          }
        });
      },
    });
    assert.equal(injected, true);
    assert.deepEqual(result.result, { kind: "unavailable" });
  }
});

test("late request listener-method mutation is refused with native cleanup", async () => {
  const controller = new AbortController();
  const actual = await exchange({
    bounds: { signal: controller.signal, deadline: Date.now() + 1000 },
    mutate: () =>
      Object.defineProperty(controller.signal, "removeEventListener", {
        get() {
          throw Error("late-cleanup-canary");
        },
      }),
  });
  assert.deepEqual(actual.result, { kind: "unavailable" });
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});
