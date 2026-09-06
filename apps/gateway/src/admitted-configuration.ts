/** No environment variable or parsed JSON can stand in for admitted startup. */
export function requireAdmittedGatewayConfiguration(): never {
  // TODO: Consume the protected startup owner's accepted contract, including its
  // prebound material/currentness and exact module owners, before enabling startup.
  // The deployment binding has not been supplied; do not invent its serialized shape.
  throw new Error("Hosted gateway admitted startup is unavailable");
}
