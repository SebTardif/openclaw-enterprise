import type {
  GitHubMetadataOperationV1,
  GitHubMetadataRepositoryV1,
} from "@openclaw-enterprise/occ";

export type MetadataOperationV1 = GitHubMetadataOperationV1;
export type MetadataFailureV1 = Readonly<{
  kind:
    | "invalid-request"
    | "invalid-response"
    | "limit-exceeded"
    | "unavailable"
    | "aborted"
    | "expired";
}>;
export type MetadataInspectionResultV1 =
  Readonly<{ kind: "inspected"; operation: Readonly<MetadataOperationV1> }> | MetadataFailureV1;
export type MetadataReadResultV1 =
  | Readonly<{ kind: "metadata"; value: Readonly<MetadataValueV1>; bytes: number }>
  | MetadataFailureV1;
export interface MetadataValueV1 {
  readonly id: number;
  readonly full_name: string;
  readonly private: boolean;
  readonly default_branch: string;
}

const SEGMENT = /^[A-Za-z0-9_.-]{1,100}$/;
const DECIMAL = /^[1-9][0-9]{0,15}$/;
const SELECTED_FIELDS = new Set(["id", "full_name", "private", "default_branch"]);
function text(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1024 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}
function segment(value: unknown): value is string {
  return typeof value === "string" && SEGMENT.test(value) && value !== "." && value !== "..";
}
function decimal(value: unknown): value is string {
  return (
    typeof value === "string" &&
    DECIMAL.test(value) &&
    Number.isSafeInteger(Number(value)) &&
    Number(value) > 0
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Copy selected supplier DATA only. No retained object can change the target across await. */
export function snapshotMetadataRepositoryV1(
  input: Readonly<GitHubMetadataRepositoryV1>,
): Readonly<GitHubMetadataRepositoryV1> | null {
  try {
    if (input === null || typeof input !== "object") return null;
    const {
      appId,
      installationId,
      repositoryId,
      canonicalOwner,
      canonicalName,
      bindingGeneration,
    } = input;
    const resource = input.repository;
    if (
      !decimal(appId) ||
      !decimal(installationId) ||
      !decimal(repositoryId) ||
      !segment(canonicalOwner) ||
      !segment(canonicalName) ||
      !text(bindingGeneration) ||
      resource === null ||
      typeof resource !== "object"
    )
      return null;
    const { upstreamInstanceId, canonicalResourceId } = resource;
    const schema = resource.resourceSchema;
    const segments = resource.canonicalPathSegments;
    if (
      !text(upstreamInstanceId) ||
      !text(canonicalResourceId) ||
      schema === null ||
      typeof schema !== "object" ||
      !Array.isArray(segments) ||
      segments.length !== 2 ||
      segments[0] !== canonicalOwner ||
      segments[1] !== canonicalName
    )
      return null;
    const { namespace, name, version, digest } = schema;
    if (
      !text(namespace) ||
      !text(name) ||
      !Number.isSafeInteger(version) ||
      version < 1 ||
      !text(digest)
    )
      return null;
    return Object.freeze({
      appId,
      installationId,
      repositoryId,
      canonicalOwner,
      canonicalName,
      bindingGeneration,
      repository: Object.freeze({
        upstreamInstanceId,
        canonicalResourceId,
        resourceSchema: Object.freeze({ namespace, name, version, digest }),
        canonicalPathSegments: Object.freeze([canonicalOwner, canonicalName]),
      }),
    });
  } catch {
    return null;
  }
}

// JSON.parse verifies the entire grammar. This iterative pass retains the root id
// token and detects escaped selected-key duplicates without recursing into extra fields.
function selectedRootId(source: string): string | null {
  const seen = new Set<string>();
  let id: string | null = null;
  let depth = 0;
  let key = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '"') {
      const start = i;
      while (++i < source.length) {
        if (source[i] === "\\") i++;
        else if (source[i] === '"') break;
      }
      if (depth === 1 && key) {
        const name: unknown = JSON.parse(source.slice(start, i + 1));
        if (typeof name === "string" && SELECTED_FIELDS.has(name)) {
          if (seen.has(name)) return null;
          seen.add(name);
          if (name === "id") {
            let tokenStart = i + 1;
            while (/\s/.test(source[tokenStart] ?? "")) tokenStart++;
            if (source[tokenStart++] !== ":") return null;
            while (/\s/.test(source[tokenStart] ?? "")) tokenStart++;
            let tokenEnd = tokenStart;
            while (tokenEnd < source.length && /[0-9.eE+-]/.test(source[tokenEnd] ?? ""))
              tokenEnd++;
            id = source.slice(tokenStart, tokenEnd);
          }
        }
        key = false;
      }
    } else if (char === "{" || char === "[") {
      depth++;
      if (depth === 1) key = char === "{";
    } else if (char === "}" || char === "]") depth--;
    else if (char === "," && depth === 1) key = true;
  }
  return id;
}

