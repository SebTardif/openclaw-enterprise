import { randomUUID } from "node:crypto";
import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type InjectOptions,
} from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import swagger from "@fastify/swagger";
import ajvFormats from "ajv-formats";
import { JsonValue } from "@openclaw-enterprise/contracts/api/common";
import { OCC_AUTH_COOKIE_PREFIX, OCC_SERVICE_KEY_HEADER } from "../auth/index.ts";

export interface ControllerApp {
  fetch(request: Request): Promise<Response>;
}

function formatsPlugin(ajv: Parameters<typeof ajvFormats.default>[0]) {
  return ajvFormats.default(ajv);
}

export function responseHeaders(reply: FastifyReply, requestId: string): void {
  reply.header("cache-control", "no-store");
  reply.header("content-type", "application/json; charset=utf-8");
  reply.header("x-content-type-options", "nosniff");
  reply.header("x-request-id", requestId);
}

export function createHttpTransport(options: {
  readonly bodyLimit: number;
  readonly developmentEnabled: boolean;
  readonly logger?: FastifyBaseLogger;
}): FastifyInstance {
  const { bodyLimit } = options;
  const app = Fastify({
    bodyLimit,
    ...(options.logger === undefined
      ? {}
      : {
          loggerInstance: options.logger,
          logController: new LogController({ disableRequestLogging: true }),
        }),
    trustProxy: false,
    requestIdHeader: false,
    genReqId: () => `req_${randomUUID()}`,
    ajv: {
      customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false },
      plugins: [formatsPlugin],
    },
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.removeContentTypeParser("text/plain");
  app.addSchema(JsonValue);
  void app.register(swagger, {
    convertConstToEnum: false,
    openapi: {
      openapi: "3.1.0",
      info: {
        title: options.developmentEnabled ? "Development OCC API" : "Internal OCC API",
        version: "0.1.0",
      },
      components: {
        securitySchemes: {
          sessionCookie: {
            type: "apiKey",
            in: "cookie",
            name: `${OCC_AUTH_COOKIE_PREFIX}.session_token`,
          },
          serviceApiKey: { type: "apiKey", in: "header", name: OCC_SERVICE_KEY_HEADER },
        },
      },
      security: [{ sessionCookie: [] }, { serviceApiKey: [] }],
    },
  });

  return app;
}

export function createFetchAdapter(app: FastifyInstance): ControllerApp {
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const headers: Record<string, string> = {};
      request.headers.forEach((value, name) => {
        headers[name] = value;
      });
      headers.host = url.host;
      const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
      const result = await app.inject({
        method: request.method as NonNullable<InjectOptions["method"]>,
        url: `${url.pathname}${url.search}`,
        headers,
        ...(body === undefined ? {} : { payload: body }),
        remoteAddress: "127.0.0.1",
      });
      const convertedHeaders = new Headers();
      for (const [name, value] of Object.entries(result.headers)) {
        if (Array.isArray(value)) {
          for (const entry of value) convertedHeaders.append(name, entry);
        } else if (value !== undefined) {
          convertedHeaders.set(name, String(value));
        }
      }
      return new Response(result.statusCode === 204 ? null : new Uint8Array(result.rawPayload), {
        status: result.statusCode,
        headers: convertedHeaders,
      });
    },
  };
}
