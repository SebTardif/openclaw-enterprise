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

const envelopeMagic = Buffer.from("OCEGH1", "ascii");
const nonceBytes = 12;
const authenticationTagBytes = 16;
const envelopeHeaderBytes = envelopeMagic.length + nonceBytes + authenticationTagBytes;
const maximumPlaintextBytes = 32768;

interface CryptoState {
  readonly selection: ProtectedGitHubKeySelectionV1;
  closed: boolean;
}

// Keep key selection and key-use callbacks out of caller-replaceable instance properties.
const cryptoStates = new WeakMap<ProtectedGitHubCryptoV1, CryptoState>();

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

function cryptoState(owner: ProtectedGitHubCryptoV1): CryptoState {
  const state = cryptoStates.get(owner);
  if (state === undefined) unavailable();
  return state;
}

function authenticatedContext(
  selection: ProtectedGitHubKeySelectionV1,
  purpose: ProtectedGitHubPurposeV1,
  context: readonly string[],
): Buffer {
  if (
    !["github-app-key-v1", "github-installation-token-v1"].includes(purpose) ||
    !Array.isArray(context) ||
    context.length < 1 ||
    context.length > 32 ||
    context.some((field) => typeof field !== "string" || field.length < 1 || field.length > 16384)
  )
    unavailable();
  const additionalData = Buffer.from(JSON.stringify([purpose, selection.keySHA256, ...context]));
  if (additionalData.length > 65536) unavailable();
  return additionalData;
}

function withProtectedKey<T>(
  state: CryptoState,
  use: (key: Buffer) => T,
  discard: (result: T) => void,
): T {
  if (state.closed) unavailable();
  const key = Buffer.alloc(32);
  let descriptor: number | undefined;
  let result: { value: T } | undefined;
  let accepted = false;
  try {
    const keyDirectory = dirname(state.selection.keyFile);
    const directoryBefore = protectedGitHubDirectoryV1(keyDirectory);
    const keyBefore = lstatSync(state.selection.keyFile, { bigint: true });
    if (
      !keyBefore.isFile() ||
      !protectedGitHubOwnedV1(keyBefore) ||
      keyBefore.nlink !== 1n ||
      keyBefore.size !== 32n ||
      ![0o400n, 0o600n].includes(keyBefore.mode & 0o777n)
    )
      unavailable();
    descriptor = openSync(state.selection.keyFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!protectedGitHubSameFileV1(keyBefore, fstatSync(descriptor, { bigint: true })))
      unavailable();
    let offset = 0;
    while (offset < key.length) {
      const count = readSync(descriptor, key, offset, key.length - offset, offset);
      if (count < 1) unavailable();
      offset += count;
    }
    if (createHash("sha256").update(key).digest("hex") !== state.selection.keySHA256) unavailable();
    result = { value: use(key) };
    // Release the result only after rechecking custody and successfully closing the file.
    if (
      state.closed ||
      !protectedGitHubSameFileV1(keyBefore, fstatSync(descriptor, { bigint: true })) ||
      !protectedGitHubSameFileV1(keyBefore, lstatSync(state.selection.keyFile, { bigint: true })) ||
      !protectedGitHubSameFileV1(directoryBefore, protectedGitHubDirectoryV1(keyDirectory))
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
        state.closed = true;
      }
    }
  }
  if (!accepted || result === undefined) {
    if (result !== undefined) discard(result.value);
    unavailable();
  }
  return result.value;
}

/** Protected bytes, never a permission or an inventory transition. The explicit
 * operator-selected key is reopened and authenticated for each operation. */
export class ProtectedGitHubCryptoV1 {
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
    cryptoStates.set(this, { selection: Object.freeze({ ...selection }), closed: false });
  }

  seal(purpose: ProtectedGitHubPurposeV1, context: readonly string[], bytes: Uint8Array): Buffer {
    if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > maximumPlaintextBytes)
      unavailable();
    const state = cryptoState(this);
    const additionalData = authenticatedContext(state.selection, purpose, context);
    const plaintext = Buffer.from(bytes);
    try {
      return withProtectedKey(
        state,
        (key) => {
          const nonce = randomBytes(nonceBytes);
          const cipher = createCipheriv("aes-256-gcm", key, nonce, {
            authTagLength: authenticationTagBytes,
          });
          cipher.setAAD(additionalData);
          const ciphertext = cipher.update(plaintext);
          const finalBytes = cipher.final();
          try {
            if (finalBytes.length !== 0) unavailable();
            return Buffer.concat([envelopeMagic, nonce, cipher.getAuthTag(), ciphertext]);
          } finally {
            ciphertext.fill(0);
            finalBytes.fill(0);
          }
        },
        (value) => value.fill(0),
      );
    } finally {
      plaintext.fill(0);
    }
  }

  open(
    purpose: ProtectedGitHubPurposeV1,
    context: readonly string[],
    envelope: Uint8Array,
  ): Buffer {
    if (
      !(envelope instanceof Uint8Array) ||
      envelope.length <= envelopeHeaderBytes ||
      envelope.length > envelopeHeaderBytes + maximumPlaintextBytes
    )
      unavailable();
    const envelopeCopy = Buffer.from(envelope);
    const state = cryptoState(this);
    const additionalData = authenticatedContext(state.selection, purpose, context);
    if (!envelopeCopy.subarray(0, envelopeMagic.length).equals(envelopeMagic)) unavailable();
    try {
      return withProtectedKey(
        state,
        (key) => {
          let plaintext: Buffer | undefined;
          let finalBytes: Buffer | undefined;
          let authenticated = false;
          try {
            const decipher = createDecipheriv(
              "aes-256-gcm",
              key,
              envelopeCopy.subarray(envelopeMagic.length, envelopeMagic.length + nonceBytes),
              { authTagLength: authenticationTagBytes },
            );
            decipher.setAAD(additionalData);
            decipher.setAuthTag(
              envelopeCopy.subarray(envelopeMagic.length + nonceBytes, envelopeHeaderBytes),
            );
            plaintext = decipher.update(envelopeCopy.subarray(envelopeHeaderBytes));
            finalBytes = decipher.final();
            if (
              finalBytes.length !== 0 ||
              plaintext.length !== envelopeCopy.length - envelopeHeaderBytes
            )
              unavailable();
            authenticated = true;
            return plaintext;
          } finally {
            finalBytes?.fill(0);
            if (!authenticated) plaintext?.fill(0);
          }
        },
        (value) => value.fill(0),
      );
    } finally {
      envelopeCopy.fill(0);
    }
  }

  assertSeparateStorage(directory: string): void {
    protectedGitHubDirectoryV1(directory);
    const { selection } = cryptoState(this);
    if (selection.keyFile === directory || selection.keyFile.startsWith(directory + "/"))
      unavailable();
    this.assertAvailable();
  }

  assertAvailable(): void {
    withProtectedKey(
      cryptoState(this),
      () => undefined,
      () => {},
    );
  }

  close(): void {
    cryptoState(this).closed = true;
  }
}
