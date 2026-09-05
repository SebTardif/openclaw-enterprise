import type {
  RuntimeEffectCallV1,
  RuntimeObservationInputV1,
  PriorWriterResultV1,
  StoreBindingV1,
} from "@openclaw-enterprise/contracts";
const untrustedCall: RuntimeEffectCallV1 = {
  // @ts-expect-error Caller JSON cannot construct the nominal authenticated service context.
  context: { schemaVersion: 1 },
  requestRef: "x",
  recipientRef: "x",
  deadline: "x",
  signal: new AbortController().signal,
};
const unbound: RuntimeObservationInputV1 = {
  schemaVersion: 1,
  kind: "preallocated-candidate",
  // @ts-expect-error An unbound name/readiness flag is not protected candidate observation input.
  ready: true,
};
// @ts-expect-error Provider sealing or lease expiry cannot represent a no-writer release.
const noWriters: PriorWriterResultV1 = { schemaVersion: 1, status: "released", fenced: true };
const configuration: StoreBindingV1 = {
  schemaVersion: 1,
  kind: "configuration-object",
  // @ts-expect-error Configuration objects do not have an invented PVC binding.
  claimUid: "fake",
};
void [untrustedCall, unbound, noWriters, configuration];
