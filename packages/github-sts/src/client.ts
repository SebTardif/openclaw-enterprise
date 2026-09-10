import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { spawn } from "node:child_process";
import { lstat, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Socket } from "node:net";
import {
  NativeClientError,
  gitConfiguration,
  nativeEnvironment,
  permissionProfile,
  planNativeCommand,
  repositoryName,
  scrubNativeOutput,
  validateGitConfig,
  validateRelease,
  validateRepository,
} from "./client-mechanics.ts";
import type {
  NativeCommand,
  NativeDeliveryPort,
  NativeDeliveryRequest,
  NativeOriginalAttempt,
  NativeRepository,
  NativeStep,
  NativeTools,
} from "./client-mechanics.ts";

export interface NativeClientOptions {
  readonly original: NativeOriginalAttempt;
  readonly repository: NativeRepository;
  readonly delivery: NativeDeliveryPort;
  readonly tools: NativeTools;
  /** Existing, explicitly allocated scratch parent; only this invocation's child is removed. */
  readonly scratchParent: string;
  /** Caller must serialize checkout/config writes for the whole operation. This is a precondition, not an authority proof. */
  readonly exclusiveCheckout: true;
  readonly signal: AbortSignal;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}
export interface NativeChildResult {
  /** "completed" means child exit zero only; provider/readback acceptance is separate. */
  readonly status: "completed" | "failed" | "unknown";
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly nextAction: "none" | "exact-readback-only";
  readonly operation: Readonly<{
    operationRef: string;
    attemptRef: string;
    canonicalBindingDigest: string;
    command: string;
    repositoryId: number;
    intendedRef: string;
    intendedCommit: string;
    baseRef: string;
    titleDigest: string | null;
    bodyDigest: string | null;
  }>;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const entry of Object.values(value)) freeze(entry);
  }
  return value;
}
function failResult(
  mutation: boolean,
  operation: NativeChildResult["operation"],
): NativeChildResult {
  return {
    operation,
    status: mutation ? "unknown" : "failed",
    code: null,
    stdout: "",
    stderr: "Native repository operation unavailable.\n",
    nextAction: mutation ? "exact-readback-only" : "none",
  };
}

/** Real process primitive shared by the inactive command runner and fixture probes.
 * Neither this primitive nor the selected-command planner is an authorization filter
 * for arbitrary runtime code. The injected delivery owner controls actual release.
 */
