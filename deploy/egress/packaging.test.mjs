import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checksumManifest, validateLock, verifyDirectory } from "./download-packages.mjs";
import { createCompose, createTlsConfiguration, validateConfiguration } from "./local.mjs";

const config = {
  schemaVersion: 1,
  project: "oce-egress-unit",
  image: `sha256:${"a".repeat(64)}`,
  authoritySocketDirectory: "/operator/authority",
  providerKeyPath: "/operator/private/provider-key",
  providerBindingRef: "openai-test",
  credentialBinding: {
    provider_binding_ref: "openai-test",
    service_account_id: "config-parser-service-account",
    credential_profile_ref: "config-parser-api-key-profile",
    provider_profile_ref: "config-parser-openai-profile",
    audience_ref: "config-parser-audience",
    transport_profile_ref: "config-parser-responses-http-profile",
  },
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
  assert.deepEqual(tlsConfig.credential_binding, config.credentialBinding);
  assert.notEqual(tlsConfig.credential_binding, config.credentialBinding);
  assert.equal(tlsConfig.max_concurrent, 8);
  assert.equal(dns.pids_limit, 128);
  assert.equal(tls.pids_limit, 128);
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

test("credential descriptors require every exact provisioned reference before configuration generation", () => {
  // This validates operator configuration, not canonical existence or authority.
  // The real authority must independently match this whole immutable descriptor.
  const withoutDescriptor = { ...config };
  delete withoutDescriptor.credentialBinding;
  assert.throws(() => createTlsConfiguration(withoutDescriptor), /credentialBinding/);
  for (const field of Object.keys(config.credentialBinding)) {
    const incomplete = { ...config.credentialBinding };
    delete incomplete[field];
    assert.throws(
      () => createTlsConfiguration({ ...config, credentialBinding: incomplete }),
      /six provisioned/,
    );
    for (const invalid of ["", " ", "non ASCII é", "line\nbreak", "a".repeat(129), null]) {
      assert.throws(
        () =>
          createTlsConfiguration({
            ...config,
            credentialBinding: { ...config.credentialBinding, [field]: invalid },
          }),
        /provisioned reference/,
      );
    }
  }
  assert.throws(
    () =>
      createTlsConfiguration({
        ...config,
        credentialBinding: { ...config.credentialBinding, unexpected: "value" },
      }),
    /six provisioned/,
  );
  assert.throws(
    () =>
      createTlsConfiguration({
        ...config,
        credentialBinding: {
          ...config.credentialBinding,
          provider_binding_ref: "different-provider",
        },
      }),
    /must equal providerBindingRef/,
  );
});

test("actual TLS executable accepts generated configuration before denying unavailable authority", async (t) => {
  const selectedBinary = process.env.OCC_TEST_EGRESS_CONFIG_BINARY;
  const binary =
    selectedBinary ?? fileURLToPath(new URL("../../.build/mvp/native/oce-egress", import.meta.url));
  assert.ok(
    isAbsolute(binary),
    "OCC_TEST_EGRESS_CONFIG_BINARY must select an absolute executable path",
  );
  const binaryStat = await lstat(binary).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (!binaryStat && !selectedBinary) {
    t.skip(
      "actual oce-egress binary is absent; JS configuration checks do not prove Rust configuration acceptance",
    );
    return;
  }
  assert.ok(binaryStat?.isFile(), "the explicitly selected actual TLS executable must exist");
  const directory = await mkdtemp(join(tmpdir(), "oce-egress-native-config-"));
  try {
    const certificate = join(directory, "localhost.pem");
    const key = join(directory, "localhost-key.pem");
    // Generate only an ephemeral test TLS identity. No provider credential or
    // authority fixture is involved in this real Service::load/ready check.
    const openssl = spawnSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        certificate,
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost",
      ],
      { encoding: "utf8", timeout: 15_000 },
    );
    assert.equal(openssl.error, undefined, "the native configuration test requires openssl");
    assert.equal(openssl.status, 0, "ephemeral TLS test certificate generation failed");
    const generated = {
      ...createTlsConfiguration(config),
      // Translate container file paths to private test paths without changing
      // the generated schema, fixed recipient profile, or credential descriptor.
      root_ca_path: certificate,
      incoming_certificate_path: certificate,
      incoming_key_path: key,
      authority_socket: join(directory, "absent-authority", "authority.sock"),
      dns_socket: join(directory, "absent-dns", "admission.sock"),
      provider_key_path: join(directory, "absent-provider-key"),
    };
    const configPath = join(directory, "egress.json");
    const invoke = async (value) => {
      await writeFile(configPath, JSON.stringify(value), { mode: 0o600 });
      const result = spawnSync(binary, ["--config", configPath, "--ready"], {
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(result.error, undefined, "actual TLS configuration check could not execute");
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      return result.stderr.trim();
    };
    // Dependency is reachable only after parsing the actual Rust Config and
    // loading valid TLS material. Its absent parent prevents any UDS connection.
    assert.equal(await invoke(generated), "oce-egress unavailable: Dependency");
    const missingDescriptor = { ...generated };
    delete missingDescriptor.credential_binding;
    assert.equal(await invoke(missingDescriptor), "oce-egress unavailable: Configuration");
    for (const field of Object.keys(generated.credential_binding)) {
      const incomplete = { ...generated.credential_binding };
      delete incomplete[field];
      assert.equal(
        await invoke({ ...generated, credential_binding: incomplete }),
        "oce-egress unavailable: Configuration",
      );
    }
    assert.equal(
      await invoke({
        ...generated,
        credential_binding: {
          ...generated.credential_binding,
          provider_binding_ref: "different-provider",
        },
      }),
      "oce-egress unavailable: Configuration",
    );
    assert.equal(
      await invoke({
        ...generated,
        credential_binding: { ...generated.credential_binding, unexpected: "value" },
      }),
      "oce-egress unavailable: Configuration",
    );
    t.diagnostic(
      `actual oce-egress sha256=${createHash("sha256")
        .update(await readFile(binary))
        .digest(
          "hex",
        )}; Config/TLS loading accepted, unavailable authority refused; no provider dispatch or runtime qualification`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
