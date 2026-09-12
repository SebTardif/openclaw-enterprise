import type { Scope } from "./scope.ts";
import type { SecretBindings } from "./secret.ts";

export const CONFIGURATION_KINDS = Object.freeze(["agent"] as const);

export type ConfigurationKind = (typeof CONFIGURATION_KINDS)[number];

export type OpenClawConfigurationValue =
  | null
  | boolean
  | number
  | string
  | readonly OpenClawConfigurationValue[]
  | { readonly [key: string]: OpenClawConfigurationValue };

export interface OpenClawConfigurationDocument {
  readonly [key: string]: OpenClawConfigurationValue;
}

export interface Configuration extends Scope {
  readonly id: string;
  readonly namespaceId: string;
  readonly kind: ConfigurationKind;
  readonly generation: number;
  readonly values: OpenClawConfigurationDocument;
  readonly secretBindings?: SecretBindings;
  readonly createdAt: string;
}

export interface ConfigurationReference extends Scope {
  readonly id: string;
  readonly namespaceId: string;
}
