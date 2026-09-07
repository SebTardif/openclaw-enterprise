import type { FastifyInstance, FastifyRequest, HTTPMethods } from "fastify";
import type { OccApiRoute } from "@openclaw-enterprise/contracts/api/routes";
import {
  LIFECYCLE_DEPLOY_LIMITS_V2,
  parseLifecycleDeployJsonV2,
} from "@openclaw-enterprise/contracts/lifecycle-deploy-v2";
import { failure } from "./errors.ts";
import {
  createOperationRegistry,
  type BootstrapOperation,
  type OperationHandler,
  ordinaryOperations,
  type OperationHandlers,
  type RegisteredOperation,
} from "./operation-registry.ts";
import type { AdmissionProfile } from "./admission.ts";

export interface ProtectedRequestInfrastructure {
  readonly admit: (
    request: FastifyRequest,
    operation: OccApiRoute,
    profile: AdmissionProfile,
  ) => Promise<void>;
  readonly resolveIdentity: (request: FastifyRequest, operation: OccApiRoute) => Promise<void>;
}

function registerOperation(
  routes: FastifyInstance,
  entry: RegisteredOperation,
  infrastructure: ProtectedRequestInfrastructure,
  profile: "ordinary" | "bootstrap",
): void {
  const { operation, schema, handler } = entry;
  const register = (target: FastifyInstance): void => {
    target.route({
      method: operation.method as HTTPMethods,
      url: operation.path,
      ...(operation.operationId === "putAgentWorkspaceFile" ? { bodyLimit: 48 * 1024 } : {}),
      ...(operation.operationId === "deployAgent"
        ? { bodyLimit: LIFECYCLE_DEPLOY_LIMITS_V2.maxJsonBytes }
        : {}),
      schema: profile === "bootstrap" ? { ...schema, security: [{ sessionCookie: [] }] } : schema,
      onRequest: async (request) => infrastructure.admit(request, operation, profile),
      preValidation: async (request) => {
        const hasRequestBody =
          request.body !== undefined ||
          Number(request.headers["content-length"] ?? 0) > 0 ||
          request.headers["transfer-encoding"] !== undefined;
        if (!Object.hasOwn(operation.schema, "body") && hasRequestBody)
          throw failure(
            400,
            "INVALID_REQUEST",
            "The request does not match the operation contract.",
          );
      },
      preHandler: async (request) => infrastructure.resolveIdentity(request, operation),
      handler: async (request, reply) => handler(request, reply, operation),
    });
  };
  if (operation.operationId !== "deployAgent") {
    register(routes);
    return;
  }
  // This child alone retains raw command bytes until the original closed parser
  // has rejected duplicate names and unsupported numeric/UTF-8 representations.
  routes.register(async (deploymentRoutes) => {
    deploymentRoutes.addContentTypeParser(
      "application/json",
      { parseAs: "buffer", bodyLimit: LIFECYCLE_DEPLOY_LIMITS_V2.maxJsonBytes },
      (_request, body, done) => {
        try {
          if (!(body instanceof Uint8Array)) throw new TypeError("Expected request bytes.");
          done(null, parseLifecycleDeployJsonV2("command", body));
        } catch {
          done(
            failure(400, "INVALID_REQUEST", "The request does not match the operation contract."),
          );
        }
      },
    );
    register(deploymentRoutes);
  });
}

/** Ordinary routes always install admission, schema validation, and current identity lookup. */
export function registerProtectedOperations(
  routes: FastifyInstance,
  handlers: OperationHandlers<typeof ordinaryOperations>,
  infrastructure: ProtectedRequestInfrastructure,
): void {
  if (
    typeof infrastructure.admit !== "function" ||
    typeof infrastructure.resolveIdentity !== "function"
  )
    throw new Error("Protected HTTP registration requires admission and identity resolution.");
  const registry = createOperationRegistry(ordinaryOperations, handlers);
  for (const entry of registry) {
    registerOperation(routes, entry as RegisteredOperation, infrastructure, "ordinary");
  }
}

export function registerBootstrapOperation(
  routes: FastifyInstance,
  operation: BootstrapOperation,
  handler: OperationHandler<BootstrapOperation>,
  infrastructure: ProtectedRequestInfrastructure,
): void {
  const [entry] = createOperationRegistry([operation] as const, { bootstrapInstallation: handler });
  registerOperation(routes, entry as RegisteredOperation, infrastructure, "bootstrap");
}
