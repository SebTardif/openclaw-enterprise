import type { Scope } from "@openclaw-enterprise/contracts/scope";
import { installationScope } from "@openclaw-enterprise/contracts/resources/scope";
import { namespaceKey } from "../../ports/configuration.js";

export const configurationKey = (scope: Scope = installationScope) => namespaceKey(scope);
