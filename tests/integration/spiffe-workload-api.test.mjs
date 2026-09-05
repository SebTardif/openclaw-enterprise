import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  createSpiffeWorkloadIdentitySource,
  SpiffeWorkloadIdentityError,
} from "../../apps/controller/src/identity/index.ts";

const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
const grpc = require("@grpc/grpc-js");
const loader = require("@grpc/proto-loader");
const definition = grpc.loadPackageDefinition(
  loader.loadSync(
    fileURLToPath(
      new URL("../../apps/controller/src/identity/proto/workload.proto", import.meta.url),
    ),
    { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true },
  ),
);
const run = promisify(execFile);
const ID = "spiffe://test.example/occ/controller";
const OTHER_ID = "spiffe://test.example/occ/other";
const AUDIENCE = "occ-test-service";
let certificateDirectory;
let controller;
let rotated;
let other;
let extraSan;
let expired;
let future;

// This is a wire integration of the real source with a local gRPC fixture.
// It does not prove SPIRE workload attestation or JWT signature verification:
// the fixture stands in for the trusted local Workload API endpoint.
before(async () => {
  certificateDirectory = await mkdtemp(join(tmpdir(), "occ-spiffe-certs-"));
  await openssl(
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
    "-days",
    "2",
    "-subj",
    "/CN=OCC disposable test CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
  );
  await openssl("x509", "-in", "ca.pem", "-outform", "DER", "-out", "ca.der");
  controller = await certificate("controller", ID, 2);
  rotated = await certificate("rotated", ID, 3);
  other = await certificate("other", OTHER_ID, 4);
  extraSan = await certificate("extra-san", ID, 5, ",DNS:test.example");
  const now = Date.now();
  expired = await datedCertificate("expired", now - 120_000, now - 60_000);
  future = await datedCertificate("future", now + 86_400_000, now + 172_800_000);
});

after(async () => {
  if (certificateDirectory) await rm(certificateDirectory, { recursive: true, force: true });
});

async function openssl(...args) {
  await run("openssl", args, { cwd: certificateDirectory });
}

async function certificate(name, spiffeId, serial, additionalSan = "") {
  await openssl(
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
    `/CN=${name}`,
  );
  await writeFile(
    join(certificateDirectory, `${name}.ext`),
    `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth,serverAuth\nsubjectAltName=URI:${spiffeId}${additionalSan}\n`,
  );
  await openssl(
    "x509",
    "-req",
    "-in",
    `${name}.csr`,
    "-CA",
    "ca.pem",
    "-CAkey",
    "ca.key",
    "-set_serial",
    String(serial),
    "-days",
    "1",
    "-extfile",
    `${name}.ext`,
    "-out",
    `${name}.pem`,
  );
  await openssl("x509", "-in", `${name}.pem`, "-outform", "DER", "-out", `${name}.der`);
  await openssl(
    "pkcs8",
    "-topk8",
    "-nocrypt",
    "-in",
    `${name}.key`,
    "-outform",
    "DER",
    "-out",
    `${name}.pk8`,
  );
  const [leaf, key, ca] = await Promise.all([
    readFile(join(certificateDirectory, `${name}.der`)),
    readFile(join(certificateDirectory, `${name}.pk8`)),
    readFile(join(certificateDirectory, "ca.der")),
  ]);
  return {
    spiffe_id: spiffeId,
    x509_svid: Buffer.concat([leaf, ca]),
    x509_svid_key: key,
    bundle: ca,
    leaf,
  };
}

