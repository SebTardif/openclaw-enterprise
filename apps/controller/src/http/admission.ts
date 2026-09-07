import { isNonEmptyString } from "@openclaw-enterprise/utils";
import type { OccApiRoute } from "@openclaw-enterprise/contracts/api/routes";
import type { FastifyRequest } from "fastify";
import type { AdmittedCaller, AdmissionVerifier } from "../admission/admission-verifier.ts";
import { OCC_SERVICE_KEY_HEADER } from "../auth/index.ts";
import type { ControllerWorkloadProfileRequestCustodyV1 } from "../auth/workload-profile-request.ts";
import { failure, requestFailure } from "./errors.ts";

export interface DevelopmentAdmission {
  readonly enabled: boolean;
  readonly installationId?: string;
  readonly trustedCidrs?: readonly string[];
}

export const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
export const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
export const RESOURCE_ID = {
  namespaceId: /^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  configurationId: /^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  serviceAccountId: /^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  secretId: /^sec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  agentId: /^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  revisionId: /^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
} as const;

export function ipv4(value: string): number | undefined {
  const parts = value.split(".");
  if (parts.length !== 4) return undefined;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    result = (result << 8) | octet;
  }
  return result >>> 0;
}

export function cidrContains(cidr: string, address: string): boolean {
  const [network, prefixText] = cidr.split("/");
  if (network === undefined || prefixText === undefined || cidr.split("/").length !== 2)
    throw new Error("Development trusted CIDRs must use IPv4 CIDR notation.");
  const prefix = Number(prefixText);
  if (!/^\d+$/.test(prefixText) || !Number.isInteger(prefix) || prefix < 0 || prefix > 32)
    throw new Error("Development trusted CIDRs must use IPv4 CIDR notation.");
  const networkValue = ipv4(network);
  const addressValue = ipv4(address);
  if (networkValue === undefined)
    throw new Error("Development trusted CIDRs must use IPv4 CIDR notation.");
  if (addressValue === undefined) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (networkValue & mask) === (addressValue & mask);
}

export function trustedDevelopmentAddress(
  development: DevelopmentAdmission,
  remoteAddress: string,
): boolean {
  if (LOOPBACK_ADDRESSES.has(remoteAddress)) return true;
  const cidrs = development.trustedCidrs ?? [];
  if (cidrs.length === 0) return false;
  const normalized = remoteAddress.startsWith("::ffff:")
    ? remoteAddress.slice("::ffff:".length)
    : remoteAddress;
  return cidrs.some((cidr) => cidrContains(cidr, normalized));
}

export function validateTrustedDevelopmentCidrs(development: DevelopmentAdmission): void {
  for (const cidr of development.trustedCidrs ?? []) {
    cidrContains(cidr, "127.0.0.1");
  }
}

export type AdmissionProfile = "ordinary" | "bootstrap" | "auth" | "runtime-service";
export interface HttpAdmissionOptions {
  readonly development: DevelopmentAdmission;
  readonly installationId: string;
  readonly publicOrigin?: string;
  readonly verifyAdmission: AdmissionVerifier["verify"];
  readonly admissions: WeakMap<FastifyRequest, AdmittedCaller>;
  /** The same original source already captured by controller construction. */
  readonly workloadProfileRequests?: Pick<
    ControllerWorkloadProfileRequestCustodyV1,
    "beginRequest" | "captureAdmission" | "closeRequest"
  >;
  readonly denial: (
    operation: OccApiRoute,
    request: FastifyRequest,
    kind: "authorization_denial",
  ) => Promise<void>;
}

