export const RESOURCE_KINDS = Object.freeze([
  "installation",
  "namespace",
  "configuration",
  "service_account",
  "secret",
  "agent",
  "agent_revision",
] as const);

export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export function isResourceKind(value: unknown): value is ResourceKind {
  return typeof value === "string" && RESOURCE_KINDS.some((kind) => kind === value);
}

export interface Scope {
  readonly namespaceId?: string;
}

export interface ResourceRef extends Scope {
  readonly kind: ResourceKind;
  readonly id: string;
}
