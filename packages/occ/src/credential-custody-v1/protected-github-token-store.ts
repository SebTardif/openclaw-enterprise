import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  statfsSync,
  unlinkSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import { join } from "node:path";
import {
  ProtectedGitHubCustodyErrorV1,
  ProtectedGitHubCryptoV1,
  protectedGitHubDirectoryV1,
  protectedGitHubOwnedV1,
  protectedGitHubSameFileV1,
} from "./protected-github-crypto.ts";

export interface ProtectedGitHubStoreSelectionV1 {
  readonly kind: "persistent-posix";
  readonly directory: string;
  readonly writerMode: "single";
}
const maximumEnvelopeBytes = 98304;
const recordMagic = Buffer.from("OCEGHTS1", "ascii");
const recordHeaderBytes = recordMagic.length + 4 + 32;
const maximumRecordBytes = recordHeaderBytes + maximumEnvelopeBytes;
interface ProtectedFile {
  readonly bytes: Buffer;
  readonly identity: BigIntStats;
}
interface PendingFile {
  readonly path: string;
  readonly recordSHA256: string;
}
function unavailable(): never {
  throw new ProtectedGitHubCustodyErrorV1();
}
const absent = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

function fileStat(path: string): BigIntStats | undefined {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (absent(error)) return undefined;
    throw error;
  }
}

function sameOwnerAndInode(before: BigIntStats, after: BigIntStats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.uid === after.uid &&
    before.gid === after.gid
  );
}

function sameFileAfterLink(before: BigIntStats, after: BigIntStats, links: bigint): boolean {
  // Our link/unlink changes ctime and nlink, but must not change the material.
  return (
    sameOwnerAndInode(before, after) &&
    after.nlink === links &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs
  );
}

function encodeRecord(envelope: Buffer): Buffer {
  const record = Buffer.alloc(recordHeaderBytes + envelope.length);
  recordMagic.copy(record);
  record.writeUInt32BE(envelope.length, recordMagic.length);
  createHash("sha256")
    .update(envelope)
    .digest()
    .copy(record, recordMagic.length + 4);
  envelope.copy(record, recordHeaderBytes);
  return record;
}

const recordSHA256 = (record: Buffer): string => createHash("sha256").update(record).digest("hex");

function decodeRecord(record: Buffer): Buffer {
  // This framing detects incomplete/corrupt storage writes. The crypto owner
  // still authenticates the original envelope and its authoritative context.
  if (
    record.length <= recordHeaderBytes ||
    record.length > maximumRecordBytes ||
    !record.subarray(0, recordMagic.length).equals(recordMagic)
  )
    unavailable();
  const length = record.readUInt32BE(recordMagic.length);
  const envelope = record.subarray(recordHeaderBytes);
  if (
    length < 1 ||
    length > maximumEnvelopeBytes ||
    length !== envelope.length ||
    !createHash("sha256")
      .update(envelope)
      .digest()
      .equals(record.subarray(recordMagic.length + 4, recordHeaderBytes))
  )
    unavailable();
  return Buffer.from(envelope);
}

interface StoreState {
  readonly directory: string;
  readonly identity: BigIntStats;
  closed: boolean;
}

// Keep directory identity and closure out of caller-replaceable instance properties.
const storeStates = new WeakMap<ProtectedGitHubTokenStoreV1, StoreState>();

function storeState(owner: ProtectedGitHubTokenStoreV1): StoreState {
  const state = storeStates.get(owner);
  if (state === undefined) throw new TypeError("Invalid protected GitHub token store receiver.");
  return state;
}

function assertDirectory(state: StoreState): void {
  if (state.closed) unavailable();
  const current = protectedGitHubDirectoryV1(state.directory);
  if (current.dev !== state.identity.dev || current.ino !== state.identity.ino) unavailable();
  // Local Linux filesystems with the selected POSIX fsync/link semantics.
  // Filesystem type alone does not attest a Kubernetes volume's lifecycle.
  const filesystem = statfsSync(state.directory, { bigint: true });
  if (![0xef53n, 0x58465342n].includes(filesystem.type)) unavailable();
}

function envelopeName(originalContext: string): string {
  if (
    typeof originalContext !== "string" ||
    originalContext.length < 1 ||
    originalContext.length > 65536
  )
    unavailable();
  return (
    createHash("sha256")
      .update("occ/github-token-material/v1\0")
      .update(originalContext)
      .digest("hex") + ".enc"
  );
}

function findPending(state: StoreState, name: string): PendingFile | undefined {
  assertDirectory(state);
  const before = lstatSync(state.directory, { bigint: true });
  const prefix = ".pending-" + name;
  let pending: PendingFile | undefined;
  // The full record commitment is atomic in the staging name, including when
  // a write leaves an empty inode. Stream the single-writer directory instead
  // of allocating an inventory-sized filename array.
  const directory = opendirSync(state.directory);
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      if (!entry.name.startsWith(prefix)) continue;
      const suffix = entry.name.slice(prefix.length);
      if (pending !== undefined || !/^-[a-f0-9]{64}$/.test(suffix)) unavailable();
      pending = {
        path: join(state.directory, entry.name),
        recordSHA256: suffix.slice(1),
      };
    }
  } finally {
    directory.closeSync();
  }
  if (!protectedGitHubSameFileV1(before, lstatSync(state.directory, { bigint: true })))
    unavailable();
  assertDirectory(state);
  return pending;
}

