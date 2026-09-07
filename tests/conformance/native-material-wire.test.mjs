import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough, Readable, Writable } from "node:stream";
import {
  MATERIAL_PAYLOAD_BYTES,
  MATERIAL_FRAME_BYTES,
  materialMetadataTextV1,
  materialFrameKinds,
  createMaterialFrameV1,
  decodeMaterialFrameV1,
  assertMaterialFrameV1,
  readMaterialFrameV1,
  writeMaterialFrameV1,
} from "../../packages/utils/src/native-material-wire.ts";

const signal = () => new AbortController().signal;
const metadata = { schemaVersion: 1, kind: "selected-bundle", requestRef: "synthetic/request" };
function wire(kind, text, payload = new Uint8Array()) {
  const header = new TextEncoder().encode(text);
  const bytes = new Uint8Array(7 + header.length + payload.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, bytes.length - 4);
  bytes[4] = kind;
  view.setUint16(5, header.length);
  bytes.set(header, 7);
  bytes.set(payload, 7 + header.length);
  return bytes;
}

test("synthetic binary bundle is a borrowed view with joined zeroing, never metadata", async () => {
  const frame = createMaterialFrameV1(materialFrameKinds.result, metadata, 4);
  frame.payload.set([0, 255, 128, 13]);
  assert.equal(frame.metadata.kind, "selected-bundle");
  assert.equal(Object.hasOwn(frame.metadata, "payload"), false);
  let output;
  await writeMaterialFrameV1(
    new Writable({
      write(chunk, encoding, done) {
        output = Buffer.from(chunk);
        done();
      },
    }),
    frame,
    signal(),
  );
  assert.deepEqual([...frame.payload], [0, 0, 0, 0]);
  assert.throws(() => assertMaterialFrameV1(frame), /unavailable/);
  const decoded = decodeMaterialFrameV1(new Uint8Array(output));
  assert.deepEqual([...decoded.payload], [0, 255, 128, 13]);
  decoded.release();
  assert.deepEqual([...decoded.payload], [0, 0, 0, 0]);
});

test("maximum valid synthetic encoded bundle fits one native frame", () => {
  const frame = createMaterialFrameV1(7, metadata, MATERIAL_PAYLOAD_BYTES);
  assert.equal(frame.payload.length, 28672);
  assert.ok(frame.payload.buffer.byteLength <= MATERIAL_FRAME_BYTES);
  frame.release();
  assert.throws(() => createMaterialFrameV1(7, metadata, MATERIAL_PAYLOAD_BYTES + 1));
  assert.throws(() => createMaterialFrameV1(4, metadata, 1));
});

for (const [name, make] of [
  ["duplicate metadata keys", () => wire(4, '{"x":1,"x":2}')],
  ["noncanonical metadata whitespace", () => wire(4, '{ "x":1}')],
  ["unknown tag", () => wire(10, "{}")],
  ["unexpected payload", () => wire(4, "{}", new Uint8Array([1]))],
  ["non-object metadata", () => wire(4, "[]")],
  ["oversize metadata", () => wire(4, JSON.stringify({ text: "x".repeat(2048) }))],
  ["prototype-key metadata", () => wire(4, '{"__proto__":{}}')],
  [
    "trailing bytes",
    () => {
      const a = wire(4, "{}");
      const b = new Uint8Array(a.length + 1);
      b.set(a);
      return b;
    },
  ],
  [
    "invalid UTF-8",
    () => {
      const a = wire(4, "{}");
      a[7] = 255;
      return a;
    },
  ],
])
  test(`synthetic frame rejects ${name} without disclosing the offending value`, () => {
    assert.throws(() => decodeMaterialFrameV1(make()), {
      message: "Native material channel unavailable",
    });
  });

test("metadata getters are never evaluated and cycles cannot allocate an output frame", () => {
  let called = 0;
  assert.throws(() =>
    createMaterialFrameV1(4, {
      get value() {
        called++;
        return "private";
      },
    }),
  );
  const cyclic = {};
  cyclic.value = cyclic;
  assert.throws(() => createMaterialFrameV1(4, cyclic));
  assert.equal(called, 0);
});

test("encoder cannot change the frame header through a borrowed payload backing", () => {
  const frame = createMaterialFrameV1(7, metadata, 2);
  const backing = new Uint8Array(frame.payload.buffer);
  backing[4] = 4;
  assert.throws(() => assertMaterialFrameV1(frame));
  frame.release();
});

test("fragmented native input yields one frame and no next-frame prefetch", async () => {
  const bytes = wire(7, JSON.stringify(metadata), new Uint8Array([2, 4, 6]));
  const input = new PassThrough();
  const result = readMaterialFrameV1(input, signal());
  input.write(bytes.subarray(0, 2));
  await new Promise((resolve) => setImmediate(resolve));
  input.write(bytes.subarray(2, 9));
  input.write(bytes.subarray(9));
  const frame = await result;
  assert.deepEqual([...frame.payload], [2, 4, 6]);
  frame.release();
  input.destroy();
});

