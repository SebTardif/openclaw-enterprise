import type { IncomingMessage } from "node:http";

type RouteKind = "metadata" | "fetch-discovery" | "fetch" | "push-discovery" | "push" | "pr-create";
type Route = Readonly<{
  kind: RouteKind;
  host: "github.com" | "api.github.com";
  method: "GET" | "POST";
  owner: string;
  repository: string;
  rawTarget: string;
}>;
type Framing =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "content-length"; bytes: number }>
  | Readonly<{ kind: "chunked" }>;
export type ParsedRequestHeadV1 = Readonly<{
  route: Route;
  framing: Framing;
  contentEncoding: "identity" | "gzip";
  expectContinue: boolean;
  gitProtocol: "version=2" | null;
  operationId: string | null;
  bodyLimits: Readonly<{ wire: number; decoded: number }>;
}>;
type Result =
  | { kind: "parsed"; head: ParsedRequestHeadV1 }
  | {
      kind: "denied";
      status: 400 | 413 | 415 | 431;
      code: "unsupported-request" | "limit-exceeded";
    };
const HEADER_LIMIT = 32768;
const COMMON = new Set([
  "host",
  "authorization",
  "user-agent",
  "accept",
  "accept-encoding",
  "connection",
]);
const POST = new Set([
  "content-type",
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "expect",
]);
const NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const VALUE = /^[\x20-\x7e]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function deny(status: 400 | 413 | 415 | 431 = 400): Result {
  return {
    kind: "denied",
    status,
    code: status === 413 || status === 431 ? "limit-exceeded" : "unsupported-request",
  };
}
function routeFor(host: Route["host"], method: Route["method"], rawTarget: string): Route | null {
  let matched: RegExpExecArray | null;
  let kind: RouteKind;
  if (host === "api.github.com") {
    matched = /^\/repos\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)(\/pulls)?$/.exec(rawTarget);
    if (!matched || (matched[3] ? method !== "POST" : method !== "GET")) return null;
    kind = matched[3] ? "pr-create" : "metadata";
  } else {
    matched =
      /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\.git\/(info\/refs\?service=git-(upload|receive)-pack|git-(upload|receive)-pack)$/.exec(
        rawTarget,
      );
    if (!matched) return null;
    const discovery = matched[4] !== undefined;
    if (method !== (discovery ? "GET" : "POST")) return null;
    const fetch = (matched[4] ?? matched[5]) === "upload";
    if (discovery) kind = fetch ? "fetch-discovery" : "push-discovery";
    else kind = fetch ? "fetch" : "push";
  }
  const owner = matched[1];
  const repository = matched[2];
  if (!owner || !repository || repository === "." || repository === "..") return null;
  return Object.freeze({ kind, host, method, owner, repository, rawTarget });
}

/** Inspect untrusted native HTTP candidates; this neither authenticates nor reads a body. */
export function inspectRequestHeadV1(request: IncomingMessage): Result {
  if (request === null || typeof request !== "object") return deny();
  const { method, url, httpVersion, rawHeaders } = request;
  if (
    httpVersion !== "1.1" ||
    (method !== "GET" && method !== "POST") ||
    typeof url !== "string" ||
    !Array.isArray(rawHeaders)
  )
    return deny();
  if (url.length > HEADER_LIMIT) return deny(413);
  if (!url.startsWith("/") || !/^[\x21-\x7e]+$/.test(url) || /[%\\#]/.test(url)) return deny();
  if (rawHeaders.length % 2 !== 0) return deny();
  if (rawHeaders.length > 128) return deny(431);
  let retainedBytes = 0;
  const headers = new Map<string, string>();
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    const value = rawHeaders[i + 1];
    if (
      typeof name !== "string" ||
      typeof value !== "string" ||
      !NAME.test(name) ||
      !VALUE.test(value)
    )
      return deny();
    retainedBytes += name.length + value.length;
    if (retainedBytes > HEADER_LIMIT) return deny(431);
    const key = name.toLowerCase();
    if (headers.has(key)) return deny();
    headers.set(key, value);
  }
  const hostValue = headers.get("host")?.toLowerCase();
  if (
    hostValue !== "github.com" &&
    hostValue !== "github.com:443" &&
    hostValue !== "api.github.com" &&
    hostValue !== "api.github.com:443"
  )
    return deny();
  const host = hostValue.startsWith("api.") ? "api.github.com" : "github.com";
  const route = routeFor(host, method, url);
  if (!route) return deny();
  for (const key of headers.keys()) {
    const git = host === "github.com" && (key === "pragma" || key === "git-protocol");
    const operation = route.kind === "pr-create" && key === "x-oce-operation-id";
    // GET permits only an explicit zero length, never body interpretation headers.
    if (
      !COMMON.has(key) &&
      !git &&
      !operation &&
      !(method === "POST" && POST.has(key)) &&
      !(method === "GET" && key === "content-length")
    )
      return deny();
  }
  const connection = headers.get("connection")?.toLowerCase();
  if (connection !== undefined && connection !== "close" && connection !== "keep-alive")
    return deny();
  if (headers.has("pragma") && headers.get("pragma") !== "no-cache") return deny();
  const protocol = headers.get("git-protocol");
  if (protocol !== undefined && protocol !== "version=2") return deny();
  const operationId = headers.get("x-oce-operation-id") ?? null;
  if (route.kind === "pr-create" && (operationId === null || !UUID.test(operationId)))
    return deny();
  let bodyCap = 0;
  if (route.kind === "push") bodyCap = 268435456;
  else if (route.kind === "pr-create") bodyCap = 65536;
  else if (method === "POST") bodyCap = 1048576;
  const length = headers.get("content-length");
  const transfer = headers.get("transfer-encoding");
  if (length !== undefined && transfer !== undefined) return deny();
  let framing: Framing = Object.freeze({ kind: "none" });
  if (length !== undefined) {
    if (!/^(0|[1-9][0-9]*)$/.test(length)) return deny();
    const bytes = Number(length);
    if (!Number.isSafeInteger(bytes)) return deny();
    if (method === "GET" && bytes !== 0) return deny();
    if (bytes > bodyCap) return deny(413);
    framing = Object.freeze({ kind: "content-length", bytes });
  } else if (transfer !== undefined) {
    if (method !== "POST" || transfer.toLowerCase() !== "chunked") return deny();
    framing = Object.freeze({ kind: "chunked" });
  } else if (method === "POST") return deny();
  let expectedType = "application/json";
  if (route.kind === "fetch") expectedType = "application/x-git-upload-pack-request";
  else if (route.kind === "push") expectedType = "application/x-git-receive-pack-request";
  if (method === "POST" && headers.get("content-type") !== expectedType) return deny(415);
  const coding = headers.get("content-encoding") ?? "identity";
  if (coding !== "identity" && !(coding === "gzip" && host === "github.com" && method === "POST"))
    return deny(415);
  const expect = headers.get("expect");
  if (expect !== undefined && (method !== "POST" || expect.toLowerCase() !== "100-continue"))
    return deny();
  return {
    kind: "parsed",
    head: Object.freeze({
      route,
      framing,
      contentEncoding: coding,
      expectContinue: expect !== undefined,
      gitProtocol: protocol === "version=2" ? protocol : null,
      operationId,
      bodyLimits: Object.freeze({ wire: bodyCap, decoded: bodyCap }),
    }),
  };
}
