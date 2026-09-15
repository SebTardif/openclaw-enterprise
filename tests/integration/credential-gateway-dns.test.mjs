import assert from "node:assert/strict";
import test from "node:test";
import { createSocket } from "node:dgram";
import { getServers } from "node:dns";
import { performance } from "node:perf_hooks";
import {
  createDestinationSelector,
  DestinationError,
} from "../../apps/credential-gateway/src/transport/destination.ts";
import { createNodeDestinationResolver } from "../../apps/credential-gateway/src/transport/destination-node-resolver.ts";

const public4 = "140.82.112.3";
const public6 = "2606:50c0:8000::153";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bounds = (signal = new AbortController().signal, ms = 1200) => ({
  signal,
  deadline: Date.now() + ms,
});
const refused = (code) => (error) => error instanceof DestinationError && error.code === code;

function question(packet) {
  assert.ok(packet.length >= 17 && packet.length <= 512, "bounded DNS datagram");
  assert.equal(packet.readUInt16BE(2) & 0x8000, 0, "query packet");
  assert.equal(packet.readUInt16BE(4), 1, "one question");
  assert.equal(packet.readUInt16BE(6), 0);
  let offset = 12;
  const labels = [];
  while (true) {
    assert.ok(offset < packet.length);
    const size = packet[offset++];
    if (size === 0) break;
    assert.ok(size <= 63 && offset + size <= packet.length, "uncompressed bounded label");
    labels.push(packet.toString("ascii", offset, offset + size));
    offset += size;
  }
  assert.ok(offset + 4 <= packet.length);
  const name = labels.join(".");
  const type = packet.readUInt16BE(offset);
  assert.ok(name === "github.com" || name === "api.github.com", "fixed name only");
  assert.ok(type === 1 || type === 28, "A or AAAA only");
  assert.equal(packet.readUInt16BE(offset + 2), 1, "IN class");
  assert.equal(offset + 4, packet.length, "ordinary question without additional records");
  return { name, type, end: offset + 4 };
}
function addressBytes(address, type) {
  if (type === 1) {
    const bytes = address.split(".").map(Number);
    assert.equal(bytes.length, 4);
    assert.ok(bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255));
    return Buffer.from(bytes);
  }
  const halves = address.split("::");
  assert.ok(halves.length <= 2);
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const groups =
    halves.length === 2
      ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
      : left;
  assert.equal(groups.length, 8);
  const bytes = Buffer.alloc(16);
  groups.forEach((group, index) => bytes.writeUInt16BE(parseInt(group, 16), index * 2));
  return bytes;
}
// Encode fixture DNS records only; returned answer addresses are never dialed.
function response(packet, query, spec) {
  const answers = spec.answers ?? [];
  assert.ok(answers.length <= 8);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(packet.readUInt16BE(0), 0);
  header.writeUInt16BE(0x8180 | (spec.rcode ?? 0), 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(answers.length, 6);
  const records = answers.map((address) => {
    const bytes = addressBytes(address, query.type);
    const record = Buffer.alloc(12);
    record.writeUInt16BE(0xc00c, 0);
    record.writeUInt16BE(query.type, 2);
    record.writeUInt16BE(1, 4);
    record.writeUInt32BE(0, 6);
    record.writeUInt16BE(bytes.length, 10);
    return Buffer.concat([record, bytes]);
  });
  const result = Buffer.concat([header, packet.subarray(12, query.end), ...records]);
  assert.ok(result.length <= 512, "nontruncated response");
  return result;
}
async function fixture(t, handler, address = "127.0.0.1") {
  const socket = createSocket(address === "::1" ? "udp6" : "udp4");
  const queries = [];
  const faults = [];
  const timers = new Set();
  let sent = 0;
  let closed = false;
  let closeEvents = 0;
  socket.on("close", () => closeEvents++);
  socket.on("error", (error) => faults.push(error));
  socket.on("message", (packet, peer) => {
    try {
      const query = question(packet);
      queries.push({ ...query, id: packet.readUInt16BE(0), peer: peer.address });
      const spec = handler(query, queries.length);
      if (spec.silent) return;
      const reply = response(packet, query, spec);
      const send = () => {
        if (closed) return;
        socket.send(reply, peer.port, peer.address, (error) => {
          if (error) faults.push(error);
          else sent++;
        });
      };
      if (spec.delay) {
        const timer = setTimeout(() => {
          timers.delete(timer);
          send();
        }, spec.delay);
        timers.add(timer);
      } else send();
    } catch (error) {
      faults.push(error);
    }
  });
  t.after(async () => {
    closed = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    await new Promise((resolve) => socket.close(resolve));
    assert.equal(closeEvents, 1, "owned socket closed");
    assert.equal(timers.size, 0, "owned response timers cleared");
    assert.deepEqual(faults, [], "fixture wire/parser errors");
  });
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, address, () => {
      socket.removeListener("error", reject);
      resolve();
    });
  });
  const config = {
    servers: [{ address, port: socket.address().port }],
    lookupTimeoutMs: 1000,
  };
  const selector = createDestinationSelector(config, createNodeDestinationResolver);
  return {
    selector,
    config,
    queries,
    get sent() {
      return sent;
    },
    async waitQueries(count) {
      const deadline = performance.now() + 500;
      while (queries.length < count && performance.now() < deadline) await delay(2);
      assert.ok(queries.length >= count, "actual configured wire queries observed");
    },
  };
}
const safe = ({ type }) => ({ answers: [type === 1 ? public4 : public6] });
function bothFamilies(queries, name = "github.com") {
  assert.deepEqual(
    queries.map(({ name: observed, type }) => [observed, type]).sort(),
    [
      [name, 1],
      [name, 28],
    ].sort(),
  );
  assert.ok(queries.every(({ peer }) => peer === "127.0.0.1" || peer === "::1"));
}

