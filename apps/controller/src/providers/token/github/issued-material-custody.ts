import type {
  Bounds,
  OriginalIssuedMaterialCustodyV1,
} from "@openclaw-enterprise/occ/internal/credential-material-v1";
import type { GitHubAppTokenCustodyV1 } from "./types.ts";

/** Two projections of one original protected registry. Neither supplies committed
 * retention, Work/IAM admission or protected request-use authority. */
export interface OriginalGitHubIssuedMaterialOwnerV1 {
  readonly material: OriginalIssuedMaterialCustodyV1;
  readonly provider: GitHubAppTokenCustodyV1;
  close(bounds: Bounds): Promise<void>;
}

// TODO(original capture/open bridge): implement the shared registry, finite
// positive limits, original identity checks and bounded callback drain/wiping.
// This declaration publishes a constructor contract; it supplies no runtime body.
export declare function createOriginalGitHubIssuedMaterialOwnerV1(options: {
  readonly clock: () => number;
  readonly maxHandles: number;
  readonly maxRetainedBytes: number;
}): OriginalGitHubIssuedMaterialOwnerV1;
