import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import test from "node:test";
import { inspectRequestHeadV1 } from "../../apps/credential-gateway/src/http/request.ts";

// Real native parsing protects framing and preserves the flat raw-header boundary.
// This is a component harness; it does not impersonate the later authenticated server.
async function exchange({
  method = "GET",
  target = "/repos/Owner/repo",
  host = "api.github.com",
  headers = [],
  version = "1.1",
  body = "",
} = {}) {
  let invoked = 0;
  let observed;
  const sockets = new Set();
  const server = createServer({ maxHeaderSize: 32768, insecureHTTPParser: false });
  server.maxHeadersCount = 0;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const handle = (request, response) => {
    invoked++;
    const result = inspectRequestHeadV1(request);
    observed = {
      result,
      flowing: request.readableFlowing,
      dataListeners: request.listenerCount("data"),
    };
    if (result.kind === "parsed") {
      assert.ok(Object.isFrozen(result.head));
      assert.ok(Object.isFrozen(result.head.route));
      assert.ok(Object.isFrozen(result.head.framing));
      assert.ok(Object.isFrozen(result.head.bodyLimits));
      assert.equal(Object.hasOwn(result.head, "authorization"), false);
    }
    response.writeHead(result.kind === "parsed" ? 200 : result.status, { Connection: "close" });
    response.end("checked");
  };
  server.on("request", handle);
  // The component returns a flag only: this harness deliberately emits no 100 response.
  server.on("checkContinue", handle);
  server.on("checkExpectation", handle);
  server.on("clientError", (_error, socket) => {
    if (socket.writable)
      socket.end(
        "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 6\r\n\r\ndenied",
      );
  });
  let client;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const output = await new Promise((resolve, reject) => {
      client = connect(address.port, "127.0.0.1");
      let bytes = "";
      client.setTimeout(1500, () => client.destroy(new Error("bounded socket timeout")));
      client.on("error", reject);
      client.on("data", (chunk) => {
        bytes += chunk.toString("ascii");
        assert.ok(bytes.length < 4096);
      });
      client.on("end", () => resolve(bytes));
      client.on("connect", () =>
        client.write(
          `${method} ${target} HTTP/${version}\r\nHost: ${host}\r\n${headers.map(([name, value]) => `${name}: ${value}\r\n`).join("")}\r\n${body}`,
        ),
      );
    });
    assert.doesNotMatch(output, /synthetic-secret/);
    assert.doesNotMatch(output, /100 Continue/);
    return { invoked, observed, output };
  } finally {
    client?.destroy();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}
const upload = "application/x-git-upload-pack-request";
const receive = "application/x-git-receive-pack-request";
const uuid = "4d0ba4ee-d95a-4f20-89bc-605807a6e8aa";
const post = (type, length = "0") => [
  ["Content-Type", type],
  ["Content-Length", length],
];
async function parsed(options, kind) {
  const result = await exchange(options);
  assert.equal(result.invoked, 1);
  assert.equal(result.observed.result.kind, "parsed");
  assert.equal(result.observed.result.head.route.kind, kind);
  assert.equal(result.observed.flowing, null);
  assert.equal(result.observed.dataListeners, 0);
  return result.observed.result.head;
}
async function denied(options, status, nativeAllowed = false) {
  const result = await exchange(options);
  if (result.invoked === 0) {
    assert.ok(nativeAllowed, "the inspector must run for this vector");
    assert.match(result.output, /^HTTP\/1\.1 400 /);
    return;
  }
  assert.equal(result.invoked, 1);
  assert.deepEqual(result.observed.result, {
    kind: "denied",
    status,
    code: status === 413 || status === 431 ? "limit-exceeded" : "unsupported-request",
  });
}

