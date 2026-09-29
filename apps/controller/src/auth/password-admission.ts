import { createHmac } from "node:crypto";

import type { PasswordAttemptBudget, PasswordAttemptReservation } from "@openclaw-enterprise/occ";

export function isPasswordAttemptBudget(value: unknown): value is PasswordAttemptBudget {
  return (
    value !== null &&
    typeof value === "object" &&
    "reserve" in value &&
    typeof value.reserve === "function"
  );
}

export interface PasswordBudgetKey {
  readonly epoch: string;
  readonly bytes: Uint8Array;
}

export interface PasswordBudgetKeyConfiguration {
  readonly policyEpoch: string;
  readonly keyProvider: { load(): Promise<PasswordBudgetKey> };
}

declare const preparedKeyBrand: unique symbol;
declare const admissionBrand: unique symbol;

export interface PreparedPasswordBudgetKey {
  readonly [preparedKeyBrand]: true;
}

export interface PasswordAdmission {
  readonly [admissionBrand]: true;
}

interface PreparedKey {
  readonly installationId: string;
  readonly keyEpoch: string;
  readonly policyEpoch: string;
  readonly key: Uint8Array;
  readonly confirmation: Uint8Array;
}

const preparedKeys = new WeakMap<PreparedPasswordBudgetKey, PreparedKey>();
const admissions = new WeakMap<
  PasswordAdmission,
  (identifier: string) => Promise<PasswordAttemptReservation>
>();

function preparedKey(handle: PreparedPasswordBudgetKey): PreparedKey {
  const key = preparedKeys.get(handle);
  if (!key) {
    throw new Error("Password admission key is not recognized.");
  }
  return key;
}

/** Public confirmation data is never accepted as a prepared key handle. */
export function passwordBudgetKeyBinding(handle: PreparedPasswordBudgetKey): {
  readonly installationId: string;
  readonly keyEpoch: string;
  readonly policyEpoch: string;
  readonly keyConfirmation: Uint8Array;
} {
  const key = preparedKey(handle);
  return Object.freeze({
    installationId: key.installationId,
    keyEpoch: key.keyEpoch,
    policyEpoch: key.policyEpoch,
    keyConfirmation: Buffer.from(key.confirmation),
  });
}

function reservation(value: unknown): PasswordAttemptReservation {
  if (value === null || typeof value !== "object") {
    return { status: "unavailable" };
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return { status: "unavailable" };
  }
  const fields = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(fields);
  const status = fields.status;
  if (!status || !("value" in status)) {
    return { status: "unavailable" };
  }
  if (keys.length === 1 && keys[0] === "status") {
    if (status.value === "allowed" || status.value === "unknown") {
      return { status: status.value };
    }
    return { status: "unavailable" };
  }
  const delay = fields.retryAfterSeconds;
  if (
    keys.length === 2 &&
    keys.includes("status") &&
    keys.includes("retryAfterSeconds") &&
    status.value === "limited" &&
    delay &&
    "value" in delay &&
    Number.isSafeInteger(delay.value) &&
    delay.value > 0 &&
    delay.value <= 2_147_483_647
  ) {
    return { status: "limited", retryAfterSeconds: delay.value };
  }
  return { status: "unavailable" };
}

/** Bind only the key recognized by this owner, never a supplied digest closure. */
export function bindPasswordBudgetKey(
  handle: PreparedPasswordBudgetKey,
  budget: PasswordAttemptBudget,
): PasswordAdmission {
  const key = preparedKey(handle);
  if (!isPasswordAttemptBudget(budget)) {
    throw new Error("Password admission store is unavailable.");
  }
  const reserve = budget.reserve.bind(budget);
  const admission = Object.freeze({}) as PasswordAdmission;
  admissions.set(admission, async (canonicalIdentifier) => {
    if (typeof canonicalIdentifier !== "string") {
      return { status: "unavailable" };
    }
    // The caller validates the original request. Normalization may expand it.
    const digest = keyed(key.key, "oce.password-attempt.account.v1", [
      key.installationId,
      canonicalIdentifier,
    ]);
    try {
      return reservation(await reserve(digest));
    } catch {
      return { status: "unavailable" };
    } finally {
      digest.fill(0);
    }
  });
  return admission;
}

function framed(values: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  for (const value of values) {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    parts.push(length, bytes);
  }
  return Buffer.concat(parts);
}

function keyed(key: Uint8Array, purpose: string, values: readonly string[]): Buffer {
  return createHmac("sha256", key)
    .update(framed([purpose, ...values]))
    .digest();
}

function validEpoch(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

/** Prepare before State construction; the raw key never leaves this closure. */
export async function preparePasswordBudgetKey(
  installationId: string,
  configuration: PasswordBudgetKeyConfiguration,
): Promise<PreparedPasswordBudgetKey> {
  const policyEpoch = configuration.policyEpoch;
  if (
    typeof installationId !== "string" ||
    installationId.length === 0 ||
    typeof policyEpoch !== "string" ||
    !/^[1-9][0-9]{0,18}$/.test(policyEpoch) ||
    BigInt(policyEpoch) > 9_223_372_036_854_775_807n
  ) {
    throw new Error("Password admission configuration is invalid.");
  }
  let material: PasswordBudgetKey;
  try {
    material = await configuration.keyProvider.load();
  } catch {
    throw new Error("Password admission key is unavailable.");
  }
  const keyEpoch = material.epoch;
  const bytes = material.bytes;
  if (!validEpoch(keyEpoch) || !(bytes instanceof Uint8Array) || bytes.byteLength !== 32) {
    throw new Error("Password admission key is unavailable.");
  }
  const key = Buffer.from(bytes);
  const confirmation = keyed(key, "oce.password-attempt.key-confirmation.v1", [
    installationId,
    keyEpoch,
  ]);
  const handle = Object.freeze({}) as PreparedPasswordBudgetKey;
  preparedKeys.set(handle, { installationId, keyEpoch, policyEpoch, key, confirmation });
  return handle;
}

export class PasswordAdmissionFailure extends Error {
  readonly status: 429 | 503;
  readonly code: "RATE_LIMITED" | "DEPENDENCY_UNAVAILABLE";
  readonly retryAfterSeconds?: number;

  constructor(result: Exclude<PasswordAttemptReservation, { readonly status: "allowed" }>) {
    super("Password authentication is temporarily unavailable.");
    this.name = "PasswordAdmissionFailure";
    this.status = result.status === "limited" ? 429 : 503;
    this.code = result.status === "limited" ? "RATE_LIMITED" : "DEPENDENCY_UNAVAILABLE";
    if (result.status === "limited") {
      this.retryAfterSeconds = result.retryAfterSeconds;
    }
  }
}

export async function requirePasswordAdmission(
  admission: PasswordAdmission,
  canonicalIdentifier: string,
): Promise<void> {
  const reserve = admissions.get(admission);
  const result = reserve ? await reserve(canonicalIdentifier) : { status: "unavailable" as const };
  if (result.status !== "allowed") {
    throw new PasswordAdmissionFailure(result);
  }
}
