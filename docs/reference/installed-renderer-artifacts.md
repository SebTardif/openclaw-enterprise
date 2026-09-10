# Protected installed renderer artifacts

The Controller's `ProtectedInstalledArtifactStore` acquires a deployment-selected local OCI Image Layout and retains verified image and source bytes. This is an artifact component. It does not grant workload-profile admission, native authority, a provider operation, or executable launch support.

## Bootstrap selection and construction

The original trusted bootstrap supplies `InstalledArtifactSelection`: an absolute layout root, expected owner UID, exact Gateway and Harness manifest descriptors and immutable image references, Linux platform, an independently pinned definition descriptor, and finite limits. The planned production mount is `/var/lib/openclaw-enterprise/installed-artifacts/oci`. This source change neither creates nor verifies that deployment mount.

Construction captures and validates immutable configuration only:

```ts
const artifacts = new ProtectedInstalledArtifactStore(selection);
const held = await artifacts.acquire(originalCancellationSignal);
try {
  held.assertCurrent();
  const gatewayFile = held.images.gateway.readFile("/selected/absolute/image/path");
  // gatewayFile.bytes is a copy. Inspecting it grants no execution permission.
} finally {
  await held.release();
}
```

There is no registry, URL resolver, mutable tag lookup, directory scan, or request-selected callback. Original renderer State enrollment remains in `renderer-source.ts`; it precedes installed-definition acquisition and retains that source until its original transaction terminal. The store constructor requires no outer Compute or DriverSelection. An eventual installed definition source recognizes the selected Compute through the existing original factory association at acquisition time.

## Acquired content

The supported input is OCI image-spec v1.1.0 layout with `oci-layout` version1.0.0, `index.json`, SHA256 blobs, Linux `amd64` or `arm64`, OCI image manifests/configurations, and ordered tar or gzip layers. Selected raw descriptor sizes and digests are checked before their JSON is decoded. Configuration platform and ordered uncompressed layer DiffIDs must correspond. Unrelated index descriptors are neither traversed nor rejected merely because they are unrelated. See the pinned [OCI layout](https://github.com/opencontainers/image-spec/blob/v1.1.0/image-layout.md), [descriptor](https://github.com/opencontainers/image-spec/blob/v1.1.0/descriptor.md), and [configuration](https://github.com/opencontainers/image-spec/blob/v1.1.0/config.md) definitions.

The independently pinned definition record uses media type `application/vnd.openclaw.installed-renderer-definition.v1+json`. Its optional `sourceBlobs` array selects at most32 unique source IDs with `application/vnd.openclaw.installed-source.v1+octet-stream` descriptors. Those bytes are acquired and retained with the images. This container for source bytes is not a launch-definition authority or a declaration of supported behavior.

Limits cover individual and aggregate compressed bytes, aggregate uncompressed bytes across both roles, layer and tar-entry counts, JSON bytes, path bytes and link depth. The existing bounded workload-profile JSON decoder rejects duplicate keys and unsupported JSON number/shape representations. The source supports the Linux immutable image subset; OCI metadata that requires another interpreter is refused explicitly.

## Virtual layers

Archive paths are interpreted only in a private in-memory image view. Nothing is extracted onto the host. Whiteouts remove lower-layer content before same-layer additions, including opaque directory markers regardless of archive order. Replacement, hardlinks and image-root-relative symlinks retain the selected byte content. See the pinned [OCI layer specification](https://github.com/opencontainers/image-spec/blob/v1.1.0/layer.md).

The tar subset supports POSIX ustar regular files, directories, symlinks, already-resolved regular-file hardlinks, and per-entry PAX path/linkpath/size/uid/gid/timestamps. Symlink target components are preserved: an intermediate symlink is followed before a later `..`. Obvious lexical root escapes are refused at capture; actual traversal also refuses escapes, missing intermediates, non-directory intermediates and excessive link depth. It rejects malformed checksums and lengths, incomplete archives, path traversal, duplicate or conflicting entries, writes through symlinks, unsafe recursion, mismatched hardlink metadata, device nodes, forward hardlinks, GNU/sparse/global headers, xattrs and other unsupported relevant metadata. Zstd is unsupported. Unsupported entries cannot be silently skipped to obtain a successful view.

## Filesystem and lifetime

Acquisition opens each real ancestor and layout directory without following symlinks. Child access uses the retained parent directory descriptor. Each selected file is first held by a Linux `O_PATH | O_NOFOLLOW` inode anchor, which opens no FIFO/device endpoint and needs no cooperating writer. Its type must be a regular, single-link object with root or the selected owner UID and no group/other writes. Only then is the held regular inode content-opened nonblocking through its kernel `/proc/self/fd` reference; the mutable layout pathname is not reopened. Both descriptors' device/inode/mode/owner/size/link count/mtime/ctime must correspond around acquisition and reads. Parents have corresponding ownership/write restrictions. Actual anchor/content opens and closes are retained through cancellation, including late returns and failed closes. Verified bytes are copied into private storage; an open descriptor or matching stat record alone is not treated as immutable content.

Actual opens, reads, stats, decompression callbacks and closes are joined. Cancellation does not abandon an entered operation. An unsuccessful original descriptor close is retained, and `store.close()` refuses instead of reporting successful physical retirement. Repeated close joins the same promise. Failed acquisitions close partial resources before rejecting.

After acquisition, image files and source blobs are served from the retained verified content. A pathname replacement cannot retarget an existing lease. Fresh acquisition rechecks all pins. A borrowed lease has an independent lifetime; releasing its parent cannot erase its content. Returned byte arrays are copies. Final release clears the owned buffers, and store closure invalidates and joins every outstanding acquisition and view.

## Required original launch and revision owners

Image/source byte custody is now a concrete implementation. Full installed renderer qualification still requires an original executable/environment/module definition tied to those acquired bytes and to the selected original constructor. The current fixed renderer exposes immutable options, image references, constructors and entrypoint strings. Those methods alone do not authenticate a packaging record's claimed launch behavior. A list of expected hashes, a copied manifest or a successful file lookup cannot replace that original qualification.

Definition acquisition must stay revision-, Namespace-, Use- and launch-free. Revision acquisition additionally needs actual original material/target construction inputs and outputs, plus the same dispatcher's exact completed launch operands. `acquireCurrentLaunchOperands` supplies that launch identity without invoking hooks; it does not supply those material/target operands. The whole `imageSetDigest` covers the actual qualified application/init/helper projection and cannot be computed as a hash of the two image references.

The existing stronger workload profile and required supported gVisor backend remain unchanged. This source does not claim a ready Agent, model turn, complete HTTP flow, populated artifact mount, or production capability set.

## Controlled source checks

The selected tests author real temporary OCI files and byte archives. External filesystem barriers retain real FileHandles while exercising late success, rejection, cancellation, mutation and failed close. Archive, digest, platform, limit, whiteout/link and borrowed-lifetime cases exercise the actual components. These tests are authored and **unrun** in the source packet. Root separately selects receiving, configured type checks, and the maintained Node test invocation with `--experimental-test-module-mocks` for the filesystem-boundary cases.
