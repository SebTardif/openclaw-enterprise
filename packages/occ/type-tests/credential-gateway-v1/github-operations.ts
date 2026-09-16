import type { RepositoryAccess } from "@openclaw-enterprise/contracts";
import type {
  AccessProfile,
  TokenProfile,
  RepositoryIdentity,
  GitHubRepositorySelection,
  GitHubRepositoryAccessV1,
  RefUpdate,
  CreatePullRequestInput,
  GitHubOperation,
  CanonicalTarget,
  GitHubHost,
  GitHubAccessId,
  GitHubRequestId,
  GitHubClientOperationId,
  GitHubDispatchId,
  GitHubFactsDigest,
  GitHubBodyDigest,
  GitHubPrefixDigest,
  GitHubCreationDigest,
} from "../../src/credential-gateway-v1/github-operations.ts";
import type {
  GitHubAppSelectionV1,
  GitHubRepositoryWriteSelectionV1,
} from "@openclaw-enterprise/occ";
import type {
  CredentialAccessGrant,
  CredentialProfileRef,
} from "../../src/credential-gateway-v1/connection.ts";

// @ts-expect-error Generic operation data remains internal to the adapter owner.
import type { GitHubOperation as PublicGitHubOperation } from "@openclaw-enterprise/occ";
// @ts-expect-error Nominal operation identities are internal, not public authority.
import type { GitHubRequestId as PublicGitHubRequestId } from "@openclaw-enterprise/occ";
// @ts-expect-error Write selection has one provider owner and no gateway reexport.
import type { GitHubRepositoryWriteSelectionV1 as GatewayWriteSelection } from "../../src/credential-gateway-v1/github-operations.ts";