test("six literal routes yield immutable, unauthenticated candidates without body reads", async () => {
  const metadata = await parsed(
    {
      host: "API.GITHUB.COM:443",
      target: "/repos/Owner/repo.git",
      headers: [["Authorization", "Bearer synthetic-secret"]],
    },
    "metadata",
  );
  assert.equal(metadata.route.repository, "repo.git");
  assert.equal(metadata.route.owner, "Owner");
  assert.deepEqual(metadata.framing, { kind: "none" });
  assert.deepEqual(metadata.bodyLimits, { wire: 0, decoded: 0 });
  assert.doesNotMatch(JSON.stringify(metadata), /synthetic-secret|Authorization/);
  for (const [service, kind] of [
    ["upload", "fetch-discovery"],
    ["receive", "push-discovery"],
  ]) {
    const head = await parsed(
      {
        host: "github.com",
        target: `/Owner/repo.git.git/info/refs?service=git-${service}-pack`,
        headers: [
          ["Git-Protocol", "version=2"],
          ["Pragma", "no-cache"],
          ["Content-Length", "0"],
        ],
      },
      kind,
    );
    assert.equal(head.route.repository, "repo.git");
    assert.equal(head.gitProtocol, "version=2");
  }
  const fetch = await parsed(
    {
      host: "github.com",
      method: "POST",
      target: "/Owner/repo.git/git-upload-pack",
      headers: [
        ...post(upload, "1048576"),
        ["Content-Encoding", "gzip"],
        ["Expect", "100-CONTINUE"],
      ],
    },
    "fetch",
  );
  assert.equal(fetch.expectContinue, true);
  assert.equal(fetch.contentEncoding, "gzip");
  assert.deepEqual(fetch.bodyLimits, { wire: 1048576, decoded: 1048576 });
  const push = await parsed(
    {
      host: "github.com",
      method: "POST",
      target: "/Owner/repo.git/git-receive-pack",
      headers: [
        ["Content-Type", receive],
        ["Transfer-Encoding", "CHUNKED"],
      ],
    },
    "push",
  );
  assert.deepEqual(push.framing, { kind: "chunked" });
  assert.equal(push.bodyLimits.wire, 268435456);
  const pr = await parsed(
    {
      method: "POST",
      target: "/repos/Owner/repo/pulls",
      headers: [...post("application/json", "65536"), ["X-OCE-Operation-Id", uuid]],
    },
    "pr-create",
  );
  assert.equal(pr.operationId, uuid);
  assert.equal(pr.bodyLimits.decoded, 65536);
});

test("route, host, method and query ambiguities deny at the native or inspector boundary", async () => {
  for (const target of [
    "/repos/o/r?",
    "/repos/o/r?x=1",
    "/repos/o/.",
    "/repos/o/..",
    "/repos//r",
    "/repos/o/r/",
    "/repos/o/%72",
    "/repos/o/r#x",
    "/repos/o/r\\x",
    "https://api.github.com/repos/o/r",
    "*",
    "/repos/o/ré",
  ])
    await denied({ target }, 400, true);
  for (const host of [
    "api.github.com.",
    "api.github.com:444",
    "api.github.com:0443",
    "other.com",
    "user@api.github.com",
    "github.com,api.github.com",
  ])
    await denied({ host }, 400);
  for (const method of ["PUT", "get", "POST"]) await denied({ method }, 400, true);
  await denied({ version: "1.0" }, 400);
  for (const suffix of ["&x=1", "&", "&service=git-upload-pack", "", "=x"])
    await denied(
      {
        host: "github.com",
        target: `/o/r.git/info/refs?service=git-upload-pack${suffix === "" ? "?" : suffix}`,
      },
      400,
    );
  await denied(
    { host: "api.github.com", target: "/o/r.git/info/refs?service=git-upload-pack" },
    400,
  );
  await denied({ host: "github.com", target: "/repos/o/r" }, 400);
});

test("closed singleton headers reject duplicate, proxy, identity and interpretation fields", async () => {
  for (const name of [
    "Cookie",
    "TE",
    "Trailer",
    "Upgrade",
    "Proxy-Authorization",
    "Forwarded",
    "X-Forwarded-For",
    "X-OCE-Agent-Id",
    "X-GitHub-Api-Version",
    "Git-Protocol",
    "Pragma",
    "X-OCE-Operation-Id",
  ])
    await denied({ headers: [[name, "value"]] }, 400);
  for (const name of ["Authorization", "Accept", "User-Agent", "Connection"])
    await denied(
      {
        headers: [
          [name, "synthetic-secret"],
          [name.toLowerCase(), "synthetic-secret"],
        ],
      },
      400,
    );
  await denied({ headers: [["hOsT", "api.github.com"]] }, 400, true);
  for (const value of ["keep-alive, close", "upgrade", "arbitrary"])
    await denied({ headers: [["Connection", value]] }, 400);
  await parsed(
    {
      headers: [
        ["Connection", "KEEP-ALIVE"],
        ["Accept", "arbitrary"],
        ["Accept-Encoding", "gzip"],
        ["User-Agent", "client"],
      ],
    },
    "metadata",
  );
  await denied({ headers: [["Accept", "a\tb"]] }, 400);
  await denied({ headers: [["Accept", "é"]] }, 400);
  await denied(
    {
      host: "github.com",
      target: "/o/r.git/info/refs?service=git-upload-pack",
      headers: [["Git-Protocol", "version=1"]],
    },
    400,
  );
  await denied(
    {
      host: "github.com",
      target: "/o/r.git/info/refs?service=git-upload-pack",
      headers: [["Pragma", "NO-CACHE"]],
    },
    400,
  );
});

