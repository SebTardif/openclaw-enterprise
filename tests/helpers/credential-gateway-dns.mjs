import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import {
  createDestinationSelector,
  DestinationError,
} from "../../apps/credential-gateway/src/transport/destination.ts";
import { createNodeDestinationResolver } from "../../apps/credential-gateway/src/transport/destination-node-resolver.ts";

export const public4 = "140.82.112.3";
export const public6 = "2606:50c0:8000::153";
export const publicAnswers = { A: [public4], AAAA: [public6] };
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const bounds = (signal = new AbortController().signal, ms = 1200) => ({
  signal,
  deadline: Date.now() + ms,
});
export const refused = (code) => (error) =>
  error instanceof DestinationError && error.code === code;

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
// Plans describe A/AAAA answers, response codes, delay, or silence. Only the
// native resolver and selector interpret their application consequences.
class NativeDnsFixture {
  queries = [];
  faults = [];
  timers = new Map();
  sent = 0;
  closed = false;

  constructor(answers, address) {
    this.answers = answers;
    this.address = address;
    this.socket = createSocket(address === "::1" ? "udp6" : "udp4");
    this.socket.on("error", this.recordFault.bind(this));
    this.socket.on("message", this.receive.bind(this));
  }

  recordFault(error) {
    this.faults.push(error);
  }

  receive(packet, peer) {
    try {
      const query = question(packet);
      this.queries.push({ ...query, id: packet.readUInt16BE(0), peer: peer.address });
      const plan = typeof this.answers === "function" ? this.answers(query) : this.answers;
      if (plan.silent) return;
      const records = plan[query.type === 1 ? "A" : "AAAA"];
      assert.ok(records, "fixture must specify both A and AAAA responses");
      const spec = Array.isArray(records) ? { answers: records } : records;
      const reply = response(packet, query, spec);
      if (plan.delayMs) {
        this.timers.set(reply, setTimeout(this.send.bind(this, reply, peer), plan.delayMs));
      } else {
        this.send(reply, peer);
      }
    } catch (error) {
      this.recordFault(error);
    }
  }

  send(reply, peer) {
    this.timers.delete(reply);
    if (this.closed) return;
    this.socket.send(reply, peer.port, peer.address, this.recordSend.bind(this));
  }

  recordSend(error) {
    if (error) this.recordFault(error);
    else this.sent++;
  }

  async listen() {
    try {
      const listening = once(this.socket, "listening");
      this.socket.bind(0, this.address);
      await listening;
    } catch (cause) {
      this.socket.close();
      throw new Error(`DNS fixture could not bind ${this.address}`, { cause });
    }
    this.config = {
      servers: [{ address: this.address, port: this.socket.address().port }],
      lookupTimeoutMs: 1000,
    };
  }

  async close() {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    await new Promise((resolve) => this.socket.close(resolve));
    assert.deepEqual(this.faults, [], "DNS fixture wire/parser errors");
  }

  async waitQueries(count) {
    const deadline = performance.now() + 500;
    while (this.queries.length < count && performance.now() < deadline) await delay(2);
    assert.ok(this.queries.length >= count, "actual configured wire queries observed");
  }
}

export async function nativeDns(t, answers, address = "127.0.0.1") {
  const fixture = new NativeDnsFixture(answers, address);
  await fixture.listen();
  t.after(() => fixture.close());
  fixture.selector = nativeSelector(fixture.config);
  return fixture;
}

export function nativeSelector(config) {
  return createDestinationSelector(config, createNodeDestinationResolver);
}

export function bothFamilies(queries, name = "github.com") {
  assert.deepEqual(
    queries.map(({ name: observed, type }) => [observed, type]).sort(),
    [
      [name, 1],
      [name, 28],
    ].sort(),
    "actual A and AAAA queries for the selected hostname",
  );
  assert.ok(queries.every(({ peer }) => peer === "127.0.0.1" || peer === "::1"));
}

export async function expectSelection(
  fixture,
  {
    hostname = "github.com",
    address = public4,
    family = 4,
    error,
    selector = fixture.selector,
  } = {},
) {
  const selected = selector.select(hostname, bounds());
  if (error) {
    await assert.rejects(selected, refused(error));
  } else {
    const result = await selected;
    assert.deepEqual(result, { hostname, address, family, port: 443 });
    assert.ok(Object.isFrozen(result));
  }
  bothFamilies(fixture.queries, hostname);
  assert.equal(fixture.sent, 2, "both DNS responses emitted");
}
