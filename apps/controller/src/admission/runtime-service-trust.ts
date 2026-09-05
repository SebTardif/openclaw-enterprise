import type { OccApiRoute } from "@openclaw-enterprise/contracts";
import type { RuntimeServiceTrustOperatorContext } from "@openclaw-enterprise/occ";
import {
  RuntimeServiceTrustRecordSchema,
  RuntimeServiceTrustRequestSchema,
  parseRuntimeServiceTrustRequest,
} from "@openclaw-enterprise/occ";

export const runtimeServiceTrustOperations = [
  {
    operationId: "mutateRuntimeServiceTrust",
    method: "POST",
    path: "/v1/runtime-service-trust/operations",
    action: "openclaw.runtime-service-trust.mutate",
    summary: "Admit or withdraw an exact runtime service trust record",
  },
  {
    operationId: "recoverRuntimeServiceTrust",
    method: "GET",
    path: "/v1/runtime-service-trust/operations/:operationRef",
    action: "openclaw.runtime-service-trust.recover",
    summary: "Recover an exact operator service trust operation",
  },
].map((operation) => ({
  ...operation,
  iamAction: "administer",
  resourceKind: "installation",
  authorizationTarget: "installation",
  tags: ["Runtime service trust"],
  schema: {},
})) as unknown as readonly OccApiRoute[];

export { RuntimeServiceTrustRecordSchema, RuntimeServiceTrustRequestSchema };
/** The route's private admission map, not a JSON caller, must first prove a real session. */
export function runtimeServiceTrustOperatorContext(
  context: Omit<RuntimeServiceTrustOperatorContext, "requestId">,
  requestId: string,
): RuntimeServiceTrustOperatorContext {
  return Object.freeze({
    actorId: context.actorId,
    issuer: context.issuer,
    subject: context.subject,
    admissionDecisionId: context.admissionDecisionId,
    requestId,
  });
}
export function parseRuntimeServiceTrustHttpBody(raw: string): unknown {
  if (Buffer.byteLength(raw, "utf8") > 8192) throw new Error("Invalid runtime service request.");
  // JSON.parse rounds fractional/exponent aliases before schema checks. Every numeric
  // field here is a nonnegative counter, so require exact integer token spelling first.
  const outsideStrings = raw.replace(/"(?:\\.|[^"\\])*"/g, '""');
  for (const token of outsideStrings.match(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g) ?? []) {
    if (!/^(0|[1-9][0-9]*)$/.test(token) || BigInt(token) > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error("Invalid runtime service counter.");
  }
  return parseRuntimeServiceTrustRequest(JSON.parse(raw));
}
