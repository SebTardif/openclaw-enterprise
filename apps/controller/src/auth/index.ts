import { isNonEmptyString } from "@openclaw-enterprise/utils";
import { createHash, randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { APIError, betterAuth, type Auth, type BetterAuthOptions } from "better-auth";
import { splitSetCookieHeader } from "better-auth/cookies";
import { memoryAdapter, type MemoryDB } from "better-auth/adapters/memory";
import { apiKey } from "@better-auth/api-key";
import type { ApiKey } from "@better-auth/api-key/types";
import type { ServicePrincipal } from "@openclaw-enterprise/contracts";
import { createAuthPrincipalSeed, type AuthPrincipalSeed } from "@openclaw-enterprise/iam";
import type { PostgresPool } from "@openclaw-enterprise/occ";
import { createPostgresAuthBinding } from "@openclaw-enterprise/occ/auth-persistence/postgres-auth-binding";
import type {
  AdmissionHeaders,
  AdmissionRequest,
  AdmissionVerifier,
  AdmittedCaller,
} from "../admission/admission-verifier.ts";
import { AdmissionFailure } from "../admission/admission-verifier.ts";
import {
  createSignInQuota,
  MemorySignInQuotaStore,
  PostgresSignInQuotaStore,
  SignInQuotaFailure,
  type SignInQuotaStore,
} from "./sign-in-quota.ts";
import { durableSessionRevocation, safeAuthDependencyLogger } from "./storage-failures.ts";
import {
  captureControllerSessionValuesV1,
  createControllerWorkloadProfileRequestCustodyV1,
  type ControllerVerifiedSessionV1,
  type ControllerWorkloadProfileRequestCustodyV1,
} from "./workload-profile-request.ts";

export const OCC_BETTER_AUTH_ISSUER_PREFIX = "occ:installation:";
export const OCC_AUTH_COOKIE_PREFIX = "openclaw_occ";
export const OCC_SERVICE_KEY_HEADER = "x-api-key";
const SERVICE_KEY_CONFIG = "occ-service";
type ControllerAuthPlugins = (ReturnType<typeof apiKey> | typeof durableSessionRevocation)[];
type ControllerBetterAuth = Auth<BetterAuthOptions & { plugins: ControllerAuthPlugins }>;

export interface ServiceKey {
  readonly id: string;
  readonly servicePrincipalId: string;
  readonly namespaceId?: string;
  readonly name: string;
  readonly expiresAt: string;
}

export interface ControllerAuthOptions {
  readonly mode: "development" | "production";
  readonly installationId: string;
  readonly baseURL: string;
  readonly secret: string;
  readonly database?: BetterAuthOptions["database"];
  readonly memoryDatabase?: MemoryDB;
  readonly secureCookies?: boolean;
  readonly signInQuotaStore?: SignInQuotaStore;
}

export interface PostgresControllerAuthOptions extends Omit<
  ControllerAuthOptions,
  "database" | "memoryDatabase"
> {
  readonly pool: PostgresPool;
}

export interface AuthenticatedAccount {
  readonly id: string;
  readonly email: string;
  readonly name: string;
}

export interface ProvisionAuthAccountInput {
  readonly email: string;
  readonly password: string;
  readonly name?: string;
}

export { AuthAccountRoleNotFoundError, type AuthPrincipalSeed } from "@openclaw-enterprise/iam";

export interface AuthPrincipalSeedOptions {
  readonly roleId?: string;
}

export interface ControllerAuth {
  readonly auth: ControllerBetterAuth;
  readonly issuer: string;
  readonly admissionVerifier: ControllerAdmissionVerifier;
  createAccount(input: ProvisionAuthAccountInput): Promise<AuthenticatedAccount>;
  deleteAccount(account: Pick<AuthenticatedAccount, "id">): Promise<void>;
  principalSeed(
    account: Pick<AuthenticatedAccount, "id">,
    options?: AuthPrincipalSeedOptions,
  ): AuthPrincipalSeed;
  signInEmail(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  signOut(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  session(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  createServiceKey(input: {
    readonly principal: ServicePrincipal;
    readonly name: string;
    readonly expiresIn?: number;
  }): Promise<ServiceKey & { readonly key: string }>;
  getServiceKey(id: string): Promise<ServiceKey | undefined>;
  revokeServiceKey(key: ServiceKey): Promise<void>;
}

function validHttpBaseURL(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.username.length === 0 &&
      parsed.password.length === 0 &&
      parsed.hash.length === 0
    );
  } catch {
    return false;
  }
}

export function betterAuthIssuer(installationId: string): string {
  if (!isNonEmptyString(installationId))
    throw new Error("Better Auth issuer requires an Installation.");
  return `${OCC_BETTER_AUTH_ISSUER_PREFIX}${installationId}:better-auth`;
}

function authHeaders(headers: AdmissionHeaders | FastifyRequest["headers"] | undefined): Headers {
  if (headers instanceof Headers) return new Headers(headers);
  const prepared = new Headers();
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value === undefined) continue;
    if (typeof value === "string") {
      prepared.set(name, value);
      continue;
    }
    for (const entry of value) prepared.append(name, entry);
  }
  return prepared;
}

