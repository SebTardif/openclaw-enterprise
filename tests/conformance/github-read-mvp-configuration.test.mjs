import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import {
  parseRuntimeAuthoritySource,
  parseRuntimeServiceNativeProfile,
  RUNTIME_SERVICE_NATIVE_LIMITS,
  runtimeServiceTrustDigest,
} from "../../packages/occ/src/runtime-authority/service-trust-schema.ts";
import { verifyNativeExecutable } from "../../apps/controller/src/admission/native-child-lifetime.ts";
import { validateNativeRuntimeServiceProfile } from "../../apps/controller/src/admission/runtime-authority-profile.ts";
import { loadStartupConfigurationSnapshot } from "../../apps/controller/src/composition/startup-config/read.ts";
import { runtimeAuthoritySourcesConfiguration } from "../../apps/controller/src/composition/startup-config/schema.ts";
import { createWorkloadProfileOwnedInputsV2 } from "../../apps/controller/src/composition/workload-profile-owned-inputs.ts";

// This suite qualifies executable bytes and the existing configuration boundary.
// It does not admit a service, enroll Work, qualify an image, or establish a
// supported deployment. The original immutable-definition owner remains required.
const binaryPath = process.env.OCC_GITHUB_GIT_READ_TEST_BINARY;
const native = {
  timeout: 15000,
  skip: binaryPath ? false : "Select the maintained binary with OCC_GITHUB_GIT_READ_TEST_BINARY.",
};
const signal = () => AbortSignal.timeout(5000);
const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), "oce-read-mvp-artifact-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function artifactProfile(path) {
  const source = parseRuntimeAuthoritySource({
    schemaVersion: 1,
    sourceRef: "source/github-read-mvp-artifact-check",
    workloadApiSocketPath: "/run/oce-read-mvp/workload-api.sock",
    ownSPIFFEId: "spiffe://read-mvp.test/controller",
    recipientRef: "recipient/read-mvp-controller",
    recipientSPIFFEId: "spiffe://read-mvp.test/controller",
    trustDomain: "read-mvp.test",
    trustRootsRef: "roots/read-mvp-controlled",
    trustBundleSha256: digest(Buffer.from("nonsecret controlled trust-root descriptor")),
    verifierProfileRef: "verifier/read-mvp-controlled",
    nativeExecutableSha256: digest(await readFile(path)),
    transportProfileRef: "owned-child-stdio-github-git-read-v3",
    limits: RUNTIME_SERVICE_NATIVE_LIMITS,
  });
  return {
    source,
    profile: parseRuntimeServiceNativeProfile({
      ...source,
      sourceConfigurationDigest: runtimeServiceTrustDigest(source),
      peerSPIFFEId: "spiffe://read-mvp.test/injector",
      operationPolicy: "github-git-read-rpc-v3",
    }),
    deployment: {
      listenPath: "/run/oce-read-mvp/github-git-read.sock",
      peerUid: process.getuid(),
      trustedAncestorUids: [...new Set([0, process.getuid()])],
    },
  };
}

test(
  "the startup reader preserves the exact executable pin consumed by the maintained native validator",
  native,
  async (t) => {
    const { source, profile, deployment } = await artifactProfile(binaryPath);
    const path = join(await directory(t), "installation.yaml");
    // JSON is valid YAML and goes through the production YAML reader. These are
    // technical source inputs only; no identity source or certificate is created.
    await writeFile(path, JSON.stringify({ runtimeAuthoritySources: [source] }), { mode: 0o600 });
    const startup = await loadStartupConfigurationSnapshot({
      mode: "production",
      environment: { OCC_CONFIG_PATH: path },
    });
    assert.deepEqual(
      runtimeAuthoritySourcesConfiguration(startup.configuration.runtimeAuthoritySources),
      [source],
    );
    await verifyNativeExecutable(binaryPath, source.nativeExecutableSha256, signal());
    // Success reaches the real Go validate-profile command after the real local
    // file digest check. That command does not start a listener or read an image.
    await validateNativeRuntimeServiceProfile(binaryPath, profile, signal(), {
      binaryPath,
      deployment,
    });
  },
);

test(
  "a same-size executable with one changed byte cannot reuse the selected artifact pin",
  native,
  async (t) => {
    const { source, profile, deployment } = await artifactProfile(binaryPath);
    const altered = join(await directory(t), "oce-github-mediation");
    await copyFile(binaryPath, altered);
    await chmod(altered, 0o700);
    const file = await open(altered, "r+");
    try {
      // Change an ELF-header byte before any execution is attempted. Length,
      // executable mode and valid parent location still satisfy the file checks.
      const byte = Buffer.alloc(1);
      await file.read(byte, 0, 1, 0);
      byte[0] ^= 1;
      await file.write(byte, 0, 1, 0);
    } finally {
      await file.close();
    }
    await chmod(altered, 0o500);
    assert.equal((await stat(altered)).size, (await stat(binaryPath)).size);
    assert.notEqual(digest(await readFile(altered)), source.nativeExecutableSha256);
    await assert.rejects(verifyNativeExecutable(altered, source.nativeExecutableSha256, signal()));
    await assert.rejects(
      validateNativeRuntimeServiceProfile(binaryPath, profile, signal(), {
        binaryPath: altered,
        deployment,
      }),
    );
    // The original artifact still succeeds, so the denial is not an unavailable
    // binary, missing toolchain, or absent profile validator.
    await validateNativeRuntimeServiceProfile(binaryPath, profile, signal(), {
      binaryPath,
      deployment,
    });
  },
);

test(
  "native executable selection refuses symlink, noncanonical and writable paths",
  native,
  async (t) => {
    const { source } = await artifactProfile(binaryPath);
    const root = await directory(t);
    const link = join(root, "native-link");
    await symlink(resolve(binaryPath), link);
    await assert.rejects(verifyNativeExecutable(link, source.nativeExecutableSha256, signal()));
    const regular = join(root, "native-regular");
    await copyFile(binaryPath, regular);
    await chmod(regular, 0o500);
    // Both spellings resolve to this same regular file. The canonical success
    // isolates the following refusal to path spelling while retaining exact bytes.
    await verifyNativeExecutable(regular, source.nativeExecutableSha256, signal());
    await assert.rejects(
      verifyNativeExecutable(
        `${root}/../${basename(root)}/native-regular`,
        source.nativeExecutableSha256,
        signal(),
      ),
    );
    const writable = join(root, "native-writable");
    await copyFile(binaryPath, writable);
    await chmod(writable, 0o720);
    await assert.rejects(verifyNativeExecutable(writable, source.nativeExecutableSha256, signal()));
  },
);

test("artifact descriptors cannot replace the original immutable-definition acquisition owner", () => {
  // These inert descriptors exercise the real composition input boundary. No
  // accepting supplier, fake State unit, lease or positive capability is made.
  const descriptors = {
    root: "/var/lib/openclaw-enterprise/installed-artifacts/oci",
    nativeExecutableSha256: digest(Buffer.from("not an installed owner")),
    gateway: `example.invalid/gateway@${digest(Buffer.from("gateway"))}`,
    harness: `example.invalid/harness@${digest(Buffer.from("harness"))}`,
  };
  for (const installedRenderer of [undefined, descriptors]) {
    assert.throws(
      () => createWorkloadProfileOwnedInputsV2({ installedRenderer }),
      (error) => {
        assert.equal(error.code, "unavailable");
        assert.deepEqual(error.prerequisites, ["owned-inputs.renderer.immutable-definition-owner"]);
        return true;
      },
    );
  }
});
