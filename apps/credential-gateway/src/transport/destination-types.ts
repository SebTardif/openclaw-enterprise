export type GitHubHostname = "github.com" | "api.github.com";
export interface DnsServer {
  readonly address: string;
  readonly port: number;
}
export interface DestinationConfig {
  readonly servers: readonly DnsServer[];
  readonly lookupTimeoutMs: number;
}
export interface DestinationResolver {
  resolve4(hostname: GitHubHostname): Promise<readonly string[]>;
  resolve6(hostname: GitHubHostname): Promise<readonly string[]>;
  cancel(): void;
}
export type DestinationResolverFactory = (
  config: Readonly<DestinationConfig>,
) => DestinationResolver;
export interface NumericDestination {
  readonly hostname: GitHubHostname;
  readonly address: string;
  readonly family: 4 | 6;
  readonly port: 443;
}
export interface DestinationSelector {
  select(
    hostname: GitHubHostname,
    bounds: { readonly signal: AbortSignal; readonly deadline: number },
  ): Promise<Readonly<NumericDestination>>;
}
export class DestinationError extends Error {
  readonly code:
    | "invalid-config"
    | "invalid-host"
    | "invalid-bounds"
    | "aborted"
    | "deadline"
    | "dns-failure"
    | "empty-answer"
    | "answer-limit"
    | "address-denied";

  constructor(code: DestinationError["code"]) {
    super(`Destination selection refused: ${code}`);
    this.name = "DestinationError";
    this.code = code;
  }
}