function setAuthHeaders(reply: FastifyReply, headers?: Headers | null): void {
  if (!headers) return;
  const cookies: string[] = [];
  headers.forEach((value, name) => {
    if (name.toLowerCase() === "set-cookie") {
      cookies.push(...splitSetCookieHeader(value));
      return;
    }
    reply.header(name, value);
  });
  if (cookies.length > 0) reply.header("set-cookie", cookies);
}

function authFailure(error: unknown): {
  readonly status: number;
  readonly code: string;
  readonly retryAfter?: number;
} {
  if (error instanceof SignInQuotaFailure) return error;
  if (error instanceof AdmissionFailure) return { status: error.status, code: error.code };
  if (error instanceof APIError || (typeof error === "object" && error !== null)) {
    const candidate = error as Record<string, unknown>;
    const status =
      error instanceof APIError ? error.statusCode : (candidate.statusCode ?? candidate.status);
    if (typeof status === "number" && Number.isSafeInteger(status) && status >= 400 && status < 500)
      return {
        status,
        code:
          status === 401 ? "UNAUTHENTICATED" : status === 409 ? "RESOURCE_CONFLICT" : "FORBIDDEN",
      };
    if (error instanceof APIError) return { status: 401, code: "UNAUTHENTICATED" };
  }
  return { status: 503, code: "DEPENDENCY_UNAVAILABLE" };
}

function authBody(request: FastifyRequest): Record<string, unknown> {
  return typeof request.body === "object" && request.body !== null && !Array.isArray(request.body)
    ? (request.body as Record<string, unknown>)
    : {};
}

function ensureEmailPassword(input: Record<string, unknown>): { email: string; password: string } {
  const { email, password } = input;
  if (!isNonEmptyString(email) || !isNonEmptyString(password))
    throw new AdmissionFailure(401, "UNAUTHENTICATED", "Email and password are required.");
  return { email, password };
}

function requireTrustedBrowserOrigin(request: FastifyRequest, expectedOrigin: string): void {
  const origin = request.headers.origin;
  if (Array.isArray(origin)) {
    throw new AdmissionFailure(403, "FORBIDDEN", "The browser origin is not trusted.");
  }
  if (origin !== undefined) {
    if (origin !== expectedOrigin) {
      throw new AdmissionFailure(403, "FORBIDDEN", "The browser origin is not trusted.");
    }
    return;
  }

  if (request.headers["sec-fetch-site"] === "cross-site") {
    throw new AdmissionFailure(403, "FORBIDDEN", "The browser origin is not trusted.");
  }
}

