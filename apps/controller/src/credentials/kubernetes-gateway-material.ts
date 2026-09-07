import { Buffer, isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import type { CoreV1Api, V1Secret } from "@kubernetes/client-node";
import { withComputeAbortSignal } from "../drivers/compute/operation-context.ts";

export const GATEWAY_PHYSICAL_MATERIAL_LIMITS_V1 = Object.freeze({
  itemBytes: 32_768,
  bundleBytes: 65_536,
  acquireMs: 5_000,
} as const);

export class GatewayPhysicalMaterialUnavailableV1 extends Error {
  constructor() {
    super("Gateway physical material is unavailable.");
    this.name = "GatewayPhysicalMaterialUnavailableV1";
  }
}

export type GatewayPhysicalMaterialRoleV1 = "slack-bot" | "slack-app";
export type GatewayPhysicalMaterialItemV1 = Readonly<{
  role: GatewayPhysicalMaterialRoleV1;
  key: string;
  credentialRef: string;
  credentialVersion: number;
  sha256: string;
}>;

/** An expectation from the original protected selection owner. These fields
 * are correspondence data; constructing them supplies no read authority. */
export type GatewayKubernetesMaterialSelectionV1 = Readonly<{
  clusterRef: string;
  namespace: string;
  name: string;
  uid: string;
  resourceVersion: string;
  logicalRevisionRef: string;
  items: readonly [GatewayPhysicalMaterialItemV1, GatewayPhysicalMaterialItemV1];
}>;

export type GatewayPhysicalSlackValuesV1 = Readonly<{
  botToken: Uint8Array;
  appToken: Uint8Array;
}>;

/** Local trusted ownership only. The holder must join its consumers before
 * disposal. Borrowed views are invalid after disposal; escaped copies cannot
 * be erased. Neither this handle nor its metadata authorizes delivery. */
export type GatewayKubernetesMaterialResultV1 = Readonly<{
  observed: GatewayKubernetesMaterialSelectionV1;
  borrow(): GatewayPhysicalSlackValuesV1;
  dispose(): undefined;
}>;

function unavailable(): never {
  throw new GatewayPhysicalMaterialUnavailableV1();
}
function text(value: unknown, max: number): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.includes("\0"))
    return false;
  // Match well-formed UTF-16 without requiring a newer library than Controller.
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

/** Snapshot all source operands before asynchronous work. UID/resourceVersion,
 * logical revision, credential version and content digests remain distinct. */
export function captureGatewayKubernetesMaterialSelectionV1(
  input: GatewayKubernetesMaterialSelectionV1,
): GatewayKubernetesMaterialSelectionV1 {
  try {
    if (
      input === null ||
      typeof input !== "object" ||
      !Array.isArray(input.items) ||
      input.items.length !== 2
    )
      unavailable();
    const result = {
      clusterRef: input.clusterRef,
      namespace: input.namespace,
      name: input.name,
      uid: input.uid,
      resourceVersion: input.resourceVersion,
      logicalRevisionRef: input.logicalRevisionRef,
      items: input.items.map((item) =>
        Object.freeze({
          role: item.role,
          key: item.key,
          credentialRef: item.credentialRef,
          credentialVersion: item.credentialVersion,
          sha256: item.sha256,
        }),
      ),
    };
    if (
      !text(result.clusterRef, 200) ||
      !text(result.logicalRevisionRef, 200) ||
      !text(result.uid, 200) ||
      !text(result.resourceVersion, 200) ||
      !text(result.namespace, 63) ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(result.namespace) ||
      !text(result.name, 253) ||
      !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(result.name) ||
      result.items.length !== 2 ||
      result.items.filter((item) => item.role === "slack-bot").length !== 1 ||
      result.items.filter((item) => item.role === "slack-app").length !== 1 ||
      new Set(result.items.map((item) => item.key)).size !== 2
    )
      unavailable();
    for (const item of result.items) {
      if (
        !text(item.key, 253) ||
        !/^[A-Za-z0-9._-]+$/.test(item.key) ||
        !text(item.credentialRef, 200) ||
        !Number.isSafeInteger(item.credentialVersion) ||
        item.credentialVersion < 1 ||
        typeof item.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(item.sha256)
      )
        unavailable();
    }
    return Object.freeze({
      ...result,
      items: Object.freeze(result.items),
    }) as GatewayKubernetesMaterialSelectionV1;
  } catch {
    return unavailable();
  }
}

