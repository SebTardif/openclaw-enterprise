import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import { dirname, isAbsolute, normalize } from "node:path";

export class ProtectedGitHubCustodyErrorV1 extends Error {
  constructor() {
    super("Protected GitHub custody is unavailable.");
    this.name = "ProtectedGitHubCustodyErrorV1";
  }
}
export interface ProtectedGitHubKeySelectionV1 {
  readonly keyFile: string;
  readonly keySHA256: string;
}
export type ProtectedGitHubPurposeV1 = "github-app-key-v1" | "github-installation-token-v1";
const magic = Buffer.from("OCEGH1", "ascii");
const overhead = magic.length + 12 + 16;
const maximumBytes = 32768;
function unavailable(): never {
  throw new ProtectedGitHubCustodyErrorV1();
}

export function protectedGitHubOwnedV1(stat: BigIntStats): boolean {
  return stat.uid === 0n || (process.getuid !== undefined && stat.uid === BigInt(process.getuid()));
}
export function protectedGitHubSameFileV1(a: BigIntStats, b: BigIntStats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.uid === b.uid &&
    a.gid === b.gid &&
    a.nlink === b.nlink &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}
export function protectedGitHubDirectoryV1(path: string): BigIntStats {
  if (!isAbsolute(path) || normalize(path) !== path || realpathSync(path) !== path) unavailable();
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || !protectedGitHubOwnedV1(stat) || (stat.mode & 0o777n) !== 0o700n)
    unavailable();
  return stat;
}

/** Protected bytes, never a permission or an inventory transition. The explicit
 * operator-selected key is reopened and authenticated for each operation. */
export class ProtectedGitHubCryptoV1 {
  readonly #selection: ProtectedGitHubKeySelectionV1;
  #closed = false;

  constructor(selection: ProtectedGitHubKeySelectionV1) {
    if (
      !selection ||
      Object.keys(selection).length !== 2 ||
      typeof selection.keyFile !== "string" ||
      !isAbsolute(selection.keyFile) ||
      normalize(selection.keyFile) !== selection.keyFile ||
      !/^[a-f0-9]{64}$/.test(selection.keySHA256)
    )
      unavailable();
    this.#selection = Object.freeze({ ...selection });
  }

  #aad(purpose: ProtectedGitHubPurposeV1, context: readonly string[]): Buffer {
    if (
      !["github-app-key-v1", "github-installation-token-v1"].includes(purpose) ||
      !Array.isArray(context) ||
      context.length < 1 ||
      context.length > 32 ||
      context.some((field) => typeof field !== "string" || field.length < 1 || field.length > 16384)
    )
      unavailable();
    const aad = Buffer.from(JSON.stringify([purpose, this.#selection.keySHA256, ...context]));
    if (aad.length > 65536) unavailable();
    return aad;
  }

  #withKey<T>(use: (key: Buffer) => T, discard: (result: T) => void): T {
    if (this.#closed) unavailable();
    const key = Buffer.alloc(32);
    let descriptor: number | undefined;
    let result: { value: T } | undefined;
    let accepted = false;
    try {
      const parent = dirname(this.#selection.keyFile);
      const parentBefore = protectedGitHubDirectoryV1(parent);
      const before = lstatSync(this.#selection.keyFile, { bigint: true });
      if (
        !before.isFile() ||
        !protectedGitHubOwnedV1(before) ||
        before.nlink !== 1n ||
        before.size !== 32n ||
        ![0o400n, 0o600n].includes(before.mode & 0o777n)
      )
        unavailable();
      descriptor = openSync(this.#selection.keyFile, constants.O_RDONLY | constants.O_NOFOLLOW);
      if (!protectedGitHubSameFileV1(before, fstatSync(descriptor, { bigint: true })))
        unavailable();
      let offset = 0;
      while (offset < key.length) {
        const count = readSync(descriptor, key, offset, key.length - offset, offset);
        if (count < 1) unavailable();
        offset += count;
      }
      if (createHash("sha256").update(key).digest("hex") !== this.#selection.keySHA256)
        unavailable();
      result = { value: use(key) };
      if (
        this.#closed ||
        !protectedGitHubSameFileV1(before, fstatSync(descriptor, { bigint: true })) ||
        !protectedGitHubSameFileV1(before, lstatSync(this.#selection.keyFile, { bigint: true })) ||
        !protectedGitHubSameFileV1(parentBefore, protectedGitHubDirectoryV1(parent))
      )
        unavailable();
      accepted = true;
    } catch {
      accepted = false;
    } finally {
      key.fill(0);
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          accepted = false;
          this.#closed = true;
        }
      }
    }
    if (!accepted || result === undefined) {
      if (result !== undefined) discard(result.value);
      unavailable();
    }
    return result.value;
  }

  seal(purpose: ProtectedGitHubPurposeV1, context: readonly string[], bytes: Uint8Array): Buffer {
    if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > maximumBytes)
      unavailable();
    const aad = this.#aad(purpose, context);
    const plain = Buffer.from(bytes);
    try {
      return this.#withKey(
        (key) => {
          const nonce = randomBytes(12);
          const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
          cipher.setAAD(aad);
          const encrypted = cipher.update(plain);
          const tail = cipher.final();
          try {
            if (tail.length !== 0) unavailable();
            return Buffer.concat([magic, nonce, cipher.getAuthTag(), encrypted]);
          } finally {
            encrypted.fill(0);
            tail.fill(0);
          }
        },
        (value) => value.fill(0),
      );
    } finally {
      plain.fill(0);
    }
  }

  open(
    purpose: ProtectedGitHubPurposeV1,
    context: readonly string[],
    envelope: Uint8Array,
  ): Buffer {
    if (
      !(envelope instanceof Uint8Array) ||
      envelope.length <= overhead ||
      envelope.length > overhead + maximumBytes
    )
      unavailable();
    const encoded = Buffer.from(envelope);
    const aad = this.#aad(purpose, context);
    if (!encoded.subarray(0, magic.length).equals(magic)) unavailable();
    try {
      return this.#withKey(
        (key) => {
          let plain: Buffer | undefined;
          let tail: Buffer | undefined;
          let authenticated = false;
          try {
            const decipher = createDecipheriv(
              "aes-256-gcm",
              key,
              encoded.subarray(magic.length, magic.length + 12),
              { authTagLength: 16 },
            );
            decipher.setAAD(aad);
            decipher.setAuthTag(encoded.subarray(magic.length + 12, overhead));
            plain = decipher.update(encoded.subarray(overhead));
            tail = decipher.final();
            if (tail.length !== 0 || plain.length !== encoded.length - overhead) unavailable();
            authenticated = true;
            return plain;
          } finally {
            tail?.fill(0);
            if (!authenticated) plain?.fill(0);
          }
        },
        (value) => value.fill(0),
      );
    } finally {
      encoded.fill(0);
    }
  }

  assertSeparateStorage(directory: string): void {
    protectedGitHubDirectoryV1(directory);
    if (
      this.#selection.keyFile === directory ||
      this.#selection.keyFile.startsWith(directory + "/")
    )
      unavailable();
    this.assertAvailable();
  }

  assertAvailable(): void {
    this.#withKey(
      () => undefined,
      () => {},
    );
  }

  close(): void {
    this.#closed = true;
  }
}