async function datedCertificate(name, startsAt, endsAt) {
  await writeFile(join(certificateDirectory, `${name}.index`), "");
  await writeFile(join(certificateDirectory, `${name}.serial`), "1000\n");
  await writeFile(
    join(certificateDirectory, `${name}.cnf`),
    `[ca]\ndefault_ca=local\n[local]\ndatabase=${name}.index\nserial=${name}.serial\nnew_certs_dir=.\ncertificate=ca.pem\nprivate_key=ca.key\ndefault_md=sha256\npolicy=subject_policy\n[subject_policy]\ncommonName=supplied\n[leaf]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nsubjectAltName=URI:${ID}\n`,
  );
  const date = (timestamp) =>
    new Date(timestamp)
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}Z$/, "Z")
      .replace("T", "");
  // Explicit validity dates exercise OpenSSL's real certificate timestamps;
  // no fake clock or alternate certificate parser participates in the test.
  await openssl(
    "ca",
    "-batch",
    "-config",
    `${name}.cnf`,
    "-in",
    "controller.csr",
    "-out",
    `${name}.pem`,
    "-startdate",
    date(startsAt),
    "-enddate",
    date(endsAt),
    "-extensions",
    "leaf",
    "-notext",
  );
  await openssl("x509", "-in", `${name}.pem`, "-outform", "DER", "-out", `${name}.der`);
  const leaf = await readFile(join(certificateDirectory, `${name}.der`));
  return { ...controller, leaf, x509_svid: Buffer.concat([leaf, controller.bundle]) };
}

function token(claims = {}) {
  return (
    [
      { alg: "ES256", typ: "JWT" },
      { sub: ID, aud: [AUDIENCE], exp: Math.floor(Date.now() / 1000) + 600, ...claims },
    ]
      .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
      .join(".") + ".dGVzdC1zaWduYXR1cmU"
  );
}

function validatedClaims({
  spiffeId = ID,
  subject = spiffeId,
  audience = AUDIENCE,
  expires = Math.floor(Date.now() / 1000) + 600,
} = {}) {
  return {
    spiffe_id: spiffeId,
    claims: {
      fields: {
        sub: { stringValue: subject },
        exp: { numberValue: expires },
        aud: { listValue: { values: [{ stringValue: audience }] } },
      },
    },
  };
}

async function fixture(
  t,
  { initial = () => ({ svids: [controller] }), timeoutMs = 1000, fetch, validate } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "occ-wapi-"));
  const socketPath = join(directory, "api.sock");
  const requests = [];
  const streams = [];
  const server = new grpc.Server();
  let source;
  t.after(async () => {
    source?.close();
    server.forceShutdown();
    await rm(directory, { recursive: true, force: true });
  });
  const record = (method, call) =>
    requests.push({
      method,
      request: call.request,
      metadata: call.metadata.get("workload.spiffe.io"),
    });
  server.addService(definition.SpiffeWorkloadAPI.service, {
    FetchX509SVID(call) {
      record("x509", call);
      streams.push(call);
      const response = initial();
      if (response) call.write(response);
    },
    FetchJWTSVID(call, callback) {
      record("fetch", call);
      if (fetch) fetch(call, callback);
      else callback(null, { svids: [{ spiffe_id: ID, svid: token() }] });
    },
    ValidateJWTSVID(call, callback) {
      record("validate", call);
      if (validate) validate(call, callback);
      else callback(null, validatedClaims());
    },
  });
  await new Promise((resolve, reject) =>
    server.bindAsync(`unix:${socketPath}`, grpc.ServerCredentials.createInsecure(), (error) =>
      error ? reject(error) : resolve(),
    ),
  );
  source = createSpiffeWorkloadIdentitySource({
    socketPath,
    expectedSpiffeId: ID,
    timeoutMs,
  });
  return { source, requests, streams, socketPath, server };
}

function identityError(error) {
  assert.ok(error instanceof SpiffeWorkloadIdentityError);
  assert.ok(
    [
      "INVALID_CONFIGURATION",
      "UNAVAILABLE",
      "INVALID_RESPONSE",
      "IDENTITY_MISMATCH",
      "EXPIRED",
      "ABORTED",
      "TIMEOUT",
      "CLOSED",
      "BUSY",
    ].includes(error.code),
  );
  assert.equal(error.message, `SPIFFE Workload API operation failed (${error.code}).`);
  return true;
}

async function eventually(check) {
  const deadline = Date.now() + 2000;
  while (true) {
    try {
      check();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await delay(10);
    }
  }
}

