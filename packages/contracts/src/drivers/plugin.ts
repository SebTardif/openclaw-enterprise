import type { Driver } from "./base.ts";
import type { Namespace } from "../resources/namespace.ts";
import type { Agent, RevisionHarnessDescriptor } from "../resources/agent.ts";
import type { OpenClawConfigurationDocument } from "../resources/configuration.ts";
import type { PluginCatalogEntry } from "../resources/plugin.ts";

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
