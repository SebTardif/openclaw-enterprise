import { parseRootGrantV1, parseModelOperationV1, sameModelOperation } from "./grant-contract.ts";
import { dataRecord, reference } from "./validation.ts";

const references = [
  "providerBindingRef",
  "serviceAccountId",
  "credentialProfileRef",
  "providerProfileRef",
  "audienceRef",
] as const;

/** Server-owned metadata only; credential bytes and caller-selected origins are never inputs. */
export interface CredentialBindingV1 {
  readonly providerBindingRef: string;
  readonly serviceAccountId: string;
  readonly credentialProfileRef: string;
  readonly providerProfileRef: string;
  readonly audienceRef: string;
  readonly transportProfileRef: "codex-responses-http-v1";
  readonly upstreamOrigin: "https://api.openai.com";
}

export function parseCredentialBindingV1(input: unknown): CredentialBindingV1 | undefined {
  const value = dataRecord(input, [...references, "transportProfileRef", "upstreamOrigin"]);
  if (
    !value ||
    !references.every((field) => reference(value[field])) ||
    value.transportProfileRef !== "codex-responses-http-v1" ||
    value.upstreamOrigin !== "https://api.openai.com"
  )
    return undefined;
  return Object.freeze(value) as unknown as CredentialBindingV1;
}

/**
 * The selected binding comes from the canonical configuration owner and must remain tied
 * to the immutable grant. Configured binding describes the acceptor's actual fixed secret.
 * Equality proves neither provenance nor current credential/identity authorization.
 */
export function matchesCredentialBinding(
  grantInput: unknown,
  operationInput: unknown,
  selectedInput: unknown,
  configuredInput: unknown,
): boolean {
  const grant = parseRootGrantV1(grantInput);
  const operation = parseModelOperationV1(operationInput);
  const selected = parseCredentialBindingV1(selectedInput);
  const configured = parseCredentialBindingV1(configuredInput);
  if (!grant || !operation || !selected || !configured) return false;
  return (
    grant.operations.some((ceiling) => sameModelOperation(ceiling, operation)) &&
    selected.providerBindingRef === operation.providerBindingRef &&
    selected.providerProfileRef === grant.holder.providerProfileRef &&
    selected.audienceRef === grant.audienceRef &&
    selected.transportProfileRef === operation.transportProfileRef &&
    references.every((field) => selected[field] === configured[field]) &&
    selected.transportProfileRef === configured.transportProfileRef &&
    selected.upstreamOrigin === configured.upstreamOrigin
  );
}