test("Workload API selects the exact X.509 identity and decodes the DER chain and PKCS8 key", async (t) => {
  const { source, requests } = await fixture(t, {
    initial: () => ({ svids: [other, controller] }),
  });
  await source.start();
  const identity = source.getX509Identity();
  assert.equal(identity.spiffeId, ID);
  assert.equal(identity.certificateChain.length, 2);
  assert.deepEqual(identity.certificateChain[0], controller.leaf);
  assert.deepEqual(identity.privateKey, controller.x509_svid_key);
  assert.deepEqual(identity.bundle, [controller.bundle]);
  assert.equal(
    identity.expiresAt,
    new Date(new X509Certificate(controller.leaf).validTo).toISOString(),
  );
  assert.deepEqual(source.getX509IdentityMetadata(), {
    spiffeId: ID,
    expiresAt: identity.expiresAt,
    certificateCount: 2,
    bundleCertificateCount: 1,
  });
  assert.deepEqual(requests, [{ method: "x509", request: {}, metadata: ["true"] }]);
});

test("a valid full-stream replacement rotates the selected identity", async (t) => {
  const { source, streams } = await fixture(t);
  await source.start();
  streams[0].write({ svids: [rotated] });
  await eventually(() =>
    assert.deepEqual(source.getX509Identity().certificateChain[0], rotated.leaf),
  );
  assert.deepEqual(source.getX509Identity().privateKey, rotated.x509_svid_key);
});

test("full replacements remove previously supplied CRLs and federated trust bundles", async (t) => {
  const trustDomain = "spiffe://federated.example";
  // CRLs remain opaque byte strings in this component; this DER sequence does
  // not claim to verify revocation processing or federation trust decisions.
  const crl = Buffer.from([0x30, 0x00]);
  const { source, streams } = await fixture(t, {
    initial: () => ({
      svids: [controller],
      crl: [crl],
      federated_bundles: { [trustDomain]: controller.bundle },
    }),
  });
  await source.start();
  assert.deepEqual(source.getX509Identity().crls, [crl]);
  assert.deepEqual(source.getX509Identity().federatedBundles, {
    [trustDomain]: [controller.bundle],
  });
  streams[0].write({ svids: [rotated] });
  await eventually(() =>
    assert.deepEqual(source.getX509Identity().certificateChain[0], rotated.leaf),
  );
  assert.deepEqual(source.getX509Identity().crls, []);
  assert.deepEqual(source.getX509Identity().federatedBundles, {});
});

test("an oversized SVID collection invalidates the previous identity at the 64-entry boundary", async (t) => {
  const { source, streams } = await fixture(t, {
    initial: () => ({ svids: [controller, ...Array(63).fill(other)] }),
  });
  await source.start();
  assert.equal(source.getX509Identity().spiffeId, ID);
  streams[0].write({ svids: [controller, ...Array(64).fill(other)] });
  await eventually(() =>
    assert.throws(() => source.getX509Identity(), { code: "INVALID_RESPONSE" }),
  );
});

test("a response over the 4 MiB receive limit terminates the stream and clears its identity", async (t) => {
  const { source, streams } = await fixture(t);
  await source.start();
  // The protobuf message itself exceeds the transport limit; a large hint
  // avoids conflating this check with DER parsing or collection validation.
  streams[0].write({ svids: [{ ...controller, hint: "x".repeat(4 * 1024 * 1024) }] });
  await eventually(() => assert.throws(() => source.getX509Identity(), { code: "UNAVAILABLE" }));
  await eventually(() => assert.equal(streams[0].cancelled, true));
});

for (const [name, credential, code] of [
  ["expired", () => expired, "EXPIRED"],
  ["not yet valid", () => future, "INVALID_RESPONSE"],
]) {
  test(`X.509 startup rejects a certificate that is ${name} with otherwise valid identity and key`, async (t) => {
    const { source } = await fixture(t, { initial: () => ({ svids: [credential()] }) });
    await assert.rejects(source.start(), { code });
    assert.throws(() => source.getX509Identity(), { code });
  });
}

