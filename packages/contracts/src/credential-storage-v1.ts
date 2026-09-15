/** Opaque reference owned and authenticated by protected token custody. It has
 * no byte accessor or serialized form. Type branding alone is not authority;
 * custody must authenticate the original handle before consuming its token. */
declare const tokenBrand: unique symbol;
export interface EphemeralTokenHandleV1 {
  readonly [tokenBrand]: true;
}
