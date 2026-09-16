import { isIP } from "node:net";
import { types } from "node:util";

/** Selected deployment DATA. Decoding does not authenticate labels, establish
 * revision currentness, install policy/DNS, or observe effective containment.
 * Original controller/Compute owners must check the owning revision and use the
 * replacement path for endpoint, CA or profile changes; ordinary is no fallback. */
export const MEDIATED_NETWORK_PROFILE = "credential-gateway-v1" as const;
export interface MediatedNetworkPeerV1 {
  readonly namespace: string;
  readonly podLabels: Readonly<Record<string, string>>;
}
export interface MediatedNetworkPacketV1 {
  readonly kind: "credential-gateway-network-v1";
  readonly profile: typeof MEDIATED_NETWORK_PROFILE;
  readonly binding: Readonly<{
    namespaceId: string;
    agentId: string;
    revisionId: string;
  }>;
  readonly agent: MediatedNetworkPeerV1;
  readonly agentGateway: MediatedNetworkPeerV1;
  readonly credentialGateway: MediatedNetworkPeerV1;
  readonly gatewayService: Readonly<{ clusterIP: string; port: 443; targetPort: 8443 }>;
  readonly scopedDns: Readonly<{
    image: string;
    clusterIP: string;
    servicePort: 53;
    targetPort: 1053;
    peer: MediatedNetworkPeerV1;
    platformHosts: readonly Readonly<{ hostname: string; address: string }>[];
  }>;
  readonly gatewayResolvers: readonly Readonly<{
    peer: MediatedNetworkPeerV1;
    address: string;
    port: number;
  }>[];
  readonly database: Readonly<{ address: string; port: number }>;
  readonly upstreamHttpsCidrs: readonly string[];
  readonly platformFlows: readonly Readonly<{
    caller: "agent" | "agent-gateway";
    purpose: "model" | "control" | "identity-bootstrap";
    peer: MediatedNetworkPeerV1;
    address: string;
    port: number;
  }>[];
  readonly harness: Readonly<{ protocol: "TCP"; port: 18790 }>;
  readonly publicCa: Readonly<{ configMapName: string; key: "ca.crt"; sha256: string }>;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
function failure(): never {
  throw new Error("Invalid mediated network packet.");
}

/** Capture descriptors, never caller getters/iterators/toJSON. Limits are checked
 * before traversing children or encoding primitive strings. Proxies are rejected
 * before reflective operations, so their traps cannot execute. */
function snapshot(input: unknown): Json {
  let bytes = 0;
  let nodes = 0;
  const ancestors = new Set<object>();
  const add = (amount: number) => {
    bytes += amount;
    if (bytes > 65536) failure();
  };
  const stringBytes = (value: string) => {
    if (
      value.length > 65536 ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)
    )
      failure();
    add(Buffer.byteLength(JSON.stringify(value), "utf8"));
  };
  const visit = (value: unknown, depth: number): Json => {
    if (++nodes > 4096 || depth > 10) failure();
    if (typeof value === "string") {
      stringBytes(value);
      return value;
    }
    if (value === null || typeof value === "boolean") {
      add(value === null ? 4 : value ? 4 : 5);
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value) || Object.is(value, -0)) failure();
      add(String(value).length);
      return value;
    }
    if (typeof value !== "object" || types.isProxy(value) || ancestors.has(value)) failure();
    const array = Array.isArray(value);
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null) failure();
    const keys = Reflect.ownKeys(value);
    // Packet records have at most 16 fields/labels, arrays at most 64 entries.
    if (keys.length > (array ? 65 : 16)) failure();
    if (keys.some((key) => typeof key !== "string")) failure();
    ancestors.add(value);
    add(2);
    let result: Json;
    if (array) {
      const descriptor = Object.getOwnPropertyDescriptor(value, "length");
      const length: unknown = descriptor?.value;
      if (typeof length !== "number" || length > 64 || keys.length !== length + 1) failure();
      const copy: Json[] = [];
      for (let index = 0; index < length; index++) {
        const item = Object.getOwnPropertyDescriptor(value, String(index));
        if (!item || !("value" in item) || !item.enumerable) failure();
        if (index > 0) add(1);
        copy.push(visit(item.value, depth + 1));
      }
      Object.freeze(copy);
      result = copy;
    } else {
      const copy: { [key: string]: Json } = {};
      for (const [index, key] of keys.entries()) {
        if (typeof key !== "string" || key.length > 317) failure();
        const item = Object.getOwnPropertyDescriptor(value, key);
        if (!item || !("value" in item) || !item.enumerable) failure();
        if (index > 0) add(1);
        stringBytes(key);
        add(1);
        Object.defineProperty(copy, key, {
          value: visit(item.value, depth + 1),
          enumerable: true,
          writable: false,
          configurable: false,
        });
      }
      result = Object.freeze(copy);
    }
    ancestors.delete(value);
    return result;
  };
  return visit(input, 0);
}