// Normalize only decimal digits and a bounded exponent. No IEEE754 conversion,
// exponent-sized allocation or arbitrary-precision arithmetic precedes equality.
function exactRepositoryId(token: string, expected: string): boolean {
  const parts = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(token);
  if (!parts) return false;
  const fraction = parts[2] ?? "";
  const digits = parts[1] + fraction;
  let first = 0;
  while (first < digits.length && digits[first] === "0") first++;
  if (first === digits.length) return false;
  let last = digits.length;
  while (last > first && digits[last - 1] === "0") last--;
  const significant = digits.slice(first, last);
  const exponent = parts[3] ?? "0";
  let magnitude = 0;
  for (let i = /^[+-]/.test(exponent) ? 1 : 0; i < exponent.length; i++) {
    magnitude = magnitude * 10 + Number(exponent[i]);
    // A larger exponent cannot compensate for this bounded token's digits.
    if (magnitude > token.length + 16) return false;
  }
  const scale =
    (exponent[0] === "-" ? -magnitude : magnitude) - fraction.length + (digits.length - last);
  if (scale < 0 || significant.length + scale !== expected.length || expected.length > 16)
    return false;
  return significant + "0".repeat(scale) === expected;
}
function isValidDefaultBranch(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 1024 ||
    Buffer.from(value, "utf8").toString("utf8") !== value ||
    /[\u0000-\u0020\u007f~^:?*\[\\]/.test(value) ||
    value.includes("..") ||
    value.includes("@{") ||
    value === "@"
  )
    return false;
  return value
    .split("/")
    .every(
      (part) =>
        part.length > 0 && !part.startsWith(".") && !part.endsWith(".") && !part.endsWith(".lock"),
    );
}

/** Entire verified provider body enters here; only fresh four-field DATA leaves. */
export function projectMetadataResponseV1(
  body: Uint8Array,
  expected: Readonly<GitHubMetadataRepositoryV1>,
): Readonly<MetadataValueV1> | null {
  try {
    const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
    const value: unknown = JSON.parse(source);
    if (!record(value)) return null;
    if (![...SELECTED_FIELDS].every((key) => Object.hasOwn(value, key))) return null;
    const { id, full_name, private: privateValue, default_branch } = value;
    const idToken = selectedRootId(source);
    if (
      typeof id !== "number" ||
      !Number.isSafeInteger(id) ||
      id <= 0 ||
      idToken === null ||
      !exactRepositoryId(idToken, expected.repositoryId) ||
      String(id) !== expected.repositoryId ||
      full_name !== `${expected.canonicalOwner}/${expected.canonicalName}` ||
      typeof privateValue !== "boolean" ||
      !isValidDefaultBranch(default_branch)
    )
      return null;
    return Object.freeze({ id, full_name, private: privateValue, default_branch });
  } catch {
    return null;
  }
}
