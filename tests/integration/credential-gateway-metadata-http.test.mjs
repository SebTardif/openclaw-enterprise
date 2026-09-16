import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { request } from "node:http";
import { getEventListeners } from "node:events";
import { createServer } from "node:net";
import test from "node:test";
import { readGitHubMetadataResponseV1 } from "../../apps/credential-gateway/src/github/metadata-http.ts";

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
const value = { id: 303, full_name: "Owner/repo.git", private: true, default_branch: "main" };
const body = Buffer.from(
  JSON.stringify({
    ...value,
    token: "provider-canary",
    extra: { authorization: "nested-canary", id: 99 },
  }),
);
function head(headers, status = "200 OK") {
  return Buffer.from(
    `HTTP/1.1 ${status}\r\n${headers.map(([name, value]) => `${name}: ${value}\r\n`).join("")}\r\n`,
    "ascii",
  );
}
const lengthHeaders = (data) => [
  ["Content-Type", "application/json"],
  ["Content-Length", String(data.length)],
  ["Connection", "close"],
];
function chunk(data) {
  return Buffer.concat([Buffer.from(`${data.length.toString(16)}\r\n`), data, Buffer.from("\r\n")]);
}

// A raw controlled origin emits adversarial wire bytes through real local sockets.
// Node's actual HTTP client creates IncomingMessage; the production consumer owns
// validation and projection. The harness proves protocol integration, not GitHub/TLS.
async function exchange({
  data = body,
  headers = lengthHeaders(data),
  status = "200 OK",
  wire,
  chunks,
  stall = false,
  truncate = false,
  bounds = { signal: new AbortController().signal, deadline: Date.now() + 1500 },
  expected = selection(),
  mutate,
  afterStart,
  configure,
} = {}) {
  const sockets = new Set();
  const timers = new Set();
  let response;
  let nativeListeners;
  let invoked = false;
  let settled = false;
  let client;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let received = false;
    socket.on("data", () => {
      if (received) return;
      received = true;
      socket.write(wire ?? head(headers, status));
      if (stall) {
        if (data.length) socket.write(data);
        return;
      }
      if (wire) {
        socket.end();
        return;
      }
      if (chunks) {
        const send = (index) => {
          if (socket.destroyed) return;
          if (index === chunks.length) {
            socket.end("0\r\n\r\n");
            return;
          }
          socket.write(chunk(chunks[index]));
          const timer = setTimeout(() => {
            timers.delete(timer);
            send(index + 1);
          }, 10);
          timers.add(timer);
        };
        send(0);
      } else {
        socket.end(truncate ? data.subarray(0, Math.max(1, data.length - 2)) : data);
      }
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("bounded protocol fixture timeout")), 2500);
      timers.add(timer);
      client = request(
        {
          hostname: "127.0.0.1",
          port: server.address().port,
          path: "/repos/Owner/repo.git",
          agent: false,
          insecureHTTPParser: false,
          maxHeaderSize: 32768,
        },
        (message) => {
          invoked = true;
          response = message;
          nativeListeners = new Map(
            ["data", "end", "aborted", "error", "close"].map((event) => [
              event,
              message.listeners(event),
            ]),
          );
          configure?.(message);
          const pending = auditTimers(() =>
            readGitHubMetadataResponseV1(message, expected, bounds),
          );
          mutate?.(expected, bounds);
          afterStart?.({
            message,
            isSettled: () => settled,
            schedule: (fn, delay) => {
              const timer = setTimeout(fn, delay);
              timers.add(timer);
            },
          });
          pending.then((result) => {
            settled = true;
            clearTimeout(timer);
            timers.delete(timer);
            resolve(result);
          }, reject);
        },
      );
      client.on("error", () => {
        if (!invoked) {
          clearTimeout(timer);
          timers.delete(timer);
          resolve({ kind: "native-rejected" });
        }
      });
      client.end();
    });
    if (response) {
      // Native HTTP owns its own EOF/error listeners; only newly retained consumer
      // listeners would be a leak. Preserve native listeners rather than removing them.
      for (const event of ["data", "end", "aborted", "error", "close"]) {
        assert.ok(
          response
            .listeners(event)
            .every((listener) => nativeListeners.get(event).includes(listener)),
          `consumer ${event} listener removed`,
        );
      }
      if (result.kind !== "metadata")
        assert.ok(response.destroyed || response.readableEnded, "refused stream terminates");
    }
    assert.doesNotMatch(
      JSON.stringify(result),
      /provider-canary|nested-canary|wire-secret|raw-provider-error/,
    );
    return { result, invoked };
  } finally {
    for (const timer of timers) clearTimeout(timer);
    client?.destroy();
    response?.destroy();
    // server.close may precede queued socket close events; await each actual closure.
    await Promise.all(
      [...sockets].map(
        (socket) =>
          new Promise((resolve) => {
            socket.once("close", resolve);
            socket.destroy();
          }),
      ),
    );
    await new Promise((resolve) => server.close(resolve));
    assert.equal(sockets.size, 0, "fixture sockets close before handoff");
  }
}
async function denied(options, kinds = ["invalid-response"]) {
  const actual = await exchange(options);
  assert.ok(kinds.includes(actual.result.kind), `${actual.result.kind} not in ${kinds}`);
  assert.deepEqual(Object.keys(actual.result), ["kind"], "no provider body/error details escape");
  return actual;
}