function accountName(input: ProvisionAuthAccountInput): string {
  return input.name?.trim() || input.email.trim();
}

function safeSessionResponse(response: unknown): {
  readonly authenticated: true;
  readonly user: { readonly id: string; readonly email: string; readonly name: string };
} | null {
  if (typeof response !== "object" || response === null) return null;
  const { session, user } = response as { readonly session?: unknown; readonly user?: unknown };
  if (!session || typeof user !== "object" || user === null) return null;
  const { id, email, name } = user as Record<string, unknown>;
  if (!isNonEmptyString(id) || !isNonEmptyString(email) || !isNonEmptyString(name)) return null;
  return {
    authenticated: true,
    user: { id, email, name },
  };
}

async function sendAuthEndpoint(
  request: FastifyRequest,
  reply: FastifyReply,
  run: () => Promise<{
    readonly response?: unknown;
    readonly headers?: Headers | null;
    readonly status?: number;
  } | null>,
  data: (response: unknown) => unknown,
  failureMessage: string,
): Promise<void> {
  try {
    const result = await run();
    setAuthHeaders(reply, result?.headers);
    reply.status(result?.status ?? 200).send({
      data: data(result?.response ?? null),
      meta: { requestId: request.id },
    });
  } catch (error) {
    const failure = authFailure(error);
    if (failure.retryAfter !== undefined) reply.header("retry-after", failure.retryAfter);
    reply.status(failure.status).send({
      error: { code: failure.code, message: failureMessage },
      meta: { requestId: request.id },
    });
  }
}

async function createOccAuthDatabase(
  pool: PostgresPool,
): Promise<NonNullable<BetterAuthOptions["database"]>> {
  const binding = await createPostgresAuthBinding(pool);
  const { drizzleAdapter } = await import("better-auth/adapters/drizzle");
  return drizzleAdapter(binding.database, {
    provider: "pg",
    schema: binding.schema,
    camelCase: true,
    transaction: true,
  });
}

export class ControllerAdmissionVerifier implements AdmissionVerifier {
  readonly #auth: ControllerBetterAuth;
  readonly #installationId: string;
  readonly #issuer: string;
  readonly #verifiedSessions = new WeakMap<AdmittedCaller, Readonly<ControllerVerifiedSessionV1>>();
  readonly #readExpiries = new WeakMap<
    AdmittedCaller,
    {
      readonly assertUnexpired: () => void;
      readonly remainingMs: () => number;
    }
  >();
  #workloadProfileCustody: ControllerWorkloadProfileRequestCustodyV1 | undefined;

  /** Actual verifier-issued expiry only. This is neither an IAM decision nor a
   * mutation lease. The lifecycle receiver keeps the original request ceiling. */
  async verifyLifecycleReadV1(request: AdmissionRequest) {
    const admitted = await this.verify(request);
    const expiry = this.consumeLifecycleReadExpiryV1(admitted);
    if (admitted.method === "session") {
      const context = await this.#auth.$context;
      const accounts = await context.adapter.findMany<{
        id: string;
        userId: string;
        accountId: string;
        providerId: string;
        password?: string | null;
      }>({
        model: "account",
        where: [
          { field: "userId", value: admitted.externalIdentity.subject },
          { field: "providerId", value: "credential" },
        ],
        limit: 2,
      });
      // Same auth-owned primary adapter and original local-credential relation.
      // A retained session on a user returned to provisioning is insufficient.
      // No credential bytes leave this verifier or enter an error/receipt.
      if (
        accounts.length !== 1 ||
        !isNonEmptyString(accounts[0]?.id) ||
        accounts[0]?.userId !== admitted.externalIdentity.subject ||
        accounts[0]?.accountId !== admitted.externalIdentity.subject ||
        accounts[0]?.providerId !== "credential" ||
        !isNonEmptyString(accounts[0]?.password)
      )
        throw new AdmissionFailure(
          401,
          "UNAUTHENTICATED",
          "The current local account is unavailable.",
        );
    }
    expiry.assertUnexpired();
    return Object.freeze({ admitted, ...expiry });
  }