function record(value: Json | undefined, fields?: readonly string[]): { [key: string]: Json } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) failure();
  if (
    fields &&
    (Object.keys(value).length !== fields.length ||
      !fields.every((field) => Object.hasOwn(value, field)))
  )
    failure();
  return value;
}
function text(value: Json | undefined): string {
  if (typeof value !== "string") failure();
  return value;
}
function literal<const T extends string | number>(value: Json | undefined, expected: T): T {
  if (value !== expected) failure();
  return expected;
}
function list(value: Json | undefined, minimum: number, maximum: number): Json[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) failure();
  return value;
}
function port(value: Json | undefined): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535)
    failure();
  return value;
}
function dns(value: Json | undefined, maximum = 253): string {
  const name = text(value);
  if (
    name.length > maximum ||
    !name
      .split(".")
      .every(
        (part) =>
          part.length >= 1 && part.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part),
      )
  )
    failure();
  return name;
}
function labelValue(value: Json | undefined): string {
  const name = text(value);
  if (name.length > 63 || !/^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/.test(name)) failure();
  return name;
}
function labelKey(key: string): void {
  const parts = key.split("/");
  if (parts.length > 2) failure();
  if (parts.length === 2) dns(parts[0]);
  labelValue(parts.at(-1));
}
function address(value: Json | undefined): string {
  const ip = text(value);
  const version = isIP(ip);
  if (version === 0 || ip.includes("%")) failure();
  if (version === 6 && new URL("http://[" + ip + "]/").hostname !== "[" + ip + "]") failure();
  return ip;
}
function publicCidr(value: Json): string {
  const cidr = text(value);
  const parts = cidr.split("/");
  if (parts.length !== 2) failure();
  const ip = address(parts[0]);
  if (isIP(ip) === 4) {
    literal(parts[1], "32");
    const octets = ip.split(".").map(Number);
    const a = octets[0];
    const b = octets[1];
    const c = octets[2];
    if (
      a === undefined ||
      b === undefined ||
      c === undefined ||
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    )
      failure();
  } else {
    literal(parts[1], "128");
    // Globally routed unicast only; exclude special-use tunnels, documentation,
    // benchmarking and ORCHID allocations within the global unicast range.
    const groups = new URL("http://[" + ip + "]/").hostname.slice(1, -1).split(":");
    const first = Number.parseInt(groups[0] || "0", 16);
    const second = Number.parseInt(groups[1] || "0", 16);
    if (
      first < 0x2000 ||
      first > 0x3fff ||
      first === 0x2002 ||
      (first === 0x2001 &&
        (second === 0 || second === 2 || second === 0xdb8 || (second >= 0x10 && second <= 0x2f))) ||
      (first === 0x3fff && second < 0x1000)
    )
      failure();
  }
  return cidr;
}
function imageReference(value: Json | undefined): string {
  const image = text(value);
  const pieces = image.split("@sha256:");
  let name = pieces[0];
  const digest = pieces[1];
  if (pieces.length !== 2 || !name || !digest || !/^[a-f0-9]{64}$/.test(digest)) failure();
  const tagAt = name.lastIndexOf(":");
  if (tagAt > name.lastIndexOf("/")) {
    const tag = name.slice(tagAt + 1);
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)) failure();
    name = name.slice(0, tagAt);
  }
  const path = name.split("/");
  const first = path[0];
  if (!first) failure();
  if (path.length > 1 && (first.includes(".") || first.includes(":") || first === "localhost")) {
    const registry = path.shift();
    if (!registry) failure();
    if (registry.startsWith("[")) {
      const close = registry.indexOf("]");
      if (close < 0) failure();
      if (isIP(address(registry.slice(1, close))) !== 6) failure();
      const suffix = registry.slice(close + 1);
      if (suffix && (!/^:[1-9][0-9]*$/.test(suffix) || Number(suffix.slice(1)) > 65535)) failure();
    } else {
      const host = registry.split(":");
      if (host.length > 2) failure();
      dns(host[0]);
      if (host.length === 2 && (!/^[1-9][0-9]*$/.test(host[1] ?? "") || Number(host[1]) > 65535))
        failure();
    }
  }
  if (!path.every((part) => /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/.test(part))) failure();
  return image;
}

