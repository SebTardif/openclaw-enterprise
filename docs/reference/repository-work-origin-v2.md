# Repository Work origin

`RepositoryWorkOriginOwnerV2` captures the original native Session source and State assignment source during construction. Its opaque origin is distinct from the native Session and from Work preparation or release handles. Copies of their diagnostic fields do not recreate private membership.

The default constructor selects metadata protocol v2. Git read requires explicit `protocolVersion: 3`, the admitted `github-git-read-rpc-v3` / `owned-child-stdio-github-git-read-v3` profile, and the State-owned `git:read` policy decision with `contents:read` and `metadata:read`. The parsed request digest retains the exact repository, Git operation, protocol and outgoing body hash/length. Each original construction keeps one version.

## Fixed custody association

The optional `nativeCustody` constructor operand implements `RepositoryWorkOriginNativeCustodyV2<Session, V>`. Runtime invokes its `bindOrigins(recognizer)` method once, with the original receiver. The receiver must capture that recognizer during construction and return `undefined`. There is no later binding setter or public native-session getter on the origin owner.

The captured `RepositoryWorkOriginNativeRecognizerV2<Session, V>` supplies:

```ts
recognize(origin: OriginalRepositoryWorkOriginV2<V>, call: AuthorityCallV1): Session
```

This synchronous method returns the exact native Session already held by that original origin. It checks Runtime private membership, original context/request/recipient, retained call and operation horizons, native lifetime, and native plus State currentness. The caller first refreshes the existing Runtime/State readset for the actual call. Recognition does not extend a call deadline, refresh an expired lease or create a new Session.

The fixed custody receiver uses that original Session with the original native source's inspection and prepared-write methods. Credential use still requires the original committed responsibility and fresh State use lease. The association grants no token permission and does not replace the native receiver or release its transport.

Origin release retains the existing accepted-work joins and borrowed-session release. A failed currentness fence retires the origin; if the fence returned an asynchronous continuation, Runtime joins it before releasing its original operands. State's separate `bindOrigins` recognizer keeps its existing native-only checkout ordering for refreshing the State readset.
