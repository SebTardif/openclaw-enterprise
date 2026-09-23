import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { nativeOAuthProfileId } from "./native-profile.mjs";

/** @typedef {{ provider: string, method: string, connectionId: string, generation: number }} NativeOAuthAcquisitionBinding */
/** @typedef {{ kind: "device-code", verificationUrl: string, userCode: string, expiresInMinutes: number }} NativeOAuthDeviceInstructions */
/** @typedef {{ kind: "browser", authorizationUrl: string, input: "redirect-url" }} NativeOAuthBrowserInstructions */
/** @typedef {NativeOAuthDeviceInstructions | NativeOAuthBrowserInstructions} NativeOAuthInstructions */
/**
 * @typedef {object} NativeOAuthAcquisitionOptions
 * @property {NativeOAuthAcquisitionBinding} binding
 * @property {AbortSignal} signal Owner aborts when the attempt loses authority.
 * @property {() => void | Promise<void>} assertCurrent
 * @property {(instructions: NativeOAuthInstructions) => Promise<void>} onInstructions
 * @property {() => Promise<string>} [requestRedirect] Private authenticated actor/attempt input; never expose the submitted redirect in status or logs.
 * @property {(envelope: NativeOAuthAcquisitionBinding & { profileId: string, credential: Record<string, unknown> }) => Promise<void>} stage Private callback persists the complete bundle under the durable attempt fence.
 */

const capability = "openclaw.models.auth.managed.v1";
const deviceUrl = "https://auth.openai.com/codex/device";
const redirectUri = "http://localhost:1455/auth/callback";
const failure = () =>
  Object.assign(new Error("NATIVE_OAUTH_ACQUISITION_FAILED"), {
    code: "NATIVE_OAUTH_ACQUISITION_FAILED",
  });

function browserAuthorization(url) {
  const parsed = new URL(url);
  const keys = new Set([
    "response_type",
    "client_id",
    "redirect_uri",
    "scope",
    "code_challenge",
    "code_challenge_method",
    "state",
    "id_token_add_organizations",
    "codex_cli_simplified_flow",
    "originator",
  ]);
  if (
    parsed.origin !== "https://auth.openai.com" ||
    parsed.pathname !== "/oauth/authorize" ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    [...parsed.searchParams.keys()].some(
      (key) => !keys.has(key) || parsed.searchParams.getAll(key).length !== 1,
    ) ||
    parsed.searchParams.get("response_type") !== "code" ||
    parsed.searchParams.get("redirect_uri") !== redirectUri ||
    parsed.searchParams.get("code_challenge_method") !== "S256" ||
    !/^[A-Za-z0-9_-]{43}$/.test(parsed.searchParams.get("code_challenge") ?? "") ||
    !/^[a-f0-9]{32}$/.test(parsed.searchParams.get("state") ?? "")
  ) {
    throw failure();
  }
  return { authorizationUrl: parsed.href, state: parsed.searchParams.get("state") };
}

function validatedRedirect(value, authorization) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 16_384 || !authorization) {
    throw failure();
  }
  const parsed = new URL(value.trim());
  if (
    `${parsed.origin}${parsed.pathname}` !== redirectUri ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    parsed.searchParams.has("error") ||
    parsed.searchParams.has("error_description") ||
    parsed.searchParams.getAll("state").length !== 1 ||
    parsed.searchParams.get("state") !== authorization.state ||
    parsed.searchParams.getAll("code").length !== 1 ||
    !parsed.searchParams.get("code")
  ) {
    throw failure();
  }
  return parsed.href;
}

/**
 * Module paths come from internal, image-qualified composition, never a request.
 * The owner must abort on claim loss and fence stage against durable attempt state.
 * No native refresh or controller credential environment enters this subprocess.
 * @param {{ managedLoginModulePath: string, providerAuthModulePath: string }} options
 * @returns {(options: NativeOAuthAcquisitionOptions) => Promise<void>}
 */
