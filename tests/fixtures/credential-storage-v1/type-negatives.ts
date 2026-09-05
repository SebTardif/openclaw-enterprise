import type {
  CredentialAuthorityObservationV1,
  CredentialCachePartitionV1,
  CredentialManagementHandleV1,
  CredentialMaterialHandleV1,
  CredentialMitigationHandleV1,
  CredentialOperationResultV1,
  CredentialReadHandleV1,
  CredentialStorageCallBoundsV1,
  CredentialStorageDependenciesV1,
  CurrentCredentialAuthorityHandleV1,
  CurrentCredentialAuthorityV1,
  EphemeralTokenHandleV1,
  InventoryWriteResultV1,
  IssuanceReservationResultV1,
  MintOutcomeV1,
  NamedCredentialUseV1,
  OutstandingTokenInventoryPortV1,
  OutstandingTokenRecordV1,
  ProtectedModelBindingV1,
  RecordedTokenDeliveryV1,
  ReserveIssuanceV1,
  RevocationClaimDiagnosticV1,
  RevocationClaimResultV1,
  RevocationOutcomeV1,
  SecretDriver,
  TokenDeliveryResultV1,
} from "@openclaw-enterprise/contracts";

/** Compile-only rejection checks. No exported function is executed by a test. */
export function rejectConstructedCapabilities(
  observation: CredentialAuthorityObservationV1,
  reader: CredentialReadHandleV1,
  management: CredentialManagementHandleV1,
  mitigation: CredentialMitigationHandleV1,
  material: CredentialMaterialHandleV1,
  token: EphemeralTokenHandleV1,
): void {
  // @ts-expect-error JSON observations cannot manufacture a current effect capability.
  const observedAuthority: CurrentCredentialAuthorityHandleV1 = observation;
  // @ts-expect-error Exact read/filter scope grants no new credential effect authority.
  const readAuthority: CurrentCredentialAuthorityHandleV1 = reader;
  // @ts-expect-error Credential management is separate from original-turn authority.
  const managementAuthority: CurrentCredentialAuthorityHandleV1 = management;
  // @ts-expect-error Accepted mitigation cannot become mint or delivery authority.
  const mitigationAuthority: CurrentCredentialAuthorityHandleV1 = mitigation;
  // @ts-expect-error Ordinary structural values cannot mint custody handles.
  const inventedMaterial: CredentialMaterialHandleV1 = {};
  // @ts-expect-error A token reference string is not protected token custody.
  const inventedToken: EphemeralTokenHandleV1 = "synthetic-token-reference";
  // @ts-expect-error Long-lived credential custody is not an ephemeral bearer handle.
  const wrongToken: EphemeralTokenHandleV1 = material;
  // @ts-expect-error An ephemeral token is not a protected named credential handle.
  const wrongMaterial: CredentialMaterialHandleV1 = token;
  // @ts-expect-error Custody handles expose no raw material accessor.
  const materialBytes = material.bytes;
  // @ts-expect-error Token handles expose no diagnostic bearer value.
  const tokenValue = token.value;
  void [
    observedAuthority,
    readAuthority,
    managementAuthority,
    mitigationAuthority,
    inventedMaterial,
    inventedToken,
    wrongToken,
    wrongMaterial,
    materialBytes,
    tokenValue,
  ];
}

export function rejectMintCustodyMismatch(
  port: OutstandingTokenInventoryPortV1,
  accepted: Extract<MintOutcomeV1, { outcome: "accepted" }>,
  rejected: Extract<MintOutcomeV1, { outcome: "definitely-rejected" }>,
  unknown: Extract<MintOutcomeV1, { outcome: "unknown" }>,
  responsibility: CredentialMitigationHandleV1,
  token: EphemeralTokenHandleV1,
  bounds: CredentialStorageCallBoundsV1,
): void {
  // @ts-expect-error Accepted provider outcome requires actual protected token custody.
  void port.recordMintOutcomeV1(accepted, responsibility, undefined, bounds);
  // @ts-expect-error Definitely rejected issuance cannot supply accepted token material.
  void port.recordMintOutcomeV1(rejected, responsibility, token, bounds);
  // @ts-expect-error Unknown issuance cannot supply an acknowledged token handle.
  void port.recordMintOutcomeV1(unknown, responsibility, token, bounds);
  // @ts-expect-error Ordinary token-like text cannot enter the protected material path.
  void port.recordMintOutcomeV1(accepted, responsibility, "synthetic-token", bounds);
  // @ts-expect-error Unknown issuance has no known token locator for delivery.
  const unknownToken = unknown.tokenRef;
  // @ts-expect-error Unknown provider outcome preserves expiry-unproven.
  const knownExpiry: "provider-expiry" = unknown.expiry.kind;
  void [unknownToken, knownExpiry];
}

