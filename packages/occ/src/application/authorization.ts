import type {
  AuthorizationDecision,
  AuthorizationRequest,
} from "@openclaw-enterprise/contracts/identity/authorization";
import type { IAMDriver } from "@openclaw-enterprise/contracts/drivers/iam";
import type { ResourceRef } from "@openclaw-enterprise/contracts/resources/scope";
import { isNonEmptyString } from "@openclaw-enterprise/utils";
import { AuthorizationDeniedError, DependencyUnavailableError } from "../errors.ts";
import type { SelectedDriver } from "./driver-selection.ts";

export type AuthorizationCallback = (
  request: AuthorizationRequest,
) => AuthorizationDecision | Promise<AuthorizationDecision>;

/** Exact operation decisions from the current Installation-selected IAM Driver. */
export class ExactAuthorization {
  private readonly selectedIAM: SelectedDriver<"iam">;
  private readonly authorization: AuthorizationCallback | undefined;

  constructor(selectedIAM: SelectedDriver<"iam">, authorization?: AuthorizationCallback) {
    this.selectedIAM = selectedIAM;
    this.authorization = authorization;
  }

  async authorize(
    principalId: string,
    action: AuthorizationRequest["action"],
    resource: ResourceRef,
  ): Promise<void> {
    const decision = await this.authorizationDecision(principalId, action, resource);
    if (!decision.allowed)
      throw new AuthorizationDeniedError(
        isNonEmptyString(decision.reason) ? decision.reason : "The exact operation was denied.",
        decision.evidence,
        { action, resource },
      );
  }

  async canRead(principalId: string, resource: ResourceRef): Promise<boolean> {
    return (await this.authorizationDecision(principalId, "read", resource)).allowed;
  }

  authorizationAuthority(principalId: string): IAMDriver {
    if (!isNonEmptyString(principalId))
      throw new AuthorizationDeniedError("The acting identity is unavailable.");
    try {
      return this.selectedIAM();
    } catch {
      throw new DependencyUnavailableError("The selected authorization Driver is unavailable.");
    }
  }

  async authorizationDecision(
    principalId: string,
    action: AuthorizationRequest["action"],
    resource: ResourceRef,
  ): Promise<AuthorizationDecision> {
    const selected = this.authorizationAuthority(principalId);
    const selectedId = selected.id;
    const request = Object.freeze({
      principalId,
      action,
      resource: Object.freeze({ ...resource }),
    });
    let decision: AuthorizationDecision;
    try {
      decision = this.authorization
        ? await this.authorization(request)
        : await selected.authorize(request);
    } catch {
      throw new DependencyUnavailableError(
        "The selected authorization Driver could not verify the operation.",
      );
    }
    if (
      !decision ||
      typeof decision.allowed !== "boolean" ||
      !isNonEmptyString(decision.driverId) ||
      !decision.evidence ||
      (decision.evidence.identityId !== undefined &&
        !isNonEmptyString(decision.evidence.identityId)) ||
      !["groupIds", "bindingIds", "roleIds", "restrictionIds"].every((key) => {
        const entries = decision.evidence[key as keyof typeof decision.evidence];
        return Array.isArray(entries) && entries.every(isNonEmptyString);
      })
    )
      throw new DependencyUnavailableError(
        "The selected authorization Driver returned an invalid decision.",
      );
    if (
      decision.driverId !== selectedId ||
      selected.id !== selectedId ||
      this.authorizationAuthority(principalId) !== selected
    )
      throw new DependencyUnavailableError("The authorization decision belongs to another Driver.");
    return decision;
  }
}
