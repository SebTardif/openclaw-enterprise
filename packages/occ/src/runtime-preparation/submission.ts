export interface RuntimePreparationDeploymentResponseV1 {
  readonly namespace: string;
  readonly name: string;
  readonly uid: string;
  readonly resourceVersion: string;
  readonly receivedAt: string;
}
export type RuntimePreparationSubmissionResultV1 =
  | Readonly<{ status: "unavailable"; effectRef: string }>
  | Readonly<{ status: "unknown"; effectRef: string }>
  | Readonly<{
      status: "retained";
      effectRef: string;
      response: RuntimePreparationDeploymentResponseV1;
    }>;