function readProtectedFile(
  state: StoreState,
  path: string,
  links: bigint = 1n,
): ProtectedFile | undefined {
  let descriptor: number | undefined;
  let bytes: Buffer | undefined;
  let identity: BigIntStats | undefined;
  let accepted = false;
  try {
    assertDirectory(state);
    const before = fileStat(path);
    if (before === undefined) return undefined;
    if (
      !before.isFile() ||
      !protectedGitHubOwnedV1(before) ||
      (before.mode & 0o777n) !== 0o600n ||
      before.nlink !== links ||
      before.size < 0n ||
      before.size > BigInt(maximumRecordBytes)
    )
      unavailable();
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!protectedGitHubSameFileV1(before, fstatSync(descriptor, { bigint: true }))) unavailable();
    bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count < 1) unavailable();
      offset += count;
    }
    if (
      !protectedGitHubSameFileV1(before, fstatSync(descriptor, { bigint: true })) ||
      !protectedGitHubSameFileV1(before, lstatSync(path, { bigint: true }))
    )
      unavailable();
    fsyncSync(descriptor);
    assertDirectory(state);
    identity = before;
    accepted = true;
  } catch {
    accepted = false;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        accepted = false;
      }
    }
    if (!accepted) bytes?.fill(0);
  }
  if (!accepted || bytes === undefined || identity === undefined) unavailable();
  return { bytes, identity };
}

function syncDirectory(state: StoreState): void {
  const descriptor = openSync(
    state.directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const current = fstatSync(descriptor, { bigint: true });
    if (current.dev !== state.identity.dev || current.ino !== state.identity.ino) unavailable();
    fsyncSync(descriptor);
    assertDirectory(state);
  } finally {
    closeSync(descriptor);
  }
}

function writePending(
  state: StoreState,
  path: string,
  record: Buffer,
  previous?: ProtectedFile,
): BigIntStats {
  let descriptor: number | undefined;
  try {
    assertDirectory(state);
    if (previous !== undefined) {
      if (
        previous.bytes.length >= record.length ||
        !record.subarray(0, previous.bytes.length).equals(previous.bytes)
      )
        unavailable();
      descriptor = openSync(path, constants.O_WRONLY | constants.O_NOFOLLOW);
    } else {
      descriptor = openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    }
    const before = fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      !protectedGitHubOwnedV1(before) ||
      (before.mode & 0o777n) !== 0o600n ||
      before.nlink !== 1n ||
      before.size !== BigInt(previous?.bytes.length ?? 0) ||
      (previous !== undefined && !protectedGitHubSameFileV1(previous.identity, before)) ||
      !protectedGitHubSameFileV1(before, lstatSync(path, { bigint: true }))
    )
      unavailable();
    // Persist the full-record commitment in the staging name before extending
    // it. The original custody owner must still reconcile absent/unknown
    // outcomes using the same envelope.
    fsyncSync(descriptor);
    syncDirectory(state);
    let offset = previous?.bytes.length ?? 0;
    while (offset < record.length) {
      const count = writeSync(descriptor, record, offset, record.length - offset, offset);
      if (count < 1) unavailable();
      offset += count;
    }
    fsyncSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    if (
      !sameOwnerAndInode(before, after) ||
      after.nlink !== 1n ||
      after.size !== BigInt(record.length) ||
      !protectedGitHubSameFileV1(after, lstatSync(path, { bigint: true }))
    )
      unavailable();
    closeSync(descriptor);
    descriptor = undefined;
    syncDirectory(state);
    return after;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        state.closed = true;
      }
    }
    // Preserve failed partial/publication files for custody reconciliation.
    // No token material is deleted on request cancellation or unknown COMMIT.
  }
}

function publish(
  state: StoreState,
  pending: string,
  destination: string,
  identity: BigIntStats,
  linked: boolean,
): void {
  syncDirectory(state);
  if (!protectedGitHubSameFileV1(identity, lstatSync(pending, { bigint: true }))) unavailable();
  if (linked) {
    if (!protectedGitHubSameFileV1(identity, lstatSync(destination, { bigint: true })))
      unavailable();
  } else {
    // link is an atomic, no-overwrite publication, unlike rename on POSIX.
    linkSync(pending, destination);
  }
  const published = lstatSync(pending, { bigint: true });
  if (
    !sameFileAfterLink(identity, published, 2n) ||
    !protectedGitHubSameFileV1(published, lstatSync(destination, { bigint: true }))
  )
    unavailable();
  // Persist the committed link while the durable staging name still exists.
  syncDirectory(state);
  if (
    !protectedGitHubSameFileV1(published, lstatSync(pending, { bigint: true })) ||
    !protectedGitHubSameFileV1(published, lstatSync(destination, { bigint: true }))
  )
    unavailable();
  unlinkSync(pending);
  const committed = lstatSync(destination, { bigint: true });
  if (!sameFileAfterLink(published, committed, 1n)) unavailable();
  syncDirectory(state);
  if (!protectedGitHubSameFileV1(committed, lstatSync(destination, { bigint: true })))
    unavailable();
}

