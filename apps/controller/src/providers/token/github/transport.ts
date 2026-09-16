import type { TokenIssuerAttemptV1 } from "@openclaw-enterprise/contracts";
import type { ClientRequest, IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { GitHubAppTokenIssuerErrorV1, assertBounds, assertSynchronous } from "./guards.ts";
import type { GitHubAppEndpointV1 } from "./types.ts";

export interface GitHubRequest {
  readonly method: "POST" | "DELETE";
  readonly path: string;
  readonly authorization: string;
  readonly body: string;
}

export interface GitHubResponse {
  readonly status: number;
  readonly body: Buffer;
}

export type GitHubExchange = (
  request: GitHubRequest,
  call: TokenIssuerAttemptV1,
  hooks: {
    readonly onDispatch: () => void;
    readonly assertMaterialCurrent?: () => void;
  },
) => Promise<GitHubResponse>;

function selectEndpoint(endpoint: GitHubAppEndpointV1): { origin: URL; ca?: string } {
  if (endpoint.kind === "github") return { origin: new URL("https://api.github.com") };
  if (endpoint.kind !== "local-protocol-test") throw new GitHubAppTokenIssuerErrorV1();
  const origin = new URL(endpoint.origin);
  const ca = endpoint.ca;
  if (
    origin.protocol !== "https:" ||
    origin.hostname !== "127.0.0.1" ||
    origin.pathname !== "/" ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    !origin.port ||
    typeof ca !== "string" ||
    ca.length > 32768 ||
    !ca.includes("BEGIN CERTIFICATE")
  )
    throw new GitHubAppTokenIssuerErrorV1();
  return { origin, ca };
}

function collectResponse(
  response: IncomingMessage,
  completion: {
    readonly isSettled: () => boolean;
    readonly fail: () => void;
    readonly succeed: (response: GitHubResponse) => void;
  },
): () => void {
  const chunks: Buffer[] = [];
  let length = 0;
  const discard = () => {
    for (const chunk of chunks) chunk.fill(0);
    chunks.length = 0;
    length = 0;
  };

  response.on("error", completion.fail);
  response.on("aborted", completion.fail);
  response.on("data", (chunk: Buffer) => {
    if (completion.isSettled()) {
      chunk.fill(0);
      return;
    }
    length += chunk.length;
    if (length > 256 * 1024) {
      chunk.fill(0);
      response.destroy();
      completion.fail();
    } else {
      chunks.push(chunk);
    }
  });
  response.on("end", () => {
    if (completion.isSettled()) return;
    let body: Buffer;
    try {
      body = Buffer.concat(chunks);
    } catch {
      completion.fail();
      return;
    } finally {
      discard();
    }
    completion.succeed({ status: response.statusCode ?? 0, body });
  });
  return discard;
}

function sendRequest(
  request: ClientRequest,
  body: string,
  signal: AbortSignal,
  remaining: number,
  onDispatch: () => void,
): Promise<GitHubResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let discardResponse: (() => void) | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", fail);
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      discardResponse?.();
      request.destroy();
      reject(new GitHubAppTokenIssuerErrorV1());
    };
    const succeed = (response: GitHubResponse) => {
      settled = true;
      cleanup();
      resolve(response);
    };

    const timer = setTimeout(fail, Math.max(1, remaining));
    signal.addEventListener("abort", fail, { once: true });
    request.on("error", fail);
    request.on("response", (response) => {
      discardResponse = collectResponse(response, {
        isSettled: () => settled,
        fail,
        succeed,
      });
    });
    if (signal.aborted) {
      fail();
      return;
    }
    // Execution may precede a transport failure; latch before handing Node bytes.
    onDispatch();
    try {
      request.end(body);
    } catch {
      fail();
    }
  });
}

export function createGitHubAppTransport(options: {
  readonly endpoint: GitHubAppEndpointV1;
  readonly clock: () => number;
  readonly assertDispatchCurrent: (attempt: Readonly<TokenIssuerAttemptV1>) => void;
}): GitHubExchange {
  const { origin, ca } = selectEndpoint(options.endpoint);
  const clock = options.clock;
  const assertDispatchCurrent = options.assertDispatchCurrent;

  return async (input, call, hooks) => {
    const remaining = call.bounds.deadline - clock();
    try {
      assertBounds(call.bounds, clock());
      assertSynchronous(() => assertDispatchCurrent(call));
      if (hooks.assertMaterialCurrent) assertSynchronous(hooks.assertMaterialCurrent);
      assertBounds(call.bounds, clock());
    } catch {
      throw new GitHubAppTokenIssuerErrorV1();
    }
    // Fresh nonpooled HTTPS connection; no redirect, transport retry or ambient proxy.
    const request = httpsRequest(new URL(input.path, origin), {
      method: input.method,
      agent: false,
      rejectUnauthorized: true,
      ...(ca === undefined ? {} : { ca }),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${input.authorization}`,
        "User-Agent": "openclaw-enterprise-github-app",
        "X-GitHub-Api-Version": "2026-03-10",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(input.body),
        Connection: "close",
      },
    });
    return sendRequest(request, input.body, call.bounds.signal, remaining, hooks.onDispatch);
  };
}