export async function runNativeStep(
  step: NativeStep,
  request: NativeDeliveryRequest,
  options: NativeClientOptions,
  home: string,
): Promise<NativeChildResult> {
  step = freeze(structuredClone(step));
  request = freeze(structuredClone(request));
  options = Object.freeze({
    ...options,
    tools: Object.freeze({ ...options.tools }),
    delivery: Object.freeze({
      withCurrentToken: options.delivery.withCurrentToken.bind(options.delivery),
      invalidateRuntimeReuse: options.delivery.invalidateRuntimeReuse.bind(options.delivery),
    }),
  });
  const operation = Object.freeze({
    operationRef: request.operationRef,
    attemptRef: request.original.attemptRef,
    canonicalBindingDigest: request.original.canonicalBindingDigest,
    command: request.command,
    repositoryId: request.repository.id,
    intendedRef: `refs/heads/${request.repository.branch}`,
    intendedCommit: request.intendedHeadCommit ?? request.repository.commit,
    baseRef: request.repository.base,
    titleDigest: request.titleDigest ?? null,
    bodyDigest: request.bodyDigest ?? null,
  });
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
  const turnDeadline =
    request.original.turnNotAfter === null ? null : Date.parse(request.original.turnNotAfter);
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30_000 ||
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    maxOutputBytes > 256 * 1024 ||
    options.signal.aborted ||
    (turnDeadline !== null && (!Number.isFinite(turnDeadline) || turnDeadline <= now())) ||
    process.platform === "win32"
  )
    return failResult(false, operation);
  const environment = nativeEnvironment(home, options.tools, request.repository);
  const gitArgs = gitConfiguration(options.tools.helper, options.tools.node).flatMap((value) => [
    "-c",
    value,
  ]);
  const file = step.tool === "git" ? options.tools.git : options.tools.node;
  const args =
    step.tool === "git" ? [...gitArgs, ...step.args] : [options.tools.ghWrapper, ...step.args];
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(
    () => deadline.abort(),
    turnDeadline === null ? timeoutMs : Math.min(timeoutMs, turnDeadline - now()),
  );
  const signal = AbortSignal.any([options.signal, deadline.signal]);
  const tokens: string[] = [];
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: home,
      env: environment,
      detached: true,
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    });
    const pipe = child.stdio[3] as Socket;
    let active = true;
    let breached = false;
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let frame = "";
    let queued = 0;
    let totalFrames = 0;
    let childClosed = false;
    let sequence = Promise.resolve();
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      breached = true;
      active = false;
      pipe.destroy();
      try {
        if (!childClosed && child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
      } catch {}
      if (!childClosed && killTimer === undefined) {
        killTimer = setTimeout(() => {
          try {
            if (!childClosed && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
          } catch {}
        }, 250);
        killTimer.unref();
      }
    };
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    function send(value: unknown): void {
      if (!active || signal.aborted || pipe.destroyed) throw new NativeClientError();
      pipe.write(`${JSON.stringify(value)}\n`);
    }
    async function handle(line: string): Promise<void> {
      try {
        const value = JSON.parse(line);
        if (
          value === null ||
          typeof value !== "object" ||
          Object.keys(value).sort().join(",") !== "host,kind,path,protocol" ||
          !["get", "erase"].includes(value.kind) ||
          value.protocol !== "https" ||
          !["github.com", "github.com:443"].includes(value.host) ||
          typeof value.path !== "string" ||
          value.path.replace(/\.git$/i, "").toLowerCase() !==
            repositoryName(request.repository).toLowerCase()
        )
          throw new NativeClientError();
        if (!active || signal.aborted || (turnDeadline !== null && turnDeadline <= now()))
          throw new NativeClientError();
        if (value.kind === "erase") {
          await options.delivery.invalidateRuntimeReuse(request, signal);
          if (turnDeadline !== null && turnDeadline <= now()) throw new NativeClientError();
          send({ kind: "erased" });
          return;
        }
        // Public setup is a no-token operation. Unexpected authentication is a failure.
        if (request.command === "G01") throw new NativeClientError();
        let released = false;
        await options.delivery.withCurrentToken(
          request,
          (token) => {
            if (!active || released) throw new NativeClientError();
            validateRelease(token, request, now(), signal);
            released = true;
            tokens.push(token.token);
            send({ kind: "token", token: token.token, expiresAt: token.expiresAt });
          },
          signal,
        );
        if (!released) throw new NativeClientError();
      } catch {
        // A failure after release cannot recall bytes. Stop the child and preserve
        // mutation ambiguity; the sole delivery/inventory owner retains cleanup.
        try {
          send({ kind: "denied" });
        } catch {}
        stop();
      } finally {
        queued -= 1;
      }
    }
    pipe.on("data", (chunk: Buffer) => {
      frame += chunk.toString("utf8");
      if (Buffer.byteLength(frame) > 16_384) {
        stop();
        return;
      }
      while (frame.includes("\n")) {
        const index = frame.indexOf("\n");
        const line = frame.slice(0, index);
        frame = frame.slice(index + 1);
        if (++queued > 8 || ++totalFrames > 8) {
          stop();
          return;
        }
        sequence = sequence.then(() => handle(line));
      }
    });
    pipe.on("error", () => {
      if (active) stop();
    });
    const collect = (kind: "stdout" | "stderr", chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        stop();
        return;
      }
      if (kind === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout!.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr!.on("data", (chunk: Buffer) => collect("stderr", chunk));
    child.on("error", stop);
    child.on("close", async (code) => {
      childClosed = true;
      active = false;
      pipe.destroy();
      // Child exit cannot turn an unresolved delivery callback into success. Join
      // owner settlement within the invocation deadline; any late release is closed.
      let stopWaiting;
      const expired = new Promise<void>((done) => {
        stopWaiting = () => done();
        signal.addEventListener("abort", stopWaiting, { once: true });
        if (signal.aborted) done();
      });
      await Promise.race([sequence, expired]);
      if (stopWaiting !== undefined) signal.removeEventListener("abort", stopWaiting);
      if (signal.aborted) breached = true;
      clearTimeout(deadlineTimer);
      signal.removeEventListener("abort", stop);
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (breached || code !== 0) {
        resolve(failResult(step.mutation, operation));
        return;
      }
      // Buffer first, then scrub: a token split across chunks must not escape.
      resolve({
        operation,
        status: "completed",
        code,
        stdout: scrubNativeOutput(stdout, tokens),
        stderr: scrubNativeOutput(stderr, tokens),
        nextAction: step.mutation ? "exact-readback-only" : "none",
      });
    });
  });
}