export function createHttpAdmission(options: HttpAdmissionOptions) {
  const { development, installationId, publicOrigin, admissions, denial } = options;
  const dependencyUnavailable = () =>
    failure(503, "DEPENDENCY_UNAVAILABLE", "A required platform dependency is unavailable.");
  function requireBrowserIntent(request: FastifyRequest, requireOrigin: boolean): void {
    const admitted = admissions.get(request);
    if (admitted?.method === "api_key") return;
    const fetchSite = request.headers["sec-fetch-site"];
    const fetchSites =
      fetchSite === undefined ? [] : Array.isArray(fetchSite) ? fetchSite : [fetchSite];
    if (fetchSites.some((site) => site.toLowerCase() === "cross-site"))
      throw failure(403, "FORBIDDEN", "The request did not satisfy the configured CSRF boundary.");
    if (!requireOrigin) return;
    if (publicOrigin === undefined) throw dependencyUnavailable();
    const origin = request.headers.origin;
    if (typeof origin !== "string" || origin !== publicOrigin)
      throw failure(403, "FORBIDDEN", "The request did not satisfy the configured CSRF boundary.");
  }

  async function admit(
    request: FastifyRequest,
    operation: OccApiRoute,
    profile: AdmissionProfile,
  ): Promise<void> {
    if (
      request.headers[OCC_SERVICE_KEY_HEADER] !== undefined &&
      ((profile === "auth" && operation.operationId === ("createAuthAccount" as string)) ||
        profile === "bootstrap")
    )
      throw failure(401, "UNAUTHENTICATED", "A human controller session is required.");
    const params = request.params as Record<string, unknown>;
    const paginatedChannelList = [
      "listChannelInstallations",
      "listChannelHumanBindings",
      "listChannelAgentBindings",
    ].includes(operation.operationId);
    if (!paginatedChannelList && Object.keys(request.query as Record<string, unknown>).length > 0)
      throw failure(400, "INVALID_REQUEST", "The request does not match the operation contract.");
    for (const [parameter, pattern] of Object.entries(RESOURCE_ID)) {
      if (
        params[parameter] !== undefined &&
        (typeof params[parameter] !== "string" || !pattern.test(params[parameter] as string))
      )
        throw failure(400, "INVALID_REQUEST", "The request does not match the operation contract.");
    }

    const host = request.headers.host;
    let hostname: string;
    try {
      hostname = new URL(`http://${host ?? "127.0.0.1"}`).hostname;
    } catch {
      hostname = "";
    }
    const remoteAddress = request.raw.socket.remoteAddress ?? "127.0.0.1";
    const origin = request.headers.origin;
    let originAllowed = true;
    if (typeof origin === "string") {
      try {
        originAllowed = LOOPBACK_HOSTNAMES.has(new URL(origin).hostname);
      } catch {
        originAllowed = false;
      }
    } else if (Array.isArray(origin)) {
      originAllowed = false;
    }
    const forwarded = Object.keys(request.headers).some(
      (name) => name === "forwarded" || name === "x-real-ip" || name.startsWith("x-forwarded-"),
    );
    if (
      forwarded ||
      (development.enabled &&
        (!LOOPBACK_HOSTNAMES.has(hostname) ||
          !originAllowed ||
          !trustedDevelopmentAddress(development, remoteAddress)))
    ) {
      throw failure(
        403,
        "FORBIDDEN",
        development.enabled
          ? "Development admission is restricted to direct loopback requests."
          : "Production admission requires a direct request.",
      );
    }

    options.workloadProfileRequests?.beginRequest(request);
    try {
      let admitted: AdmittedCaller;
      try {
        admitted = await options.verifyAdmission({
          requestId: request.id,
          method: request.method,
          routeId: operation.operationId,
          requestedScope: {
            installationId,
            ...(typeof params.namespaceId === "string" ? { namespaceId: params.namespaceId } : {}),
          },
          transport: {
            remoteAddress,
            ...(request.raw.socket.localAddress === undefined
              ? {}
              : { localAddress: request.raw.socket.localAddress }),
            trustProxy: false,
          },
          ...(typeof request.headers.authorization === "string"
            ? { authorizationHeader: request.headers.authorization }
            : {}),
          headers: request.headers,
        });
      } catch (error) {
        throw requestFailure(error);
      }

      if (
        !admitted ||
        !isNonEmptyString(admitted.externalIdentity?.issuer) ||
        !isNonEmptyString(admitted.externalIdentity?.subject) ||
        !isNonEmptyString(admitted.decisionId) ||
        (admitted.method !== "session" && admitted.method !== "api_key") ||
        admitted.admittedScope?.installationId !== installationId ||
        (admitted.method === "session" &&
          admitted.admittedScope.namespaceId !== undefined &&
          admitted.admittedScope.namespaceId !== params.namespaceId)
      ) {
        await denial(operation, request, "authorization_denial");
        throw failure(
          503,
          "DEPENDENCY_UNAVAILABLE",
          "A required platform dependency is unavailable.",
        );
      }

      admissions.set(request, admitted);
      // Only verified explicit service keys can bypass browser intent. A cookie
      // mutation requires the configured exact Origin even for a bodyless POST.
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) requireBrowserIntent(request, true);
      options.workloadProfileRequests?.captureAdmission(request, admitted);
    } catch (error) {
      options.workloadProfileRequests?.closeRequest(request);
      throw error;
    }
  }

  return { admit, requireBrowserIntent };
}
