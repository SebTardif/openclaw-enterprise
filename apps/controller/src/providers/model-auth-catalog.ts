import type { ModelAuthCatalogProvider } from "@openclaw-enterprise/contracts";

// Native support and OCE deployment support are separate capabilities.
// TODO(runtime capabilities): derive deployment availability from the selected runtime adapter.
export const MODEL_AUTH_CATALOG: readonly ModelAuthCatalogProvider[] = [
  {
    id: "openai",
    label: "OpenAI",
    requiresBaseUrl: false,
    authMethods: [
      {
        id: "api-key",
        label: "API key",
        credentialKind: "secret",
        nativeProviderId: "openai",
        nativeMethodId: "api-key",
        nativeVersion: "2026.9.1",
        deploymentAuthMethod: "provider_connection",
        unavailableReason: null,
      },
      // TODO(provider OAuth integration): enable after login and credential deployment are wired.
      {
        id: "oauth",
        label: "ChatGPT / Codex login",
        credentialKind: "oauth",
        nativeProviderId: "openai",
        nativeMethodId: "oauth",
        nativeVersion: "2026.9.1",
        deploymentAuthMethod: null,
        unavailableReason: "OAuth login and credential deployment are not available yet.",
      },
      {
        id: "device-code",
        label: "ChatGPT device pairing",
        credentialKind: "oauth",
        nativeProviderId: "openai",
        nativeMethodId: "device-code",
        nativeVersion: "2026.9.1",
        deploymentAuthMethod: null,
        unavailableReason: "Device pairing and credential deployment are not available yet.",
      },
      // TODO(OpenAI auth integration): use the SIWC owner's release once login and deployment ship.
      {
        id: "token-sharing",
        label: "Sign in with ChatGPT (Responses)",
        credentialKind: "oauth",
        nativeProviderId: "openai",
        nativeMethodId: "siwc",
        nativeVersion: null,
        deploymentAuthMethod: null,
        unavailableReason: "Not available in the bundled OpenClaw version.",
      },
    ],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    requiresBaseUrl: false,
    authMethods: [
      {
        id: "api-key",
        label: "API key",
        credentialKind: "secret",
        nativeProviderId: "anthropic",
        nativeMethodId: "api-key",
        nativeVersion: "2026.9.1",
        deploymentAuthMethod: "provider_connection",
        unavailableReason: null,
      },
      {
        id: "setup-token",
        label: "Claude setup token",
        credentialKind: "secret",
        nativeProviderId: "anthropic",
        nativeMethodId: "setup-token",
        nativeVersion: "2026.9.1",
        deploymentAuthMethod: "provider_connection",
        unavailableReason: null,
      },
    ],
  },
  {
    id: "ollama",
    label: "Ollama",
    requiresBaseUrl: true,
    authMethods: [
      {
        id: "local",
        label: "Local server",
        credentialKind: "none",
        nativeProviderId: "ollama",
        nativeMethodId: "local",
        nativeVersion: "2026.9.1",
        deploymentAuthMethod: "provider_connection",
        unavailableReason: null,
      },
    ],
  },
  {
    id: "vllm",
    label: "vLLM",
    requiresBaseUrl: true,
    authMethods: [
      {
        id: "custom",
        label: "Self-hosted server",
        credentialKind: "secret",
        nativeProviderId: "vllm",
        nativeMethodId: "custom",
        nativeVersion: "2026.9.1",
        deploymentAuthMethod: "provider_connection",
        unavailableReason: null,
      },
    ],
  },
];