function recover(state: StoreState, name: string, expected?: Buffer): Buffer | undefined {
  assertDirectory(state);
  const destination = join(state.directory, name);
  const pending = findPending(state, name);
  let file: ProtectedFile | undefined;
  let envelope: Buffer | undefined;
  try {
    if (pending !== undefined) {
      if (expected !== undefined && recordSHA256(expected) !== pending.recordSHA256) unavailable();
      const pendingStat = fileStat(pending.path);
      if (pendingStat === undefined) unavailable();
      const destinationStat = fileStat(destination);
      if (
        destinationStat !== undefined &&
        (pendingStat.dev !== destinationStat.dev || pendingStat.ino !== destinationStat.ino)
      )
        unavailable();
      file = readProtectedFile(state, pending.path, destinationStat === undefined ? 1n : 2n);
      if (file === undefined || !protectedGitHubSameFileV1(pendingStat, file.identity))
        unavailable();
      if (
        destinationStat === undefined &&
        expected !== undefined &&
        file.bytes.length < expected.length &&
        expected.subarray(0, file.bytes.length).equals(file.bytes)
      ) {
        const completed = writePending(state, pending.path, expected, file);
        file.bytes.fill(0);
        file = readProtectedFile(state, pending.path);
        if (file === undefined || !protectedGitHubSameFileV1(completed, file.identity))
          unavailable();
      }
      envelope = decodeRecord(file.bytes);
      if (
        recordSHA256(file.bytes) !== pending.recordSHA256 ||
        (expected !== undefined && !file.bytes.equals(expected))
      )
        unavailable();
      publish(state, pending.path, destination, file.identity, destinationStat !== undefined);
    } else {
      file = readProtectedFile(state, destination);
      if (file === undefined) return undefined;
      envelope = decodeRecord(file.bytes);
      syncDirectory(state);
    }
    return envelope;
  } catch (error) {
    envelope?.fill(0);
    throw error;
  } finally {
    file?.bytes.fill(0);
  }
}

/** Encrypted material files only. All operation/claim/release state remains in
 * the original inventory. The selected deployment must retain this dedicated
 * directory across restarts and enforce one custody writer. */
export class ProtectedGitHubTokenStoreV1 {
  constructor(selection: ProtectedGitHubStoreSelectionV1) {
    try {
      if (
        process.platform !== "linux" ||
        selection.kind !== "persistent-posix" ||
        selection.writerMode !== "single" ||
        Object.keys(selection).length !== 3 ||
        typeof selection.directory !== "string" ||
        /^\/(tmp|var\/tmp|dev|proc|sys|run)(\/|$)/.test(selection.directory)
      )
        unavailable();
      const directory = selection.directory;
      const state: StoreState = {
        directory,
        identity: protectedGitHubDirectoryV1(directory),
        closed: false,
      };
      storeStates.set(this, state);
      assertDirectory(state);
    } catch {
      unavailable();
    }
  }

  read(originalContext: string): Buffer | undefined {
    try {
      const state = storeState(this);
      return recover(state, envelopeName(originalContext));
    } catch {
      unavailable();
    }
  }

  /** Returns only after file and directory fsync. A failure can follow durable
   * publication; retry/readback must keep the same original context/envelope. */
  retain(originalContext: string, envelope: Uint8Array): void {
    const copiedEnvelope = Buffer.from(envelope);
    let record: Buffer | undefined;
    let previousEnvelope: Buffer | undefined;
    try {
      if (copiedEnvelope.length < 1 || copiedEnvelope.length > maximumEnvelopeBytes) unavailable();
      const state = storeState(this);
      const name = envelopeName(originalContext);
      record = encodeRecord(copiedEnvelope);
      previousEnvelope = recover(state, name, record);
      if (previousEnvelope === undefined) {
        const pendingPath = join(state.directory, ".pending-" + name + "-" + recordSHA256(record));
        writePending(state, pendingPath, record);
        previousEnvelope = recover(state, name, record);
      }
      if (previousEnvelope === undefined || !previousEnvelope.equals(copiedEnvelope)) unavailable();
    } catch {
      unavailable();
    } finally {
      copiedEnvelope.fill(0);
      record?.fill(0);
      previousEnvelope?.fill(0);
    }
  }

  assertSeparateKeySource(crypto: ProtectedGitHubCryptoV1): void {
    const state = storeState(this);
    assertDirectory(state);
    crypto.assertSeparateStorage(state.directory);
  }

  close(): void {
    storeState(this).closed = true;
  }
}
