import { numericAddress } from "./destination-addresses.ts";
import { DestinationError, type DestinationConfig, type DnsServer } from "./destination-types.ts";

export function ownData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
function copyConfig(config: DestinationConfig): Readonly<DestinationConfig> {
  if (!config || typeof config !== "object") throw new DestinationError("invalid-config");
  const inputServers = ownData(config, "servers");
  const timeout = ownData(config, "lookupTimeoutMs");
  if (
    !Array.isArray(inputServers) ||
    inputServers.length < 1 ||
    inputServers.length > 3 ||
    typeof timeout !== "number" ||
    !Number.isInteger(timeout) ||
    timeout < 1 ||
    timeout > 5000
  ) {
    throw new DestinationError("invalid-config");
  }
  const servers: DnsServer[] = [];
  for (let i = 0; i < inputServers.length; i++) {
    const server = ownData(inputServers, String(i));
    if (!server || typeof server !== "object") throw new DestinationError("invalid-config");
    const address = ownData(server, "address");
    const port = ownData(server, "port");
    if (
      !numericAddress(address) ||
      typeof port !== "number" ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    )
      throw new DestinationError("invalid-config");
    servers.push(Object.freeze({ address, port }));
  }
  return Object.freeze({ servers: Object.freeze(servers), lookupTimeoutMs: timeout });
}

export function retainConfig(config: DestinationConfig): Readonly<DestinationConfig> {
  try {
    return copyConfig(config);
  } catch {
    throw new DestinationError("invalid-config");
  }
}
