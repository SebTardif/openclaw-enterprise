import type { V1LabelSelector } from "@kubernetes/client-node";

/** Explicit classification for controller-approved workload templates. Label
 * writers and NetworkPolicy enforcement remain separate trust boundaries. */
export const NETWORK_PROFILE_LABEL = "openclaw.dev/network-profile";
export const ORDINARY_NETWORK_PROFILE = "broad-egress-v1";

/** Ordinary grants require their exact profile. Scope labels cannot override it. */
export function ordinaryNetworkPolicySelector(
  matchLabels: Readonly<Record<string, string>> = {},
): V1LabelSelector {
  return {
    matchLabels: { ...matchLabels, [NETWORK_PROFILE_LABEL]: ORDINARY_NETWORK_PROFILE },
  };
}