export function createNativeOAuthAcquisition({ managedLoginModulePath, providerAuthModulePath }) {
  if (
    typeof managedLoginModulePath !== "string" ||
    typeof providerAuthModulePath !== "string" ||
    !isAbsolute(managedLoginModulePath) ||
    !isAbsolute(providerAuthModulePath) ||
    dirname(managedLoginModulePath) !== dirname(providerAuthModulePath)
  ) {
    throw failure();
  }
  return async function acquire({
    binding,
    signal,
    assertCurrent,
    onInstructions,
    requestRedirect,
    stage,
  }) {
    let home;
    let child;
    let closed;
    let abort;
    let staging;
    const current = async () => {
      signal.throwIfAborted();
      await assertCurrent();
      signal.throwIfAborted();
    };
    try {
      if (
        binding.provider !== "openai" ||
        !["device-code", "oauth"].includes(binding.method) ||
        (binding.method === "oauth" && typeof requestRedirect !== "function")
      ) {
        throw failure();
      }
      const identity = {
        provider: binding.provider,
        method: binding.method,
        connectionId: binding.connectionId,
        generation: binding.generation,
        profileId: nativeOAuthProfileId(binding),
      };
      await current();
      home = await mkdtemp(join(tmpdir(), "oce-oauth-acquisition-"));
      await current();
      const stateDir = join(home, "state");
      const agentDir = join(stateDir, "agents", "main", "agent");
      child = fork(fileURLToPath(import.meta.url), ["--native-oauth-child"], {
        cwd: home,
        execArgv: [],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        // Native module imports can inspect process.env before explicit env is
        // supplied. Start clean, including CLI stores, config, caches and temp files.
        env: {
          HOME: home,
          USERPROFILE: home,
          OPENCLAW_HOME: home,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_AGENT_DIR: agentDir,
          OPENCLAW_CONFIG_PATH: join(home, "openclaw.json"),
          CODEX_HOME: join(home, "codex"),
          XDG_CONFIG_HOME: join(home, "config"),
          XDG_CACHE_HOME: join(home, "cache"),
          TMPDIR: home,
          PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        },
      });
      closed = new Promise((resolve) => child.once("close", resolve));
      await new Promise((resolve, reject) => {
        let queue = Promise.resolve();
        let finished = false;
        const fail = () => {
          finished = true;
          reject(failure());
        };
        abort = fail;
        signal.addEventListener("abort", abort, { once: true });
        child.once("error", fail);
        child.once("close", () => {
          if (!finished) {
            fail();
          }
        });
        const respond = async (message) => {
          if (finished) {
            return;
          }
          await current();
          if (finished) {
            return;
          }
          let redirect;
          if (message.type === "instructions") {
            await onInstructions(message.instructions);
          } else if (message.type === "redirect-input" && binding.method === "oauth") {
            redirect = await requestRedirect();
          } else if (message.type === "before-persist") {
            // A durable owner check precedes native's synchronous abort guard.
          } else if (message.type === "credential") {
            staging = stage({ ...identity, credential: message.credential });
            await staging;
            await current();
            finished = true;
            resolve();
            return;
          } else {
            throw failure();
          }
          await current();
          if (finished) {
            return;
          }
          child.send(
            { type: message.type, id: message.id, ...(redirect === undefined ? {} : { redirect }) },
            (error) => {
              if (error) {
                fail();
              }
            },
          );
        };
        child.on("message", (message) => {
          // Native may finish its loopback callback while the manual prompt is
          // pending. A user-input wait must not block persistence or completion.
          if (message.type === "redirect-input") {
            void respond(message).catch(fail);
          } else {
            queue = queue.then(() => respond(message)).catch(fail);
          }
        });
        if (signal.aborted) {
          fail();
          return;
        }
        child.send(
          { identity, managedLoginModulePath, providerAuthModulePath, stateDir, agentDir },
          (error) => {
            if (error) {
              fail();
            }
          },
        );
      });
    } catch {
      // Native/callback exceptions can contain raw provider responses or tokens.
      throw failure();
    } finally {
      if (abort) {
        signal.removeEventListener("abort", abort);
      }
      if (child) {
        child.kill("SIGKILL");
        await closed;
      }
      // An admitted custody write owns its bytes until it settles. Do not return
      // cancellation while that write can still publish or require recovery.
      await staging?.catch(() => undefined);
      if (home) {
        await rm(home, { recursive: true, force: true }).catch(() => {
          throw failure();
        });
      }
    }
    // Cleanup yields too; a result must still belong to the live attempt.
    try {
      await current();
    } catch {
      throw failure();
    }
  };
}

