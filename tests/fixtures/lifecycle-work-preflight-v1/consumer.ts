import {
  decodeLifecycleWorkV1,
  encodeLifecycleWorkV1,
} from "@openclaw-enterprise/occ/lifecycle/work-codec-v1";
import {
  LifecycleWorkPreflightV1,
  type LifecycleWorkPreflightOptionsV1,
  type LifecycleWorkPreflightResultV1,
} from "@openclaw-enterprise/occ/lifecycle/work-preflight-v1";
import type { LifecycleHandlerCallV1 } from "@openclaw-enterprise/occ/lifecycle/handler-ports-v1";
import type { AuthorityCallV1 } from "@openclaw-enterprise/contracts/runtime-authority-v1";
import type { LifecycleAdmissionAssociationV1 } from "@openclaw-enterprise/contracts/lifecycle-admission-v1";

/** Compile-only consumer: real owners supply service custody and read adapters. */
export async function inspect(
  dependencies: LifecycleWorkPreflightOptionsV1,
  wire: Uint8Array,
  original: LifecycleAdmissionAssociationV1,
  call: LifecycleHandlerCallV1,
): Promise<LifecycleWorkPreflightResultV1> {
  const canonical = encodeLifecycleWorkV1(decodeLifecycleWorkV1(wire));
  return new LifecycleWorkPreflightV1(dependencies).inspect(canonical, original, call);
}

type MustBeFalse<T extends false> = T;
export type SnapshotIsNotAuthority = MustBeFalse<
  Extract<LifecycleWorkPreflightResultV1, { kind: "snapshot-matches" }> extends AuthorityCallV1
    ? true
    : false
>;
