#!/usr/bin/env node
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { exchangeCredentialFrame } from "../src/client-mechanics.ts";

try {
  const executable = process.env.OCE_NATIVE_GH_BIN;
  const repository = process.env.OCE_NATIVE_REPOSITORY;
  if (
    !executable ||
    !isAbsolute(executable) ||
    !repository ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
  )
    throw new Error();
  const released = await exchangeCredentialFrame({
    kind: "get",
    protocol: "https",
    host: "github.com",
    path: repository,
  });
  if (released === undefined) throw new Error();
  // Construct a new child environment. No inherited personal token, credential pipe,
  // broker connection or authority descriptor is passed to the native CLI.
  const environment = Object.fromEntries(
    [
      "HOME",
      "XDG_CONFIG_HOME",
      "GH_CONFIG_DIR",
      "LANG",
      "LC_ALL",
      "TERM",
      "PATH",
      "GH_HOST",
      "GH_PROMPT_DISABLED",
      "GH_NO_UPDATE_NOTIFIER",
      "GH_NO_EXTENSION_UPDATE_NOTIFIER",
      "GH_BROWSER",
      "BROWSER",
      "GH_PAGER",
      "PAGER",
      "GIT_CONFIG_NOSYSTEM",
      "GIT_CONFIG_SYSTEM",
      "GIT_CONFIG_GLOBAL",
      "GIT_TERMINAL_PROMPT",
      "GIT_ASKPASS",
      "SSH_ASKPASS",
      "GIT_NO_REPLACE_OBJECTS",
      "GIT_LITERAL_PATHSPECS",
    ].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])),
  );
  environment.GH_TOKEN = released.token;
  const child = spawn(executable, process.argv.slice(2), { env: environment, stdio: "inherit" });
  const forward = (signal) => child.kill(signal);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, forward);
  child.on("error", () => {
    process.stderr.write("Native GitHub CLI unavailable.\n");
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.off(name, forward);
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
} catch {
  process.stderr.write("Native GitHub credential acquisition unavailable.\n");
  process.exitCode = 1;
}
