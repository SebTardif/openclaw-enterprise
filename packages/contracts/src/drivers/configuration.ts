import type { Driver } from "./base.ts";
import type { Configuration, ConfigurationReference } from "../resources/configuration.ts";

export interface ConfigurationDriver extends Driver {
  readonly capability: "configuration";
  create(configuration: Configuration): Promise<Configuration>;
  read(reference: ConfigurationReference): Promise<Configuration>;
  update(configuration: Configuration): Promise<Configuration>;
  delete(reference: ConfigurationReference): Promise<void>;
  validate(configuration: Configuration): Promise<void>;
}