for (const [name, response] of [
  ["missing expected identity", () => ({ svids: [other] })],
  ["duplicate expected identities", () => ({ svids: [controller, rotated] })],
  [
    "certificate URI different from response identity",
    () => ({ svids: [{ ...other, spiffe_id: ID }] }),
  ],
  // This component deliberately supports the sole-URI SPIRE leaf profile;
  // SPIFFE certificates with additional DNS SANs are outside that local profile.
  ["additional SAN outside the supported sole-URI profile", () => ({ svids: [extraSan] })],
  [
    "mismatched private key",
    () => ({ svids: [{ ...controller, x509_svid_key: other.x509_svid_key }] }),
  ],
  [
    "malformed certificate DER",
    () => ({ svids: [{ ...controller, x509_svid: Buffer.from("invalid DER") }] }),
  ],
  ["empty trust bundle", () => ({ svids: [{ ...controller, bundle: Buffer.alloc(0) }] })],
]) {
  test(`X.509 startup rejects ${name}`, async (t) => {
    const { source } = await fixture(t, { initial: response });
    await assert.rejects(source.start(), identityError);
    assert.throws(() => source.getX509Identity(), identityError);
  });
}

test("an invalid replacement clears the previous identity and disables JWT operations", async (t) => {
  const { source, streams, requests } = await fixture(t);
  await source.start();
  // Each streamed response replaces the entire entitlement set; removal must
  // invalidate the previous credential instead of retaining it until expiry.
  streams[0].write({ svids: [other] });
  await eventually(() => assert.throws(() => source.getX509Identity(), identityError));
  assert.throws(() => source.getX509IdentityMetadata(), identityError);
  await assert.rejects(source.fetchJwtSvid({ audience: AUDIENCE }), identityError);
  assert.equal(
    requests.some(({ method }) => method === "fetch"),
    false,
  );
});

test("stream completion fails closed even while the previous certificate is unexpired", async (t) => {
  const { source, streams } = await fixture(t);
  await source.start();
  assert.ok(Date.parse(source.getX509Identity().expiresAt) > Date.now());
  streams[0].end();
  await eventually(() => assert.throws(() => source.getX509Identity(), identityError));
});

test("recovery requires a new source and never revives the terminated source", async (t) => {
  const { source, streams, socketPath } = await fixture(t);
  await source.start();
  streams[0].end();
  await eventually(() => assert.throws(() => source.getX509Identity(), { code: "UNAVAILABLE" }));
  await assert.rejects(source.start(), { code: "UNAVAILABLE" });
  assert.equal(streams.length, 1);
  const replacement = createSpiffeWorkloadIdentitySource({
    socketPath,
    expectedSpiffeId: ID,
    timeoutMs: 1000,
  });
  t.after(() => replacement.close());
  await replacement.start();
  assert.equal(replacement.getX509Identity().spiffeId, ID);
  assert.equal(streams.length, 2);
  assert.throws(() => source.getX509Identity(), { code: "UNAVAILABLE" });
});

test("an unavailable Workload API server terminates the identity stream", async (t) => {
  const { source, server } = await fixture(t);
  await source.start();
  server.forceShutdown();
  await eventually(() => assert.throws(() => source.getX509Identity(), { code: "UNAVAILABLE" }));
  await assert.rejects(source.fetchJwtSvid({ audience: AUDIENCE }), { code: "UNAVAILABLE" });
});

for (const kind of ["missing", "regular file", "symlink"]) {
  test(`startup rejects a ${kind} socket path without issuing an RPC`, async (t) => {
    const { socketPath, requests } = await fixture(t);
    const candidate = `${socketPath}.candidate`;
    if (kind === "regular file") await writeFile(candidate, "not a Unix socket");
    if (kind === "symlink") await symlink(socketPath, candidate);
    // A symlink to an otherwise live endpoint is intentionally rejected: the
    // configured endpoint itself must be an operator-provisioned Unix socket.
    const source = createSpiffeWorkloadIdentitySource({
      socketPath: candidate,
      expectedSpiffeId: ID,
      timeoutMs: 1000,
    });
    t.after(() => source.close());
    await assert.rejects(source.start(), { code: "UNAVAILABLE" });
    assert.throws(() => source.getX509Identity(), { code: "UNAVAILABLE" });
    assert.deepEqual(requests, []);
  });
}

