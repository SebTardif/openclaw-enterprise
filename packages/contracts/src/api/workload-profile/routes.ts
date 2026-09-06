import { Type } from "typebox";
import { EmptyQuery } from "../common.ts";
import {
  WorkloadProfilePrepareSchemaV1,
  WorkloadProfileWithdrawSchemaV1,
} from "../../workload-profile-v1.ts";
import {
  WorkloadProfileOperationParams,
  WorkloadProfileAdmissionParams,
  WorkloadProfileAcknowledgementResponse,
  WorkloadProfileOperationResponse,
  WorkloadProfileAdmissionResponse,
  WorkloadProfileUnknownOutcomeResponse,
} from "./resources.ts";

const error = Type.Ref("ErrorResponse");
const errors = {
  400: error,
  401: error,
  403: error,
  404: error,
  409: error,
  413: error,
  415: error,
  500: error,
  503: error,
};
const mutation = {
  iamAction: "administer",
  resourceKind: "installation",
  authorizationTarget: "installation",
  tags: ["Workload profiles"],
} as const;
const read = { ...mutation, iamAction: "read" } as const;
/** Contract definitions only; protected HTTP registration remains unavailable until
 * the actual guarded human and profile service composition are implemented. */
export const workloadProfileApiRoutes = [
  {
    ...mutation,
    operationId: "prepareWorkloadProfile",
    method: "POST",
    path: "/workload-profile-operations",
    action: "openclaw.workload-profiles.prepare",
    summary: "Prepare an exact immutable workload profile operation",
    schema: {
      querystring: EmptyQuery,
      body: WorkloadProfilePrepareSchemaV1,
      response: {
        200: WorkloadProfileAcknowledgementResponse,
        202: WorkloadProfileUnknownOutcomeResponse,
        ...errors,
      },
    },
  },
  {
    ...mutation,
    operationId: "acceptWorkloadProfile",
    method: "POST",
    path: "/workload-profile-operations/:operationRef/accept",
    action: "openclaw.workload-profiles.accept",
    summary: "Accept the exact retained workload profile operation",
    schema: {
      querystring: EmptyQuery,
      params: WorkloadProfileOperationParams,
      response: {
        200: WorkloadProfileAcknowledgementResponse,
        202: WorkloadProfileUnknownOutcomeResponse,
        ...errors,
      },
    },
  },
  {
    ...read,
    operationId: "getWorkloadProfileOperation",
    method: "GET",
    path: "/workload-profile-operations/:operationRef",
    action: "openclaw.workload-profiles.read-operation",
    summary:
      "Read an original-actor workload profile operation with current read and administer authority",
    schema: {
      querystring: EmptyQuery,
      params: WorkloadProfileOperationParams,
      response: { 200: WorkloadProfileOperationResponse, ...errors },
    },
  },
  {
    ...read,
    operationId: "getWorkloadProfile",
    method: "GET",
    path: "/workload-profiles/:admissionRef",
    action: "openclaw.workload-profiles.read",
    summary: "Read a retained workload profile with current read and administer authority",
    schema: {
      querystring: EmptyQuery,
      params: WorkloadProfileAdmissionParams,
      response: { 200: WorkloadProfileAdmissionResponse, ...errors },
    },
  },
  {
    ...mutation,
    operationId: "withdrawWorkloadProfile",
    method: "POST",
    path: "/workload-profiles/:admissionRef/withdraw",
    action: "openclaw.workload-profiles.withdraw",
    summary: "Consume the admission-owned reserved terminal template",
    schema: {
      querystring: EmptyQuery,
      params: WorkloadProfileAdmissionParams,
      body: WorkloadProfileWithdrawSchemaV1,
      response: {
        200: WorkloadProfileAcknowledgementResponse,
        202: WorkloadProfileUnknownOutcomeResponse,
        ...errors,
      },
    },
  },
] as const;
export type WorkloadProfileApiRoute = (typeof workloadProfileApiRoutes)[number];
