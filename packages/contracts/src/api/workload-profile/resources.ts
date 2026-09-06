import { Type, type Static } from "typebox";
import { Meta, Timestamp } from "../common.ts";
import {
  WorkloadProfileIdSchemaV1,
  WorkloadProfileScopeSchemaV1,
  WorkloadProfileContentEnvelopeSchemaV1,
  WorkloadProfileSelectionSchemaV1,
} from "../../workload-profile-v1.ts";

const closed = { additionalProperties: false } as const;
const Action = Type.Union([
  Type.Literal("admit"),
  Type.Literal("replace"),
  Type.Literal("withdraw"),
]);
export const WorkloadProfileOperationParams = Type.Object(
  { operationRef: WorkloadProfileIdSchemaV1 },
  closed,
);
export const WorkloadProfileAdmissionParams = Type.Object(
  { admissionRef: WorkloadProfileIdSchemaV1 },
  closed,
);
/** Mutation responses deliberately contain no retained content or allocated identities. */
export const WorkloadProfileAcknowledgementSchema = Type.Object(
  {
    kind: Type.Literal("acknowledged"),
    operationRef: WorkloadProfileIdSchemaV1,
    action: Action,
    scope: WorkloadProfileScopeSchemaV1,
  },
  closed,
);
export type WorkloadProfileAcknowledgement = Static<typeof WorkloadProfileAcknowledgementSchema>;
export const WorkloadProfileUnknownOutcomeSchema = Type.Object(
  {
    kind: Type.Literal("commit-unknown"),
    operationRef: WorkloadProfileIdSchemaV1,
    recovery: Type.Literal("exact-readback-only"),
  },
  closed,
);
export type WorkloadProfileUnknownOutcome = Static<typeof WorkloadProfileUnknownOutcomeSchema>;
/** Requires current read + administer Installation and the registered class. */
export const WorkloadProfilePreparationProjectionSchema = Type.Object(
  {
    kind: Type.Literal("inert-preparation"),
    operationRef: WorkloadProfileIdSchemaV1,
    action: Type.Union([Type.Literal("admit"), Type.Literal("replace")]),
    scope: WorkloadProfileScopeSchemaV1,
    manifest: WorkloadProfileContentEnvelopeSchemaV1,
    preparedAt: Timestamp,
  },
  closed,
);
export type WorkloadProfilePreparationProjection = Static<
  typeof WorkloadProfilePreparationProjectionSchema
>;
/** Historical state is not current authorization or evidence of runtime termination. */
export const WorkloadProfileAdmissionProjectionSchema = Type.Object(
  {
    scope: WorkloadProfileScopeSchemaV1,
    selection: WorkloadProfileSelectionSchemaV1,
    status: Type.Union([Type.Literal("active"), Type.Literal("withdrawn")]),
    manifest: WorkloadProfileContentEnvelopeSchemaV1,
  },
  closed,
);
export type WorkloadProfileAdmissionProjection = Static<
  typeof WorkloadProfileAdmissionProjectionSchema
>;
export const WorkloadProfileAcknowledgementResponse = Type.Object(
  { data: WorkloadProfileAcknowledgementSchema, meta: Meta },
  closed,
);
export const WorkloadProfileUnknownOutcomeResponse = Type.Object(
  { data: WorkloadProfileUnknownOutcomeSchema, meta: Meta },
  closed,
);
export const WorkloadProfileOperationResponse = Type.Object(
  { data: WorkloadProfilePreparationProjectionSchema, meta: Meta },
  closed,
);
export const WorkloadProfileAdmissionResponse = Type.Object(
  { data: WorkloadProfileAdmissionProjectionSchema, meta: Meta },
  closed,
);