test("real length and chunked origin streams project only four immutable metadata fields at EOF", async () => {
  for (const options of [
    {},
    {
      headers: [
        ["Content-Type", "application/json; charset=utf-8"],
        ["Transfer-Encoding", "chunked"],
        ["Content-Encoding", "identity"],
      ],
      chunks: [body.subarray(0, 20), body.subarray(20)],
    },
  ]) {
    const actual = await exchange(options);
    assert.equal(actual.invoked, true);
    assert.deepEqual(actual.result, { kind: "metadata", value, bytes: body.length });
    assert.ok(Object.isFrozen(actual.result));
    assert.ok(Object.isFrozen(actual.result.value));
  }
});

test("selected identity/types, selected escaped duplicates and strict UTF8/JSON deny", async () => {
  const invalid = [
    { ...value, id: 404 },
    { ...value, id: 0 },
    { ...value, id: -1 },
    { ...value, id: 303.5 },
    { ...value, id: 9007199254740992 },
    { ...value, id: "303" },
    { ...value, full_name: "owner/repo.git" },
    { ...value, full_name: "Owner/renamed" },
    { ...value, private: "true" },
    { ...value, default_branch: false },
    { ...value, default_branch: "" },
    { ...value, default_branch: "bad..branch" },
    { ...value, default_branch: "feature/.hidden" },
    { ...value, default_branch: "bad\ud800branch" },
    { id: 303, full_name: value.full_name, private: true },
    [],
    null,
  ].map((data) => Buffer.from(JSON.stringify(data)));
  invalid.push(
    Buffer.from(`${JSON.stringify(value)} trailing`),
    Buffer.from(
      `{"id":303,"id":303,"full_name":"Owner/repo.git","private":true,"default_branch":"main"}`,
    ),
    Buffer.from(
      `{"id":404,"\\u0069d":303,"full_name":"Owner/repo.git","private":true,"default_branch":"main"}`,
    ),
  );
  for (const key of ["full_name", "private", "default_branch"])
    invalid.push(
      Buffer.from(JSON.stringify(value).slice(0, -1) + `,"${key}":${JSON.stringify(value[key])}}`),
    );
  invalid.push(
    Buffer.concat([body.subarray(0, 15), Buffer.from([0xc3, 0x28]), body.subarray(15)]),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]),
  );
  for (const data of invalid) await denied({ data });
  const data = Buffer.from(
    JSON.stringify({
      ...value,
      extra: { id: 1, nested: [{ private: false, default_branch: "nested" }] },
      escaped: 'brace } comma , quote \\"',
    }),
  );
  assert.deepEqual(
    (await exchange({ data })).result.value,
    value,
    "nested/quoted provider extras do not become selected keys",
  );
});

test("one MiB exact body succeeds and both declared and streamed overflow terminate", async () => {
  const base = JSON.stringify({ ...value, padding: "" });
  const data = Buffer.from(
    JSON.stringify({ ...value, padding: "a".repeat(1048576 - Buffer.byteLength(base)) }),
  );
  assert.equal(data.length, 1048576);
  assert.equal((await exchange({ data })).result.bytes, 1048576);
  await denied({ data: Buffer.concat([data, Buffer.from(" ")]) }, ["limit-exceeded"]);
  await denied(
    {
      headers: [
        ["Content-Type", "application/json"],
        ["Transfer-Encoding", "chunked"],
      ],
      chunks: [data, Buffer.from(" ")],
    },
    ["limit-exceeded"],
  );
});