test("close during startup rejects the pending start and cancels the idle stream", async (t) => {
  const { source, streams } = await fixture(t, { initial: () => undefined });
  const rejected = assert.rejects(source.start(), { code: "CLOSED" });
  await eventually(() => assert.equal(streams.length, 1));
  source.close();
  await rejected;
  await eventually(() => assert.equal(streams[0].cancelled, true));
  assert.throws(() => source.getX509Identity(), { code: "CLOSED" });
  await assert.rejects(source.start(), { code: "CLOSED" });
});

test("startup timeout cancels the live RPC and keeps identity unavailable", async (t) => {
  const { source, streams } = await fixture(t, { initial: () => undefined, timeoutMs: 1000 });
  await assert.rejects(source.start(), identityError);
  assert.throws(() => source.getX509Identity(), identityError);
  await eventually(() => assert.equal(streams[0]?.cancelled, true));
});

test("startup cancellation cancels the stream and a source cannot restart after close", async (t) => {
  const { source, streams } = await fixture(t, { initial: () => undefined });
  const abort = new AbortController();
  const started = source.start({ signal: abort.signal });
  const rejected = assert.rejects(started, identityError);
  await eventually(() => assert.equal(streams.length, 1));
  abort.abort();
  await rejected;
  await eventually(() => assert.equal(streams[0].cancelled, true));
  source.close();
  await assert.rejects(source.start(), identityError);
});

test("JWT methods require a live X.509 stream and close revokes access", async (t) => {
  const { source, requests } = await fixture(t);
  await assert.rejects(source.fetchJwtSvid({ audience: AUDIENCE }), identityError);
  await assert.rejects(
    source.validateJwtSvid({ token: token(), audience: AUDIENCE, expectedSpiffeId: ID }),
    identityError,
  );
  assert.deepEqual(requests, []);
  await source.start();
  source.close();
  assert.throws(() => source.getX509Identity(), identityError);
  await assert.rejects(source.fetchJwtSvid({ audience: AUDIENCE }), identityError);
});

test("the startup signal revokes an established identity and cancels pending unary work", async (t) => {
  const pending = [];
  const { source, streams } = await fixture(t, { fetch: (call) => pending.push(call) });
  const lifetime = new AbortController();
  await source.start({ signal: lifetime.signal });
  const rejected = assert.rejects(source.fetchJwtSvid({ audience: AUDIENCE }), (error) => {
    identityError(error);
    assert.equal(error.code, "ABORTED");
    return true;
  });
  await eventually(() => assert.equal(pending.length, 1));
  // Cancellation after startup still controls the whole identity source lifetime.
  lifetime.abort(new Error("private caller cancellation reason"));
  await rejected;
  assert.throws(() => source.getX509Identity(), identityError);
  await eventually(() => {
    assert.equal(streams[0].cancelled, true);
    assert.equal(pending[0].cancelled, true);
  });
});

test("callers cannot mutate the retained identity through returned credential buffers", async (t) => {
  const { source } = await fixture(t);
  await source.start();
  const snapshot = source.getX509Identity();
  snapshot.privateKey.fill(0);
  snapshot.certificateChain[0].fill(0);
  snapshot.bundle[0].fill(0);
  const next = source.getX509Identity();
  assert.deepEqual(next.privateKey, controller.x509_svid_key);
  assert.deepEqual(next.certificateChain[0], controller.leaf);
  assert.deepEqual(next.bundle[0], controller.bundle);
});