/** Preflight only; the caller must exclude concurrent checkout/config mutation. */
async function inspectCheckout(
  checkout: string,
  repository: NativeRepository,
  tools: NativeTools,
  home: string,
): Promise<void> {
  const directory = join(checkout, ".git");
  if (!(await lstat(directory)).isDirectory() || (await realpath(directory)) !== directory)
    throw new NativeClientError();
  const names = await readdir(directory);
  if (names.includes("config.worktree") || names.includes("commondir"))
    throw new NativeClientError();
  for (const suffix of ["config", "objects/info/alternates", "objects/info/http-alternates"]) {
    try {
      const metadata = await lstat(join(directory, suffix));
      if (suffix !== "config" || !metadata.isFile() || metadata.isSymbolicLink())
        throw new NativeClientError();
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT" &&
        suffix !== "config"
      )
        continue;
      throw error;
    }
  }
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      tools.git,
      ["config", "--no-includes", "--null", "--list", "--file", join(directory, "config")],
      {
        env: nativeEnvironment(home, tools, repository),
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
      },
    );
    let value = "";
    child.stdout.on("data", (chunk) => {
      value += chunk;
      if (Buffer.byteLength(value) > 64 * 1024) {
        child.kill("SIGKILL");
        reject(new NativeClientError());
      }
    });
    child.on("error", () => reject(new NativeClientError()));
    child.on("close", (code) => (code === 0 ? resolve(value) : reject(new NativeClientError())));
  });
  validateGitConfig(output, `https://github.com/${repositoryName(repository)}.git`);
}

/** No default delivery implementation or production registration. Repository integration owns
 * integration with real current authority, recorded delivery, and qualified tools.
 */
export function createNativeClient(options: NativeClientOptions): {
  run(command: NativeCommand): Promise<readonly NativeChildResult[]>;
} {
  options = Object.freeze({
    ...options,
    delivery: Object.freeze({
      withCurrentToken: options.delivery.withCurrentToken.bind(options.delivery),
      invalidateRuntimeReuse: options.delivery.invalidateRuntimeReuse.bind(options.delivery),
    }),
  });
  const original = freeze(structuredClone(options.original));
  const repository = validateRepository(options.repository);
  const tools = Object.freeze({ ...options.tools });
  if (
    options.exclusiveCheckout !== true ||
    !isAbsolute(options.scratchParent) ||
    Object.values(tools).some((path) => !isAbsolute(path))
  )
    throw new NativeClientError();
  return Object.freeze({
    async run(command: NativeCommand): Promise<readonly NativeChildResult[]> {
      command = freeze(structuredClone(command));
      planNativeCommand(command, repository);
      let body: Buffer | undefined;
      if (command.id === "G11") {
        if (command.bodyFile === undefined) throw new NativeClientError();
        // Nonblocking open lets fstat reject special files without waiting for a
        // writer; no-follow and the descriptor-based check retain the same file.
        const fd = openSync(
          command.bodyFile,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const metadata = fstatSync(fd);
          if (!metadata.isFile() || metadata.size > 16_384) throw new NativeClientError();
          const buffer = Buffer.alloc(16_385);
          let bytes = 0;
          while (bytes < buffer.length) {
            const read = readSync(fd, buffer, bytes, buffer.length - bytes, null);
            if (read === 0) break;
            bytes += read;
          }
          body = buffer.subarray(0, bytes);
          if (
            body.length > 16_384 ||
            `sha256:${createHash("sha256").update(body).digest("hex")}` !== command.bodySha256
          )
            throw new NativeClientError();
        } finally {
          closeSync(fd);
        }
      }
      const request: NativeDeliveryRequest = freeze({
        original,
        repository,
        command: command.id,
        operationRef: command.operationRef,
        ...(command.intendedHeadCommit === undefined
          ? {}
          : { intendedHeadCommit: command.intendedHeadCommit }),
        ...(command.bodySha256 === undefined ? {} : { bodyDigest: command.bodySha256 }),
        ...(command.title === undefined
          ? {}
          : { titleDigest: `sha256:${createHash("sha256").update(command.title).digest("hex")}` }),
        permissionProfile: permissionProfile(command.id),
      });
      const home = await mkdtemp(join(options.scratchParent, "native-client-"));
      const results: NativeChildResult[] = [];
      try {
        const ownedCommand =
          body === undefined
            ? command
            : Object.freeze({ ...command, bodyFile: join(home, "pull-request-body.txt") });
        if (body !== undefined)
          await writeFile(ownedCommand.bodyFile!, body, { flag: "wx", mode: 0o600 });
        const steps = planNativeCommand(ownedCommand, repository);
        for (const step of steps) {
          if (step.repositoryConfig)
            await inspectCheckout(command.checkout, repository, tools, home);
          const result = await runNativeStep(
            step,
            request,
            { ...options, original, repository, tools },
            home,
          );
          results.push(result);
          if (result.status !== "completed") break;
        }
      } catch {
        results.push(
          failResult(
            false,
            Object.freeze({
              operationRef: command.operationRef,
              attemptRef: original.attemptRef,
              canonicalBindingDigest: original.canonicalBindingDigest,
              command: command.id,
              repositoryId: repository.id,
              intendedRef: `refs/heads/${repository.branch}`,
              intendedCommit: command.intendedHeadCommit ?? repository.commit,
              baseRef: repository.base,
              titleDigest: request.titleDigest ?? null,
              bodyDigest: request.bodyDigest ?? null,
            }),
          ),
        );
      } finally {
        await rm(home, { recursive: true, force: true });
      }
      return Object.freeze(results);
    },
  });
}
