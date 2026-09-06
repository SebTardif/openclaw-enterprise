import type {
  PurgeManifestV1,
  PurgeProgressV1,
  PurgeStorePreconditionV1,
} from "../../../packages/contracts/src/retirement-purge-manifest-v1.ts";

declare const manifest: PurgeManifestV1;
declare const progress: PurgeProgressV1;
declare const store: PurgeStorePreconditionV1;

// @ts-expect-error A committed manifest is immutable.
manifest.manifestVersion = 2;
// @ts-expect-error A read result has no current deletion permission.
progress.delete();
// @ts-expect-error A progress result has no resume permission.
progress.resume();
// @ts-expect-error A shared secret is outside the closed store union.
const shared: PurgeStorePreconditionV1 = { ...store, kind: "shared-secret" };
void shared;
