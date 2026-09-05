import { Type, type Static, type TProperties } from "typebox";
import { BindRuntimeSchemaV1 } from "./runtime-authority-v1.ts";

const object = <P extends TProperties>(properties: P) =>
  Type.Object(properties, { additionalProperties: false });
const ref = Type.String({ minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9._:/-]+$" });

/** Exact locator for the one canonical whole-Agent reservation. The conversation,
 * platform and revision are deliberately absent from the exclusion key. No held,
 * expired, released or no-attempt fact follows from possession of this value.
 */
export const WorkspaceReservationRefSchemaV1 = object({
  schemaVersion: Type.Literal(1),
  scope: Type.Pick(BindRuntimeSchemaV1.properties.target, [
    "installationId",
    "namespaceId",
    "agentId",
  ]),
  reservationRef: ref,
  reservationVersion: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
});
export type WorkspaceReservationRefV1 = Static<typeof WorkspaceReservationRefSchemaV1>;

/** An accepted turn may precede its canonical attempt. That state must use an
 * explicit journal-confirmed no-attempt branch, never a fabricated attempt ID.
 * A locator or historical receipt cannot initiate or replay an execution.
 */
export const WorkspaceAttemptRefSchemaV1 = object({
  schemaVersion: Type.Literal(1),
  reservation: WorkspaceReservationRefSchemaV1,
  conversationRef: ref,
  turnRef: ref,
  attemptRef: ref,
});
export type WorkspaceAttemptRefV1 = Static<typeof WorkspaceAttemptRefSchemaV1>;
