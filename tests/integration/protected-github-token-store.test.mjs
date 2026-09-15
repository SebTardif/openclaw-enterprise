import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statfsSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ProtectedGitHubCryptoV1,
  ProtectedGitHubCustodyErrorV1,
} from "../../packages/occ/src/credential-custody-v1/protected-github-crypto.ts";
import { ProtectedGitHubTokenStoreV1 } from "../../packages/occ/src/credential-custody-v1/protected-github-token-store.ts";
import { interruptProtectedGitHubRetain } from "../fixtures/protected-github-token-store/interrupt-retain.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const linuxOnly = {
  skip: process.platform !== "linux" && "persistent token custody requires real Linux ext4/XFS",
};
const purpose = "github-installation-token-v1";
const context = ["installation-1", "github.com", "app-1", "lease-1", "attempt-1", "token-1"];
const originalContext = JSON.stringify(context);
const rejectsCustody = (call) => assert.throws(call, ProtectedGitHubCustodyErrorV1);
const openStore = (directory) =>
  new ProtectedGitHubTokenStoreV1({ kind: "persistent-posix", directory, writerMode: "single" });

function fixture(t) {
  const parent = realpathSync(repositoryRoot);
  assert.ok(
    [0xef53n, 0x58465342n].includes(statfsSync(parent, { bigint: true }).type),
    "run this integration from a checkout on real Linux ext4 or XFS",
  );
  const root = realpathSync(mkdtempSync(join(parent, ".oce-token-store-test-")));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = (name) => {
    const path = join(root, name);
    mkdirSync(path, { mode: 0o700 });
    return path;
  };
  const keyDirectory = directory("key");
  const inputDirectory = directory("input");
  const keyFile = join(keyDirectory, "master-key");
  const key = randomBytes(32);
  writeFileSync(keyFile, key, { mode: 0o600, flag: "wx" });
  const crypto = new ProtectedGitHubCryptoV1({
    keyFile,
    keySHA256: createHash("sha256").update(key).digest("hex"),
  });
  key.fill(0);
  const plain = Buffer.from("synthetic-token-no-live-credentials");
  const envelope = crypto.seal(purpose, context, plain);
  const conflictingPlain = Buffer.from(plain);
  conflictingPlain[0] ^= 1;
  let conflicting;
  try {
    assert.equal(conflictingPlain.length, plain.length);
    assert.notDeepEqual(conflictingPlain, plain);
    conflicting = crypto.seal(purpose, context, conflictingPlain);
  } finally {
    conflictingPlain.fill(0);
  }
  assert.equal(conflicting.length, envelope.length);
  assert.notDeepEqual(conflicting, envelope);
  const envelopeFile = join(inputDirectory, "envelope");
  const conflictingFile = join(inputDirectory, "conflicting-envelope");
  writeFileSync(envelopeFile, envelope, { mode: 0o600, flag: "wx" });
  writeFileSync(conflictingFile, conflicting, { mode: 0o600, flag: "wx" });
  t.after(() => {
    crypto.close();
    plain.fill(0);
    envelope.fill(0);
    conflicting.fill(0);
  });

  // Obtain the persisted representation from the real owner. Recovery fixtures
  // reuse these genuine bytes and never duplicate the private framing codec.
  const seedDirectory = directory("seed");
  const seed = openStore(seedDirectory);
  try {
    seed.assertSeparateKeySource(crypto);
    assert.equal(seed.read(originalContext), undefined);
    seed.retain(originalContext, envelope);
  } finally {
    seed.close();
  }
  const names = readdirSync(seedDirectory);
  assert.equal(names.length, 1);
  const [name] = names;
  assert.match(name, /^[a-f0-9]{64}\.enc$/);
  const record = readFileSync(join(seedDirectory, name));
  const conflictingDirectory = directory("conflicting-seed");
  const conflictingSeed = openStore(conflictingDirectory);
  try {
    conflictingSeed.retain(originalContext, conflicting);
  } finally {
    conflictingSeed.close();
  }
  assert.deepEqual(readdirSync(conflictingDirectory), [name]);
  const conflictingRecord = readFileSync(join(conflictingDirectory, name));
  t.after(() => {
    record.fill(0);
    conflictingRecord.fill(0);
  });
  return {
    directory,
    crypto,
    plain,
    envelope,
    conflicting,
    envelopeFile,
    conflictingFile,
    record,
    conflictingRecord,
    name,
    destination: (path) => join(path, name),
  };
}

function interruptedRetain(f, directory, limit, envelopeFile = f.envelopeFile, record = f.record) {
  const interrupted = interruptProtectedGitHubRetain({
    directory,
    envelopeFile,
    originalContext,
    limit,
    record,
  });
  assert.equal(existsSync(f.destination(directory)), false);
  return interrupted;
}

function snapshotFiles(directory) {
  return readdirSync(directory)
    .sort()
    .map((name) => {
      const path = join(directory, name);
      return { name, stat: lstatSync(path, { bigint: true }), bytes: readFileSync(path) };
    });
}

