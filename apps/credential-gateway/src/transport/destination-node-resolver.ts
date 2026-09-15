import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";
import type { DestinationResolverFactory, GitHubHostname } from "./destination.ts";

// The selector supplies retained, validated configuration and owns call cleanup.
export const createNodeDestinationResolver: DestinationResolverFactory = (config) => {
  const resolver = new Resolver({ timeout: config.lookupTimeoutMs, tries: 1 });
  resolver.setServers(
    config.servers.map(({ address, port }) =>
      isIP(address) === 6 ? `[${address}]:${port}` : `${address}:${port}`,
    ),
  );
  const query = async (family: 4 | 6, hostname: GitHubHostname): Promise<readonly string[]> => {
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
  };
  return Object.freeze({
    resolve4: (hostname: GitHubHostname) => query(4, hostname),
    resolve6: (hostname: GitHubHostname) => query(6, hostname),
    cancel: () => resolver.cancel(),
  });
};
