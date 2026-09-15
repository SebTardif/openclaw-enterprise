import { BlockList, isIP } from "node:net";
import { DestinationError } from "./destination-types.ts";

// Conservative github-public-destination-v1; special-service exceptions stay denied.
const denied = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["192.175.48.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  denied.addSubnet(address, prefix, "ipv4");
const allowed6 = new BlockList();
allowed6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["2620:4f:8000::", 48],
  ["3fff::", 20],
] as const)
  denied.addSubnet(address, prefix, "ipv6");

export function numericAddress(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= 45 && !/[\s%\[\]]/.test(value) && isIP(value) !== 0
  );
}
function publicAddress(value: unknown, family: 4 | 6): value is string {
  if (!numericAddress(value) || isIP(value) !== family) return false;
  if (family === 4) return !denied.check(value, "ipv4");
  return (
    /^[0-9a-fA-F:]+$/.test(value) && allowed6.check(value, "ipv6") && !denied.check(value, "ipv6")
  );
}
export function copyAnswers(value: unknown, family: 4 | 6): readonly string[] {
  if (!Array.isArray(value)) throw new DestinationError("dns-failure");
  if (value.length > 32) throw new DestinationError("answer-limit");
  const copy: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !("value" in descriptor) || !publicAddress(descriptor.value, family)) {
      throw new DestinationError("address-denied");
    }
    copy.push(descriptor.value);
  }
  return Object.freeze(copy);
}