  consumeLifecycleReadExpiryV1(admitted: AdmittedCaller) {
    const expiry = this.#readExpiries.get(admitted);
    this.#readExpiries.delete(admitted);
    if (!expiry)
      throw new AdmissionFailure(
        401,
        "UNAUTHENTICATED",
        "Current authentication expiry is unavailable.",
      );
    expiry.assertUnexpired();
    return expiry;
  }

  private retainReadExpiry(
    admitted: AdmittedCaller,
    value: unknown,
    began: bigint,
    observedAt: number,
  ): void {
    const expiry =
      value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : NaN;
    const now = Date.now();
    if (!Number.isFinite(expiry) || expiry <= now) return;
    // Both observations can only shorten the original duration. A wall clock
    // rollback while the primary-store lookup waits never renews authentication.
    const original = began + BigInt(Math.max(0, Math.floor(expiry - observedAt))) * 1_000_000n;
    const current =
      process.hrtime.bigint() + BigInt(Math.max(0, Math.floor(expiry - now))) * 1_000_000n;
    const deadline = original < current ? original : current;
    const assertUnexpired = () => {
      if (process.hrtime.bigint() >= deadline || Date.now() >= expiry)
        throw new AdmissionFailure(401, "UNAUTHENTICATED", "The current authentication expired.");
    };
    this.#readExpiries.set(
      admitted,
      Object.freeze({
        assertUnexpired,
        remainingMs: () => {
          assertUnexpired();
          return Math.max(0, Math.floor(Number(deadline - process.hrtime.bigint()) / 1_000_000));
        },
      }),
    );
  }

  createWorkloadProfileRequestCustodyV1(
    options: Readonly<{ maxRequestLifetimeMs: number }>,
  ): ControllerWorkloadProfileRequestCustodyV1 {
    if (this.#workloadProfileCustody)
      throw new Error("The original request custody already exists.");
    const source = createControllerWorkloadProfileRequestCustodyV1(
      { installationId: this.#installationId, maxRequestLifetimeMs: options.maxRequestLifetimeMs },
      (admitted) => {
        const session = this.#verifiedSessions.get(admitted);
        this.#verifiedSessions.delete(admitted);
        return session;
      },
    );
    this.#workloadProfileCustody = source;
    return source;
  }

  constructor(auth: ControllerBetterAuth, installationId: string) {
    this.#auth = auth;
    this.#installationId = installationId;
    this.#issuer = betterAuthIssuer(installationId);
  }

  async verify(request: AdmissionRequest): Promise<AdmittedCaller> {
    const began = process.hrtime.bigint();
    const observedAt = Date.now();
    if (request.authorizationHeader !== undefined) {
      throw new AdmissionFailure(
        401,
        "UNAUTHENTICATED",
        "Controller API bearer authentication is disabled.",
      );
    }
    if (request.requestedScope.installationId !== this.#installationId) {
      throw new AdmissionFailure(403, "FORBIDDEN", "The admitted Installation does not match.");
    }

    const headers = authHeaders(request.headers);
    // An explicitly supplied key never falls back to a potentially more privileged cookie.
    if (headers.has(OCC_SERVICE_KEY_HEADER)) {
      const result = await this.#auth.api.verifyApiKey({
        body: { key: headers.get(OCC_SERVICE_KEY_HEADER)!, configId: SERVICE_KEY_CONFIG },
      });
      if (!result.valid || !result.key)
        throw new AdmissionFailure(401, "UNAUTHENTICATED", "A valid service API key is required.");
      const key = serviceKeyDetails(result.key, this.#installationId);
      if (!key)
        throw new AdmissionFailure(401, "UNAUTHENTICATED", "A valid service API key is required.");
      const admitted: AdmittedCaller = {
        externalIdentity: {
          issuer: `${this.#issuer}:service-key`,
          subject: key.servicePrincipalId,
        },
        admittedScope: {
          installationId: this.#installationId,
          ...(key.namespaceId === undefined ? {} : { namespaceId: key.namespaceId }),
        },
        decisionId: `adm_${randomUUID()}`,
        method: "api_key",
      };
      this.retainReadExpiry(admitted, key.expiresAt, began, observedAt);
      return admitted;
    }

    const session = await this.#auth.api.getSession({
      headers,
      query: { disableCookieCache: true, disableRefresh: true },
      asResponse: false,
      returnHeaders: true,
    });
    const response = session && "response" in session ? session.response : session;
    if (!response?.session || !isNonEmptyString(response.user?.id)) {
      throw new AdmissionFailure(401, "UNAUTHENTICATED", "A valid controller session is required.");
    }

    const accountId = response.user.id;
    const admitted: AdmittedCaller = {
      externalIdentity: { issuer: this.#issuer, subject: accountId },
      admittedScope: {
        installationId: this.#installationId,
        ...(request.requestedScope.namespaceId === undefined
          ? {}
          : { namespaceId: request.requestedScope.namespaceId }),
      },
      decisionId: `adm_${randomUUID()}`,
      method: "session" as const,
    };
    // Keep the public admission result unchanged. Only a complete genuine
    // primary-store session can seed the private workload-profile receiver.
    // Missing fields preserve ordinary admission but supply no such proof.
    if (this.#workloadProfileCustody) {
      try {
        const sessionId = response.session.id;
        const sessionUserId = response.session.userId;
        const expiry = response.session.expiresAt;
        const sessionToken = response.session.token;
        if (
          isNonEmptyString(sessionId) &&
          isNonEmptyString(sessionUserId) &&
          isNonEmptyString(sessionToken)
        ) {
          const expiresAt = new Date(expiry).toISOString();
          const captured = captureControllerSessionValuesV1({
            installationId: this.#installationId,
            issuer: this.#issuer,
            accountId,
            sessionId,
            sessionUserId,
            expiresAt,
            sessionCredentialDigest: createHash("sha256")
              .update(sessionToken, "utf8")
              .digest("hex"),
            requestId: request.requestId,
            routeId: request.routeId,
            method: request.method,
          });
          this.#verifiedSessions.set(admitted, captured);
        }
      } catch {
        // No credential/source exception is exposed and no partial proof is kept.
      }
    }
    this.retainReadExpiry(admitted, response.session.expiresAt, began, observedAt);
    return admitted;
  }
}

