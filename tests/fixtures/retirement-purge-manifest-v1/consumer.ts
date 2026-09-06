import {
  comparePurgeProgressV1,
  encodeRetirementPurgeV1,
  parseRetirementPurgeJsonV1,
  purgeManifestLocatorV1,
  type PurgeManifestV1,
  type PurgeManifestLocatorV1,
  type PurgeProgressV1,
  type PurgeStorePreconditionV1,
} from "../../../packages/contracts/src/retirement-purge-manifest-v1.ts";

/** An independent operator projection. It has no delete/resume/dispatch port. */
export function summarizeRetainedPurge(progress: PurgeProgressV1): Readonly<{
  locator: PurgeManifestLocatorV1;
  pendingObjects: readonly PurgeStorePreconditionV1[];
  liveObjectsAbsent: boolean;
  physicalErasureEstablished: false;
}> {
  return {
    locator: purgeManifestLocatorV1(progress.manifest),
    pendingObjects: progress.stores
      .filter((row) => row.state.kind !== "observed-absent")
      .map((row) => row.entry.store),
    liveObjectsAbsent: progress.state === "live-objects-absent",
    physicalErasureEstablished: false,
  };
}

export function preserveExactReadbackRequest(manifest: PurgeManifestV1): string {
  return encodeRetirementPurgeV1("locator", purgeManifestLocatorV1(manifest));
}

export function receiveMetadataReadback(wire: string): PurgeProgressV1 {
  return parseRetirementPurgeJsonV1("progress", wire);
}

export function inspectCandidate(before: PurgeProgressV1, after: PurgeProgressV1): string {
  return comparePurgeProgressV1(before, after, before.recordVersion).kind;
}