test("framing, coding, content type and declared body caps deny before stream consumption", async () => {
  const fetch = { method: "POST", host: "github.com", target: "/o/r.git/git-upload-pack" };
  for (const length of ["00", "+1", "-1", "1,1", "1 0", "9007199254740992"])
    await denied({ ...fetch, headers: post(upload, length) }, 400, true);
  await denied(
    { ...fetch, headers: [...post(upload), ["Transfer-Encoding", "chunked"]] },
    400,
    true,
  );
  await denied({ ...fetch, headers: [["Content-Type", upload]] }, 400);
  for (const value of ["gzip", "gzip, chunked", "chunked, chunked"])
    await denied(
      {
        ...fetch,
        headers: [
          ["Content-Type", upload],
          ["Transfer-Encoding", value],
        ],
      },
      400,
      true,
    );
  for (const value of [
    "Application/x-git-upload-pack-request",
    `${upload}; charset=utf-8`,
    "application/json",
  ])
    await denied({ ...fetch, headers: post(value) }, 415);
  for (const value of ["br", "gzip, identity", "GZIP"])
    await denied({ ...fetch, headers: [...post(upload), ["Content-Encoding", value]] }, 415);
  await denied({ ...fetch, headers: [...post(upload), ["Expect", "other"]] }, 400);
  await denied({ ...fetch, headers: post(upload, "1048577") }, 413);
  await denied(
    {
      method: "POST",
      host: "github.com",
      target: "/o/r.git/git-receive-pack",
      headers: post(receive, "268435457"),
    },
    413,
  );
  for (const pair of [
    ["Content-Length", "1"],
    ["Transfer-Encoding", "chunked"],
    ["Content-Type", "application/json"],
    ["Content-Encoding", "identity"],
    ["Expect", "100-continue"],
  ])
    await denied({ headers: [pair] }, 400, true);
  const pr = { method: "POST", target: "/repos/o/r/pulls" };
  await denied({ ...pr, headers: post("application/json") }, 400);
  for (const id of [
    uuid.toUpperCase(),
    uuid.replace("-4f20-", "-5f20-"),
    uuid.replace("-89bc-", "-79bc-"),
    "false",
    "",
  ])
    await denied(
      { ...pr, headers: [...post("application/json"), ["X-OCE-Operation-Id", id]] },
      400,
    );
  await denied(
    { ...pr, headers: [...post("application/json", "65537"), ["X-OCE-Operation-Id", uuid]] },
    413,
  );
  await denied(
    {
      ...pr,
      headers: [
        ...post("application/json"),
        ["X-OCE-Operation-Id", uuid],
        ["Content-Encoding", "gzip"],
      ],
    },
    415,
  );
});

test("raw pair count is enforced without native truncation; native owns original wire bytes", async () => {
  // Unknown headers force a 400 at 64; 65 must hit the earlier count ceiling, 431.
  const extras = Array.from({ length: 63 }, (_, i) => [`X-${i}`, "a"]);
  await denied({ headers: extras }, 400);
  await denied({ headers: [...extras, ["X-last", "a"]] }, 431);
  await parsed({ headers: [["Accept", "a".repeat(32000)]] }, "metadata");
  // Locate the actual strict native ceiling, then protect its adjacent byte cases.
  // This remains parser evidence, rather than claiming the inspector saw rejected input.
  let accepted = 32000;
  let rejected = 32768;
  while (rejected - accepted > 1) {
    const candidate = Math.floor((accepted + rejected) / 2);
    const result = await exchange({ headers: [["Accept", "a".repeat(candidate)]] });
    if (result.invoked === 1) {
      assert.equal(result.observed.result.kind, "parsed");
      accepted = candidate;
    } else rejected = candidate;
  }
  assert.equal(rejected, accepted + 1);
  await parsed({ headers: [["Accept", "a".repeat(accepted)]] }, "metadata");
  const adjacent = await exchange({ headers: [["Accept", "a".repeat(rejected)]] });
  assert.equal(adjacent.invoked, 0);
  const overflow = await exchange({ headers: [["Accept", "a".repeat(32768)]] });
  assert.equal(overflow.invoked, 0, "native overflow must not be credited to the inspector");
  assert.match(overflow.output, /^HTTP\/1\.1 400 /);
});

test("malformed top-level runtime operands return finite denial", () => {
  for (const input of [null, false, undefined, 0, "request"])
    assert.deepEqual(inspectRequestHeadV1(input), {
      kind: "denied",
      status: 400,
      code: "unsupported-request",
    });
});