function peer(value: Json | undefined): MediatedNetworkPeerV1 {
  const data = record(value, ["namespace", "podLabels"]);
  const labels = record(data.podLabels);
  if (Object.keys(labels).length < 1 || Object.keys(labels).length > 16) failure();
  const copied: Record<string, string> = {};
  for (const key of Object.keys(labels)) {
    labelKey(key);
    Object.defineProperty(copied, key, {
      value: labelValue(labels[key]),
      enumerable: true,
    });
  }
  const namespace = dns(data.namespace, 63);
  if (namespace.includes(".")) failure();
  return Object.freeze({ namespace, podLabels: Object.freeze(copied) });
}
function ownedPeer(
  value: Json | undefined,
  role: "agent" | "gateway",
  binding: MediatedNetworkPacketV1["binding"],
): MediatedNetworkPeerV1 {
  const result = peer(value);
  const labels = result.podLabels;
  // Selected-profile pod-label requirement; ordinary Compute currently records
  // namespace-id as an ownership annotation. Its selected producer must supply
  // and authenticate these labels. Equality to the authenticated owning revision
  // belongs to Compute. Supplied binding/labels are never trusted ownership.
  for (const key of ["openclaw.dev/namespace-id", "openclaw.dev/agent", "openclaw.dev/revision"])
    labelValue(labels[key]);
  if (
    labels["openclaw.dev/namespace-id"] !== binding.namespaceId ||
    labels["openclaw.dev/agent"] !== binding.agentId ||
    labels["openclaw.dev/revision"] !== binding.revisionId
  )
    failure();
  // Internal DATA equality rejects inconsistent packets; it authenticates nothing.
  literal(labels["openclaw.dev/network-profile"], MEDIATED_NETWORK_PROFILE);
  literal(labels["openclaw.dev/workload-role"], role);
  return result;
}

/** Validates closed DATA and returns an owned, deeply frozen ordered snapshot.
 * Every failure has the same message and no caller-derived cause or values. */