test(
  "configured native DNS component: real loopback wire and cleanup",
  { timeout: 10000 },
  async (t) => {
    const globalServers = getServers();
    t.after(() =>
      assert.deepEqual(getServers(), globalServers, "global DNS configuration unchanged"),
    );
    await t.test("A plus AAAA selects frozen first A at port 443", async (t) => {
      const f = await fixture(t, safe);
      const result = await f.selector.select("github.com", bounds());
      assert.deepEqual(result, { hostname: "github.com", address: public4, family: 4, port: 443 });
      assert.ok(Object.isFrozen(result));
      bothFamilies(f.queries);
      assert.equal(f.sent, 2);
    });
    await t.test("configured IPv6 loopback server and nondefault port", async (t) => {
      const f = await fixture(t, safe, "::1");
      assert.equal((await f.selector.select("api.github.com", bounds())).address, public4);
      bothFamilies(f.queries, "api.github.com");
      assert.equal(f.sent, 2);
    });
    await t.test("multiple configured servers preserve native first-server order", async (t) => {
      const first = await fixture(t, safe);
      const second = await fixture(t, () => ({ silent: true }));
      const selector = createDestinationSelector(
        { ...first.config, servers: [...first.config.servers, ...second.config.servers] },
        createNodeDestinationResolver,
      );
      assert.equal((await selector.select("github.com", bounds())).address, public4);
      bothFamilies(first.queries);
      assert.deepEqual(second.queries, [], "no application query to the unused server");
      assert.equal(first.sent, 2);
      assert.equal(second.sent, 0);
    });
    for (const family of [1, 28]) {
      await t.test(
        `NOERROR empty opposite family selects ${family === 1 ? "A" : "AAAA"}`,
        async (t) => {
          const f = await fixture(t, ({ type }) => ({
            answers: type === family ? [family === 1 ? public4 : public6] : [],
          }));
          const result = await f.selector.select("github.com", bounds());
          assert.equal(result.family, family === 1 ? 4 : 6);
          assert.equal(result.address, family === 1 ? public4 : public6);
          bothFamilies(f.queries);
        },
      );
    }
    await t.test("both native ENODATA families refuse empty-answer", async (t) => {
      const f = await fixture(t, () => ({ answers: [] }));
      await assert.rejects(f.selector.select("github.com", bounds()), refused("empty-answer"));
      bothFamilies(f.queries);
    });
    for (const family of [1, 28]) {
      await t.test(
        `safe first and later private ${family === 1 ? "A" : "AAAA"} refuse complete set`,
        async (t) => {
          const f = await fixture(t, ({ type }) => ({
            answers:
              type === family
                ? [family === 1 ? public4 : public6, family === 1 ? "10.0.0.1" : "fc00::1"]
                : [type === 1 ? public4 : public6],
          }));
          await assert.rejects(
            f.selector.select("github.com", bounds()),
            refused("address-denied"),
          );
          bothFamilies(f.queries);
        },
      );
    }
    for (const family of [1, 28]) {
      await t.test(
        `NXDOMAIN in ${family === 1 ? "A" : "AAAA"} refuses despite safe opposite family`,
        async (t) => {
          const f = await fixture(t, (query) =>
            query.type === family ? { rcode: 3 } : safe(query),
          );
          await assert.rejects(f.selector.select("github.com", bounds()), refused("dns-failure"));
          bothFamilies(f.queries);
        },
      );
    }
    await t.test("silent configured server settles at selector deadline", async (t) => {
      const f = await fixture(t, () => ({ silent: true }));
      // The selector deadline precedes the native timeout, isolating terminal cancellation.
      const started = performance.now();
      let outcomes = 0;
      const selected = f.selector
        .select("github.com", bounds(undefined, 80))
        .finally(() => outcomes++);
      await assert.rejects(selected, refused("deadline"));
      assert.ok(performance.now() - started < 500, "settled before native timeout");
      bothFamilies(f.queries);
      await delay(120);
      assert.equal(outcomes, 1);
      assert.equal(f.sent, 0);
    });
    await t.test("fresh selections send fresh A/AAAA and observe changed answers", async (t) => {
      let answer = public4;
      const f = await fixture(t, ({ type }) => ({ answers: type === 1 ? [answer] : [] }));
      assert.equal((await f.selector.select("github.com", bounds())).address, public4);
      answer = "140.82.113.3";
      assert.equal((await f.selector.select("github.com", bounds())).address, answer);
      assert.equal(f.queries.length, 4);
      bothFamilies(f.queries.slice(0, 2));
      bothFamilies(f.queries.slice(2));
      assert.equal(f.sent, 4);
    });
    await t.test(
      "concurrent cancellation is isolated and late real responses cannot succeed",
      async (t) => {
        const f = await fixture(t, (query) => ({
          ...safe(query),
          delay: query.name === "github.com" ? 100 : 40,
        }));
        const controller = new AbortController();
        let abortedOutcomes = 0;
        const aborted = f.selector
          .select("github.com", bounds(controller.signal))
          .finally(() => abortedOutcomes++);
        const denial = assert.rejects(aborted, refused("aborted"));
        const independent = f.selector.select("api.github.com", bounds());
        // Abort after both calls have real A and AAAA queries in flight.
        await f.waitQueries(4);
        controller.abort();
        await denial;
        assert.equal((await independent).address, public4);
        await delay(120);
        assert.equal(abortedOutcomes, 1);
        bothFamilies(f.queries.filter(({ name }) => name === "github.com"));
        bothFamilies(
          f.queries.filter(({ name }) => name === "api.github.com"),
          "api.github.com",
        );
        assert.equal(f.sent, 4, "actual late responses emitted after cancellation");
      },
    );
  },
);
