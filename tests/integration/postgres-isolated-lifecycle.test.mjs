import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, fsyncSync, openSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createConnection, createServer } from "node:net";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { childEnvironment, runChildren } from "../../scripts/test-postgres-isolated.mjs";
import {
  createPlan,
  connectionURL,
  OwnedDatabases,
  readConfiguration,
  withConnection,
} from "../helpers/postgres-isolated-databases.mjs";

const selected = process.env.OCC_TEST_ISOLATED_POSTGRES === "1";

test(
  "explicit isolated PostgreSQL ownership and process lifecycle",
  {
    skip: selected
      ? false
      : "Set OCC_TEST_ISOLATED_POSTGRES=1 plus the separate protected allocation config and new evidence directory; ordinary database URLs never authorize provisioning.",
    timeout: 180000,
  },
  async (t) => {
    assert.ok(
      process.env.OCC_ISOLATED_POSTGRES_CONFIG,
      "Explicit lifecycle selection requires its protected config.",
    );
    assert.ok(
      process.env.OCC_ISOLATED_POSTGRES_EVIDENCE,
      "Explicit lifecycle selection requires a new evidence directory.",
    );
    const config = await readConfiguration(process.env.OCC_ISOLATED_POSTGRES_CONFIG);
    const evidence = resolve(process.env.OCC_ISOLATED_POSTGRES_EVIDENCE);
    await mkdir(evidence, { mode: 0o700 });
    async function allocation(label, selectedSuites) {
      const directory = resolve(evidence, label);
      await mkdir(directory, { mode: 0o700 });
      const plan = createPlan(config, selectedSuites);
      await writeFile(resolve(directory, "manifest.json"), JSON.stringify(plan, null, 2) + "\n", {
        mode: 0o400,
        flag: "wx",
      });
      const fd = openSync(resolve(directory, "manifest.json"), "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      const record = (event) =>
        appendFileSync(resolve(directory, "events.jsonl"), JSON.stringify(event) + "\n", {
          mode: 0o600,
        });
      return { directory, plan, record, owner: new OwnedDatabases(config, plan, record) };
    }
    async function absent(plan) {
      const rows = await withConnection(config, "admin", "postgres", (client) =>
        client.query("SELECT datname FROM pg_database WHERE datname=ANY($1::text[])", [
          plan.databases.map((entry) => entry.name),
        ]),
      );
      assert.equal(rows.rowCount, 0);
    }
    async function cleanupAll(...owners) {
      const results = await Promise.allSettled(owners.map((owner) => owner.cleanup()));
      const errors = results
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
      if (errors.length)
        throw new AggregateError(errors, "Independent cleanup custodians reported failures.");
    }

    await t.test("a different instance identity refuses provisioning before CREATE", async () => {
      const value = await allocation("instance", ["runtime"]);
      const wrongConfig = { ...config, systemIdentifier: config.systemIdentifier + "0" };
      const plan = Object.freeze({
        ...value.plan,
        server: Object.freeze({
          ...value.plan.server,
          systemIdentifier: wrongConfig.systemIdentifier,
        }),
      });
      const owner = new OwnedDatabases(wrongConfig, plan, value.record);
      await assert.rejects(owner.create(plan.databases[0]), /instance identity changed/);
      await absent(plan);
    });

    await t.test(
      "lost real CREATE acknowledgement retains uncertain custody until separate resolution",
      async (t) => {
        const sockets = new Set();
        let observedCreate = false;
        const server = createServer((downstream) => {
          const upstream = createConnection({ host: config.host, port: config.port });
          sockets.add(downstream);
          sockets.add(upstream);
          downstream.on("error", () => upstream.destroy());
          upstream.on("error", () => downstream.destroy());
          downstream.on("close", () => {
            sockets.delete(downstream);
            upstream.destroy();
          });
          upstream.on("close", () => {
            sockets.delete(upstream);
            downstream.destroy();
          });
          downstream.pipe(upstream);
          let pending = Buffer.alloc(0);
          upstream.on("data", (chunk) => {
            pending = Buffer.concat([pending, chunk]);
            while (pending.length >= 5) {
              const size = pending.readUInt32BE(1) + 1;
              if (size < 5 || size > 1024 * 1024) {
                upstream.destroy();
                downstream.destroy();
                return;
              }
              if (pending.length < size) return;
              const frame = pending.subarray(0, size);
              pending = pending.subarray(size);
              if (
                !observedCreate &&
                frame[0] === 67 &&
                frame.subarray(5).toString() === "CREATE DATABASE\0"
              ) {
                // The real server committed CREATE; deliberately lose only its
                // acknowledgement. No fake SQL result or lifecycle decision is used.
                observedCreate = true;
                downstream.destroy();
                upstream.destroy();
                return;
              }
              downstream.write(frame);
            }
          });
        });
        t.after(async () => {
          for (const socket of sockets) socket.destroy();
          if (server.listening) await new Promise((done) => server.close(done));
        });
        await new Promise((done, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", done);
        });
        const proxyConfig = { ...config, port: server.address().port };
        const directory = resolve(evidence, "unknown-create");
        await mkdir(directory, { mode: 0o700 });
        const plan = createPlan(proxyConfig, ["runtime"]);
        await writeFile(resolve(directory, "manifest.json"), JSON.stringify(plan, null, 2), {
          mode: 0o400,
          flag: "wx",
        });
        const fd = openSync(resolve(directory, "manifest.json"), "r");
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        const record = (event) =>
          appendFileSync(resolve(directory, "events.jsonl"), JSON.stringify(event) + "\n", {
            mode: 0o600,
          });
        const owner = new OwnedDatabases(proxyConfig, plan, record);
        const entry = plan.databases[0];
        try {
          await assert.rejects(owner.create(entry));
          assert.equal(observedCreate, true);
          await assert.rejects(owner.cleanup(), /Uncertain CREATE outcome/);
        } finally {
          const cleanupResults = await Promise.allSettled([
            (async () => {
              if (observedCreate) {
                // The independent fault custodian observed this exact successful CREATE
                // at the real server, then binds its cleanup to the recorded current OID.
                await withConnection(config, "admin", "postgres", async (client) => {
                  const row = (
                    await client.query(
                      "SELECT oid::text,datdba::text FROM pg_database WHERE datname=$1",
                      [entry.name],
                    )
                  ).rows[0];
                  assert.ok(row);
                  record({ event: "fault-custodian-identity", name: entry.name, ...row });
                  const current = (
                    await client.query(
                      "SELECT oid::text,datdba::text FROM pg_database WHERE datname=$1",
                      [entry.name],
                    )
                  ).rows[0];
                  assert.deepEqual(current, row);
                  await client.query(`DROP DATABASE "${entry.name}"`);
                });
              }
            })(),
            (async () => {
              for (const socket of sockets) socket.destroy();
              await new Promise((done) => server.close(done));
            })(),
          ]);
          const cleanupErrors = cleanupResults
            .filter((result) => result.status === "rejected")
            .map((result) => result.reason);
          if (cleanupErrors.length)
            throw new AggregateError(cleanupErrors, "Fault custody cleanup failed.");
        }
        await absent(plan);
        record({ event: "fault-custodian-absence-verified", name: entry.name });
      },
    );

    await t.test(
      "partial setup preserves a separately owned preexisting database and its state",
      async () => {
        const value = await allocation("partial", ["runtime", "channels"]);
        const sentinel = new OwnedDatabases(config, value.plan, (event) =>
          value.record({ custodian: "sentinel", ...event }),
        );
        const [first, second] = value.plan.databases;
        try {
          await sentinel.create(second);
          await sentinel.seedProbe(second);
          await value.owner.create(first);
          await assert.rejects(value.owner.create(second), /preexisting database/);
          await value.owner.cleanup();
          await sentinel.verifyProbe(second);
        } finally {
          await cleanupAll(value.owner, sentinel);
        }
        await absent(value.plan);
      },
    );

    await t.test(
      "real journal failure still attempts cleanup for every identified database",
      async () => {
        const value = await allocation("cleanup-journal", ["runtime", "channels"]);
        try {
          for (const entry of value.plan.databases) await value.owner.create(entry);
          const log = resolve(value.directory, "events.jsonl");
          await rename(log, resolve(value.directory, "events-before-failure.jsonl"));
          await mkdir(log);
          await assert.rejects(value.owner.cleanup(), /EISDIR/);
          await absent(value.plan);
          await writeFile(
            resolve(value.directory, "custodian-absence.json"),
            JSON.stringify({
              databases: value.plan.databases.map((entry) => entry.name),
              absent: true,
            }),
            { mode: 0o600 },
          );
        } finally {
          await value.owner.cleanup();
        }
      },
    );

    await t.test(
      "changed database marker prevents cleanup until its custodian restores identity",
      async () => {
        const value = await allocation("marker", ["runtime"]);
        const entry = value.plan.databases[0];
        let identity;
        try {
          identity = await value.owner.create(entry);
          await withConnection(config, "admin", "postgres", (client) =>
            client.query(`COMMENT ON DATABASE "${entry.name}" IS 'changed-custody-marker'`),
          );
          await assert.rejects(value.owner.cleanup(), /Ownership mismatch/);
        } finally {
          try {
            if (identity)
              await withConnection(config, "admin", "postgres", (client) =>
                client.query(`COMMENT ON DATABASE "${entry.name}" IS '${identity.marker}'`),
              );
          } finally {
            await value.owner.cleanup();
          }
        }
        await absent(value.plan);
      },
    );

    await t.test(
      "a recreated same-name database is not deleted by the original OID owner",
      async () => {
        const value = await allocation("replacement", ["runtime"]);
        const entry = value.plan.databases[0];
        let original,
          dropped = false,
          replacement;
        try {
          original = await value.owner.create(entry);
          // This exclusive fixture's separate custodian intentionally replaces its own
          // disposable DB. The stale owner must not infer custody from name/marker alone.
          await withConnection(config, "admin", "postgres", async (client) => {
            const row = (
              await client.query("SELECT oid::text FROM pg_database WHERE datname=$1", [entry.name])
            ).rows[0];
            assert.equal(row.oid, original.oid);
            await client.query(`DROP DATABASE "${entry.name}"`);
            dropped = true;
          });
          replacement = new OwnedDatabases(config, value.plan, (event) =>
            value.record({ custodian: "replacement", ...event }),
          );
          const next = await replacement.create(entry);
          assert.notEqual(next.oid, original.oid);
          await assert.rejects(value.owner.cleanup(), /Ownership mismatch/);
        } finally {
          await cleanupAll(...[replacement, !dropped ? value.owner : undefined].filter(Boolean));
        }
        await absent(value.plan);
        value.record({
          event: "original-custody-discharged",
          reason: "separately recorded deliberate replacement removed and absence verified",
        });
      },
    );

    await t.test(
      "real child SQL failure cancels its peer before owned database cleanup",
      async () => {
        const value = await allocation("child-failure", ["runtime", "channels"]);
        const ready = resolve(value.directory, "peer-ready");
        const processes = [];
        try {
          for (const entry of value.plan.databases) {
            await value.owner.create(entry);
            await value.owner.seedProbe(entry);
          }
          const connect =
            "import pg from 'pg';const client=new pg.Client({connectionString:process.env.OCC_TEST_DATABASE_URL});await client.connect();await client.query('SELECT value FROM isolated_test.marker');";
          const peer =
            connect +
            `import {writeFileSync} from 'node:fs';process.on('SIGTERM',async()=>{await client.end();process.exit(0)});writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`;
          const failure =
            connect +
            `import {existsSync} from 'node:fs';while(!existsSync(${JSON.stringify(ready)}))await new Promise(r=>setTimeout(r,10));try{await client.query('SELECT missing_fixture_column FROM isolated_test.marker')}finally{await client.end()}`;
          await assert.rejects(
            runChildren(
              value.plan.databases.map((entry, index) => ({
                label: entry.suite,
                args: ["--input-type=module", "--eval", index ? failure : peer],
                env: childEnvironment(
                  "OCC_TEST_DATABASE_URL",
                  connectionURL(config, "application", entry.name),
                ),
              })),
              {
                concurrency: 2,
                record: (event) => {
                  value.record(event);
                  if (event.event === "child-start") processes.push(event.pid);
                },
              },
            ),
          );
          assert.equal(processes.length, 2);
          for (const pid of processes) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
        } finally {
          await value.owner.cleanup();
        }
        await absent(value.plan);
      },
    );

    await t.test(
      "SIGTERM during the real two-suite runner cleans databases after reaping children",
      async () => {
        const directory = resolve(evidence, "interrupted-run");
        const child = spawn(
          process.execPath,
          [
            "scripts/test-postgres-isolated.mjs",
            "--config",
            resolve(process.env.OCC_ISOLATED_POSTGRES_CONFIG),
            "--output",
            directory,
            "--mode",
            "parallel",
          ],
          { cwd: process.cwd(), env: childEnvironment(), stdio: ["ignore", "pipe", "pipe"] },
        );
        const output = [];
        child.stdout.on("data", (chunk) => output.push(chunk));
        child.stderr.on("data", (chunk) => output.push(chunk));
        const closed = new Promise((done, reject) => {
          child.once("error", reject);
          child.once("close", (code, signal) => done({ code, signal }));
        });
        let running = false,
          result;
        try {
          for (let i = 0; i < 2000; i++) {
            let events = [];
            try {
              events = (await readFile(resolve(directory, "events.jsonl"), "utf8"))
                .trim()
                .split("\n")
                .filter(Boolean)
                .map(JSON.parse);
            } catch (error) {
              if (error.code !== "ENOENT") throw error;
            }
            if (
              events.filter(
                (event) =>
                  event.event === "child-start" && ["runtime", "channels"].includes(event.label),
              ).length === 2
            ) {
              running = true;
              break;
            }
            if (child.exitCode !== null) break;
            await delay(20);
          }
          assert.equal(running, true, "both real suite processes must start before interruption");
        } finally {
          child.kill("SIGTERM");
          let forced = false;
          const fallback = setTimeout(() => {
            // Do not signal historical journal PIDs: they may have been reused.
            // If the runner regresses, stop only its retained ChildProcess handle
            // and preserve all worker/database custody for the allocation owner.
            forced = true;
            child.kill("SIGKILL");
          }, 10000);
          try {
            result = await closed;
          } finally {
            clearTimeout(fallback);
            assert.equal(
              forced,
              false,
              "Runner did not close; retain manifest/journal resource custody.",
            );
          }
        }
        assert.deepEqual(result, { code: 143, signal: null });
        const summary = JSON.parse(await readFile(resolve(directory, "summary.json"), "utf8"));
        assert.equal(summary.cleanupVerified, true);
        assert.ok(summary.failures.length > 0);
        const events = (await readFile(resolve(directory, "events.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .map(JSON.parse);
        for (const event of events.filter((event) => event.event === "child-start"))
          assert.throws(() => process.kill(event.pid, 0), { code: "ESRCH" });
        await absent(summary.plan);
      },
    );
  },
);
