# Git object snapshot store

This library saves the exact Git content of a proposed change so it can be read
again after the working repository changes or disappears. It is exported as
`@openclaw-enterprise/occ/git-object-store` and has no callers in the controller
or worker yet.

For example, an agent might produce commit A, then keep editing while a person
reviews it. A future publishing flow needs to retain A and its files so approval
of A cannot accidentally publish commit B. A commit ID identifies content, but
does not keep the underlying objects available after workspace cleanup or Git
garbage collection. This store retains those bytes independently.

Saving a snapshot grants no permission to push it. Approval and publishing need
a separate implementation with a real application caller.

## What the library does

`GitObjectStore` accepts explicit commit, tree, and blob records. Each record
contains its Git object ID, type, and raw bytes. The caller also selects the
proposed commit, captured base commit, and either an expected previous target
commit or branch creation.

| Method                                 | Behavior                                                                                           |
| -------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `open(options)`                        | Opens the selected storage directory and verifies the selected Git executable.                     |
| `capture(request, objects, signal)`    | Copies the supplied bytes, validates the graph, and saves a snapshot.                              |
| `inspect(snapshot)`                    | Returns the snapshot's object counts, byte counts, root IDs, and SHA-256 digests.                  |
| `assertRequest(snapshot, request)`     | Checks that the roots match and an expected previous target is an ancestor of the proposed commit. |
| `readPack(snapshot)`                   | Reads the saved Git pack into a new buffer.                                                        |
| `restore(descriptor, request, signal)` | Reopens saved content and validates its bytes and graph again.                                     |
| `close()`                              | Stops accepting operations, waits for pending operations, and closes file descriptors.             |

The store validates each object's hash and requires all referenced objects to be
present with the correct type. It rejects duplicate IDs, unreachable extra
objects, missing history, and updates whose expected previous commit is not an
ancestor of the proposal. The result includes a normal Git PACK v2 without delta
compression, which Git can import. It does not read a checkout or access a remote.

## Supported repositories and limits

This is a deliberately limited snapshot format, not a general repository mirror.
It supports SHA-1 repositories with regular files, executable files, and
directories. It rejects symbolic links, submodules, tags, non-ASCII filenames,
case-colliding names, and several platform-specific or unsafe filenames. Commit
headers support tree, parents, author, committer, optional UTF-8 encoding, and
folded `gpgsig` signatures. A retained signature is content, not verified approval.

**Every capture requires the complete history and file objects reachable from
both the base and proposed commits.** It cannot accept a shallow checkout or a
small patch that relies on unprovided base objects. Restrictions apply to historical
trees too, so a currently ordinary repository can still be unsupported.

Callers choose positive limits up to these ceilings:

| Limit                                        | Maximum     |
| -------------------------------------------- | ----------- |
| Unique objects                               | 8,192       |
| One object's raw bytes                       | 8 MiB       |
| All raw object bytes                         | 64 MiB      |
| Retained pack bytes                          | 80 MiB      |
| Tree depth                                   | 128         |
| Path length                                  | 4,096 bytes |
| Expanded tree/path visits across all commits | 100,000     |
| Capture or restore validation deadline       | 120 seconds |

Repeated historical trees count toward the expanded-path limit each time they
are visited. These limits can exclude ordinary larger repositories even for a
one-line change. A first application integration must establish whether this
profile fits its repositories before relying on it.

## Storage and execution requirements

The implementation requires Linux with `/proc`, an existing directory owned by
the configured UID with mode `0700`, and an explicitly selected Git executable.
The executable selection includes its absolute path, expected owner UID, and
SHA-256 digest. Select a Git build with collision-detecting SHA-1; the digest
identifies the binary but does not establish how it was built.

Git runs only `hash-object` with fixed arguments and an isolated environment. It
receives object bytes on stdin and does not run project commands, hooks, filters,
or shell text. Executable identity and bytes are checked before each invocation;
child output and execution time are bounded.

Saved content is addressed by its graph digest, uses mode `0600`, and is synced
to disk before capture succeeds. Existing content is compared rather than
replaced. A later capture of the same graph reuses the saved pack. Reopening
validates that pack against its raw objects without recompressing it, so a
compressor change does not invalidate saved content. Reads check file identity,
ownership, permissions, and content. The
store keeps both raw objects and the pack, so disk usage exceeds pack size alone.

The `durability: "persistent-posix"` option declares the caller's storage choice;
it cannot make a temporary directory survive container or host replacement.
Deployments must supply persistent storage and control access to it. There is no
retention policy, garbage collection, or total directory quota. Failed or
cancelled captures can leave saved content. Those lifecycle decisions belong
with the first application integration.

## Verification

See [Git object store testing](../testing/git-object-store.md) for local
Git setup, interoperability coverage, and troubleshooting. The tests verify
local capture, corruption rejection, pack import, and reopening; they do not
exercise human approval, GitHub publication, or deployment durability.
