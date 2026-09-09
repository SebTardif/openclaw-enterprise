import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute, normalize } from "node:path";
import type { PlatformStateStore, RuntimeServiceTrustService } from "@openclaw-enterprise/occ";
import type { ComputeDriver } from "@openclaw-enterprise/contracts";
import { startNativeRuntimeReadback } from "../admission/runtime-authority-context.ts";
import {
  closedNativeObject,
  nativeJson,
  nativeUnavailable,
} from "../admission/runtime-authority-wire.ts";

/** Bootstrap selection is separate from service admission: operators can admit
 * the first service using the packaged validator before selecting its listener. */
export const DEFAULT_RUNTIME_AUTHORITY_BINARY_PATH = "/usr/local/bin/oce-runtime-authority";
export interface RuntimeAuthorityReadbackStartup {
  readonly state: PlatformStateStore;
  readonly installationId: string;
  readonly trust: RuntimeServiceTrustService;
  readonly configPath: string;
  readonly binaryPath: string;
  readonly computeDriver?: ComputeDriver;
}

export async function startRuntimeAuthorityReadback(options: RuntimeAuthorityReadbackStartup) {
  if (!isAbsolute(options.configPath) || normalize(options.configPath) !== options.configPath)
    throw nativeUnavailable();
  const file = await open(options.configPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.size < 1 ||
      before.size > 16384 ||
      (before.mode & 0o022) !== 0 ||
      (before.uid !== 0 && before.uid !== process.getuid?.())
    )
      throw nativeUnavailable();
    bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw nativeUnavailable();
      offset += bytesRead;
    }
    const after = await file.stat();
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw nativeUnavailable();
  } finally {
    await file.close();
  }
  const config = closedNativeObject(nativeJson(bytes), [
    "schemaVersion",
    "binaryPath",
    "listenAddress",
    "recipientRef",
    "serviceIdentityRef",
  ]);
  if (
    config.schemaVersion !== 1 ||
    config.binaryPath !== options.binaryPath ||
    typeof config.listenAddress !== "string" ||
    typeof config.recipientRef !== "string" ||
    typeof config.serviceIdentityRef !== "string" ||
    !/^[A-Za-z0-9._:/-]{1,200}$/.test(config.recipientRef) ||
    !/^runtime-service\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      config.serviceIdentityRef,
    )
  )
    throw nativeUnavailable();
  const address = /^(?:\[([^\]]+)\]|([^:]+)):([1-9][0-9]{0,4})$/.exec(config.listenAddress);
  if (!address || isIP(address[1] ?? address[2] ?? "") === 0 || Number(address[3]) > 65535)
    throw nativeUnavailable();
  return startNativeRuntimeReadback({
    state: options.state,
    installationId: options.installationId,
    trust: options.trust,
    binaryPath: options.binaryPath,
    listenAddress: config.listenAddress,
    recipientRef: config.recipientRef,
    serviceIdentityRef: config.serviceIdentityRef,
    ...(options.computeDriver === undefined ? {} : { computeDriver: options.computeDriver }),
  });
}
