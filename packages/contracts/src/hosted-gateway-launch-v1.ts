/** Fixed installed paths and framing limits. These values select no authority,
 * Runtime readiness, credential, registration or material lease. */
export const gatewayMainPath = "/app/apps/gateway/src/main.mjs";
export const gatewayLaunchPath = "/run/openclaw/hosted-gateway/launch.json";
export const gatewayNativeBinaryPath = "/usr/local/bin/oce-runtime-authority";
export const gatewayLaunchMaxBytes = 65_536;
export const gatewayReadinessPath = "/app/apps/gateway/src/readiness.mjs";
export const gatewayReadinessHost = "127.0.0.1";
export const gatewayReadinessPort = 19_891;
