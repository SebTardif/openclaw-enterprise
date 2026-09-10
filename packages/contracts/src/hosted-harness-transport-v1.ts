import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

export const hostedHarnessTokenPathV1 = "/run/openclaw/hosted-gateway/harness/app-server-token";
export const hostedHarnessTokenBytesV1 = 43;
const ref = Type.String({ minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9._:/-]+$" });
const name = Type.String({
  minLength: 1,
  maxLength: 63,
  pattern: "^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$",
});
const positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const resourceVersion = Type.String({ minLength: 1, maxLength: 64, pattern: "^[1-9][0-9]*$" });

/** Nonsecret captured selection. Decoding it grants neither allocation,
 * currentness, peer identity, account authority nor permission to read a key. */
export const HostedHarnessTransportSelectionSchemaV1 = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    transportProfile: Type.Literal("kubernetes-capability-token-websocket-v1"),
    assignment: Type.Object(
      {
        installationRef: ref,
        namespaceRef: ref,
        agentRef: ref,
        revisionRef: ref,
        assignmentRef: ref,
        gatewayAssignmentRef: ref,
        lifecycleGeneration: positive,
        runtimeGeneration: positive,
        peerIdentity: ref,
        transportRef: ref,
      },
      { additionalProperties: false },
    ),
    endpoint: Type.String({ minLength: 1, maxLength: 2048 }),
    service: Type.Object(
      {
        namespace: name,
        name,
        uid: ref,
        resourceVersion,
        clusterIP: Type.String({
          minLength: 7,
          maxLength: 15,
          pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$",
        }),
      },
      { additionalProperties: false },
    ),
    secret: Type.Object(
      {
        namespace: name,
        name,
        uid: ref,
        resourceVersion,
        key: Type.Literal("app-server-token"),
        sha256: Type.String({ pattern: "^[0-9a-f]{64}$", minLength: 64, maxLength: 64 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type HostedHarnessTransportSelectionV1 = Readonly<
  Static<typeof HostedHarnessTransportSelectionSchemaV1>
>;

export function decodeHostedHarnessTransportSelectionV1(
  value: unknown,
): HostedHarnessTransportSelectionV1 {
  const copy = structuredClone(value);
  if (!Check(HostedHarnessTransportSelectionSchemaV1, copy))
    throw new Error("Harness transport selection unavailable");
  const selected = copy as Static<typeof HostedHarnessTransportSelectionSchemaV1>;
  let endpoint: URL;
  try {
    endpoint = new URL(selected.endpoint);
  } catch {
    throw new Error("Harness transport selection unavailable");
  }
  if (
    endpoint.protocol !== "ws:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/" ||
    endpoint.href !== selected.endpoint ||
    !endpoint.port ||
    Number(endpoint.port) < 1024 ||
    Number(endpoint.port) > 65535 ||
    endpoint.hostname !== `${selected.service.name}.${selected.service.namespace}.svc` ||
    selected.service.namespace !== selected.secret.namespace ||
    selected.service.clusterIP
      .split(".")
      .some((part) => String(Number(part)) !== part || Number(part) > 255)
  )
    throw new Error("Harness transport selection unavailable");
  Object.freeze(selected.assignment);
  Object.freeze(selected.service);
  Object.freeze(selected.secret);
  return Object.freeze(selected);
}