export function rejectUnknownResolutionAsTokenCustody(
  port: OutstandingTokenInventoryPortV1,
  observation: Exclude<MintOutcomeV1, { outcome: "accepted" }>,
  responsibility: CredentialMitigationHandleV1,
  token: EphemeralTokenHandleV1,
  bounds: CredentialStorageCallBoundsV1,
): void {
  // @ts-expect-error Resolving unknown issuance without bytes cannot supply token custody.
  void port.recordMintOutcomeV1(observation, responsibility, token, bounds);
  if (observation.outcome === "unknown-expiry-established") {
    // @ts-expect-error Future evidenced expiry still establishes no received token.
    const tokenRef = observation.tokenRef;
    void tokenRef;
  }
  if (observation.outcome === "unknown-broader-revocation-confirmed") {
    // @ts-expect-error Broader revocation evidence is distinct from single-token confirmation.
    const singleTokenOutcome: "confirmed" = observation.outcome;
    void singleTokenOutcome;
  }
}

export function rejectObservationAsEffectAuthority(
  port: OutstandingTokenInventoryPortV1,
  reserve: ReserveIssuanceV1,
  delivery: RecordedTokenDeliveryV1,
  reservation: IssuanceReservationResultV1,
  written: InventoryWriteResultV1,
  readback: CredentialOperationResultV1,
  reader: CredentialReadHandleV1,
  mitigation: CredentialMitigationHandleV1,
  consume: (token: EphemeralTokenHandleV1) => Promise<void>,
  bounds: CredentialStorageCallBoundsV1,
): void {
  // @ts-expect-error A read capability cannot reserve new issuance.
  void port.reserveIssuanceV1(reserve, reader, bounds);
  // @ts-expect-error Accepted mitigation responsibility cannot authorize delivery.
  void port.deliverRecordedTokenV1(delivery, mitigation, consume, bounds);
  if (reservation.kind === "reserved") {
    // @ts-expect-error Durable intent is not fresh original delivery authority.
    const authority: CurrentCredentialAuthorityV1 = reservation.receipt;
    // @ts-expect-error A reservation has no accepted token to release.
    const reservedToken = reservation.record.tokenRef;
    void [authority, reservedToken];
  }
  if (written.kind === "recorded") {
    // @ts-expect-error Durable storage acknowledgment cannot grant a new effect.
    const authority: CurrentCredentialAuthorityV1 = written.receipt;
    void authority;
  }
  if (written.kind === "commit-unknown") {
    // @ts-expect-error An ambiguous commit provides no successful durable receipt.
    const receipt = written.receipt;
    void receipt;
  }
  if (readback.kind === "found") {
    // @ts-expect-error Even completed readback is an observation, not an effect permit.
    const authority: CurrentCredentialAuthorityV1 = readback;
    void authority;
  }
}

export function rejectOutcomePromotion(
  record: OutstandingTokenRecordV1,
  delivery: TokenDeliveryResultV1<void>,
  claim: RevocationClaimResultV1,
  diagnostic: RevocationClaimDiagnosticV1,
  revoked: RevocationOutcomeV1,
): void {
  if (record.state === "mint-unknown") {
    // @ts-expect-error Unknown mint cannot be observed as a known outstanding token.
    const outstanding: Extract<OutstandingTokenRecordV1, { state: "outstanding" }> = record;
    void outstanding;
  }
  if (record.state === "resolved-without-token") {
    // @ts-expect-error Resolution without token bytes cannot create material to deliver.
    const tokenRef = record.tokenRef;
    void tokenRef;
  }
  if (record.state === "outstanding" && record.disposition === "mitigation-only") {
    // This checks the discriminator; the actual release guard remains the owner's duty.
    // @ts-expect-error Late tracked material has no current-delivery disposition.
    const currentDisposition: "current-check-required" = record.disposition;
    void currentDisposition;
  }
  if (delivery.kind === "delivery-unknown") {
    // @ts-expect-error Acknowledgment loss supplies no successful adapter result.
    const value = delivery.value;
    void value;
  }
  if (claim.kind === "claimed") {
    // @ts-expect-error CAS ownership of a revoke attempt is not provider confirmation.
    const confirmedOutcome: "confirmed" = claim.kind;
    void confirmedOutcome;
  }
  if (diagnostic.kind === "claimed") {
    // @ts-expect-error Parsed claim diagnostics do not contain protected token custody.
    const trustedClaim: RevocationClaimResultV1 = diagnostic;
    // @ts-expect-error No token handle is serialized into a claim diagnostic.
    const token = diagnostic.token;
    void [trustedClaim, token];
  }
  if (revoked.outcome === "expired") {
    // @ts-expect-error Evidenced provider expiry is distinct from confirmed revocation.
    const confirmed: Extract<RevocationOutcomeV1, { outcome: "confirmed" }> = revoked;
    void confirmed;
  }
}

