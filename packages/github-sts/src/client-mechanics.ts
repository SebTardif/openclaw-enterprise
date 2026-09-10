import { isAbsolute, join } from "node:path";
import { Socket } from "node:net";
import type { OriginalCredentialBindingV1 } from "@openclaw-enterprise/contracts/credential-authority-v1";

/** Inert mechanics only. An original-binding projection is never an authority handle. */
export type NativeOriginalAttempt = OriginalCredentialBindingV1;
export type NativeCommandId =
  `G0${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}` | `G1${0 | 1 | 2 | 3 | 4 | 5}`;
export type NativePermissionProfile =
  "native-read-v1" | "native-collaboration-read-v1" | "native-change-v1";
export const NATIVE_PERMISSIONS = Object.freeze({
  "native-read-v1": Object.freeze({ metadata: "read", contents: "read" }),
  "native-collaboration-read-v1": Object.freeze({
    metadata: "read",
    contents: "read",
    issues: "read",
    pull_requests: "read",
  }),
  "native-change-v1": Object.freeze({
    metadata: "read",
    contents: "write",
    issues: "read",
    pull_requests: "write",
  }),
} as const);
export const SELECTED_NATIVE_TOOLS = Object.freeze({
  git: Object.freeze({ version: "2.55.0", commit: "e9019fcafe0040228b8631c30f97ae1adb61bcdc" }),
  gh: Object.freeze({ version: "2.93.0", commit: "f96972ce1c11fdb8eaa556257fde962a363dffde" }),
});
export interface NativeRepository {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  readonly commit: string;
  readonly base: string;
  readonly branch: string;
  readonly issue: number;
  readonly pull: number;
}
export interface NativeCommand {
  readonly id: NativeCommandId;
  readonly operationRef: string;
  readonly intendedHeadCommit?: string;
  readonly checkout: string;
  readonly files?: readonly string[];
  readonly message?: string;
  readonly title?: string;
  readonly bodyFile?: string;
  readonly bodySha256?: string;
}
export interface NativeStep {
  readonly tool: "git" | "gh";
  readonly args: readonly string[];
  readonly repositoryConfig: boolean;
  readonly mutation: boolean;
}
export interface NativeTokenRelease {
  readonly attemptRef: string;
  readonly canonicalBindingDigest: string;
  readonly token: string;
  /** Actual provider-derived expiry. There is no timeout-derived expiry fallback. */
  readonly expiresAt: string;
}
export interface NativeDeliveryRequest {
  readonly original: NativeOriginalAttempt;
  readonly repository: NativeRepository;
  readonly command: NativeCommandId;
  readonly operationRef: string;
  readonly intendedHeadCommit?: string;
  readonly bodyDigest?: string;
  readonly titleDigest?: string;
  readonly permissionProfile: NativePermissionProfile;
}
export interface NativeDeliveryPort {
  /** Future accepting owner must check actual current original authority and protected
   * recorded delivery at this callback boundary. No implementation/default is provided.
   * It invokes release at most once, for this request's exact original attempt.
   */
  withCurrentToken(
    request: NativeDeliveryRequest,
    release: (token: NativeTokenRelease) => void,
    signal: AbortSignal,
  ): Promise<void>;
  /** Invalidates only this invocation's runtime reuse, not protected inventory/revocation. */
  invalidateRuntimeReuse(request: NativeDeliveryRequest, signal: AbortSignal): Promise<void>;
}
export interface NativeTools {
  readonly node: string;
  readonly git: string;
  readonly gh: string;
  readonly helper: string;
  readonly ghWrapper: string;
}
export class NativeClientError extends Error {
  constructor() {
    super("Native repository operation unavailable.");
    this.name = "NativeClientError";
  }
}
export function validateRepository(value: NativeRepository): NativeRepository {
  const ref = /^(?![-.])(?!.*(?:\.\.|@\{|[\\\s~^:?*\[]))(?!.*(?:\.lock|[./])$)[A-Za-z0-9_./-]+$/;
  if (
    !Number.isSafeInteger(value.id) ||
    value.id < 1 ||
    [value.owner, value.name, value.commit, value.base, value.branch].some(
      (part) => typeof part !== "string" || part.length < 1 || part.length > 255,
    ) ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value.owner) ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value.name) ||
    !/^[0-9a-f]{40}$/.test(value.commit) ||
    !ref.test(value.base) ||
    !ref.test(value.branch) ||
    !value.branch.startsWith("oce-demo/") ||
    !Number.isSafeInteger(value.issue) ||
    value.issue < 1 ||
    !Number.isSafeInteger(value.pull) ||
    value.pull < 1
  )
    throw new NativeClientError();
  return Object.freeze({ ...value });
}
export function repositoryName(repository: NativeRepository): string {
  return `${repository.owner}/${repository.name}`;
}
export function permissionProfile(id: NativeCommandId): NativePermissionProfile {
  if (id === "G05" || id === "G06" || id === "G11") return "native-change-v1";
  if (["G08", "G09", "G10", "G14", "G15"].includes(id)) return "native-collaboration-read-v1";
  return "native-read-v1";
}
function scalar(value: string | undefined, limit: number): string {
  if (value === undefined || value.length < 1 || value.length > limit || /[\r\n\0]/.test(value))
    throw new NativeClientError();
  return value;
}
export function planNativeCommand(
  command: NativeCommand,
  repository: NativeRepository,
): readonly NativeStep[] {
  validateRepository(repository);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(command.operationRef))
    throw new NativeClientError();
  if (
    (command.id === "G06" || command.id === "G11") &&
    !/^[0-9a-f]{40}$/.test(command.intendedHeadCommit ?? "")
  )
    throw new NativeClientError();
  if (!isAbsolute(command.checkout) || /[\r\n\0]/.test(command.checkout))
    throw new NativeClientError();
  const name = repositoryName(repository);
  const remote = `https://github.com/${name}.git`;
  const git = (args: string[], repositoryConfig = true, mutation = false): NativeStep => ({
    tool: "git",
    args,
    repositoryConfig,
    mutation,
  });
  const gh = (args: string[], mutation = false): NativeStep => ({
    tool: "gh",
    args,
    repositoryConfig: false,
    mutation,
  });
  const at = ["-C", command.checkout];
  const repo = ["--repo", `github.com/${name}`];
  const api = (path: string, extra: string[] = []) =>
    gh([
      "api",
      "--hostname",
      "github.com",
      "--method",
      "GET",
      path,
      "-H",
      "X-GitHub-Api-Version: 2026-03-10",
      ...extra,
    ]);
  const plans: Record<NativeCommandId, () => NativeStep[]> = {
    G01: () => [
      git(["init", "--", command.checkout], false),
      git([...at, "remote", "add", "origin", remote]),
      git([...at, "fetch", "--depth=1", "origin", repository.commit]),
      git([...at, "checkout", "--detach", repository.commit]),
    ],
    G02: () => [
      git(
        ["clone", "--no-checkout", "--no-recurse-submodules", "--", remote, command.checkout],
        false,
      ),
    ],
    G03: () => [
      git([...at, "fetch", "--no-recurse-submodules", "origin", repository.commit]),
      git([...at, "checkout", "--detach", repository.commit]),
      git([...at, "rev-parse", "HEAD"]),
    ],
    G04: () => [
      git([...at, "status", "--porcelain"]),
      git([...at, "diff", "--no-ext-diff", "--no-textconv"]),
      git([...at, "log", "--no-show-signature", "--no-ext-diff", "--no-textconv", "-n", "20"]),
      git([...at, "branch"]),
    ],
    G05: () => {
      const files = command.files;
      if (
        !Array.isArray(files) ||
        files.length < 1 ||
        files.length > 100 ||
        files.some(
          (file: string) =>
            !/^[A-Za-z0-9_.-][A-Za-z0-9_./-]*$/.test(file) ||
            file.split("/").some((part) => part === ".." || part === ".git"),
        )
      )
        throw new NativeClientError();
      return [
        git([...at, "switch", "-c", repository.branch]),
        git([...at, "add", "--", ...files]),
        git([...at, "-c", "commit.gpgSign=false", "commit", "-m", scalar(command.message, 200)]),
      ];
    },
    G06: () => [
      git(
        [...at, "push", "origin", `${command.intendedHeadCommit}:refs/heads/${repository.branch}`],
        true,
        true,
      ),
    ],
    G07: () => [
      gh([
        "repo",
        "view",
        `github.com/${name}`,
        "--json",
        "nameWithOwner,url,isPrivate,defaultBranchRef",
      ]),
    ],
    G08: () => [
      gh([
        "issue",
        "list",
        ...repo,
        "--state",
        "open",
        "--limit",
        "20",
        "--json",
        "number,title,state,url",
      ]),
    ],
    G09: () => [
      gh([
        "issue",
        "view",
        String(repository.issue),
        ...repo,
        "--json",
        "number,title,state,url,body",
      ]),
    ],
    G10: () => [
      gh([
        "pr",
        "view",
        String(repository.pull),
        ...repo,
        "--json",
        "number,title,state,url,isDraft,baseRefName,headRefName",
      ]),
    ],
    G11: () => {
      if (
        !command.bodyFile ||
        !isAbsolute(command.bodyFile) ||
        !/^sha256:[0-9a-f]{64}$/.test(command.bodySha256 ?? "")
      )
        throw new NativeClientError();
      return [
        gh(
          [
            "pr",
            "create",
            ...repo,
            "--base",
            repository.base,
            "--head",
            repository.branch,
            "--draft",
            "--title",
            scalar(command.title, 200),
            "--body-file",
            scalar(command.bodyFile, 4096),
            "--no-maintainer-edit",
          ],
          true,
        ),
      ];
    },
    G12: () => [api(`repos/${name}`, ["--jq", "{id,full_name,private,default_branch}"])],
    G13: () => [api(`repos/${name}/commits/${repository.commit}`, ["--jq", "{sha}"])],
    G14: () => [api(`repos/${name}/issues?state=open&per_page=20`)],
    G15: () => [api(`repos/${name}/pulls?state=open&per_page=20`)],
  };
  const selected = plans[command.id];
  if (selected === undefined) throw new NativeClientError();
  return Object.freeze(
    selected().map((step) => Object.freeze({ ...step, args: Object.freeze([...step.args]) })),
  );
}

