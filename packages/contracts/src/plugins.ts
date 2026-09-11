import { Check } from "typebox/value";
import { asRecord, immutableCopy, isNonEmptyString } from "@openclaw-enterprise/utils";
import {
  PluginDriverIdentitySchema,
  PluginToolPolicySchema,
  PluginDesiredSelectionSchema,
  PluginDesiredStateSchema,
} from "./api/resources.ts";
import type { Driver } from "./drivers/base.ts";
import type { Namespace } from "./resources/namespace.ts";
import type { Agent, RevisionHarnessDescriptor } from "./resources/agent.ts";
import type { OpenClawConfigurationDocument } from "./resources/configuration.ts";

export type PluginApprovalMode = "always" | "never" | "prompt" | "auto";

export type PluginApprovalsReviewer = "user" | "auto_review";

export interface PluginDriverIdentity {
  readonly id: string;
  readonly implementation: string;
}

export interface PluginToolPolicy {
  readonly enabled?: boolean;
  readonly approvalMode?: PluginApprovalMode;
}

export interface PluginDesiredSelection {
  readonly enabled: boolean;
  readonly approvalMode: PluginApprovalMode;
  readonly approvalsReviewer?: PluginApprovalsReviewer;
  readonly destructiveActions?: PluginApprovalMode;
  readonly writes?: PluginApprovalMode;
  readonly tools?: Readonly<Record<string, PluginToolPolicy>>;
}

export type PluginDesiredState = Readonly<Record<string, PluginDesiredSelection>>;

export interface PluginToolCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly destructive: boolean;
  readonly writes: boolean;
}

export interface PluginCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly tools: readonly PluginToolCatalogEntry[] | null;
}

export interface PluginRevisionState {
  readonly driver: PluginDriverIdentity;
  readonly plugins: PluginDesiredState;
}

export type PluginValidationFailure = (message: string) => never;

const PLUGIN_SCHEMA_REFS = {
  PluginDriverIdentity: PluginDriverIdentitySchema,
  PluginToolPolicy: PluginToolPolicySchema,
  PluginDesiredSelection: PluginDesiredSelectionSchema,
  PluginDesiredState: PluginDesiredStateSchema,
};

function validPluginDriverIdentity(value: unknown): value is PluginDriverIdentity {
  if (!Check(PLUGIN_SCHEMA_REFS, PluginDriverIdentitySchema, value)) return false;
  const driver = value as PluginDriverIdentity;
  return isNonEmptyString(driver.id) && isNonEmptyString(driver.implementation);
}

export function normalizePluginDesiredState(
  plugins: unknown,
  fail: PluginValidationFailure,
): PluginDesiredState | undefined {
  if (plugins === undefined) return undefined;
  if (!Check(PLUGIN_SCHEMA_REFS, PluginDesiredStateSchema, plugins)) {
    return fail("Agent plugin selections are invalid.");
  }
  return immutableCopy(plugins as PluginDesiredState);
}

export function validPluginRevisionState(value: unknown): value is PluginRevisionState | undefined {
  if (value === undefined) return true;
  const record = asRecord(value);
  if (
    record === undefined ||
    Object.keys(record).some((key) => key !== "driver" && key !== "plugins")
  ) {
    return false;
  }
  if (!validPluginDriverIdentity(record.driver) || record.plugins === undefined) {
    return false;
  }
  try {
    normalizePluginDesiredState(record.plugins, (message) => {
      throw new Error(message);
    });
  } catch {
    return false;
  }
  return true;
}

export interface PluginDriverContext {
  readonly namespace: Readonly<Namespace>;
  readonly agent: Readonly<Agent>;
  readonly harness: RevisionHarnessDescriptor;
  readonly configuration: Readonly<OpenClawConfigurationDocument>;
  readonly signal: AbortSignal;
}

export interface PluginDriver extends Driver {
  readonly capability: "plugin";
  listCatalog(context: PluginDriverContext): Promise<readonly PluginCatalogEntry[]>;
}