test("response status, credential headers, coding and framing refuse before publishing provider data", async () => {
  for (const status of [
    "301 Moved",
    "302 Found",
    "307 Temporary Redirect",
    "308 Permanent Redirect",
    "401 Unauthorized",
    "404 Not Found",
    "500 Failed",
  ])
    await denied({ status, data: Buffer.from("raw-provider-error") });
  for (const name of [
    "Set-Cookie",
    "Cookie",
    "Authorization",
    "Proxy-Authenticate",
    "WWW-Authenticate",
    "Authentication-Info",
    "X-API-Key",
    "X-GitHub-Token",
    "Location",
    "Refresh",
    "Trailer",
    "Upgrade",
    "Content-Range",
  ])
    await denied({ headers: [...lengthHeaders(body), [name, "wire-secret"]] });
  for (const coding of ["gzip", "br", "identity, gzip", "IDENTITY"])
    await denied({ headers: [...lengthHeaders(body), ["Content-Encoding", coding]] });
  for (const type of [
    "text/html",
    "application/json; charset=iso-8859-1",
    "application/json; charset=utf-8; boundary=x",
  ])
    await denied({
      headers: [
        ["Content-Type", type],
        ["Content-Length", String(body.length)],
      ],
    });
  await denied({
    headers: [
      ["Content-Type", "application/json"],
      ["Connection", "close"],
    ],
  });
  await denied({ headers: [...lengthHeaders(body), ["Content-Type", "application/json"]] });
  await denied({ headers: [...lengthHeaders(body), ["Transfer-Encoding", "chunked"]] }, [
    "invalid-response",
    "native-rejected",
  ]);
  for (const length of ["00", "+1", "-1", "9007199254740992"])
    await denied(
      {
        headers: [
          ["Content-Type", "application/json"],
          ["Content-Length", length],
        ],
      },
      ["invalid-response", "native-rejected"],
    );
  for (const transfer of ["gzip", "gzip, chunked", "chunked, chunked"])
    await denied(
      {
        headers: [
          ["Content-Type", "application/json"],
          ["Transfer-Encoding", transfer],
        ],
        data: Buffer.from("0\r\n\r\n"),
      },
      ["invalid-response", "native-rejected"],
    );
});

test("actual truncated EOF, malformed chunk and unannounced trailers yield safe denials", async () => {
  await denied({ truncate: true }, ["invalid-response", "unavailable"]);
  const h = head([
    ["Content-Type", "application/json"],
    ["Transfer-Encoding", "chunked"],
  ]);
  await denied({
    wire: Buffer.concat([h, chunk(body), Buffer.from("0\r\nX-Canary: wire-secret\r\n\r\n")]),
  });
  await denied({ wire: Buffer.concat([h, Buffer.from("z\r\nraw-provider-error\r\n0\r\n\r\n")]) }, [
    "invalid-response",
    "unavailable",
  ]);
});

test("original cancellation and finite deadlines terminate stalled real response streams", async () => {
  const before = new AbortController();
  before.abort();
  await denied({ bounds: { signal: before.signal, deadline: Date.now() + 1000 } }, ["aborted"]);
  await denied({ bounds: { signal: new AbortController().signal, deadline: Date.now() - 1 } }, [
    "expired",
  ]);
  const during = new AbortController();
  await denied(
    {
      stall: true,
      data: body.subarray(0, 20),
      headers: lengthHeaders(body),
      bounds: { signal: during.signal, deadline: Date.now() + 500 },
      afterStart: ({ schedule }) => schedule(() => during.abort(), 20),
    },
    ["aborted"],
  );
  const bounds = { signal: new AbortController().signal, deadline: Date.now() + 50 };
  await denied(
    {
      stall: true,
      data: body.subarray(0, 20),
      headers: lengthHeaders(body),
      bounds,
      mutate: (_expected, current) => {
        current.deadline = Date.now() + 60000;
      },
    },
    ["expired"],
  );
  await denied(
    {
      headers: [
        ["Content-Type", "application/json"],
        ["Transfer-Encoding", "chunked"],
      ],
      chunks: [body.subarray(0, 20), body.subarray(20)],
      mutate: (_expected, current) => {
        current.deadline = Date.now() - 1;
      },
    },
    ["expired"],
  );
  await denied(
    {
      mutate: (_expected, current) => {
        current.signal = new AbortController().signal;
      },
    },
    ["unavailable"],
  );
});

