/** Selected channel material is a private binary payload, never JSON or logs.
 * This codec allocates no payload storage and supplies no delivery authority.
 * The caller owns the source backing and native frame for the whole borrow.
 * Each fixed endpoint allows two payload/frame allocations and64KiB; the four
 * endpoint call has a separate eight/256KiB cap, with OS/TLS disclosed separately.
 */
export const GATEWAY_CHANNEL_MATERIAL_LIMITS_V1 = Object.freeze({
  payloadBytes: 28_672,
  metadataBytes: 2_048,
  frameBytes: 32_768,
  ownedBytes: 65_536,
  headerBytes: 10,
  endpointAllocations: 2,
  completeCallAllocations: 8,
  completeCallOwnedBytes: 262_144,
} as const);

export type GatewayChannelMaterialUseV1 = "startup-slack-pair" | "teams-invocation-token";

export type GatewayChannelSlackMaterialV1 = Readonly<{
  use: "startup-slack-pair";
  botToken: Uint8Array;
  appToken: Uint8Array;
}>;

export class GatewayChannelMaterialUnavailableV1 extends Error {
  constructor() {
    super("Selected channel material is unavailable.");
    this.name = "GatewayChannelMaterialUnavailableV1";
  }
}
function unavailable(): never {
  throw new GatewayChannelMaterialUnavailableV1();
}

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const getBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")!.get!;
const getLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")!.get!;
const getOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")!.get!;
const getBackingLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get!;
const getResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get;
const set = Uint8Array.prototype.set;
type View = Readonly<{
  value: Uint8Array;
  buffer: ArrayBuffer;
  length: number;
  offset: number;
  backingLength: number;
}>;

/** Intrinsic accessors reject spoofed properties, shared/resizable and detached
 * storage. The returned object is only metadata, not another material backing. */
function fixed(value: Uint8Array, max: number): View {
  try {
    if (!(value instanceof Uint8Array)) unavailable();
    const buffer: unknown = getBuffer.call(value);
    if (!(buffer instanceof ArrayBuffer) || getResizable?.call(buffer) === true) unavailable();
    const length = getLength.call(value) as number;
    const offset = getOffset.call(value) as number;
    const backingLength = getBackingLength.call(buffer) as number;
    if (length < 1 || length > max || backingLength > max) unavailable();
    return { value, buffer, length, offset, backingLength };
  } catch {
    return unavailable();
  }
}

/** Validate UTF-8 without allocating a decoded string or another byte buffer. */
function token(value: Uint8Array, length: number): void {
  for (let i = 0; i < length; i++) {
    const first = value[i]!;
    if (first === 0) unavailable();
    if (first < 0x80) continue;
    let count: number;
    let lower = 0x80;
    let upper = 0xbf;
    if (first >= 0xc2 && first <= 0xdf) count = 1;
    else if (first >= 0xe0 && first <= 0xef) {
      count = 2;
      if (first === 0xe0) lower = 0xa0;
      if (first === 0xed) upper = 0x9f;
    } else if (first >= 0xf0 && first <= 0xf4) {
      count = 3;
      if (first === 0xf0) lower = 0x90;
      if (first === 0xf4) upper = 0x8f;
    } else return unavailable();
    if (i + count >= length) unavailable();
    const second = value[++i]!;
    if (second < lower || second > upper) unavailable();
    for (let j = 1; j < count; j++) {
      const next = value[++i]!;
      if (next < 0x80 || next > 0xbf) unavailable();
    }
  }
}
function checked(material: GatewayChannelSlackMaterialV1): Readonly<{
  bot: View;
  app: View;
  length: number;
}> {
  try {
    if (!material || typeof material !== "object" || Object.keys(material).length !== 3)
      unavailable();
    const use = Object.getOwnPropertyDescriptor(material, "use");
    const botDescriptor = Object.getOwnPropertyDescriptor(material, "botToken");
    const appDescriptor = Object.getOwnPropertyDescriptor(material, "appToken");
    if (
      !use ||
      !botDescriptor ||
      !appDescriptor ||
      !Object.hasOwn(use, "value") ||
      !Object.hasOwn(botDescriptor, "value") ||
      !Object.hasOwn(appDescriptor, "value") ||
      use.value !== "startup-slack-pair"
    )
      unavailable();
    const bot = fixed(
      botDescriptor.value as Uint8Array,
      GATEWAY_CHANNEL_MATERIAL_LIMITS_V1.ownedBytes,
    );
    const app = fixed(
      appDescriptor.value as Uint8Array,
      GATEWAY_CHANNEL_MATERIAL_LIMITS_V1.ownedBytes,
    );
    if (
      bot.buffer !== app.buffer ||
      bot.offset !== 0 ||
      app.offset !== bot.length ||
      bot.length + app.length !== bot.backingLength
    )
      unavailable();
    const length = GATEWAY_CHANNEL_MATERIAL_LIMITS_V1.headerBytes + bot.length + app.length;
    if (length > GATEWAY_CHANNEL_MATERIAL_LIMITS_V1.payloadBytes) unavailable();
    token(bot.value, bot.length);
    token(app.value, app.length);
    return { bot, app, length };
  } catch {
    return unavailable();
  }
}