test("partial input cancellation and oversized length close without a payload", async () => {
  const input = new PassThrough(),
    abort = new AbortController();
  const pending = readMaterialFrameV1(input, abort.signal);
  input.write(new Uint8Array([0, 0]));
  abort.abort();
  await assert.rejects(pending, /unavailable/);
  input.destroy();
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, MATERIAL_FRAME_BYTES);
  await assert.rejects(readMaterialFrameV1(Readable.from([prefix]), signal()), /unavailable/);
});

test("pending backpressure retains the original buffer and refuses release or a second write", async () => {
  let complete;
  const stream = new Writable({
    write(chunk, encoding, done) {
      complete = done;
    },
  });
  const frame = createMaterialFrameV1(7, metadata, 3);
  frame.payload.set([7, 8, 9]);
  const pending = writeMaterialFrameV1(stream, frame, signal());
  assert.throws(() => frame.release(), /unavailable/);
  await assert.rejects(writeMaterialFrameV1(stream, frame, signal()), /unavailable/);
  assert.deepEqual([...frame.payload], [7, 8, 9]);
  complete();
  await pending;
  assert.deepEqual([...frame.payload], [0, 0, 0]);
});

test("exact Go metadata escaping preserves non-ASCII references and duplicate-key refusal", () => {
  const value = { ref: "selected/<x>&\u2028\u2029" };
  const encoded = materialMetadataTextV1(value);
  assert.equal(encoded, '{"ref":"selected/\\u003cx\\u003e\\u0026\\u2028\\u2029"}');
  const frame = decodeMaterialFrameV1(wire(4, encoded));
  assert.deepEqual(frame.metadata, value);
  frame.release();
  assert.throws(() => decodeMaterialFrameV1(wire(4, '{"ref":"first","ref":"second"}')));
});

test("a real Writable callback failure stays observed through its later error and close", async () => {
  const stream = new Writable({
    write(chunk, encoding, done) {
      done(new Error("synthetic write failure"));
    },
  });
  const closed = new Promise((resolve) => stream.once("close", resolve));
  const frame = createMaterialFrameV1(7, metadata, 2);
  frame.payload.set([3, 5]);
  await assert.rejects(writeMaterialFrameV1(stream, frame, signal()), {
    message: "Native material channel unavailable",
  });
  await closed;
  assert.deepEqual([...frame.payload], [0, 0]);
  assert.equal(stream.listenerCount("error"), 0);
});

test("aborted delayed output remains owned until the actual callback settles", async () => {
  let complete, destroyComplete;
  const stream = new Writable({
    write(chunk, encoding, done) {
      complete = done;
    },
    destroy(error, done) {
      destroyComplete = () => done(error);
    },
  });
  const closed = new Promise((resolve) => stream.once("close", resolve));
  const abort = new AbortController(),
    frame = createMaterialFrameV1(7, metadata, 2);
  frame.payload.set([11, 13]);
  const pending = writeMaterialFrameV1(stream, frame, abort.signal);
  const denied = assert.rejects(pending, /unavailable/);
  abort.abort();
  assert.deepEqual([...frame.payload], [11, 13]);
  assert.throws(() => frame.release());
  complete(new Error("synthetic delayed abort"));
  destroyComplete();
  await denied;
  await closed;
  assert.deepEqual([...frame.payload], [0, 0]);
  assert.equal(stream.listenerCount("error"), 0);
});

test("a distinct frame cannot queue behind pending output on the same pipe", async () => {
  let complete;
  const stream = new Writable({
    write(chunk, encoding, done) {
      complete = done;
    },
  });
  const first = createMaterialFrameV1(7, metadata, 1),
    second = createMaterialFrameV1(7, metadata, 1);
  const pending = writeMaterialFrameV1(stream, first, signal());
  await assert.rejects(writeMaterialFrameV1(stream, second, signal()), /unavailable/);
  second.release();
  complete();
  await pending;
});

test("completion input reuses only an actually retired original output backing", async () => {
  const frame = createMaterialFrameV1(7, metadata, 5);
  const ack = wire(8, '{"completed":true}');
  await assert.rejects(
    readMaterialFrameV1(Readable.from([ack], { objectMode: false }), signal(), frame),
    /unavailable/,
  );
  const backing = frame.payload.buffer;
  await writeMaterialFrameV1(
    new Writable({
      write(chunk, encoding, done) {
        done();
      },
    }),
    frame,
    signal(),
  );
  const result = await readMaterialFrameV1(
    Readable.from([ack], { objectMode: false }),
    signal(),
    frame,
  );
  assert.equal(result.payload.buffer, backing);
  assert.equal(result.metadata.completed, true);
  await assert.rejects(
    readMaterialFrameV1(Readable.from([ack], { objectMode: false }), signal(), frame),
    /unavailable/,
  );
  result.release();
  assert.ok(new Uint8Array(backing).every((x) => x === 0));
});

test("resizable or foreign backing cannot be adopted as fixed owned material storage", () => {
  const input = wire(4, "{}");
  const resizable = new ArrayBuffer(input.length, { maxByteLength: 32768 });
  new Uint8Array(resizable).set(input);
  assert.throws(() => decodeMaterialFrameV1(new Uint8Array(resizable)), /unavailable/);
});