test("selection snapshot and full EOF remain required across asynchronous origin chunks", async () => {
  let verifiedNotSettled = false;
  const actual = await exchange({
    headers: [
      ["Content-Type", "application/json"],
      ["Transfer-Encoding", "chunked"],
    ],
    chunks: [body.subarray(0, 20), body.subarray(20)],
    mutate: (expected) => {
      expected.repositoryId = "404";
      expected.canonicalName = "other";
      expected.repository.canonicalPathSegments[1] = "other";
    },
    afterStart: ({ isSettled, schedule }) =>
      schedule(() => {
        assert.equal(isSettled(), false);
        verifiedNotSettled = true;
      }, 5),
  });
  assert.deepEqual(actual.result.value, value);
  assert.ok(verifiedNotSettled);
  await denied({ configure: (message) => message.setEncoding("utf8") });
});

test("invalid original selection or bounds terminate native response ownership safely", async () => {
  for (const bounds of [
    null,
    {},
    { signal: null, deadline: Date.now() + 1000 },
    { signal: new AbortController().signal, deadline: Infinity },
  ]) {
    await denied({ bounds, stall: true, data: body.subarray(0, 20), headers: lengthHeaders(body) });
  }
  const expected = selection();
  expected.repositoryId = "0303";
  await denied({ expected, stall: true, data: body.subarray(0, 20), headers: lengthHeaders(body) });
});

test("selected numeric root identity is lossless across length and chunked native framing", async () => {
  const valid = [
    "303",
    "303.0",
    "3.03e2",
    "30300e-2",
    "0.303e3",
    "303e+00000",
    "303" + "0".repeat(16384) + "e-16384",
    "0." + "0".repeat(16384) + "303e16387",
  ];
  const invalid = [
    "303.00000000000000000001",
    "303." + "0".repeat(16384) + "1",
    "302.99999999999999999999",
    "3.0300000000000000000001e2",
    "30300000000000000000001e-20",
    "0",
    "-303",
    "9007199254740992",
    "303e1000000",
    "303e-1000000",
    "303e" + "9".repeat(10000),
  ];
  for (const chunked of [false, true]) {
    for (const token of [...valid, ...invalid]) {
      // Escaped selected keys and numeric/string/nested decoys must not change
      // which root token determines identity.
      const data = Buffer.from(
        `{"extra":{"id":404},"text":"id:404","\\u0069d":${token},"full_name":"Owner/repo.git","private":true,"default_branch":"main"}`,
      );
      const options = chunked
        ? {
            data,
            headers: [
              ["Content-Type", "application/json"],
              ["Transfer-Encoding", "chunked"],
            ],
            chunks: [data.subarray(0, 30), data.subarray(30)],
          }
        : { data };
      const actual = await exchange(options);
      if (valid.includes(token)) assert.deepEqual(actual.result.value, value, token);
      else assert.deepEqual(actual.result, { kind: "invalid-response" }, token.slice(0, 80));
    }
  }
});

