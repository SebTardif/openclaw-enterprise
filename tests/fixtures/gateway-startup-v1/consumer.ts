import type {
  GatewayProcessCallV1,
  GatewayProcessCreateInputV1,
  GatewayProcessParticipantV1,
  GatewayProcessSubmissionOwnerV1,
  GatewayStartupEnrollmentV1,
} from "@openclaw-enterprise/contracts/gateway-startup-v1";
import {
  createGatewayStartupOwnerV1,
  createGatewayStartupSubmissionOwnerV1,
  type GatewayStartupCommandV1,
  type GatewayStartupOwnerParticipantsV1,
  type GatewayStartupTransactionOwnerV1,
} from "@openclaw-enterprise/occ/gateway-startup-v1/owner";
import {
  createGatewayInstallationServiceAuthorityV1,
  type GatewayInstallationServiceCommandV1,
  type GatewayInstallationNativeLeaseV1,
  type GatewayInstallationNativeSourceV1,
} from "@openclaw-enterprise/occ/gateway-startup-v1/installation-service";
import type { GatewayHostV1 } from "openclaw/plugin-sdk/gateway-host";
import type { GatewayStartupPreparedCompositionV1 } from "../../../apps/gateway/src/startup-lifetime.ts";

declare const process: GatewayProcessParticipantV1;
declare const call: GatewayProcessCallV1;
declare const input: GatewayProcessCreateInputV1;
declare const enrolled: GatewayStartupEnrollmentV1;
declare const transaction: GatewayStartupTransactionOwnerV1;
declare const prepared: GatewayStartupPreparedCompositionV1;
const host: GatewayHostV1 = prepared.start();
const closed: Promise<Readonly<{ cleanup: "finished" | "failed" | "unknown" }>> = prepared.close();
const create: ReturnType<GatewayProcessParticipantV1["createOriginal"]> = process.createOriginal(
  input,
  call,
);
const owner = createGatewayStartupOwnerV1({ transaction });
const submission: GatewayProcessSubmissionOwnerV1 = createGatewayStartupSubmissionOwnerV1(owner);
void [host, closed, create, submission];
void enrolled.usePort.start(enrolled.recipient, enrolled.startup);
// @ts-expect-error Public object data cannot construct the original local recipient.
void enrolled.usePort.start({}, enrolled.startup);
// @ts-expect-error A process call cannot be assembled from a public authority DTO.
const forged: GatewayProcessCallV1 = { authorityCall: call.authorityCall };
// @ts-expect-error A create capability requires the exact original scoped call.
void process.createOriginal(input, {});
// @ts-expect-error A host handle is returned synchronously, before readiness.
const delayed: Promise<GatewayHostV1> = prepared.start();
void [forged, delayed];

declare const account: GatewayStartupOwnerParticipantsV1["authority"];
declare const native: GatewayInstallationNativeSourceV1;
declare const nativeLease: GatewayInstallationNativeLeaseV1;
declare const accept: Extract<GatewayStartupCommandV1, { kind: "accept-startup" }>;
const service = createGatewayInstallationServiceAuthorityV1({ account, native });
const authority: GatewayStartupOwnerParticipantsV1["authority"] = service.authority;
// @ts-expect-error Installation service cannot accept a new generation.
const serviceAccept: GatewayInstallationServiceCommandV1 = accept;
// @ts-expect-error Currentness is synchronous and does not accept an async fence.
const asyncFence: GatewayInstallationNativeLeaseV1["assertCurrent"] = async () => undefined;
// @ts-expect-error Existing Agent profiles cannot become the third Installation profile.
const oldProfile: GatewayInstallationNativeLeaseV1["profile"] = "initial-harness-bind-v1";
void [authority, nativeLease, serviceAccept, asyncFence, oldProfile];
