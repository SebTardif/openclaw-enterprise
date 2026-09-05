import type { Installation } from "@openclaw-enterprise/contracts/resources/installation";

export interface InstallationReadRepository {
  findInstallation(installationId: string): Promise<Readonly<Installation> | undefined>;
  getInstallation(): Promise<Readonly<Installation> | undefined>;
}

export interface InstallationRepository extends InstallationReadRepository {
  createInstallation(installation: Installation): Promise<Readonly<Installation>>;
}