export function rejectUnsupportedShapes(
  reserve: ReserveIssuanceV1,
  delivery: RecordedTokenDeliveryV1,
): void {
  // @ts-expect-error Requests admit only schema version one.
  const version: ReserveIssuanceV1 = { ...reserve, schemaVersion: 2 };
  // @ts-expect-error The closed operation vocabulary has no direct-login fallback.
  const method: RecordedTokenDeliveryV1 = { ...delivery, method: "directLogin" };
  const rawMaterial: RecordedTokenDeliveryV1 = {
    ...delivery,
    // @ts-expect-error Ordinary delivery metadata cannot carry token bytes.
    token: "synthetic-token",
  };
  void [version, method, rawMaterial];
}

export function rejectUnsafeModelBinding(
  binding: ProtectedModelBindingV1,
  modelUse: Extract<NamedCredentialUseV1, { purpose: "model-use" }>,
  partition: Extract<CredentialCachePartitionV1, { purpose: "model-use" }>,
): void {
  const { modelBinding: useBinding, ...useWithoutBinding } = modelUse;
  // @ts-expect-error Model use requires the protected ownership/lifecycle binding.
  const missingUseBinding: typeof modelUse = useWithoutBinding;
  const { modelBinding: cacheBinding, ...cacheWithoutBinding } = partition;
  // @ts-expect-error A model material cache partition must include its protected binding.
  const missingCacheBinding: typeof partition = cacheWithoutBinding;

  const rawLogin: ProtectedModelBindingV1 = {
    ...binding,
    // @ts-expect-error Login state remains with the external protected owner.
    loginState: { session: "synthetic-session" },
  };
  const rawRefresh: ProtectedModelBindingV1 = {
    ...binding,
    setup: {
      ...binding.setup,
      // @ts-expect-error Lifecycle metadata carries a refresh owner, never refresh bytes.
      refreshToken: "synthetic-refresh-state",
    },
  };
  const rawCredential: ProtectedModelBindingV1 = {
    ...binding,
    // @ts-expect-error Ordinary binding metadata cannot serialize an upstream API key.
    apiKey: "synthetic-key",
  };
  const runtimeCustody: ProtectedModelBindingV1 = {
    ...binding,
    // @ts-expect-error Model credential custody cannot be assigned to Agent execution.
    custody: "agent-runtime",
  };

  if (binding.setup.kind === "api-key-import") {
    const { rotationOwnerRef, ...unownedSetup } = binding.setup;
    // @ts-expect-error Imported key lifecycle requires an explicit protected rotation owner.
    const setup: ProtectedModelBindingV1["setup"] = unownedSetup;
    void [rotationOwnerRef, setup];
  } else {
    const { refreshOwnerRef, ...unownedSetup } = binding.setup;
    // @ts-expect-error Login/federation lifecycle requires an explicit protected refresh owner.
    const setup: ProtectedModelBindingV1["setup"] = unownedSetup;
    void [refreshOwnerRef, setup];
  }
  void [
    useBinding,
    cacheBinding,
    missingUseBinding,
    missingCacheBinding,
    rawLogin,
    rawRefresh,
    rawCredential,
    runtimeCustody,
  ];
}

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const reusesExistingSecretDriver: Same<
  CredentialStorageDependenciesV1["secretDriver"],
  SecretDriver
> = true;
void reusesExistingSecretDriver;
