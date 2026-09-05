import type {
  AuthorityCallV1,
  RuntimeAuthorityTrustedContextV1,
  RuntimeAuthorityTransportBindingV1,
  ResolveAssignmentRequestV1,
  RuntimeAllocation,
  RuntimeIntent,
} from "../../../packages/contracts/src/index.ts";
import type {
  RuntimeAllocation as ExistingAllocation,
  RuntimeIntent as ExistingIntent,
} from "../../../packages/occ/src/state/platform-state.ts";

// @ts-expect-error Ordinary structural JSON cannot construct an authenticated local handle.
const jsonContext: RuntimeAuthorityTrustedContextV1 = { schemaVersion: 1 };
// @ts-expect-error A boolean verification claim is not protected transport correspondence.
const jsonTransport: RuntimeAuthorityTransportBindingV1 = { verified: true };
// @ts-expect-error Context, deadline, recipient, cancellation and correlation are mandatory.
const incompleteCall: AuthorityCallV1 = { context: jsonContext };
// @ts-expect-error An unknown eighth purpose cannot compile as a closed request.
const unknownPurpose: ResolveAssignmentRequestV1 = { purpose: "purge" };

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const allocationStillIdentical: Same<RuntimeAllocation, ExistingAllocation> = true;
const intentStillIdentical: Same<RuntimeIntent, ExistingIntent> = true;
void [
  jsonTransport,
  incompleteCall,
  unknownPurpose,
  allocationStillIdentical,
  intentStillIdentical,
];