// Inert consumers of provider roots and internal operation contracts. Inputs carry
// nominal data; this fixture never mints authority, computes digests, admits grants
// or calls GitHub.
export function consumeGitHubContract(
  ids: {
    readonly accessId: GitHubAccessId;
    readonly requestId: GitHubRequestId;
    readonly clientOperationId: GitHubClientOperationId;
    readonly dispatchId: GitHubDispatchId;
    readonly factsDigest: GitHubFactsDigest;
    readonly bodyDigest: GitHubBodyDigest;
    readonly prefixDigest: GitHubPrefixDigest;
    readonly creationDigest: GitHubCreationDigest;
  },
  grant: CredentialAccessGrant,
  writeProfile: CredentialProfileRef,
) {
  const repository: RepositoryIdentity = {
    ...grant.resource,
    canonicalPathSegments: ["example-owner", "example-repository"],
  };
  const selection: GitHubRepositorySelection = {
    repository,
    appId: "101",
    installationId: "202",
    repositoryId: "303",
    canonicalOwner: "example-owner",
    canonicalName: "example-repository",
    bindingGeneration: "binding-generation-1",
  };
  const omitted: GitHubRepositoryAccessV1 = {
    schemaVersion: 1,
    repositories: [{ repository: selection }],
  };
  const readAccess: GitHubRepositoryAccessV1 = {
    ...omitted,
    repositories: [{ repository: selection, accessProfile: "read" }],
  };
  const writeAccess: GitHubRepositoryAccessV1 = {
    ...omitted,
    repositories: [{ repository: selection, accessProfile: "read-write" }],
  };
  const accessProfile: AccessProfile = "read-write";
  const tokenProfile: TokenProfile = "repository-write-v1";
  const host: GitHubHost = "github.com";
  const issuerRead: GitHubAppSelectionV1 = {
    key: {
      clientId: "example-app-client",
      bindingRef: "example-key-binding",
      immutableVersion: "example-key-version-1",
    },
    installationId: 202,
    repositories: [{ id: 303, fullName: "example-owner/example-repository" }],
    permissions: { metadata: "read", contents: "read" },
  };
  const issuerWrite: GitHubRepositoryWriteSelectionV1 = {
    key: issuerRead.key,
    installationId: issuerRead.installationId,
    repositories: issuerRead.repositories,
    permissions: { metadata: "read", contents: "write", pull_requests: "write" },
  };
  const checkout: RepositoryAccess = {
    schemaVersion: 1,
    repositories: [
      {
        bindingRef: { kind: "repository_binding", namespaceId: "ns_example", id: "rb_example" },
        repositoryId: 303,
        checkoutRef: "refs/heads/main",
        readProfile: "checkout",
        publication: { mode: "disabled" },
      },
    ],
  };
  const target: CanonicalTarget = {
    repository: selection,
    host,
    method: "GET",
    pathAndQuery: "/example-owner/example-repository/info/refs?service=git-upload-pack",
  };
  const metadata: GitHubOperation = {
    kind: "metadata",
    requestId: ids.requestId,
    target,
    factsDigest: ids.factsDigest,
    bodyDigest: ids.bodyDigest,
  };
  const fetchDiscovery: GitHubOperation = { ...metadata, kind: "fetch-discovery" };
  const fetch: GitHubOperation = {
    ...metadata,
    kind: "fetch",
    target: { ...target, method: "POST" },
  };
  const pushDiscovery: GitHubOperation = { ...metadata, kind: "push-discovery" };
  const pushProbe: GitHubOperation = {
    ...metadata,
    kind: "push-probe",
    target: { ...target, method: "POST" },
  };
  const update: RefUpdate = {
    refName: "refs/heads/topic",
    oldOid: "0".repeat(40),
    newOid: "1".repeat(40),
    change: "create",
  };
  const push: GitHubOperation = {
    kind: "push",
    requestId: ids.requestId,
    target: { ...target, method: "POST" },
    factsDigest: ids.factsDigest,
    objectFormat: "sha1",
    updates: [update],
    capabilities: ["report-status"],
    pushOptions: [],
    prefixDigest: ids.prefixDigest,
    prefixBytes: 128,
    requiresPack: true,
  };
  const input: CreatePullRequestInput = {
    head: "topic",
    base: "main",
    title: "Example change",
    body: "",
    draft: false,
    maintainer_can_modify: false,
  };
  const createPr: GitHubOperation = {
    kind: "pull-request-create",
    requestId: ids.requestId,
    target: {
      ...target,
      host: "api.github.com",
      method: "POST",
      pathAndQuery: "/repos/example-owner/example-repository/pulls",
    },
    factsDigest: ids.factsDigest,
    clientOperationId: ids.clientOperationId,
    input,
    apiVersion: "2026-03-10",
    bodyDigest: ids.bodyDigest,
    creationDigest: ids.creationDigest,
  };
  // The same declared immutable write profile composes with reads and writes.
  // Equality/currentness/profile admission remains the core owner's runtime duty.
  const writeGrant: CredentialAccessGrant = { ...grant, credentialProfile: writeProfile };
  const readWithWriteProfile: {
    readonly grant: CredentialAccessGrant;
    readonly operation: GitHubOperation;
    readonly profile: TokenProfile;
  } = {
    grant: writeGrant,
    operation: fetch,
    profile: tokenProfile,
  };
  const operations: readonly GitHubOperation[] = [
    metadata,
    fetchDiscovery,
    fetch,
    pushDiscovery,
    pushProbe,
    push,
    createPr,
  ];
  for (const operation of operations) {
    switch (operation.kind) {
      case "push": {
        const prefix: GitHubPrefixDigest = operation.prefixDigest;
        const updates: readonly RefUpdate[] = operation.updates;
        void [prefix, updates];
        // @ts-expect-error Push facts expose a prefix, not a whole-body digest.
        operation.bodyDigest;
        break;
      }
      case "pull-request-create": {
        const client: GitHubClientOperationId = operation.clientOperationId;
        const creation: GitHubCreationDigest = operation.creationDigest;
        const body: GitHubBodyDigest = operation.bodyDigest;
        void [client, creation, body];
        // @ts-expect-error PR creation facts do not expose push updates.
        operation.updates;
        break;
      }
      default: {
        const body: GitHubBodyDigest = operation.bodyDigest;
        void body;
        // @ts-expect-error Read/discovery/probe facts have no client dedup key.
        operation.clientOperationId;
      }
    }
  }
  const { key: omittedWritekey, ...withoutWritekey } = issuerWrite;
  const { installationId: omittedWriteinstallationId, ...withoutWriteinstallationId } = issuerWrite;
  const { repositories: omittedWriterepositories, ...withoutWriterepositories } = issuerWrite;
  const { permissions: omittedWritepermissions, ...withoutWritepermissions } = issuerWrite;
  const checkoutEntry: RepositoryAccess["repositories"][number] = {
    bindingRef: { kind: "repository_binding", namespaceId: "ns_example", id: "rb_example" },
    repositoryId: 303,
    checkoutRef: "refs/heads/main",
    readProfile: "checkout",
    publication: { mode: "disabled" },
  };
  const { repository: omittedSelectionrepository, ...withoutSelectionrepository } = selection;
  const { appId: omittedSelectionappId, ...withoutSelectionappId } = selection;
  const { installationId: omittedSelectioninstallationId, ...withoutSelectioninstallationId } =
    selection;
  const { repositoryId: omittedSelectionrepositoryId, ...withoutSelectionrepositoryId } = selection;
  const { canonicalOwner: omittedSelectioncanonicalOwner, ...withoutSelectioncanonicalOwner } =
    selection;
  const { canonicalName: omittedSelectioncanonicalName, ...withoutSelectioncanonicalName } =
    selection;
  const {
    bindingGeneration: omittedSelectionbindingGeneration,
    ...withoutSelectionbindingGeneration
  } = selection;
  const { repository: omittedTargetrepository, ...withoutTargetrepository } = target;
  const { host: omittedTargethost, ...withoutTargethost } = target;
  const { method: omittedTargetmethod, ...withoutTargetmethod } = target;
  const { pathAndQuery: omittedTargetpathAndQuery, ...withoutTargetpathAndQuery } = target;
  const { requestId: omittedMetadatarequestId, ...withoutMetadatarequestId } = metadata;
  const { target: omittedMetadatatarget, ...withoutMetadatatarget } = metadata;
  const { factsDigest: omittedMetadatafactsDigest, ...withoutMetadatafactsDigest } = metadata;
  const { bodyDigest: omittedMetadatabodyDigest, ...withoutMetadatabodyDigest } = metadata;
  const { prefixDigest: omittedPushprefixDigest, ...withoutPushprefixDigest } = push;
  const { prefixBytes: omittedPushprefixBytes, ...withoutPushprefixBytes } = push;
  const { updates: omittedPushupdates, ...withoutPushupdates } = push;
  const { capabilities: omittedPushcapabilities, ...withoutPushcapabilities } = push;
  const { pushOptions: omittedPushpushOptions, ...withoutPushpushOptions } = push;
  const { requiresPack: omittedPushrequiresPack, ...withoutPushrequiresPack } = push;
  const { objectFormat: omittedPushobjectFormat, ...withoutPushobjectFormat } = push;
  const { input: omittedPrinput, ...withoutPrinput } = createPr;
  const { clientOperationId: omittedPrclientOperationId, ...withoutPrclientOperationId } = createPr;
  const { bodyDigest: omittedPrbodyDigest, ...withoutPrbodyDigest } = createPr;
  const { creationDigest: omittedPrcreationDigest, ...withoutPrcreationDigest } = createPr;
  const { apiVersion: omittedPrapiVersion, ...withoutPrapiVersion } = createPr;
  const { head: omittedInputhead, ...withoutInputhead } = input;
  const { base: omittedInputbase, ...withoutInputbase } = input;
  const { title: omittedInputtitle, ...withoutInputtitle } = input;
  const { body: omittedInputbody, ...withoutInputbody } = input;
  const { draft: omittedInputdraft, ...withoutInputdraft } = input;
  const {
    maintainer_can_modify: omittedInputmaintainer_can_modify,
    ...withoutInputmaintainer_can_modify
  } = input;
  const missingPrPermission: GitHubRepositoryWriteSelectionV1 = {
    ...issuerWrite,
    // @ts-expect-error The write tuple requires pull_requests:write.
    permissions: { metadata: "read", contents: "write" },
  };
  const unrelatedPermission: GitHubRepositoryWriteSelectionV1 = {
    ...issuerWrite,
    // @ts-expect-error Checked permission literals reject unrelated scopes.
    permissions: { metadata: "read", contents: "write", pull_requests: "write", issues: "write" },
  };
  const wrongmetadataPermission: GitHubRepositoryWriteSelectionV1 = {
    ...issuerWrite,
    // @ts-expect-error The write profile fixes metadata permission.
    permissions: { ...issuerWrite.permissions, metadata: "write" },
  };
  const wrongcontentsPermission: GitHubRepositoryWriteSelectionV1 = {
    ...issuerWrite,
    // @ts-expect-error The write profile fixes contents permission.
    permissions: { ...issuerWrite.permissions, contents: "read" },
  };
  const wrongpull_requestsPermission: GitHubRepositoryWriteSelectionV1 = {
    ...issuerWrite,
    // @ts-expect-error The write profile fixes pull_requests permission.
    permissions: { ...issuerWrite.permissions, pull_requests: "read" },
  };
  // @ts-expect-error Write selection retains exactly one supplier repository.
  const emptyRepositories: GitHubRepositoryWriteSelectionV1 = { ...issuerWrite, repositories: [] };
  const twoRepositories: GitHubRepositoryWriteSelectionV1 = {
    ...issuerWrite,
    // @ts-expect-error Write selection retains exactly one supplier repository.
    repositories: [issuerRead.repositories[0], issuerRead.repositories[0]],
  };
  // @ts-expect-error Write selection requires key.
  const missingWritekey: GitHubRepositoryWriteSelectionV1 = withoutWritekey;
  // @ts-expect-error Write selection requires installationId.
  const missingWriteinstallationId: GitHubRepositoryWriteSelectionV1 = withoutWriteinstallationId;
  // @ts-expect-error Write selection requires repositories.
  const missingWriterepositories: GitHubRepositoryWriteSelectionV1 = withoutWriterepositories;
  // @ts-expect-error Write selection requires permissions.
  const missingWritepermissions: GitHubRepositoryWriteSelectionV1 = withoutWritepermissions;
  const broadenedIssuerRead: GitHubAppSelectionV1 = {
    ...issuerRead,
    // @ts-expect-error The original issuer selection remains read-only.
    permissions: { metadata: "read", contents: "write" },
  };
  const prIssuerRead: GitHubAppSelectionV1 = {
    ...issuerRead,
    // @ts-expect-error The original issuer read DTO has no PR permission.
    permissions: { metadata: "read", contents: "read", pull_requests: "write" },
  };
  const stringInstallation: GitHubRepositoryWriteSelectionV1 = {
    ...issuerWrite,
    // @ts-expect-error Installation IDs retain the actual supplier numeric type.
    installationId: "202",
  };
  const incompleteKey: GitHubRepositoryWriteSelectionV1 = {
    ...issuerWrite,
    // @ts-expect-error Real supplier key identity requires immutableVersion.
    key: { clientId: "client", bindingRef: "binding" },
  };
  // @ts-expect-error The access input requires its schema version.
  const missingAccessVersion: GitHubRepositoryAccessV1 = { repositories: [] };
  // @ts-expect-error The access input supports only schema version one.
  const wrongAccessVersion: GitHubRepositoryAccessV1 = { ...omitted, schemaVersion: 2 };
  const missingAccessRepository: GitHubRepositoryAccessV1 = {
    schemaVersion: 1,
    // @ts-expect-error Access entries require the admitted repository selection data.
    repositories: [{ accessProfile: "read" }],
  };
  const undefinedProfile: GitHubRepositoryAccessV1 = {
    ...omitted,
    // @ts-expect-error An explicit optional profile cannot be undefined.
    repositories: [{ repository: selection, accessProfile: undefined }],
  };
  // @ts-expect-error The access vocabulary has no write-only profile.
  const unsupportedProfile: AccessProfile = "write";
  // @ts-expect-error Token profiles have a finite versioned vocabulary.
  const unsupportedTokenProfile: TokenProfile = "write";
  const oldwriteAccess: RepositoryAccess = {
    ...checkout,
    // @ts-expect-error Existing checkout readProfile is unchanged.
    repositories: [{ ...checkoutEntry, readProfile: "write" }],
  };
  const oldreadwriteAccess: RepositoryAccess = {
    ...checkout,
    // @ts-expect-error Existing checkout readProfile is unchanged.
    repositories: [{ ...checkoutEntry, readProfile: "read-write" }],
  };
  const enabledPublication: RepositoryAccess = {
    ...checkout,
    // @ts-expect-error Existing checkout publication stays disabled.
    repositories: [{ ...checkoutEntry, publication: { mode: "enabled" } }],
  };
  // @ts-expect-error Repository identities require their inherited resource schema.
  const missingResourceIdentity: RepositoryIdentity = {
    upstreamInstanceId: "upstream",
    canonicalResourceId: "repository",
    canonicalPathSegments: [],
  };
  // @ts-expect-error Repository selection requires repository.
  const missingSelectionrepository: GitHubRepositorySelection = withoutSelectionrepository;
  // @ts-expect-error Repository selection requires appId.
  const missingSelectionappId: GitHubRepositorySelection = withoutSelectionappId;
  // @ts-expect-error Repository selection requires installationId.
  const missingSelectioninstallationId: GitHubRepositorySelection = withoutSelectioninstallationId;
  // @ts-expect-error Repository selection requires repositoryId.
  const missingSelectionrepositoryId: GitHubRepositorySelection = withoutSelectionrepositoryId;
  // @ts-expect-error Repository selection requires canonicalOwner.
  const missingSelectioncanonicalOwner: GitHubRepositorySelection = withoutSelectioncanonicalOwner;
  // @ts-expect-error Repository selection requires canonicalName.
  const missingSelectioncanonicalName: GitHubRepositorySelection = withoutSelectioncanonicalName;
  // @ts-expect-error Repository selection requires bindingGeneration.
  const missingSelectionbindingGeneration: GitHubRepositorySelection =
    withoutSelectionbindingGeneration;
  // @ts-expect-error Repository numeric IDs are serialized strings.
  const numericRepositoryId: GitHubRepositorySelection = { ...selection, repositoryId: 303 };
  // @ts-expect-error Only the two admitted GitHub hosts are representable.
  const foreignHost: CanonicalTarget = { ...target, host: "example.com" };
  // @ts-expect-error The catalog excludes PATCH/update methods.
  const patchTarget: CanonicalTarget = { ...target, method: "PATCH" };
  // @ts-expect-error Canonical targets require repository.
  const missingTargetrepository: CanonicalTarget = withoutTargetrepository;
  // @ts-expect-error Canonical targets require host.
  const missingTargethost: CanonicalTarget = withoutTargethost;
  // @ts-expect-error Canonical targets require method.
  const missingTargetmethod: CanonicalTarget = withoutTargetmethod;
  // @ts-expect-error Canonical targets require pathAndQuery.
  const missingTargetpathAndQuery: CanonicalTarget = withoutTargetpathAndQuery;
  // @ts-expect-error Read operations require requestId.
  const missingMetadatarequestId: GitHubOperation = withoutMetadatarequestId;
  // @ts-expect-error Read operations require target.
  const missingMetadatatarget: GitHubOperation = withoutMetadatatarget;
  // @ts-expect-error Read operations require factsDigest.
  const missingMetadatafactsDigest: GitHubOperation = withoutMetadatafactsDigest;
  // @ts-expect-error Read operations require bodyDigest.
  const missingMetadatabodyDigest: GitHubOperation = withoutMetadatabodyDigest;
  // @ts-expect-error Push facts require prefixDigest.
  const missingPushprefixDigest: GitHubOperation = withoutPushprefixDigest;
  // @ts-expect-error Push facts require prefixBytes.
  const missingPushprefixBytes: GitHubOperation = withoutPushprefixBytes;
  // @ts-expect-error Push facts require updates.
  const missingPushupdates: GitHubOperation = withoutPushupdates;
  // @ts-expect-error Push facts require capabilities.
  const missingPushcapabilities: GitHubOperation = withoutPushcapabilities;
  // @ts-expect-error Push facts require pushOptions.
  const missingPushpushOptions: GitHubOperation = withoutPushpushOptions;
  // @ts-expect-error Push facts require requiresPack.
  const missingPushrequiresPack: GitHubOperation = withoutPushrequiresPack;
  // @ts-expect-error Push facts require objectFormat.
  const missingPushobjectFormat: GitHubOperation = withoutPushobjectFormat;
  // @ts-expect-error Push uses only the admitted sha1 object format.
  const sha256Push: GitHubOperation = { ...push, objectFormat: "sha256" };
  // @ts-expect-error Ref OIDs cannot infer force.
  const forceUpdate: RefUpdate = { ...update, force: true };
  // @ts-expect-error Ref change vocabulary is finite.
  const forceChange: RefUpdate = { ...update, change: "force" };
  // @ts-expect-error PR creation facts require input.
  const missingPrinput: GitHubOperation = withoutPrinput;
  // @ts-expect-error PR creation facts require clientOperationId.
  const missingPrclientOperationId: GitHubOperation = withoutPrclientOperationId;
  // @ts-expect-error PR creation facts require bodyDigest.
  const missingPrbodyDigest: GitHubOperation = withoutPrbodyDigest;
  // @ts-expect-error PR creation facts require creationDigest.
  const missingPrcreationDigest: GitHubOperation = withoutPrcreationDigest;
  // @ts-expect-error PR creation facts require apiVersion.
  const missingPrapiVersion: GitHubOperation = withoutPrapiVersion;
  // @ts-expect-error The operation catalog admits creation only.
  const pullrequestupdateOperation: GitHubOperation = { ...createPr, kind: "pull-request-update" };
  // @ts-expect-error The operation catalog admits creation only.
  const pullrequestmergeOperation: GitHubOperation = { ...createPr, kind: "pull-request-merge" };
  // @ts-expect-error PR API version is fixed.
  const wrongApiVersion: GitHubOperation = { ...createPr, apiVersion: "2022-11-28" };
  // @ts-expect-error PR maintainer mutation is always disabled.
  const maintainerEnabled: CreatePullRequestInput = { ...input, maintainer_can_modify: true };
  // @ts-expect-error The creation input has no fork/update/merge field.
  const extraPrheadRepository: CreatePullRequestInput = { ...input, headRepository: "unsupported" };
  // @ts-expect-error The creation input has no fork/update/merge field.
  const extraPrheadOwner: CreatePullRequestInput = { ...input, headOwner: "unsupported" };
  // @ts-expect-error The creation input has no fork/update/merge field.
  const extraPrfork: CreatePullRequestInput = { ...input, fork: "unsupported" };
  // @ts-expect-error The creation input has no fork/update/merge field.
  const extraPrmerge: CreatePullRequestInput = { ...input, merge: "unsupported" };
  // @ts-expect-error The creation input has no fork/update/merge field.
  const extraPrnumber: CreatePullRequestInput = { ...input, number: "unsupported" };
  // @ts-expect-error Normalized PR input requires head.
  const missingInputhead: CreatePullRequestInput = withoutInputhead;
  // @ts-expect-error Normalized PR input requires base.
  const missingInputbase: CreatePullRequestInput = withoutInputbase;
  // @ts-expect-error Normalized PR input requires title.
  const missingInputtitle: CreatePullRequestInput = withoutInputtitle;
  // @ts-expect-error Normalized PR input requires body.
  const missingInputbody: CreatePullRequestInput = withoutInputbody;
  // @ts-expect-error Normalized PR input requires draft.
  const missingInputdraft: CreatePullRequestInput = withoutInputdraft;
  // @ts-expect-error Normalized PR input requires maintainer_can_modify.
  const missingInputmaintainer_can_modify: CreatePullRequestInput =
    withoutInputmaintainer_can_modify;
  // @ts-expect-error Raw strings cannot populate nominal accessId.
  const rawaccessId: GitHubAccessId = "unvalidated";
  // @ts-expect-error Raw strings cannot populate nominal requestId.
  const rawrequestId: GitHubRequestId = "unvalidated";
  // @ts-expect-error Raw strings cannot populate nominal clientOperationId.
  const rawclientOperationId: GitHubClientOperationId = "unvalidated";
  // @ts-expect-error Raw strings cannot populate nominal dispatchId.
  const rawdispatchId: GitHubDispatchId = "unvalidated";
  // @ts-expect-error Raw strings cannot populate nominal factsDigest.
  const rawfactsDigest: GitHubFactsDigest = "unvalidated";
  // @ts-expect-error Raw strings cannot populate nominal bodyDigest.
  const rawbodyDigest: GitHubBodyDigest = "unvalidated";
  // @ts-expect-error Raw strings cannot populate nominal prefixDigest.
  const rawprefixDigest: GitHubPrefixDigest = "unvalidated";
  // @ts-expect-error Raw strings cannot populate nominal creationDigest.
  const rawcreationDigest: GitHubCreationDigest = "unvalidated";
  // @ts-expect-error HTTP request identity is separate from the client dedup key.
  const requestAsClient: GitHubClientOperationId = ids.requestId;
  // @ts-expect-error Client dedup identity is separate from HTTP request identity.
  const clientAsRequest: GitHubRequestId = ids.clientOperationId;
  // @ts-expect-error Access identity is separate from dispatch identity.
  const accessAsDispatch: GitHubDispatchId = ids.accessId;
  // @ts-expect-error Dispatch identity is separate from access identity.
  const dispatchAsAccess: GitHubAccessId = ids.dispatchId;
  // @ts-expect-error Digest categories cannot be swapped.
  const swappedfactsDigest: GitHubFactsDigest = ids.bodyDigest;
  // @ts-expect-error Digest categories cannot be swapped.
  const swappedbodyDigest: GitHubBodyDigest = ids.prefixDigest;
  // @ts-expect-error Digest categories cannot be swapped.
  const swappedprefixDigest: GitHubPrefixDigest = ids.creationDigest;
  // @ts-expect-error Digest categories cannot be swapped.
  const swappedcreationDigest: GitHubCreationDigest = ids.factsDigest;
  // @ts-expect-error Nominal request slots reject client-operation IDs.
  const wrongRequestSlot: GitHubOperation = { ...createPr, requestId: ids.clientOperationId };
  // @ts-expect-error Nominal client slots reject HTTP request IDs.
  const wrongClientSlot: GitHubOperation = { ...createPr, clientOperationId: ids.requestId };
  // @ts-expect-error Push prefix slots reject whole-body digests.
  const wrongPrefixSlot: GitHubOperation = { ...push, prefixDigest: ids.bodyDigest };
  // @ts-expect-error Creation slots reject facts digests.
  const wrongCreationSlot: GitHubOperation = { ...createPr, creationDigest: ids.factsDigest };
  // @ts-expect-error Access DTOs are immutable.
  omitted.schemaVersion = 1;
  // @ts-expect-error Nested access arrays are immutable.
  omitted.repositories.push({ repository: selection });
  // @ts-expect-error Nested access entries are immutable.
  writeAccess.repositories[0]?.repository.repository.canonicalPathSegments.push("other");
  // @ts-expect-error Selection scalar fields are immutable.
  selection.repositoryId = "404";
  // @ts-expect-error Write permission values are immutable.
  issuerWrite.permissions.contents = "write";
  // @ts-expect-error Supplier repository tuples are immutable.
  issuerWrite.repositories.push(issuerRead.repositories[0]);
  // @ts-expect-error Supplier repository entries are immutable.
  issuerWrite.repositories[0].id = 404;
  // @ts-expect-error Targets are immutable.
  target.host = "api.github.com";
  // @ts-expect-error Operation identity is immutable.
  push.requestId = ids.requestId;
  // @ts-expect-error Push update arrays are immutable.
  push.updates.push(update);
  // @ts-expect-error Push capabilities are immutable.
  push.capabilities.push("other");
  // @ts-expect-error Push options are immutable.
  push.pushOptions.push("other");
  // @ts-expect-error Nested ref updates are immutable.
  update.refName = "refs/heads/other";
  // @ts-expect-error PR input is immutable.
  createPr.input.title = "Other title";
  void [
    ids.accessId,
    ids.dispatchId,
    omitted,
    readAccess,
    writeAccess,
    accessProfile,
    issuerWrite,
    checkout,
    readWithWriteProfile,
  ];
}