async function runChild(input) {
  const controller = new AbortController();
  const current = () => {
    controller.signal.throwIfAborted();
    if (!process.connected) {
      throw failure();
    }
  };
  let sequence = 0;
  const request = (type, payload = {}) =>
    new Promise((resolve, reject) => {
      current();
      const id = ++sequence;
      const onReply = (reply) => {
        if (reply?.id !== id) {
          return;
        }
        process.off("message", onReply);
        if (reply.type === type) {
          resolve(reply);
        } else {
          reject(failure());
        }
      };
      process.on("message", onReply);
      process.send({ type, id, ...payload }, (error) => {
        if (error) {
          process.off("message", onReply);
          reject(failure());
        }
      });
    });
  process.once("disconnect", () => {
    controller.abort();
    process.exit(1);
  });
  const login = await import(pathToFileURL(input.managedLoginModulePath).href);
  const sdk = await import(pathToFileURL(input.providerAuthModulePath).href);
  if (
    login.MANAGED_MODELS_AUTH_LOGIN_FLOW_CAPABILITY !== capability ||
    typeof login.runManagedModelsAuthLoginFlow !== "function" ||
    typeof sdk.updateAuthProfileStoreWithLock !== "function"
  ) {
    throw failure();
  }
  const ignore = async () => {};
  const unsupported = async () => {
    throw failure();
  };
  let verificationUrl;
  let authorization;
  let redirectInput;
  const result = await login.runManagedModelsAuthLoginFlow({
    provider: input.identity.provider,
    method: input.identity.method,
    agent: "main",
    config: {
      agents: { entries: { main: {} } },
      plugins: { allow: ["openai"], entries: { openai: { enabled: true } } },
    },
    env: process.env,
    isRemote: true,
    signal: controller.signal,
    runtime: {
      log() {},
      error() {},
      exit() {
        throw failure();
      },
    },
    prompter: {
      intro: ignore,
      outro: ignore,
      note: ignore,
      select: unsupported,
      multiselect: unsupported,
      text() {
        if (input.identity.method !== "oauth" || !authorization) {
          throw failure();
        }
        // Native's manual parser accepts bare codes. This boundary always returns
        // a complete redirect bound to native's state before its PKCE exchange.
        redirectInput ??= request("redirect-input").then((reply) =>
          validatedRedirect(reply.redirect, authorization),
        );
        return redirectInput;
      },
      confirm: unsupported,
      progress: () => ({ update() {}, stop() {} }),
      async deviceCode({ code, expiresInMinutes }) {
        if (
          input.identity.method !== "device-code" ||
          verificationUrl !== deviceUrl ||
          typeof code !== "string" ||
          !/^[A-Za-z0-9-]{1,64}$/.test(code) ||
          !Number.isSafeInteger(expiresInMinutes) ||
          expiresInMinutes < 1 ||
          expiresInMinutes > 30
        ) {
          throw failure();
        }
        await request("instructions", {
          instructions: { kind: "device-code", verificationUrl, userCode: code, expiresInMinutes },
        });
      },
    },
    async openUrl(url) {
      if (input.identity.method === "oauth") {
        if (authorization) {
          throw failure();
        }
        authorization = browserAuthorization(url);
        await request("instructions", {
          instructions: {
            kind: "browser",
            authorizationUrl: authorization.authorizationUrl,
            input: "redirect-url",
          },
        });
        return;
      }
      // The first qualified method uses this exact native HTTPS endpoint, with
      // no query/fragment. Never forward arbitrary URL text or native log prose.
      if (url !== deviceUrl) {
        throw failure();
      }
      verificationUrl = url;
    },
    browserAuthorization: unsupported,
    managed: {
      capability,
      profileId: input.identity.profileId,
      stateDir: input.stateDir,
      beforePersist: () => request("before-persist"),
      assertCurrent: current,
    },
  });
  current();
  if (
    result.providerId !== input.identity.provider ||
    result.methodId !== input.identity.method ||
    result.profiles.length !== 1 ||
    result.profiles[0].profileId !== input.identity.profileId ||
    result.profiles[0].provider !== input.identity.provider ||
    result.profiles[0].mode !== "oauth"
  ) {
    throw failure();
  }
  let credential;
  const store = await sdk.updateAuthProfileStoreWithLock({
    agentDir: input.agentDir,
    stateDir: input.stateDir,
    updater(store) {
      current();
      credential = structuredClone(store.profiles[input.identity.profileId]);
      return false;
    },
  });
  if (
    store === null ||
    credential?.type !== "oauth" ||
    credential.provider !== input.identity.provider ||
    typeof credential.access !== "string" ||
    !credential.access ||
    typeof credential.refresh !== "string" ||
    !credential.refresh ||
    !Number.isFinite(credential.expires) ||
    credential.expires <= 0 ||
    credential.copyToAgents === true
  ) {
    throw failure();
  }
  current();
  await request("credential", { credential });
}

if (
  process.argv[1] === fileURLToPath(import.meta.url) &&
  process.argv[2] === "--native-oauth-child"
) {
  process.once("message", (input) => {
    runChild(input).catch(() => process.exit(1));
  });
}