function validate(
  observed: V1Secret,
  selected: GatewayKubernetesMaterialSelectionV1,
): GatewayKubernetesMaterialResultV1 {
  let owned: Buffer | undefined;
  try {
    const metadata = observed.metadata;
    const data = observed.data;
    if (
      observed.apiVersion !== "v1" ||
      observed.kind !== "Secret" ||
      observed.type !== "Opaque" ||
      observed.immutable !== true ||
      metadata?.namespace !== selected.namespace ||
      metadata.name !== selected.name ||
      metadata.uid !== selected.uid ||
      metadata.resourceVersion !== selected.resourceVersion ||
      metadata.deletionTimestamp !== undefined ||
      observed.stringData !== undefined ||
      data === undefined ||
      data === null ||
      typeof data !== "object" ||
      Object.keys(data).length !== selected.items.length
    )
      unavailable();
    let total = 0;
    const prepared: { item: GatewayPhysicalMaterialItemV1; encoded: string; length: number }[] = [];
    for (const item of selected.items) {
      if (!Object.hasOwn(data, item.key)) unavailable();
      const encoded = data[item.key];
      if (
        typeof encoded !== "string" ||
        encoded.length < 4 ||
        encoded.length > 4 * Math.ceil(GATEWAY_PHYSICAL_MATERIAL_LIMITS_V1.itemBytes / 3) ||
        encoded.length % 4 !== 0 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
      )
        unavailable();
      const length =
        (encoded.length / 4) * 3 - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
      if (
        length < 1 ||
        length > GATEWAY_PHYSICAL_MATERIAL_LIMITS_V1.itemBytes ||
        total + length > GATEWAY_PHYSICAL_MATERIAL_LIMITS_V1.bundleBytes
      )
        unavailable();
      total += length;
      prepared.push({ item, encoded, length });
    }
    // One dedicated exact-size backing allocation for this fixed, jointly
    // authorized bundle. Both views expose only this bundle, never a shared
    // Node pool or another request. Lengths are checked before allocation.
    owned = Buffer.alloc(total);
    const storage = owned;
    const values = new Map<GatewayPhysicalMaterialRoleV1, Buffer>();
    let offset = 0;
    for (const { item, encoded, length } of prepared) {
      const bytes = storage.subarray(offset, offset + length);
      offset += length;
      if (
        bytes.write(encoded, "base64") !== length ||
        bytes.toString("base64") !== encoded ||
        bytes.includes(0) ||
        !isUtf8(bytes) ||
        createHash("sha256").update(bytes).digest("hex") !== item.sha256
      )
        unavailable();
      values.set(item.role, bytes);
    }
    const botToken = values.get("slack-bot");
    const appToken = values.get("slack-app");
    if (botToken === undefined || appToken === undefined) unavailable();
    let disposed = false;
    const views = Object.freeze({ botToken, appToken });
    return Object.freeze({
      observed: selected,
      borrow() {
        if (disposed) unavailable();
        return views;
      },
      dispose() {
        if (!disposed) {
          disposed = true;
          storage.fill(0);
        }
        return undefined;
      },
    });
  } catch {
    owned?.fill(0);
    return unavailable();
  }
}

/** Capture the original trusted client's single get method. The caller must
 * supply the already selected client created with cancellation middleware;
 * this factory never loads kubeconfig or constructs another client. The SDK's
 * parsed response/base64 strings are outside the owned decoded-buffer bound:
 * transport response limits and erasure of external copies are not proved.
 *
 * One get, no list, retry, write or fallback. The await remains joined when a
 * canceled transport resolves late. A canceled result is never borrowed.
 * Teams provider/refresh material is not supported by this Slack-only reader. */
export function createKubernetesGatewayMaterialReaderV1(
  client: Pick<CoreV1Api, "readNamespacedSecret">,
  selectedClusterRef: string,
): Readonly<{
  read(
    selection: GatewayKubernetesMaterialSelectionV1,
    signal: AbortSignal,
  ): Promise<GatewayKubernetesMaterialResultV1>;
}> {
  let read: CoreV1Api["readNamespacedSecret"];
  try {
    if (!text(selectedClusterRef, 200) || typeof client.readNamespacedSecret !== "function")
      unavailable();
    read = client.readNamespacedSecret.bind(client);
  } catch {
    return unavailable();
  }
  return Object.freeze({
    async read(selection, signal) {
      let result: GatewayKubernetesMaterialResultV1 | undefined;
      try {
        const selected = captureGatewayKubernetesMaterialSelectionV1(selection);
        if (
          !(signal instanceof AbortSignal) ||
          signal.aborted ||
          selected.clusterRef !== selectedClusterRef
        )
          unavailable();
        const observed = await withComputeAbortSignal(signal, () =>
          read({ namespace: selected.namespace, name: selected.name }),
        );
        if (signal.aborted) unavailable();
        result = validate(observed, selected);
        if (signal.aborted) unavailable();
        return result;
      } catch {
        result?.dispose();
        return unavailable();
      }
    },
  });
}
