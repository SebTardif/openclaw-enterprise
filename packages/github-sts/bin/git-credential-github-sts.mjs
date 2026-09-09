#!/usr/bin/env node
import { exchangeCredentialFrame, parseCredentialInput } from "../src/client-mechanics.ts";

const action = process.argv[2];
try {
  if (action !== "get" && action !== "store" && action !== "erase") throw new Error();
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 16_384) throw new Error();
  }
  const fields = parseCredentialInput(input);
  if (action === "store") process.exitCode = 0;
  else {
    const token = await exchangeCredentialFrame({ kind: action, ...fields });
    if (action === "get") {
      if (token === undefined) throw new Error();
      process.stdout.write(
        `username=x-access-token\npassword=${token.token}\npassword_expiry_utc=${Math.floor(Date.parse(token.expiresAt) / 1000)}\n\n`,
      );
    }
  }
} catch {
  if (action === "get") process.stdout.write("quit=true\n\n");
  process.stderr.write("Native Git credential acquisition unavailable.\n");
  process.exitCode = 1;
}
