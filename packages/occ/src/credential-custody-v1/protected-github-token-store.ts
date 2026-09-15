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

/** Encrypted material files only. All operation/claim/release state remains in
 * the original inventory. The selected deployment must retain this dedicated
 * directory across restarts and enforce one custody writer. */
export class ProtectedGitHubTokenStoreV1 {
  readonly #directory: string;
  readonly #identity: BigIntStats;
  #closed = false;

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
      this.#directory = selection.directory;
      this.#identity = protectedGitHubDirectoryV1(this.#directory);
      this.#assertDirectory();
    } catch {
      unavailable();
    }
  }

  #assertDirectory(): void {
    if (this.#closed) unavailable();
    const current = protectedGitHubDirectoryV1(this.#directory);
    if (current.dev !== this.#identity.dev || current.ino !== this.#identity.ino) unavailable();
    // Local Linux filesystems with the selected POSIX fsync/link semantics.
    // Filesystem type alone does not attest a Kubernetes volume's lifecycle.
    const fs = statfsSync(this.#directory, { bigint: true });
    if (![0xef53n, 0x58465342n].includes(fs.type)) unavailable();
  }

  #name(originalContext: string): string {
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

  #read(path: string, links: bigint = 1n): Buffer | undefined {
    let descriptor: number | undefined;
    let bytes: Buffer | undefined;
    let accepted = false;
    try {
      this.#assertDirectory();
      let before: BigIntStats;
      try {
        before = lstatSync(path, { bigint: true });
      } catch (error) {
        if (absent(error)) return undefined;
        throw error;
      }
      if (
        !before.isFile() ||
        !protectedGitHubOwnedV1(before) ||
        (before.mode & 0o777n) !== 0o600n ||
        before.nlink !== links ||
        before.size < 1n ||
        before.size > BigInt(maximumEnvelopeBytes)
      )
        unavailable();
      descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      if (!protectedGitHubSameFileV1(before, fstatSync(descriptor, { bigint: true })))
        unavailable();
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
      this.#assertDirectory();
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
    if (!accepted || bytes === undefined) unavailable();
    return bytes;
  }

  #syncDirectory(): void {
    const descriptor = openSync(
      this.#directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const current = fstatSync(descriptor, { bigint: true });
      if (current.dev !== this.#identity.dev || current.ino !== this.#identity.ino) unavailable();
      fsyncSync(descriptor);
      this.#assertDirectory();
    } finally {
      closeSync(descriptor);
    }
  }

  read(originalContext: string): Buffer | undefined {
    try {
      this.#assertDirectory();
      const name = this.#name(originalContext);
      const destination = join(this.#directory, name);
      const pending = join(this.#directory, ".pending-" + name);
      let pendingStat: BigIntStats | undefined;
      try {
        pendingStat = lstatSync(pending, { bigint: true });
      } catch (error) {
        if (!absent(error)) throw error;
      }
      if (pendingStat !== undefined) {
        let destinationStat: BigIntStats | undefined;
        try {
          destinationStat = lstatSync(destination, { bigint: true });
        } catch (error) {
          if (!absent(error)) throw error;
        }
        if (
          destinationStat !== undefined &&
          (pendingStat.dev !== destinationStat.dev || pendingStat.ino !== destinationStat.ino)
        )
          unavailable();
        const bytes = this.#read(pending, destinationStat === undefined ? 1n : 2n);
        if (bytes === undefined) unavailable();
        try {
          if (destinationStat === undefined) linkSync(pending, destination);
          unlinkSync(pending);
          this.#syncDirectory();
          return bytes;
        } catch {
          bytes.fill(0);
          unavailable();
        }
      }
      const bytes = this.#read(destination);
      if (bytes !== undefined) this.#syncDirectory();
      return bytes;
    } catch {
      unavailable();
    }
  }

  /** Returns only after file and directory fsync. A failure can follow durable
   * publication; retry/readback must keep the same original context/envelope. */
  retain(originalContext: string, envelope: Uint8Array): void {
    let descriptor: number | undefined;
    let temporary: string | undefined;
    const owned = Buffer.from(envelope);
    try {
      if (owned.length < 1 || owned.length > maximumEnvelopeBytes) unavailable();
      this.#assertDirectory();
      const destination = join(this.#directory, this.#name(originalContext));
      const previous = this.read(originalContext);
      if (previous !== undefined) {
        try {
          if (!previous.equals(owned)) unavailable();
        } finally {
          previous.fill(0);
        }
        return;
      }
      temporary = join(this.#directory, ".pending-" + this.#name(originalContext));
      descriptor = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      let offset = 0;
      while (offset < owned.length) {
        const count = writeSync(descriptor, owned, offset, owned.length - offset, offset);
        if (count < 1) unavailable();
        offset += count;
      }
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      this.#assertDirectory();
      // link is an atomic, no-overwrite publication, unlike rename on POSIX.
      try {
        linkSync(temporary, destination);
      } catch (error) {
        if (!exists(error)) throw error;
        const competing = this.#read(destination);
        try {
          if (competing === undefined || !competing.equals(owned)) unavailable();
        } finally {
          competing?.fill(0);
        }
      }
      unlinkSync(temporary);
      temporary = undefined;
      this.#syncDirectory();
    } catch {
      unavailable();
    } finally {
      owned.fill(0);
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          this.#closed = true;
        }
      }
      // Preserve failed partial/publication files for custody reconciliation.
      // No token material is deleted on request cancellation or unknown COMMIT.
    }
  }

  assertSeparateKeySource(crypto: ProtectedGitHubCryptoV1): void {
    this.#assertDirectory();
    crypto.assertSeparateStorage(this.#directory);
  }

  close(): void {
    this.#closed = true;
  }
}
