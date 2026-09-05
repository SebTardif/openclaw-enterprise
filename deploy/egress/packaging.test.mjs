import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checksumManifest, validateLock, verifyDirectory } from "./download-packages.mjs";
import { createCompose, createTlsConfiguration, validateConfiguration } from "./local.mjs";

const config = {
  schemaVersion: 1,
  project: "oce-egress-unit",
  image: `sha256:${"a".repeat(64)}`,
  authoritySocketDirectory: "/operator/authority",
  providerKeyPath: "/operator/private/provider-key",
  providerBindingRef: "openai-test",
  certificatePath: "/operator/private/certificate.pem",
  certificateKeyPath: "/operator/private/key.pem",
  dnsUpstream: "192.0.2.53:53",
};

test("local configuration rejects unsupported profiles and mutable image references", () => {
  assert.equal(validateConfiguration(config), config);
  assert.throws(() => validateConfiguration({ ...config, image: "oce-egress:latest" }), /image/);
  assert.throws(
    () => validateConfiguration({ ...config, development_loopback_http: true }),
    /unsupported/,
  );
  assert.throws(
    () => validateConfiguration({ ...config, dnsUpstream: "resolver.example:53" }),
    /resolver/,
  );
  assert.throws(
    () => validateConfiguration({ ...config, providerBindingRef: "*" }),
    /providerBindingRef/,
  );
});

test("actual Compose generation keeps custody and firewall authority in distinct processes", () => {
  // This verifies generated deployment configuration; it does not claim live
  // Docker capabilities, peer credentials, kernel enforcement, or provider proof.
  const compose = createCompose(
    config,
    "/operator/build-state",
    "05b050e8-5a57-4b73-a089-290ace2c4d18",
  );
  assert.deepEqual(Object.keys(compose.services), ["dns", "tls"]);
  const { dns, tls } = compose.services;
  assert.equal(dns.user, "0:0");
  assert.equal(tls.user, "10002:10002");
  assert.deepEqual(dns.cap_add, ["NET_ADMIN"]);
  assert.equal(tls.cap_add, undefined);
  assert.deepEqual(tls.cap_drop, ["ALL"]);
  assert.equal(tls.network_mode, "service:dns");
  assert.equal(dns.ports[0].host_ip, "127.0.0.1");
  assert.equal(tls.ports, undefined);
  assert.equal(tls.read_only, true);
  assert.equal(dns.read_only, true);
  assert.equal(
    dns.volumes.some((mount) => mount.source === config.providerKeyPath),
    false,
  );
  assert.equal(
    tls.volumes.find((mount) => mount.source === config.providerKeyPath)?.read_only,
    true,
  );
  assert.equal(tls.volumes.find((mount) => mount.source === "dns-socket")?.read_only, true);
  for (const service of [dns, tls]) {
    assert.equal(
      service.volumes.find((mount) => mount.source === config.authoritySocketDirectory)?.read_only,
      true,
    );
    assert.equal(service.privileged, undefined);
    assert.equal(service.pid, undefined);
    assert.equal(service.restart, "no");
  }
  const tlsConfig = createTlsConfiguration(config);
  assert.equal(tlsConfig.listener_authority, "localhost:8443");
  assert.equal(tlsConfig.incoming_key_path, "/run/oce-tls/key.pem");
  assert.equal(tlsConfig.development_loopback_http, undefined);
  const literalPath = createCompose(
    { ...config, providerKeyPath: "/operator/private/$LITERAL" },
    "/operator/build-state",
    "05b050e8-5a57-4b73-a089-290ace2c4d18",
  );
  assert.equal(
    literalPath.services.tls.volumes.find((mount) => mount.target === "/run/oce-provider/key")
      .source,
    "/operator/private/$$LITERAL",
  );
});

test("package verifier checks real file bytes, complete closure, and symlink rejection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oce-egress-package-verification-"));
  const content = Buffer.from("bounded verifier input, not a Debian archive or runtime fixture");
  const entry = {
    filename: "verifier-input_1_amd64.deb",
    sha256: createHash("sha256").update(content).digest("hex"),
    bytes: content.length,
    url: "https://deb.debian.org/debian/pool/main/v/verifier-input/verifier-input_1_amd64.deb",
  };
  const lock = {
    schemaVersion: 1,
    architecture: "amd64",
    baseImage: `node:24-trixie-slim@sha256:${"a".repeat(64)}`,
    packages: [entry],
  };
  try {
    await writeFile(join(directory, entry.filename), content);
    await writeFile(join(directory, "SHA256SUMS"), checksumManifest(lock));
    await verifyDirectory(lock, directory);
    await writeFile(join(directory, "unexpected.deb"), content);
    await assert.rejects(verifyDirectory(lock, directory), /complete locked closure/);
    await rm(join(directory, "unexpected.deb"));
    await writeFile(join(directory, entry.filename), Buffer.alloc(content.length));
    await assert.rejects(verifyDirectory(lock, directory), /checksum mismatch/);
    await rm(join(directory, entry.filename));
    await symlink(join(directory, "SHA256SUMS"), join(directory, entry.filename));
    await assert.rejects(verifyDirectory(lock, directory), /file is invalid/);
    assert.throws(
      () => validateLock({ ...lock, packages: [{ ...entry, filename: "../outside.deb" }] }),
      /filename/,
    );
    assert.throws(
      () =>
        validateLock({
          ...lock,
          packages: [{ ...entry, url: "https://untrusted.invalid/file.deb" }],
        }),
      /official Debian/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
