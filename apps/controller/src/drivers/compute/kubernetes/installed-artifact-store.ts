import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import {
  canonicalizeWorkloadProfileJson,
  decodeWorkloadProfileJson,
} from "@openclaw-enterprise/occ/workload-profiles/canonical";
import { InstalledImageFiles, type InstalledLayerInput } from "./installed-artifact-layers.ts";

export interface InstalledArtifactDescriptor {
  readonly mediaType: string;
  readonly digest: string;
  readonly size: number;
}
export interface InstalledArtifactSelection {
  readonly root: string;
  readonly ownerUid: number;
  readonly platform: {
    readonly os: "linux";
    readonly architecture: "amd64" | "arm64";
    readonly variant?: string;
  };
  readonly images: Readonly<
    Record<
      "gateway" | "harness",
      Readonly<{
        reference: string;
        descriptor: InstalledArtifactDescriptor;
      }>
    >
  >;
  /** An independently pinned deployment-owned source record in the OCI blob set.
   * Its bytes do not grant State enrollment or executable support. */
  readonly definition: InstalledArtifactDescriptor;
  readonly limits: {
    readonly blobBytes: number;
    readonly compressedBytes: number;
    readonly uncompressedBytes: number;
    readonly jsonBytes: number;
    readonly layers: number;
    readonly entries: number;
    readonly pathBytes: number;
    readonly linkDepth: number;
  };
}
export interface InstalledArtifactImage {
  readonly reference: string;
  readonly descriptor: InstalledArtifactDescriptor;
  readonly configuration: Readonly<Record<string, unknown>>;
  readFile(
    path: string,
  ): Readonly<{ mode: number; uid: number; gid: number; digest: string; bytes: Uint8Array }>;
}
export interface InstalledArtifactLease {
  readonly images: Readonly<Record<"gateway" | "harness", InstalledArtifactImage>>;
  readonly definition: InstalledArtifactDescriptor;
  readDefinition(): Uint8Array;
  readBlob(digest: string): Uint8Array;
  borrow(): InstalledArtifactLease;
  assertCurrent(): undefined;
  release(): Promise<void>;
}
const manifestType = "application/vnd.oci.image.manifest.v1+json";
const configType = "application/vnd.oci.image.config.v1+json";
const definitionType = "application/vnd.openclaw.installed-renderer-definition.v1+json";
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const acquireImage = InstalledImageFiles.acquire;
const readImage = InstalledImageFiles.prototype.read;
const closeImage = InstalledImageFiles.prototype.close;
const throwIfAborted = AbortSignal.prototype.throwIfAborted;
// Linux UAPI O_PATH: acquire an inode reference without opening its endpoint.
// Node does not expose this Linux-only flag in its portable constants type.
const pathOnly = 0x200000;
function invalid(): never {
  throw new Error("Protected installed artifacts are unavailable.");
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, names: readonly string[]): void {
  if (
    Object.keys(value).length !== names.length ||
    names.some((name) => !Object.hasOwn(value, name))
  )
    invalid();
}
function sha(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
function same(before: Stats, after: Stats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.uid === after.uid &&
    before.gid === after.gid &&
    before.size === after.size &&
    before.nlink === after.nlink &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}
function parse(bytes: Uint8Array, max: number): Record<string, unknown> {
  if (bytes.byteLength > max) invalid();
  return record(decodeWorkloadProfileJson(bytes, "operator-envelope").value);
}
function descriptor(
  value: unknown,
  mediaTypes: readonly string[],
  max: number,
): InstalledArtifactDescriptor {
  const d = record(value);
  if (
    !mediaTypes.includes(d.mediaType as string) ||
    typeof d.digest !== "string" ||
    !digestPattern.test(d.digest) ||
    !Number.isSafeInteger(d.size) ||
    (d.size as number) < 1 ||
    (d.size as number) > max ||
    d.urls !== undefined ||
    d.data !== undefined ||
    d.artifactType !== undefined
  )
    invalid();
  return Object.freeze({
    mediaType: d.mediaType as string,
    digest: d.digest,
    size: d.size as number,
  });
}
function selected(input: InstalledArtifactSelection): InstalledArtifactSelection {
  // Copies only data properties; getters/proxies/toJSON never select acquisition.
  const copy = parse(canonicalizeWorkloadProfileJson(input, "operator-envelope"), 65536);
  exactKeys(copy, ["root", "ownerUid", "platform", "images", "definition", "limits"]);
  const root = copy.root;
  if (
    typeof root !== "string" ||
    !isAbsolute(root) ||
    normalize(root) !== root ||
    root === "/" ||
    root.endsWith("/") ||
    Buffer.byteLength(root) > 4096 ||
    root.slice(1).split("/").length > 64 ||
    /[\\\x00-\x1f]/.test(root)
  )
    invalid();
  if (
    !Number.isSafeInteger(copy.ownerUid) ||
    (copy.ownerUid as number) < 0 ||
    (copy.ownerUid as number) > 0xffffffff
  )
    invalid();
  const limits = record(copy.limits),
    caps = {
      blobBytes: 268435456,
      compressedBytes: 2147483647,
      uncompressedBytes: 4294967295,
      jsonBytes: 65536,
      layers: 1024,
      entries: 1000000,
      pathBytes: 4096,
      linkDepth: 64,
    };
  exactKeys(limits, Object.keys(caps));
  for (const key of Object.keys(caps) as (keyof typeof caps)[])
    if (
      !Number.isSafeInteger(limits[key]) ||
      (limits[key] as number) < 1 ||
      (limits[key] as number) > caps[key]
    )
      invalid();
  const platform = record(copy.platform);
  if (
    platform.os !== "linux" ||
    !["amd64", "arm64"].includes(platform.architecture as string) ||
    Object.keys(platform).some((key) => !["os", "architecture", "variant"].includes(key)) ||
    (platform.variant !== undefined &&
      (typeof platform.variant !== "string" || !/^[a-zA-Z0-9._-]{1,32}$/.test(platform.variant)))
  )
    invalid();
  const images = record(copy.images);
  exactKeys(images, ["gateway", "harness"]);
  for (const role of ["gateway", "harness"] as const) {
    const image = record(images[role]);
    exactKeys(image, ["reference", "descriptor"]);
    const d = descriptor(image.descriptor, [manifestType], limits.jsonBytes as number);
    if (
      typeof image.reference !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(image.reference) ||
      !image.reference.endsWith(`@${d.digest}`)
    )
      invalid();
  }
  descriptor(copy.definition, [definitionType], limits.jsonBytes as number);
  return copy as unknown as InstalledArtifactSelection;
}

/** Original local filesystem acquisition, never a registry/receipt callback.
 * Construction is inert. Each acquisition owns all entered operations until
 * settlement, then retains private verified bytes rather than trusting paths. */
export class ProtectedInstalledArtifactStore {
  readonly #selection: InstalledArtifactSelection;
  readonly #pending = new Set<Promise<unknown>>();
  readonly #retire = new Set<() => Promise<void>>();
  readonly #descriptorClosures = new Map<FileHandle, Promise<void>>();
  #closed = false;
  #closing: Promise<void> | undefined;
  constructor(selection: InstalledArtifactSelection) {
    if (process.platform !== "linux") invalid();
    this.#selection = selected(selection);
    Object.freeze(this);
  }
  acquire(signal: AbortSignal): Promise<InstalledArtifactLease> {
    if (!(signal instanceof AbortSignal) || this.#closed)
      return Promise.reject(new Error("Protected installed artifacts are unavailable."));
    // Publish ownership before the first original open or cancellation getter.
    const pending = Promise.resolve().then(() => this.#acquire(signal));
    this.#pending.add(pending);
    void pending.then(
      () => this.#pending.delete(pending),
      () => this.#pending.delete(pending),
    );
    return pending;
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#closing = Promise.resolve().then(async () => {
      while (this.#pending.size) await Promise.allSettled([...this.#pending]);
      const results = await Promise.allSettled([...this.#retire].map((release) => release()));
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      const closures = await Promise.allSettled([...this.#descriptorClosures.values()]);
      const closureFailure = closures.find((result) => result.status === "rejected");
      if (closureFailure?.status === "rejected") throw closureFailure.reason;
    });
    return this.#closing;
  }
  #closeDescriptor(handle: FileHandle): Promise<void> {
    const old = this.#descriptorClosures.get(handle);
    if (old) return old;
    // Publish the original close join before entering the descriptor callback.
    // A failed close retains its actual handle and rejected join permanently.
    const pending = Promise.resolve().then(() => handle.close());
    this.#descriptorClosures.set(handle, pending);
    void pending.then(
      () => this.#descriptorClosures.delete(handle),
      () => undefined,
    );
    return pending;
  }
  async #acquire(signal: AbortSignal): Promise<InstalledArtifactLease> {
    const selection = this.#selection,
      limits = selection.limits;
    const handles: { handle: FileHandle; before: Stats }[] = [];
    const buffers = new Map<string, Buffer>();
    const images = new Map<
      "gateway" | "harness",
      {
        view: InstalledImageFiles;
        descriptor: InstalledArtifactDescriptor;
        reference: string;
        configuration: Readonly<Record<string, unknown>>;
      }
    >();
    const metadata: Buffer[] = [];
    let compressed = 0,
      published = false;
    const current = () => {
      throwIfAborted.call(signal);
      if (this.#closed) invalid();
    };
    const protectedStat = (s: Stats, directory: boolean) => {
      if (
        (directory ? !s.isDirectory() : !s.isFile()) ||
        (s.uid !== 0 && s.uid !== selection.ownerUid) ||
        (s.mode & 0o022) !== 0 ||
        (!directory && s.nlink !== 1)
      )
        invalid();
    };
    const directory = async (path: string): Promise<FileHandle> => {
      current();
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      // Retain even a late handle before checking cancellation/stat/identity.
      const entry = { handle, before: undefined as unknown as Stats };
      handles.push(entry);
      entry.before = await handle.stat();
      protectedStat(entry.before, true);
      current();
      return handle;
    };
    const file = async (
      parent: FileHandle,
      name: string,
      maximum: number,
      expected?: InstalledArtifactDescriptor,
    ): Promise<Buffer> => {
      current();
      // O_PATH|O_NOFOLLOW anchors even a FIFO/symlink without endpoint-open or
      // a cooperating writer. The type gate precedes every content open.
      const anchor = await open(
        `/proc/self/fd/${parent.fd}/${name}`,
        pathOnly | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      let handle: FileHandle | undefined;
      let bytes: Buffer | undefined;
      try {
        const anchored = await anchor.stat();
        protectedStat(anchored, false);
        current();
        // This proc reference names our held inode, not the replaceable entry
        // in the layout. O_NOFOLLOW cannot be used on the kernel proc link.
        handle = await open(
          `/proc/self/fd/${anchor.fd}`,
          constants.O_RDONLY | constants.O_NONBLOCK,
        );
        const before = await handle.stat();
        protectedStat(before, false);
        current();
        if (!same(anchored, before)) invalid();
        if (
          !Number.isSafeInteger(before.size) ||
          before.size < 1 ||
          before.size > maximum ||
          (expected && before.size !== expected.size)
        )
          invalid();
        compressed += before.size;
        if (compressed > limits.compressedBytes) invalid();
        bytes = Buffer.alloc(before.size);
        for (let offset = 0; offset < bytes.length;) {
          current();
          const { bytesRead } = await handle.read(
            bytes,
            offset,
            Math.min(65536, bytes.length - offset),
            offset,
          );
          current();
          if (!bytesRead) invalid();
          offset += bytesRead;
        }
        const after = await handle.stat();
        current();
        const anchorAfter = await anchor.stat();
        current();
        if (
          !same(before, after) ||
          !same(anchored, anchorAfter) ||
          (expected && sha(bytes) !== expected.digest)
        )
          invalid();
        return bytes;
      } catch (error) {
        bytes?.fill(0);
        throw error;
      } finally {
        const failures: unknown[] = [];
        if (handle)
          try {
            await this.#closeDescriptor(handle);
          } catch (error) {
            failures.push(error);
          }
        try {
          await this.#closeDescriptor(anchor);
        } catch (error) {
          failures.push(error);
        }
        if (failures.length) {
          bytes?.fill(0);
          if (failures.length === 1) throw failures[0];
          throw new AggregateError(failures, "Installed artifact inode cleanup failed.");
        }
      }
    };
    try {
      let parent = await directory("/");
      for (const component of selection.root.slice(1).split("/"))
        parent = await directory(`/proc/self/fd/${parent.fd}/${component}`);
      const layout = await file(parent, "oci-layout", limits.jsonBytes);
      metadata.push(layout);
      if (parse(layout, limits.jsonBytes).imageLayoutVersion !== "1.0.0") invalid();
      const indexBytes = await file(parent, "index.json", limits.jsonBytes);
      metadata.push(indexBytes);
      const index = parse(indexBytes, limits.jsonBytes);
      if (
        index.schemaVersion !== 2 ||
        !Array.isArray(index.manifests) ||
        (index.mediaType !== undefined &&
          index.mediaType !== "application/vnd.oci.image.index.v1+json")
      )
        invalid();
      const blobs = await directory(`/proc/self/fd/${parent.fd}/blobs`);
      const shaDirectory = await directory(`/proc/self/fd/${blobs.fd}/sha256`);
      const blob = async (d: InstalledArtifactDescriptor): Promise<Buffer> => {
        const existing = buffers.get(d.digest);
        if (existing) {
          if (existing.length !== d.size) invalid();
          return existing;
        }
        const bytes = await file(
          shaDirectory,
          d.digest.slice(7),
          Math.min(limits.blobBytes, d.size),
          d,
        );
        buffers.set(d.digest, bytes);
        return bytes;
      };
      const definitionBytes = await blob(
        descriptor(selection.definition, [definitionType], limits.jsonBytes),
      );
      const definition = parse(definitionBytes, limits.jsonBytes);
      if (definition.sourceBlobs !== undefined) {
        if (!Array.isArray(definition.sourceBlobs) || definition.sourceBlobs.length > 32) invalid();
        const sourceIds = new Set<string>();
        for (const value of definition.sourceBlobs) {
          const source = record(value);
          exactKeys(source, ["id", "descriptor"]);
          if (
            typeof source.id !== "string" ||
            !/^[a-z][a-zA-Z0-9-]{0,63}$/.test(source.id) ||
            sourceIds.has(source.id)
          )
            invalid();
          sourceIds.add(source.id);
          await blob(
            descriptor(
              source.descriptor,
              ["application/vnd.openclaw.installed-source.v1+octet-stream"],
              limits.blobBytes,
            ),
          );
        }
      }
      let layerCount = 0,
        uncompressedBytes = 0,
        entries = 0;
      for (const role of ["gateway", "harness"] as const) {
        const chosen = selection.images[role];
        const matches = index.manifests.filter(
          (value) =>
            value &&
            typeof value === "object" &&
            (value as Record<string, unknown>).digest === chosen.descriptor.digest,
        );
        if (matches.length !== 1) invalid();
        const indexed = record(matches[0]),
          d = descriptor(indexed, [manifestType], limits.jsonBytes);
        if (d.size !== chosen.descriptor.size) invalid();
        if (indexed.platform !== undefined) {
          const p = record(indexed.platform);
          for (const key of ["os", "architecture", "variant"] as const)
            if (p[key] !== selection.platform[key]) invalid();
          if (
            p["os.version"] !== undefined ||
            p["os.features"] !== undefined ||
            p.features !== undefined
          )
            invalid();
        }
        const manifest = parse(await blob(d), limits.jsonBytes);
        if (
          manifest.schemaVersion !== 2 ||
          (manifest.mediaType !== undefined && manifest.mediaType !== manifestType) ||
          manifest.subject !== undefined ||
          manifest.artifactType !== undefined ||
          !Array.isArray(manifest.layers)
        )
          invalid();
        layerCount += manifest.layers.length;
        if (layerCount > limits.layers) invalid();
        const configuration = parse(
          await blob(descriptor(manifest.config, [configType], limits.jsonBytes)),
          limits.jsonBytes,
        );
        for (const key of ["os", "architecture", "variant"] as const)
          if (configuration[key] !== selection.platform[key]) invalid();
        if (configuration["os.version"] !== undefined || configuration["os.features"] !== undefined)
          invalid();
        const rootfs = record(configuration.rootfs);
        if (
          rootfs.type !== "layers" ||
          !Array.isArray(rootfs.diff_ids) ||
          rootfs.diff_ids.length !== manifest.layers.length
        )
          invalid();
        const layers: InstalledLayerInput[] = [];
        for (let i = 0; i < manifest.layers.length; i++) {
          const layer = descriptor(
            manifest.layers[i],
            [
              "application/vnd.oci.image.layer.v1.tar",
              "application/vnd.oci.image.layer.v1.tar+gzip",
            ],
            limits.blobBytes,
          );
          const diffId = rootfs.diff_ids[i];
          if (typeof diffId !== "string" || !digestPattern.test(diffId)) invalid();
          layers.push({ mediaType: layer.mediaType, bytes: await blob(layer), diffId });
        }
        const view = await acquireImage(
          layers,
          {
            uncompressedBytes: limits.uncompressedBytes - uncompressedBytes,
            entries: limits.entries - entries,
            pathBytes: limits.pathBytes,
            linkDepth: limits.linkDepth,
          },
          signal,
        );
        images.set(role, { view, descriptor: d, reference: chosen.reference, configuration });
        current();
        uncompressedBytes += view.usage.uncompressedBytes;
        entries += view.usage.entries;
      }
      for (const { handle, before } of handles) {
        if (!same(before, await handle.stat())) invalid();
        current();
      }
      // Close actual filesystem operations before a retained-byte lease exists.
      while (handles.length) await this.#closeDescriptor(handles.pop()!.handle);
      current();
      const views = new Set<() => Promise<void>>();
      let retired = false;
      const retire = () => {
        if (retired) return;
        retired = true;
        for (const image of images.values()) closeImage.call(image.view);
        images.clear();
        for (const buffer of [...metadata, ...buffers.values()]) buffer.fill(0);
        metadata.length = 0;
        buffers.clear();
      };
      const makeView = (): InstalledArtifactLease => {
        if (retired || this.#closed) invalid();
        let released = false,
          closing: Promise<void> | undefined;
        const assertCurrent = (): undefined => {
          if (released || retired) invalid();
          current();
          return undefined;
        };
        const release = (): Promise<void> => {
          if (closing) return closing;
          released = true;
          closing = Promise.resolve().then(() => {
            views.delete(release);
            this.#retire.delete(release);
            if (!views.size) retire();
          });
          return closing;
        };
        const imageView = (role: "gateway" | "harness"): InstalledArtifactImage => {
          const image = images.get(role)!;
          return Object.freeze({
            reference: image.reference,
            descriptor: image.descriptor,
            configuration: image.configuration,
            readFile: (path: string) => {
              assertCurrent();
              const result = readImage.call(image.view, path);
              assertCurrent();
              return result;
            },
          });
        };
        const result = Object.freeze({
          images: Object.freeze({ gateway: imageView("gateway"), harness: imageView("harness") }),
          definition: selection.definition,
          readDefinition: () => {
            assertCurrent();
            return new Uint8Array(buffers.get(selection.definition.digest)!);
          },
          readBlob: (digest: string) => {
            assertCurrent();
            const bytes = buffers.get(digest);
            if (!bytes) invalid();
            return new Uint8Array(bytes);
          },
          borrow: () => {
            assertCurrent();
            return makeView();
          },
          assertCurrent,
          release,
        });
        views.add(release);
        this.#retire.add(release);
        return result;
      };
      const lease = makeView();
      published = true;
      return lease;
    } finally {
      const failures: unknown[] = [];
      while (handles.length) {
        try {
          await this.#closeDescriptor(handles.pop()!.handle);
        } catch (error) {
          failures.push(error);
        }
      }
      if (!published) {
        for (const image of images.values()) closeImage.call(image.view);
        for (const buffer of [...metadata, ...buffers.values()]) buffer.fill(0);
      }
      if (failures.length)
        throw new AggregateError(failures, "Installed artifact descriptor cleanup failed.");
    }
  }
}