test("headers-only stalled response cancellation resists earlier event suppression and late cleanup shadows", async () => {
  const controller = new AbortController();
  controller.signal.addEventListener("abort", (event) => event.stopImmediatePropagation(), {
    once: true,
  });
  const started = Date.now();
  await denied(
    {
      stall: true,
      data: Buffer.alloc(0),
      headers: lengthHeaders(body),
      bounds: { signal: controller.signal, deadline: Date.now() + 1500 },
      afterStart: ({ schedule }) => {
        Object.defineProperty(controller.signal, "removeEventListener", {
          get() {
            throw Error("late-cleanup-canary");
          },
        });
        schedule(() => controller.abort(), 20);
      },
    },
    ["aborted"],
  );
  assert.ok(Date.now() - started < 1000, "abort settles before deadline without a body event");
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("response bounds authenticate native state without running caller method getters", async () => {
  const stopped = new AbortController();
  stopped.abort();
  Object.defineProperty(stopped.signal, "aborted", { value: false });
  await denied({ bounds: { signal: stopped.signal, deadline: Date.now() + 1000 } }, ["aborted"]);
  let reads = 0;
  await denied(
    {
      bounds: {
        get signal() {
          reads++;
          return reads === 1 ? stopped.signal : new AbortController().signal;
        },
        deadline: Date.now() + 1000,
      },
    },
    ["aborted"],
  );
  assert.equal(reads, 1);
  for (const name of ["addEventListener", "removeEventListener", "aborted"]) {
    for (const accessor of [false, true]) {
      const controller = new AbortController();
      let reads = 0;
      const throwing = () => {
        reads++;
        throw Error("operand-canary");
      };
      Object.defineProperty(
        controller.signal,
        name,
        accessor ? { get: throwing } : { value: throwing },
      );
      await denied(
        {
          stall: true,
          data: Buffer.alloc(0),
          headers: lengthHeaders(body),
          bounds: {
            signal: controller.signal,
            deadline: Date.now() + 1000,
          },
        },
        ["unavailable"],
      );
      assert.equal(reads, 0);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    }
  }
  for (const field of ["signal", "deadline"]) {
    const bounds = { signal: new AbortController().signal, deadline: Date.now() + 1000 };
    Object.defineProperty(bounds, field, {
      get() {
        throw Error("operand-canary");
      },
    });
    await denied({ bounds, stall: true, data: Buffer.alloc(0), headers: lengthHeaders(body) });
  }
});

test("response final reflection and timer checkpoints settle finitely with no success after cancellation", async () => {
  for (const mode of ["abort", "expire", "throw"]) {
    const controller = new AbortController();
    const deadline = Date.now() + 150;
    let message;
    let finalRead = false;
    let finalCheckpoint = false;
    let signalReads = 0;
    let deadlineReads = 0;
    const bounds = {
      get signal() {
        signalReads++;
        return controller.signal;
      },
      get deadline() {
        deadlineReads++;
        if (finalCheckpoint) {
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
      configure: (response) => {
        message = response;
        const trailers = response.rawTrailers;
        Object.defineProperty(response, "rawTrailers", {
          get() {
            // Final stream verification follows collection cleanup and precedes
            // projection and its final bounds checkpoint.
            if (message.readableEnded && getEventListeners(controller.signal, "abort").length === 0)
              finalCheckpoint = true;
            return trailers;
          },
        });
      },
    });
    assert.equal(finalRead, true);
    assert.equal(
      actual.result.kind,
      { abort: "aborted", expire: "expired", throw: "unavailable" }[mode],
    );
    assert.equal(signalReads, deadlineReads);
    assert.ok(signalReads <= 7, "one read per bounded response checkpoint");
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  }
  const controller = new AbortController();
  const bounds = { signal: controller.signal, deadline: Date.now() + 30 };
  await denied(
    {
      bounds,
      stall: true,
      data: Buffer.alloc(0),
      headers: lengthHeaders(body),
      mutate: () =>
        Object.defineProperty(bounds, "deadline", {
          get() {
            throw Error("timer-canary");
          },
        }),
    },
    ["unavailable"],
  );
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("response stream setup and cleanup exceptions settle without owned listeners or timers", async () => {
  for (const stage of ["setup", "cleanup"]) {
    let injected = false;
    await denied(
      {
        configure: (message) => {
          const event = stage === "setup" ? "newListener" : "removeListener";
          message.on(event, (name) => {
            if (!injected && name === (stage === "setup" ? "end" : "data")) {
              injected = true;
              throw Error("stream-operand-canary");
            }
          });
        },
      },
      ["unavailable"],
    );
    assert.equal(injected, true);
  }
});

test("late response listener-method mutation is refused with native cleanup", async () => {
  const controller = new AbortController();
  await denied(
    {
      bounds: { signal: controller.signal, deadline: Date.now() + 1000 },
      mutate: () =>
        Object.defineProperty(controller.signal, "removeEventListener", {
          get() {
            throw Error("late-cleanup-canary");
          },
        }),
    },
    ["unavailable"],
  );
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});