function serviceKeyDetails(
  key: Pick<ApiKey, "id" | "configId" | "referenceId" | "metadata" | "name" | "expiresAt">,
  installationId: string,
): ServiceKey | undefined {
  const metadata = key.metadata as Record<string, unknown> | null;
  if (
    key.configId !== SERVICE_KEY_CONFIG ||
    !isNonEmptyString(key.referenceId) ||
    metadata?.installationId !== installationId ||
    (metadata.namespaceId !== undefined && !isNonEmptyString(metadata.namespaceId)) ||
    !isNonEmptyString(key.name) ||
    !key.expiresAt
  )
    return undefined;
  return {
    id: key.id,
    servicePrincipalId: key.referenceId,
    ...(metadata.namespaceId === undefined ? {} : { namespaceId: metadata.namespaceId as string }),
    name: key.name,
    expiresAt: new Date(key.expiresAt).toISOString(),
  };
}

export function createControllerAuth(options: ControllerAuthOptions): ControllerAuth {
  if (options.mode !== "development" && options.mode !== "production")
    throw new Error("Controller auth requires an explicit runtime mode.");
  if (!isNonEmptyString(options.secret) || options.secret.length < 32)
    throw new Error("OCC_AUTH_SECRET must contain at least 256 bits of secret material.");
  if (!validHttpBaseURL(options.baseURL)) throw new Error("OCC_AUTH_BASE_URL must be an HTTP URL.");

  const expectedBrowserOrigin = new URL(options.baseURL).origin;
  const issuer = betterAuthIssuer(options.installationId);
  if (options.database && !options.signInQuotaStore)
    throw new Error("Persistent authentication requires a shared sign-in quota store.");
  const reserveSignIn = createSignInQuota(
    options.signInQuotaStore ?? new MemorySignInQuotaStore(),
    options.secret,
    options.installationId,
  );
  const auth = betterAuth<BetterAuthOptions & { plugins: ControllerAuthPlugins }>({
    appName: "OpenClaw Enterprise Controller",
    baseURL: options.baseURL,
    basePath: "/auth",
    secret: options.secret,
    logger: safeAuthDependencyLogger,
    database:
      options.database ??
      memoryAdapter(
        options.memoryDatabase ?? {
          user: [],
          session: [],
          account: [],
          verification: [],
          apikey: [],
        },
      ),
    plugins: [
      durableSessionRevocation,
      apiKey({
        configId: SERVICE_KEY_CONFIG,
        defaultPrefix: "occ_",
        enableMetadata: true,
        enableSessionForAPIKeys: false,
        requireName: true,
        rateLimit: { enabled: false },
        keyExpiration: { defaultExpiresIn: 30 * 24 * 60 * 60 },
      }),
    ],
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      requireEmailVerification: false,
      minPasswordLength: 12,
      maxPasswordLength: 128,
    },
    trustedOrigins: [options.baseURL],
    rateLimit: { enabled: true },
    advanced: {
      cookiePrefix: OCC_AUTH_COOKIE_PREFIX,
      defaultCookieAttributes: {
        httpOnly: true,
        path: "/",
        sameSite: "lax",
        secure: options.secureCookies ?? options.mode === "production",
      },
    },
  });
  const api = auth.api;

  async function createAccount(input: ProvisionAuthAccountInput): Promise<AuthenticatedAccount> {
    const email = input.email.trim().toLowerCase();
    const password = input.password;
    if (!isNonEmptyString(email) || !isNonEmptyString(password))
      throw new Error("Account creation requires email and password.");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
      throw APIError.from("BAD_REQUEST", {
        code: "INVALID_EMAIL",
        message: "Email must be a valid address.",
      });
    const context = await auth.$context;
    if (password.length < context.password.config.minPasswordLength)
      throw APIError.from("BAD_REQUEST", {
        code: "PASSWORD_TOO_SHORT",
        message: "Password is too short.",
      });
    if (password.length > context.password.config.maxPasswordLength)
      throw APIError.from("BAD_REQUEST", {
        code: "PASSWORD_TOO_LONG",
        message: "Password is too long.",
      });
    const existing = await context.internalAdapter.findUserByEmail(email);
    if (existing?.user) {
      await context.password.hash(password);
      throw APIError.fromStatus("CONFLICT", {
        code: "USER_ALREADY_EXISTS",
        message: "The requested account already exists.",
      });
    }
    const hash = await context.password.hash(password);
    const created = await context.internalAdapter.createUser({
      email,
      name: accountName({ ...input, email }),
      emailVerified: true,
    });
    try {
      await context.internalAdapter.linkAccount({
        userId: created.id,
        providerId: "credential",
        accountId: created.id,
        password: hash,
      });
    } catch (error) {
      await context.internalAdapter.deleteUser(created.id).catch(() => {});
      throw error;
    }
    return Object.freeze({
      id: created.id,
      email: created.email,
      name: created.name,
    });
  }

  async function deleteAccount(account: Pick<AuthenticatedAccount, "id">): Promise<void> {
    const context = await auth.$context;
    await context.internalAdapter.deleteUser(account.id);
  }

  async function signInEmail(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await sendAuthEndpoint(
      request,
      reply,
      async () => {
        // Better Auth server API calls skip origin middleware without a Request context.
        requireTrustedBrowserOrigin(request, expectedBrowserOrigin);
        const input = authBody(request);
        // The direct Better Auth API also skips its HTTP rate hooks. Admit before
        // any account lookup/password work, using only the actual transport peer.
        await reserveSignIn(request.raw.socket.remoteAddress, input.email);
        const body = ensureEmailPassword(input);
        return api.signInEmail({
          body: { ...body, email: body.email.trim().toLowerCase(), rememberMe: true },
          headers: authHeaders(request.headers),
          asResponse: false,
          returnHeaders: true,
          returnStatus: true,
        });
      },
      () => ({ authenticated: true }),
      "The caller did not provide valid authentication credentials.",
    );
  }

  async function signOut(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await sendAuthEndpoint(
      request,
      reply,
      () => {
        // Better Auth server API calls skip origin middleware without a Request context.
        requireTrustedBrowserOrigin(request, expectedBrowserOrigin);
        return api.signOut({
          headers: authHeaders(request.headers),
          asResponse: false,
          returnHeaders: true,
          returnStatus: true,
        });
      },
      (response) => response,
      "The controller session could not be revoked.",
    );
  }

  async function session(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await sendAuthEndpoint(
      request,
      reply,
      () =>
        api.getSession({
          headers: authHeaders(request.headers),
          query: { disableCookieCache: true, disableRefresh: true },
          asResponse: false,
          returnHeaders: true,
          returnStatus: true,
        }),
      safeSessionResponse,
      "The controller session could not be resolved.",
    );
  }

  return {
    auth,
    issuer,
    admissionVerifier: new ControllerAdmissionVerifier(auth, options.installationId),
    createAccount,
    deleteAccount,
    principalSeed: (
      account: Pick<AuthenticatedAccount, "id">,
      seedOptions?: AuthPrincipalSeedOptions,
    ) =>
      createAuthPrincipalSeed(
        options.installationId,
        betterAuthIssuer(options.installationId),
        account,
        seedOptions,
      ),
    signInEmail,
    signOut,
    session,
    async createServiceKey({ principal, name, expiresIn }) {
      // The server-only userId parameter is the plugin's referenceId; no human
      // account or session is created for this existing IAM automation identity.
      const created = await api.createApiKey({
        body: {
          configId: SERVICE_KEY_CONFIG,
          userId: principal.id,
          name,
          ...(expiresIn === undefined ? {} : { expiresIn }),
          metadata: {
            installationId: options.installationId,
            ...(principal.namespaceId === undefined ? {} : { namespaceId: principal.namespaceId }),
          },
        },
      });
      return { ...serviceKeyDetails(created, options.installationId)!, key: created.key };
    },
    async getServiceKey(id) {
      const context = await auth.$context;
      const key = await context.adapter.findOne<ApiKey>({
        model: "apikey",
        where: [{ field: "id", value: id }],
      });
      return key ? serviceKeyDetails(key, options.installationId) : undefined;
    },
    async revokeServiceKey(key) {
      // Better Auth recommends direct storage deletion for server-managed
      // revocation. Deletion also prevents a concurrent verification update
      // from restoring a previously read enabled=true value.
      const context = await auth.$context;
      await context.adapter.delete({
        model: "apikey",
        where: [
          { field: "id", value: key.id },
          { field: "configId", value: SERVICE_KEY_CONFIG },
          { field: "referenceId", value: key.servicePrincipalId },
        ],
      });
    },
  };
}

export async function createPostgresControllerAuth(
  options: PostgresControllerAuthOptions,
): Promise<ControllerAuth> {
  const { pool, ...controllerOptions } = options;
  return createControllerAuth({
    ...controllerOptions,
    database: await createOccAuthDatabase(pool),
    signInQuotaStore: new PostgresSignInQuotaStore(pool),
  });
}
