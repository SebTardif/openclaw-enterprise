import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
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
function unavailable(): never {
  throw new ProtectedGitHubCustodyErrorV1();
}
const absent = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
const exists = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "EEXIST";

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

function readEnvelope(
  state: StoreState,
  path: string,
  expectedLinks: bigint = 1n,
): Buffer | undefined {
  let descriptor: number | undefined;
  let envelopeBytes: Buffer | undefined;
  let accepted = false;
  try {
    assertDirectory(state);
    let fileBefore: BigIntStats;
    try {
      fileBefore = lstatSync(path, { bigint: true });
    } catch (error) {
      if (absent(error)) return undefined;
      throw error;
    }
    if (
      !fileBefore.isFile() ||
      !protectedGitHubOwnedV1(fileBefore) ||
      (fileBefore.mode & 0o777n) !== 0o600n ||
      fileBefore.nlink !== expectedLinks ||
      fileBefore.size < 1n ||
      fileBefore.size > BigInt(maximumEnvelopeBytes)
    )
      unavailable();
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!protectedGitHubSameFileV1(fileBefore, fstatSync(descriptor, { bigint: true })))
      unavailable();
    envelopeBytes = Buffer.alloc(Number(fileBefore.size));
    let offset = 0;
    while (offset < envelopeBytes.length) {
      const bytesRead = readSync(
        descriptor,
        envelopeBytes,
        offset,
        envelopeBytes.length - offset,
        offset,
      );
      if (bytesRead < 1) unavailable();
      offset += bytesRead;
    }
    if (
      !protectedGitHubSameFileV1(fileBefore, fstatSync(descriptor, { bigint: true })) ||
      !protectedGitHubSameFileV1(fileBefore, lstatSync(path, { bigint: true }))
    )
      unavailable();
    fsyncSync(descriptor);
    assertDirectory(state);
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
    if (!accepted) envelopeBytes?.fill(0);
  }
  if (!accepted || envelopeBytes === undefined) unavailable();
  return envelopeBytes;
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
      assertDirectory(state);
      const name = envelopeName(originalContext);
      const destinationPath = join(state.directory, name);
      const pendingPath = join(state.directory, ".pending-" + name);
      let pendingStat: BigIntStats | undefined;
      try {
        pendingStat = lstatSync(pendingPath, { bigint: true });
      } catch (error) {
        if (!absent(error)) throw error;
      }
      if (pendingStat !== undefined) {
        let destinationStat: BigIntStats | undefined;
        try {
          destinationStat = lstatSync(destinationPath, { bigint: true });
        } catch (error) {
          if (!absent(error)) throw error;
        }
        if (
          destinationStat !== undefined &&
          (pendingStat.dev !== destinationStat.dev || pendingStat.ino !== destinationStat.ino)
        )
          unavailable();
        const envelopeBytes = readEnvelope(
          state,
          pendingPath,
          destinationStat === undefined ? 1n : 2n,
        );
        if (envelopeBytes === undefined) unavailable();
        try {
          if (destinationStat === undefined) linkSync(pendingPath, destinationPath);
          unlinkSync(pendingPath);
          syncDirectory(state);
          return envelopeBytes;
        } catch {
          envelopeBytes.fill(0);
          unavailable();
        }
      }
      const envelopeBytes = readEnvelope(state, destinationPath);
      if (envelopeBytes !== undefined) syncDirectory(state);
      return envelopeBytes;
    } catch {
      unavailable();
    }
  }

  /** Returns only after file and directory fsync. A failure can follow durable
   * publication; retry/readback must keep the same original context/envelope. */
  retain(originalContext: string, envelope: Uint8Array): void {
    let descriptor: number | undefined;
    let pendingPath: string | undefined;
    const copiedEnvelope = Buffer.from(envelope);
    try {
      if (copiedEnvelope.length < 1 || copiedEnvelope.length > maximumEnvelopeBytes) unavailable();
      const state = storeState(this);
      assertDirectory(state);
      const name = envelopeName(originalContext);
      const destinationPath = join(state.directory, name);
      const previousEnvelope = this.read(originalContext);
      if (previousEnvelope !== undefined) {
        try {
          if (!previousEnvelope.equals(copiedEnvelope)) unavailable();
        } finally {
          previousEnvelope.fill(0);
        }
        return;
      }
      pendingPath = join(state.directory, ".pending-" + name);
      descriptor = openSync(
        pendingPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      let offset = 0;
      while (offset < copiedEnvelope.length) {
        const bytesWritten = writeSync(
          descriptor,
          copiedEnvelope,
          offset,
          copiedEnvelope.length - offset,
          offset,
        );
        if (bytesWritten < 1) unavailable();
        offset += bytesWritten;
      }
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      assertDirectory(state);
      // link is an atomic, no-overwrite publication, unlike rename on POSIX.
      try {
        linkSync(pendingPath, destinationPath);
      } catch (error) {
        if (!exists(error)) throw error;
        const competingEnvelope = readEnvelope(state, destinationPath);
        try {
          if (competingEnvelope === undefined || !competingEnvelope.equals(copiedEnvelope))
            unavailable();
        } finally {
          competingEnvelope?.fill(0);
        }
      }
      unlinkSync(pendingPath);
      pendingPath = undefined;
      syncDirectory(state);
    } catch {
      unavailable();
    } finally {
      copiedEnvelope.fill(0);
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          storeState(this).closed = true;
        }
      }
      // Preserve failed partial/publication files for custody reconciliation.
      // No token material is deleted on request cancellation or unknown COMMIT.
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