function assertFilesUnchanged(directory, snapshot) {
  assert.deepEqual(
    readdirSync(directory).sort(),
    snapshot.map(({ name }) => name),
  );
  for (const { name, stat, bytes } of snapshot) {
    const path = join(directory, name);
    const current = lstatSync(path, { bigint: true });
    for (const field of ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"])
      assert.equal(current[field], stat[field], `${name}: ${field} changed`);
    assert.deepEqual(readFileSync(path), bytes);
  }
}

const discardSnapshot = (snapshot) => {
  for (const { bytes } of snapshot) bytes.fill(0);
};

function verifyRecovered(f, directory) {
  const restarted = openStore(directory);
  let recovered;
  let plain;
  try {
    restarted.assertSeparateKeySource(f.crypto);
    recovered = restarted.read(originalContext);
    assert.deepEqual(recovered, f.envelope);
    plain = f.crypto.open(purpose, context, recovered);
    assert.deepEqual(plain, f.plain);
    restarted.retain(originalContext, f.envelope);
    rejectsCustody(() => restarted.retain(originalContext, f.conflicting));
    assert.deepEqual(readdirSync(directory), [f.name]);
    const persisted = lstatSync(f.destination(directory));
    assert.equal(persisted.mode & 0o777, 0o600);
    assert.equal(persisted.nlink, 1);
  } finally {
    recovered?.fill(0);
    plain?.fill(0);
    restarted.close();
  }
}

test("persistent GitHub token storage reconciles real interrupted writes", linuxOnly, (t) => {
  const f = fixture(t);

  // These limits cover an empty staging file, an incomplete header, and a
  // complete header with its last payload byte missing, without encoding it here.
  // Start with a positive short write so the pre-fix regression fails on its
  // original defect: restart publishes the incomplete record.
  for (const limit of [1, 0, f.record.length - 1]) {
    const directory = f.directory(`short-write-${limit}`);
    interruptedRetain(f, directory, limit);
    const interrupted = snapshotFiles(directory);

    // A fresh reader must not turn a failed retain into authoritative material.
    // It also must preserve the pending evidence for the original owner's retry.
    const reader = openStore(directory);
    try {
      rejectsCustody(() => reader.read(originalContext));
    } finally {
      reader.close();
    }
    assertFilesUnchanged(directory, interrupted);

    const retry = openStore(directory);
    try {
      // The durable intent must identify the exact original envelope even if
      // the data write left no bytes or only a common framing prefix.
      rejectsCustody(() => retry.retain(originalContext, f.conflicting));
      assertFilesUnchanged(directory, interrupted);
      retry.retain(originalContext, f.envelope);
    } finally {
      discardSnapshot(interrupted);
      retry.close();
    }
    verifyRecovered(f, directory);
  }
});

test(
  "persistent GitHub token storage recovers completed publication boundaries",
  linuxOnly,
  (t) => {
    const f = fixture(t);
    for (const linked of [false, true]) {
      const directory = f.directory(linked ? "linked-pending" : "complete-pending");
      const { pending } = interruptedRetain(f, directory, 1);
      const inode = lstatSync(pending, { bigint: true }).ino;
      const descriptor = openSync(pending, "r+");
      try {
        writeFileSync(descriptor, f.record);
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      assert.equal(lstatSync(pending, { bigint: true }).ino, inode);
      // Reconstruct the two restart-visible boundaries using the actual staged
      // inode and owner-produced bytes: complete-file fsync, then optional link.
      if (linked) linkSync(pending, f.destination(directory));
      verifyRecovered(f, directory);
    }
  },
);

test(
  "persistent GitHub token storage refuses unsafe or conflicting recovery files",
  linuxOnly,
  (t) => {
    const f = fixture(t);
    const { pendingName } = interruptedRetain(f, f.directory("original-intent"), 0);
    const { pendingName: conflictingName } = interruptedRetain(
      f,
      f.directory("conflicting-intent"),
      0,
      f.conflictingFile,
      f.conflictingRecord,
    );
    assert.notEqual(pendingName, conflictingName);
    const cases = [
      "mode",
      "symlink",
      "extra-link",
      "different-inodes",
      "corrupt-record",
      "legacy-name",
      "malformed-name",
      "multiple-intents",
      "wrong-commitment",
    ];
    for (const scenario of cases) {
      const directory = f.directory(scenario);
      const destination = f.destination(directory);
      let name = pendingName;
      if (scenario === "legacy-name") name = ".pending-" + f.name;
      if (scenario === "malformed-name") name += "-invalid";
      if (scenario === "wrong-commitment") name = conflictingName;
      const pending = join(directory, name);
      if (scenario === "symlink") {
        const target = join(directory, "target");
        writeFileSync(target, f.record, { mode: 0o600, flag: "wx" });
        symlinkSync(target, pending);
      } else {
        const bytes = Buffer.from(f.record);
        if (scenario === "corrupt-record") bytes[bytes.length - 1] ^= 1;
        writeFileSync(pending, bytes, { mode: 0o600, flag: "wx" });
        bytes.fill(0);
        if (scenario === "mode") chmodSync(pending, 0o644);
        if (scenario === "extra-link") linkSync(pending, join(directory, "extra"));
        // Equal contents are not proof that two independently owned inodes form
        // a valid interrupted link publication.
        if (scenario === "different-inodes")
          writeFileSync(destination, f.record, { mode: 0o600, flag: "wx" });
        // The store must reject ambiguous intents even when both filenames and
        // both complete records were independently produced by the real owner.
        if (scenario === "multiple-intents")
          writeFileSync(join(directory, conflictingName), f.conflictingRecord, {
            mode: 0o600,
            flag: "wx",
          });
      }
      const before = snapshotFiles(directory);
      const reader = openStore(directory);
      try {
        rejectsCustody(() => reader.read(originalContext));
        rejectsCustody(() => reader.retain(originalContext, f.envelope));
        assertFilesUnchanged(directory, before);
      } finally {
        discardSnapshot(before);
        reader.close();
      }
    }
  },
);
