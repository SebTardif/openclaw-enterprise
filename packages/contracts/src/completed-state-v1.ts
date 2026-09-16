import { Type, type Static, type TProperties } from "typebox";
import { BindRuntimeSchemaV1 } from "./runtime-authority-v1.ts";

const closed = <P extends TProperties>(properties: P) =>
  Type.Object(properties, { additionalProperties: false });
const reference = Type.String({ minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9._:/-]+$" });
const scope = closed(
  Type.Pick(BindRuntimeSchemaV1.properties.target, ["installationId", "namespaceId", "agentId"])
    .properties,
);

/** Immutable OCC store correspondence. DATA grants neither mount nor purge authority. */
export const StoreBindingRefSchemaV1 = closed({
  schemaVersion: Type.Literal(1),
  scope,
  logicalStoreRef: reference,
  bindingRef: reference,
  bindingVersion: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
});
export type StoreBindingRefV1 = Static<typeof StoreBindingRefSchemaV1>;