/** Git's --null --list representation, from an explicit --no-includes config read.
 * Reject all keys except this finite non-executable complete-checkout subset.
 */
export function validateGitConfig(output: string, expectedRemote: string): void {
  if (output.length > 64 * 1024 || /\r/.test(output)) throw new NativeClientError();
  const seen = new Set<string>();
  for (const entry of output.split("\0")) {
    if (!entry) continue;
    const newline = entry.indexOf("\n");
    if (newline < 1) throw new NativeClientError();
    const key = entry.slice(0, newline).toLowerCase();
    const value = entry.slice(newline + 1);
    if (seen.has(key)) throw new NativeClientError();
    seen.add(key);
    const simple =
      [
        "core.filemode",
        "core.ignorecase",
        "core.logallrefupdates",
        "core.precomposeunicode",
      ].includes(key) && ["true", "false"].includes(value);
    const allowed =
      simple ||
      (key === "core.repositoryformatversion" && value === "0") ||
      (key === "core.bare" && value === "false") ||
      (key === "remote.origin.url" && value === expectedRemote) ||
      (key === "remote.origin.fetch" && value === "+refs/heads/*:refs/remotes/origin/*") ||
      (/^branch\.[a-z0-9_./-]+\.remote$/.test(key) && value === "origin") ||
      (/^branch\.[a-z0-9_./-]+\.merge$/.test(key) && /^refs\/heads\/[A-Za-z0-9_./-]+$/.test(value));
    if (!allowed) throw new NativeClientError();
  }
}
export function gitConfiguration(helper: string, node: string): readonly string[] {
  if (![helper, node].every((path) => isAbsolute(path) && /^[A-Za-z0-9_./-]+$/.test(path)))
    throw new NativeClientError();
  return Object.freeze([
    "credential.helper=",
    `credential.helper=!${node} ${helper}`,
    "credential.useHttpPath=true",
    "credential.interactive=false",
    "credential.username=x-access-token",
    "protocol.allow=never",
    "protocol.https.allow=always",
    "http.followRedirects=false",
    "http.sslVerify=true",
    "http.extraHeader=",
    // Avoid libcurl retrying a mutation on a stale reused HTTP connection.
    "http.version=HTTP/1.1",
    "http.extraHeader=Connection: close",
    "http.proxy=",
    "core.hooksPath=/dev/null",
    "core.fsmonitor=false",
    "core.untrackedCache=false",
    "core.attributesFile=/dev/null",
    "core.excludesFile=/dev/null",
    "commit.gpgSign=false",
    "tag.gpgSign=false",
    "user.name=OCE Native Client",
    "user.email=native-client@local.invalid",
    "log.showSignature=false",
    "submodule.recurse=false",
    "fetch.recurseSubmodules=false",
    "push.recurseSubmodules=no",
    "credential.credentialStore=",
    "init.templateDir=",
    "maintenance.auto=false",
    "gc.auto=0",
  ]);
}
/** Starts from an allowlist; the inherited process environment is intentionally absent. */
export function nativeEnvironment(
  home: string,
  tools: NativeTools,
  repository: NativeRepository,
): NodeJS.ProcessEnv {
  if (!isAbsolute(home) || Object.values(tools).some((path) => !isAbsolute(path)))
    throw new NativeClientError();
  return {
    HOME: home,
    XDG_CONFIG_HOME: home,
    GH_CONFIG_DIR: join(home, "gh"),
    LANG: "C",
    LC_ALL: "C",
    TERM: "dumb",
    PATH: "/usr/bin:/bin",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_LITERAL_PATHSPECS: "1",
    GCM_INTERACTIVE: "never",
    GH_HOST: "github.com",
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
    GH_BROWSER: "/bin/false",
    BROWSER: "/bin/false",
    GH_PAGER: "cat",
    PAGER: "cat",
    OCE_NATIVE_GH_BIN: tools.gh,
    OCE_NATIVE_REPOSITORY: repositoryName(repository),
    OCE_NATIVE_CREDENTIAL_FD: "3",
  };
}
export function parseCredentialInput(input: string): {
  protocol: string;
  host: string;
  path: string;
} {
  if (
    Buffer.byteLength(input) > 16_384 ||
    /[\x00-\x09\x0b-\x1f\x7f]/.test(input) ||
    !input.endsWith("\n")
  )
    throw new NativeClientError();
  // Git's helper invocation closes stdin after the last field's newline; a
  // blank terminator is optional at EOF. Interior empty records remain invalid.
  const lines = input.split("\n");
  lines.pop();
  if (lines.at(-1) === "") lines.pop();
  if (lines.some((line) => !line)) throw new NativeClientError();
  const fields = new Map<string, string>();
  for (const line of lines) {
    const index = line.indexOf("=");
    const key = line.slice(0, index);
    if (
      index < 1 ||
      (fields.has(key) && key !== "capability[]" && key !== "wwwauth[]") ||
      ![
        "protocol",
        "host",
        "path",
        "username",
        "password",
        "password_expiry_utc",
        "oauth_refresh_token",
        "capability[]",
        "wwwauth[]",
      ].includes(key)
    )
      throw new NativeClientError();
    // Array metadata may repeat; only the exact destination fields reach delivery.
    fields.set(key, line.slice(index + 1));
  }
  const protocol = fields.get("protocol");
  const host = fields.get("host");
  const path = fields.get("path");
  if (
    protocol !== "https" ||
    !["github.com", "github.com:443"].includes(host ?? "") ||
    path === undefined ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(path)
  )
    throw new NativeClientError();
  return { protocol, host: host!, path };
}
export function validateRelease(
  value: NativeTokenRelease,
  request: NativeDeliveryRequest,
  now: number,
  signal: AbortSignal,
): number {
  const expiry = Date.parse(value.expiresAt);
  const turnExpiry =
    request.original.turnNotAfter === null ? null : Date.parse(request.original.turnNotAfter);
  if (
    signal.aborted ||
    (turnExpiry !== null && (!Number.isFinite(turnExpiry) || turnExpiry <= now)) ||
    value.attemptRef !== request.original.attemptRef ||
    value.canonicalBindingDigest !== request.original.canonicalBindingDigest ||
    typeof value.token !== "string" ||
    value.token.length < 1 ||
    value.token.length > 16_384 ||
    /\s|\0/.test(value.token) ||
    !Number.isFinite(expiry) ||
    expiry <= now
  )
    throw new NativeClientError();
  return expiry;
}
export function scrubNativeOutput(output: string, tokens: readonly string[]): string {
  let safe = output;
  for (const token of tokens) {
    for (const form of [
      token,
      encodeURIComponent(token),
      Buffer.from(token).toString("base64"),
      Buffer.from(`x-access-token:${token}`).toString("base64"),
    ].sort((a, b) => b.length - a.length))
      safe = safe.split(form).join("[credential]");
  }
  return safe;
}