/** Source is the exact jointly selected dedicated Slack backing, bot then app.
 * Requiring full, adjacent coverage rejects pooled or unrelated source bytes.
 * Teams remains unavailable until its qualified producer/expiry shape exists.
 */
export function gatewayChannelMaterialEncodedLengthV1(
  material: GatewayChannelSlackMaterialV1,
): number {
  return checked(material).length;
}

/** GCM version 1: 47 43 4d 01, Slack use 01, reserved 00,
 * two unsigned big-endian16-bit lengths, then bot and app UTF-8 bytes.
 * Encode into the native-owned exact payload view, with no third allocation.
 * All size/backing checks occur before any target write. Metadata is separate.
 */
export function encodeGatewayChannelMaterialIntoV1(
  material: GatewayChannelSlackMaterialV1,
  target: Uint8Array,
): number {
  const { bot, app, length } = checked(material);
  const destination = fixed(target, GATEWAY_CHANNEL_MATERIAL_LIMITS_V1.frameBytes);
  if (
    destination.length !== length ||
    destination.buffer === bot.buffer ||
    destination.backingLength + bot.backingLength > GATEWAY_CHANNEL_MATERIAL_LIMITS_V1.ownedBytes
  )
    unavailable();
  target[0] = 0x47;
  target[1] = 0x43;
  target[2] = 0x4d;
  target[3] = 1;
  target[4] = 1;
  target[5] = 0;
  target[6] = bot.length >>> 8;
  target[7] = bot.length & 0xff;
  target[8] = app.length >>> 8;
  target[9] = app.length & 0xff;
  set.call(target, bot.value, 10);
  set.call(target, app.value, 10 + bot.length);
  return length;
}

/** Returns borrowed views into the receiver-owned frame; no material copy.
 * The receiver must keep and join that original frame owner before disposal.
 * The result, expected-use argument and bytes do not authenticate a recipient,
 * select a Secret, prove an original claim, or establish provider token expiry.
 */
export function decodeGatewayChannelMaterialV1(
  encoded: Uint8Array,
  expectedUse: GatewayChannelMaterialUseV1,
): GatewayChannelSlackMaterialV1 {
  const view = fixed(encoded, GATEWAY_CHANNEL_MATERIAL_LIMITS_V1.frameBytes);
  if (
    expectedUse !== "startup-slack-pair" ||
    view.length < GATEWAY_CHANNEL_MATERIAL_LIMITS_V1.headerBytes + 2 ||
    view.length > GATEWAY_CHANNEL_MATERIAL_LIMITS_V1.payloadBytes ||
    encoded[0] !== 0x47 ||
    encoded[1] !== 0x43 ||
    encoded[2] !== 0x4d ||
    encoded[3] !== 1 ||
    encoded[4] !== 1 ||
    encoded[5] !== 0
  )
    unavailable();
  const botLength = encoded[6]! * 256 + encoded[7]!;
  const appLength = encoded[8]! * 256 + encoded[9]!;
  if (botLength < 1 || appLength < 1 || 10 + botLength + appLength !== view.length) unavailable();
  const botToken = new Uint8Array(view.buffer, view.offset + 10, botLength);
  const appToken = new Uint8Array(view.buffer, view.offset + 10 + botLength, appLength);
  token(botToken, botLength);
  token(appToken, appLength);
  return Object.freeze({ use: "startup-slack-pair", botToken, appToken });
}
