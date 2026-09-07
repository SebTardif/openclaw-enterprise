import { spawn } from "node:child_process";
import {
  canonicalRuntimeServiceTrust,
  parseRuntimeServiceNativeProfile,
  type RuntimeServiceNativeProfile,
} from "@openclaw-enterprise/occ";
import {
  closedNativeObject,
  consumeNativeFrames,
  nativeJson,
  nativeUnavailable,
  writeNativeFrame,
} from "./runtime-authority-wire.ts";

export {
  verifyNativeExecutable,
  nativeChildExit,
  closeNativeChild,
} from "./native-child-lifetime.ts";
import {
  verifyNativeExecutable,
  nativeChildExit,
  closeNativeChild,
} from "./native-child-lifetime.ts";

/** Admission's pure maintained parser. This starts no listener or Source and
 * supplies no role, registry record, authenticated context or runtime effect. */
export async function validateNativeRuntimeServiceProfile(
  binaryPath: string,
  input: Readonly<RuntimeServiceNativeProfile>,
  parentSignal: AbortSignal,
): Promise<void> {
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(3000)]);
  const profile = parseRuntimeServiceNativeProfile(input);
  await verifyNativeExecutable(binaryPath, profile.nativeExecutableSha256, signal);
  const child = spawn(binaryPath, ["validate-profile"], {
    env: {},
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  child.stdin.on("error", () => {});
  const exited = nativeChildExit(child);
  let stop = () => {};
  try {
    const result = new Promise<void>((resolve, reject) => {
      let seen = false;
      const abort = () => reject(nativeUnavailable());
      signal.addEventListener("abort", abort, { once: true });
      stop = consumeNativeFrames(
        child.stdout,
        (bytes) => {
          const value = closedNativeObject(nativeJson(bytes), ["schemaVersion", "result"]);
          if (seen || value.schemaVersion !== 1 || value.result !== "valid") {
            reject(nativeUnavailable());
            return;
          }
          seen = true;
        },
        (reason) => {
          if (reason !== "eof" || !seen) reject(nativeUnavailable());
        },
      );
      exited.then(() => {
        signal.removeEventListener("abort", abort);
        if (seen && child.exitCode === 0 && !signal.aborted) resolve();
        else reject(nativeUnavailable());
      });
      if (signal.aborted) abort();
    });
    result.catch(() => {});
    // Canonical field ordering comes from the actual registry serializer.
    await writeNativeFrame(child.stdin, JSON.parse(canonicalRuntimeServiceTrust(profile)), signal);
    child.stdin.end();
    await result;
  } finally {
    stop();
    await closeNativeChild(child, exited);
  }
}
