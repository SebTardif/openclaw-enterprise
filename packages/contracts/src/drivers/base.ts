import type { ComputeLifecycleHooks } from "./compute.ts";

export const DRIVER_CAPABILITIES = Object.freeze([
  "iam",
  "compute",
  "configuration",
  "service_account",
  "secret",
  "sandbox",
] as const);

export type DriverCapability = (typeof DRIVER_CAPABILITIES)[number];

export function isDriverCapability(value: unknown): value is DriverCapability {
  return (
    typeof value === "string" && DRIVER_CAPABILITIES.some((capability) => capability === value)
  );
}

export interface Driver {
  readonly id: string;
  readonly capability: DriverCapability;
  readonly implementation: string;
  readonly computeLifecycleHooks?: ComputeLifecycleHooks;
}

export type JSONSchema = Readonly<Record<string, unknown>>;

export interface DriverImplementation {
  readonly configurationSchema: JSONSchema;
  validateConfiguration(configuration: unknown): void;
}