/** Private per-child inherited pipe, not a network credential-delivery endpoint. */
export async function exchangeCredentialFrame(frame: {
  kind: "get" | "erase";
  protocol: string;
  host: string;
  path: string;
}): Promise<{ token: string; expiresAt: string } | undefined> {
  if (process.env.OCE_NATIVE_CREDENTIAL_FD !== "3") throw new NativeClientError();
  return new Promise((resolve, reject) => {
    const socket = new Socket({ fd: 3, readable: true, writable: true });
    const timeout = setTimeout(() => fail(), 20_000);
    let buffer = "";
    function fail(): void {
      clearTimeout(timeout);
      socket.destroy();
      reject(new NativeClientError());
    }
    socket.on("error", fail);
    socket.on("end", () => {
      if (!buffer.includes("\n")) fail();
    });
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > 32_768) {
        fail();
        return;
      }
      if (!buffer.includes("\n")) return;
      try {
        const value = JSON.parse(buffer);
        if (frame.kind === "erase" && value.kind === "erased" && Object.keys(value).length === 1) {
          clearTimeout(timeout);
          socket.destroy();
          resolve(undefined);
          return;
        }
        if (
          value.kind !== "token" ||
          Object.keys(value).length !== 3 ||
          typeof value.token !== "string" ||
          !value.token ||
          value.token.length > 16_384 ||
          /\s|\0/.test(value.token) ||
          typeof value.expiresAt !== "string" ||
          !(Date.parse(value.expiresAt) > Date.now())
        )
          throw new NativeClientError();
        clearTimeout(timeout);
        socket.destroy();
        resolve({ token: value.token, expiresAt: value.expiresAt });
      } catch {
        fail();
      }
    });
    socket.write(`${JSON.stringify(frame)}\n`);
  });
}
