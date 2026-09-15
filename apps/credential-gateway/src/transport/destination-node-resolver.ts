import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";
import type { DestinationResolverFactory, GitHubHostname } from "./destination.ts";

async function query(
  resolver: Resolver,
  family: 4 | 6,
  hostname: GitHubHostname,
): Promise<readonly string[]> {
  try {
    return await (family === 4 ? resolver.resolve4(hostname) : resolver.resolve6(hostname));
  } catch (error: unknown) {
    if (
      error &&
      typeof error === "object" &&
      Object.getOwnPropertyDescriptor(error, "code")?.value === "ENODATA"
    )
      return [];
    throw error;
  }
}

// The selector supplies retained, validated configuration and owns call cleanup.
export const createNodeDestinationResolver: DestinationResolverFactory = (config) => {
  const resolver = new Resolver({ timeout: config.lookupTimeoutMs, tries: 1 });
  resolver.setServers(
    config.servers.map(({ address, port }) =>
      isIP(address) === 6 ? `[${address}]:${port}` : `${address}:${port}`,
    ),
  );
  return Object.freeze({
    resolve4: (hostname: GitHubHostname) => query(resolver, 4, hostname),
    resolve6: (hostname: GitHubHostname) => query(resolver, 6, hostname),
    cancel: () => resolver.cancel(),
  });
};