test("JWT fetch and validation use the official unary requests and workload metadata", async (t) => {
  const issued = token();
  const validated = validatedClaims();
  const { source, requests } = await fixture(t, {
    fetch: (_call, callback) =>
      callback(null, {
        svids: [
          { spiffe_id: OTHER_ID, svid: token({ sub: OTHER_ID }) },
          { spiffe_id: ID, svid: issued },
        ],
      }),
    validate: (_call, callback) => callback(null, validated),
  });
  await source.start();
  const fetched = await source.fetchJwtSvid({ audience: AUDIENCE });
  assert.equal(fetched.spiffeId, ID);
  assert.equal(fetched.token, issued);
  assert.ok(Date.parse(fetched.expiresAt) > Date.now());
  assert.deepEqual(
    await source.validateJwtSvid({ token: issued, audience: AUDIENCE, expectedSpiffeId: ID }),
    {
      spiffeId: ID,
      expiresAt: new Date(validated.claims.fields.exp.numberValue * 1000).toISOString(),
    },
  );
  assert.deepEqual(requests.slice(1), [
    { method: "fetch", request: { audience: [AUDIENCE], spiffe_id: ID }, metadata: ["true"] },
    { method: "validate", request: { audience: AUDIENCE, svid: issued }, metadata: ["true"] },
    { method: "validate", request: { audience: AUDIENCE, svid: issued }, metadata: ["true"] },
  ]);
});

for (const [name, claims] of [
  ["wrong subject", { subject: OTHER_ID }],
  ["wrong audience", { audience: "another-service" }],
  ["expired token", { expires: 1 }],
]) {
  test(`JWT fetch rejects ${name}`, async (t) => {
    const { source } = await fixture(t, {
      // Fetch must check the trusted validation response before returning the token.
      validate: (_call, callback) => callback(null, validatedClaims(claims)),
    });
    await source.start();
    await assert.rejects(source.fetchJwtSvid({ audience: AUDIENCE }), identityError);
  });
}

for (const [name, claims] of [
  ["wrong identity", { spiffeId: OTHER_ID }],
  ["inconsistent subject", { subject: OTHER_ID }],
  ["wrong audience", { audience: "another-service" }],
  ["expired claims", { expires: 1 }],
]) {
  test(`JWT validation rejects trusted endpoint response with ${name}`, async (t) => {
    const { source } = await fixture(t, {
      validate: (_call, callback) => callback(null, validatedClaims(claims)),
    });
    await source.start();
    await assert.rejects(
      source.validateJwtSvid({ token: token(), audience: AUDIENCE, expectedSpiffeId: ID }),
      identityError,
    );
  });
}

test("unary failures are sanitized and cannot expose the token or remote error details", async (t) => {
  const sensitive = "fixture-secret-must-not-escape";
  const { source } = await fixture(t, {
    validate: (_call, callback) =>
      callback({ code: grpc.status.PERMISSION_DENIED, details: sensitive, message: sensitive }),
  });
  await source.start();
  await assert.rejects(
    source.validateJwtSvid({ token: token(), audience: AUDIENCE, expectedSpiffeId: ID }),
    (error) => {
      identityError(error);
      assert.equal(String(error).includes(sensitive), false);
      assert.equal(JSON.stringify(error).includes(sensitive), false);
      assert.equal(error.cause, undefined);
      return true;
    },
  );
});

test("unary timeout and cancellation cancel the underlying gRPC calls", async (t) => {
  const pending = [];
  const { source } = await fixture(t, { timeoutMs: 1000, fetch: (call) => pending.push(call) });
  await source.start();
  await assert.rejects(source.fetchJwtSvid({ audience: AUDIENCE }), identityError);
  await eventually(() => assert.equal(pending[0]?.cancelled, true));
  const abort = new AbortController();
  const rejected = assert.rejects(
    source.fetchJwtSvid({ audience: AUDIENCE, signal: abort.signal }),
    identityError,
  );
  await eventually(() => assert.equal(pending.length, 2));
  abort.abort();
  await rejected;
  await eventually(() => assert.equal(pending[1].cancelled, true));
});
