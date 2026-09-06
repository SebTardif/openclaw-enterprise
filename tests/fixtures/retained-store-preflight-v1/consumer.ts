import type { StoreBindingV1 } from "@openclaw-enterprise/contracts/completed-state-v1";
import type { StoreBindingResultV1 } from "@openclaw-enterprise/contracts/runtime-effects-v1";
import {
  compareRetainedStorePreflightV1,
  type RetainedStoreDescriptorsV1,
  type RetainedStorePreflightResultV1,
} from "@openclaw-enterprise/occ/persistence/retained-store-preflight-v1";
import { descriptors } from "./descriptors.ts";

// This independently compiling caller consumes the actual three package subpaths.
export function compareTrustedRuntimeDescriptor(
  store: StoreBindingV1,
  observed: Extract<StoreBindingResultV1, { status: "verified" }>,
  expected: RetainedStoreDescriptorsV1,
): RetainedStorePreflightResultV1 {
  return compareRetainedStorePreflightV1(expected, {
    status: "present",
    descriptors: {
      stores: [store],
      mounts: [
        {
          store: observed.store.ref,
          component: observed.input.target.component,
          mount: observed.mount,
        },
      ],
    },
  });
}

const expected = descriptors();
const result = compareRetainedStorePreflightV1(expected, {
  status: "present",
  descriptors: expected,
});
const status: "match" | "mismatch" | "unavailable" = result.status;
void status;
// @ts-expect-error Metadata comparison has no attachment authority.
const attachment: true = result.attachmentAuthority;
// @ts-expect-error Metadata comparison has no writer authority.
const writer: true = result.writerAuthority;
// @ts-expect-error Credential-home overlay exclusion is not represented by these descriptors.
const excluded: "verified" = result.credentialHomeExclusion;
// @ts-expect-error A boolean does not replace a trusted StoreBindingV1 inventory.
compareRetainedStorePreflightV1({ stores: [true], mounts: [] }, { status: "unknown" });
// @ts-expect-error Unknown lifecycle status cannot become a successful comparison.
compareRetainedStorePreflightV1(expected, { status: "ready", descriptors: expected });
void [attachment, writer, excluded];