export function decodeMediatedNetworkPacketV1(input: unknown): MediatedNetworkPacketV1 {
  try {
    const data = record(snapshot(input), [
      "kind",
      "profile",
      "binding",
      "agent",
      "agentGateway",
      "credentialGateway",
      "gatewayService",
      "scopedDns",
      "gatewayResolvers",
      "database",
      "upstreamHttpsCidrs",
      "platformFlows",
      "harness",
      "publicCa",
    ]);
    const binding = record(data.binding, ["namespaceId", "agentId", "revisionId"]);
    const bindingData = Object.freeze({
      namespaceId: labelValue(binding.namespaceId),
      agentId: labelValue(binding.agentId),
      revisionId: labelValue(binding.revisionId),
    });
    const gateway = record(data.gatewayService, ["clusterIP", "port", "targetPort"]);
    const scoped = record(data.scopedDns, [
      "image",
      "clusterIP",
      "servicePort",
      "targetPort",
      "peer",
      "platformHosts",
    ]);
    const database = record(data.database, ["address", "port"]);
    const harness = record(data.harness, ["protocol", "port"]);
    const ca = record(data.publicCa, ["configMapName", "key", "sha256"]);
    const credentialGateway = peer(data.credentialGateway);
    literal(credentialGateway.podLabels["openclaw.dev/workload-role"], "credential-gateway");
    literal(credentialGateway.podLabels["openclaw.dev/network-profile"], MEDIATED_NETWORK_PROFILE);
    const endpoints = new Set<string>();
    const endpoint = (ip: string, number: number) => {
      const key = ip + "/" + number;
      if (endpoints.has(key)) failure();
      endpoints.add(key);
    };
    const gatewayService = Object.freeze({
      clusterIP: address(gateway.clusterIP),
      port: literal(gateway.port, 443),
      targetPort: literal(gateway.targetPort, 8443),
    });
    endpoint(gatewayService.clusterIP, gatewayService.port);
    const image = imageReference(scoped.image);
    const caDigest = text(ca.sha256);
    if (!/^[a-f0-9]{64}$/.test(caDigest)) failure();
    const hostnames = new Set<string>();
    const platformHosts = Object.freeze(
      list(scoped.platformHosts, 0, 32).map((item) => {
        const host = record(item, ["hostname", "address"]);
        const hostname = dns(host.hostname);
        if (hostname === "github.com" || hostname === "api.github.com" || hostnames.has(hostname))
          failure();
        hostnames.add(hostname);
        return Object.freeze({ hostname, address: address(host.address) });
      }),
    );
    const scopedDns = Object.freeze({
      image,
      clusterIP: address(scoped.clusterIP),
      servicePort: literal(scoped.servicePort, 53),
      targetPort: literal(scoped.targetPort, 1053),
      peer: peer(scoped.peer),
      platformHosts,
    });
    endpoint(scopedDns.clusterIP, scopedDns.servicePort);
    const gatewayResolvers = Object.freeze(
      list(data.gatewayResolvers, 1, 3).map((item) => {
        const resolver = record(item, ["peer", "address", "port"]);
        const result = Object.freeze({
          peer: peer(resolver.peer),
          address: address(resolver.address),
          port: port(resolver.port),
        });
        endpoint(result.address, result.port);
        return result;
      }),
    );
    const db = Object.freeze({ address: address(database.address), port: port(database.port) });
    endpoint(db.address, db.port);
    const cidrs = list(data.upstreamHttpsCidrs, 1, 64).map(publicCidr);
    if (new Set(cidrs).size !== cidrs.length) failure();
    const platformFlows = Object.freeze(
      list(data.platformFlows, 0, 32).map((item) => {
        const flow = record(item, ["caller", "purpose", "peer", "address", "port"]);
        const caller = text(flow.caller);
        const purpose = text(flow.purpose);
        if (caller !== "agent" && caller !== "agent-gateway") failure();
        if (purpose !== "model" && purpose !== "control" && purpose !== "identity-bootstrap")
          failure();
        const result = Object.freeze({
          caller,
          purpose,
          peer: peer(flow.peer),
          address: address(flow.address),
          port: port(flow.port),
        });
        endpoint(result.address, result.port);
        return result;
      }),
    );
    return Object.freeze({
      kind: literal(data.kind, "credential-gateway-network-v1"),
      profile: literal(data.profile, MEDIATED_NETWORK_PROFILE),
      binding: bindingData,
      agent: ownedPeer(data.agent, "agent", bindingData),
      agentGateway: ownedPeer(data.agentGateway, "gateway", bindingData),
      credentialGateway,
      gatewayService,
      scopedDns,
      gatewayResolvers,
      database: db,
      upstreamHttpsCidrs: Object.freeze(cidrs),
      platformFlows,
      harness: Object.freeze({
        protocol: literal(harness.protocol, "TCP"),
        port: literal(harness.port, 18790),
      }),
      publicCa: Object.freeze({
        configMapName: dns(ca.configMapName),
        key: literal(ca.key, "ca.crt"),
        sha256: caDigest,
      }),
    });
  } catch {
    return failure();
  }
}
