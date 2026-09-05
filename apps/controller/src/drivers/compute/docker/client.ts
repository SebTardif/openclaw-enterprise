import { request as httpRequest } from "node:http";
import { currentComputeAbortSignal, withComputeAbortSignal } from "../operation-context.ts";

export type DockerRequest = (
  method: string,
  path: string,
  body: unknown,
  expected: readonly number[],
) => Promise<unknown>;

export interface DockerContainerInspect {
  readonly Config?: {
    readonly Labels?: Readonly<Record<string, string>>;
  };
  readonly State?: {
    readonly Running?: boolean;
    readonly Health?: {
      readonly Status?: string;
    };
  };
}

export interface DockerNetworkInspect {
  readonly Labels?: Readonly<Record<string, string>>;
}

export class DockerApiError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function statusCode(error: unknown): number | undefined {
  return error instanceof DockerApiError ? error.statusCode : undefined;
}

const SOCKET_PATH = "/var/run/docker.sock";
const REQUEST_TIMEOUT_MS = 10_000;

export async function image(request: DockerRequest, ref: string): Promise<void> {
  await request("GET", `/images/${encodeURIComponent(ref)}/json`, undefined, [200]);
}

export async function network(
  request: DockerRequest,
  name: string,
): Promise<DockerNetworkInspect | undefined> {
  try {
    return (await request(
      "GET",
      `/networks/${encodeURIComponent(name)}`,
      undefined,
      [200],
    )) as DockerNetworkInspect;
  } catch (error) {
    if (statusCode(error) === 404) return undefined;
    throw error;
  }
}

export async function removeNetwork(request: DockerRequest, name: string): Promise<void> {
  await request("DELETE", `/networks/${encodeURIComponent(name)}`, undefined, [204]);
}

export async function container(
  request: DockerRequest,
  name: string,
): Promise<DockerContainerInspect | undefined> {
  try {
    return (await request(
      "GET",
      `/containers/${encodeURIComponent(name)}/json`,
      undefined,
      [200],
    )) as DockerContainerInspect;
  } catch (error) {
    if (statusCode(error) === 404) return undefined;
    throw error;
  }
}

export async function removeContainer(
  request: DockerRequest,
  name: string,
  force: boolean,
): Promise<void> {
  const suffix = force ? "?force=true&v=true" : "?v=true";
  await request(
    "DELETE",
    `/containers/${encodeURIComponent(name)}${suffix}`,
    undefined,
    [204, 404],
  );
}

export async function dockerRequest(
  method: string,
  path: string,
  body: unknown,
  expected: readonly number[],
): Promise<unknown> {
  const ownerSignal = currentComputeAbortSignal();
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = ownerSignal === undefined ? timeout : AbortSignal.any([ownerSignal, timeout]);
  return withComputeAbortSignal(
    signal,
    () =>
      new Promise<unknown>((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const request = httpRequest(
          {
            socketPath: SOCKET_PATH,
            method,
            path,
            signal,
            headers:
              payload === undefined
                ? undefined
                : {
                    "content-type": "application/json",
                    "content-length": Buffer.byteLength(payload),
                  },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer | string) =>
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
            );
            response.on("end", () => {
              const status = response.statusCode ?? 0;
              const text = Buffer.concat(chunks).toString("utf8");
              if (!expected.includes(status)) {
                reject(new DockerApiError(status, text || `Docker API returned HTTP ${status}.`));
                return;
              }
              const contentType = response.headers["content-type"];
              if (
                typeof contentType === "string" &&
                contentType.includes("application/json") &&
                text.length > 0
              ) {
                try {
                  resolve(JSON.parse(text));
                } catch {
                  reject(new Error("Docker API returned invalid JSON."));
                }
                return;
              }
              resolve(text);
            });
          },
        );
        request.once("error", reject);
        if (payload !== undefined) request.write(payload);
        request.end();
      }),
  );
}
