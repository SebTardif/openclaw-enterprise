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

## Native currentness during the State handoff

Original Work captures `owner.assertNativeCurrent.bind(owner)` during construction. This separate synchronous method accepts the same opaque origin and actual `AuthorityCallV1` as `assertCurrent`. It checks the retained native Session, current Exchange, original context/request/recipient and independent lifetime, plus the existing monotonic call, lease and operation horizons. An invalid asynchronous native assertion is refused and joined before original release.

State's `selection.prepareStateUse(selection, origin, call)` retires the initial SQL readset before original Work acquires its current readset through the original unit. During this handoff, `assertNativeCurrent` does not acquire or assert State assignment. Its success establishes no Work or repository permission. Original Work owns its captured native port and joins accepted source work through the original `context.joinAccepted` receiver.

After State's `participant.acquireCurrentReadset` and current policy acquisition establish the new held readset, the original full `assertCurrent` still checks both native and State currentness. The custody recognizer also keeps its full check. Neither is relabeled or bypassed by the native-only method. Original observation cleanup remains with its separately retained source after origin closure; native handoff cannot revive a closed origin or authorize reentry.

## Fixed custody correspondence during the State handoff

The same frozen construction recognizer also supplies the explicitly selected synchronous method:

```ts
recognizeNative(origin: OriginalRepositoryWorkOriginV2<V>, call: AuthorityCallV1): Session
```

The original custody receiver captures this method and its receiver once, alongside `recognize`. During the SQL handoff, `recognizeNative` returns the exact retained native Session after checking original Runtime membership, the native current Exchange, context/request/recipient, cancellation, independent lifetime and the unchanged monotonic call, lease and operation horizons. It neither asserts nor acquires State authority. There is no public Session getter or later binding setter on the origin owner.

This explicit correspondence lets the original backend pair the opaque Work origin with its retained native Session before acquiring the new State unit. The backend owns that deliberate method selection. After the new held State readset and current policy are acquired, the unchanged full `recognize` and `assertCurrent` remain required at their original effect boundaries. Failure of full recognition still retires the origin; native-only correspondence cannot serve as a fallback or revive it. Invalid asynchronous native fences remain joined before either original operand is released.

## Native inspection for a later RPC

Original Work also captures `owner.inspectNative.bind(owner)` during construction:

```ts
inspectNative(
  origin: OriginalRepositoryWorkOriginV2<V>,
  call: AuthorityCallV1,
): Promise<RepositoryWorkNativeBindingV2>
```

A later genuine broker RPC has its own native Exchange and deadline. Before the State handoff and synchronous native fences, Work uses this operation to authenticate that Exchange through the original retained native Session source. Runtime uses the existing call cutoff, cancellation and pending-work gate, reuses native observation and current registry/profile checks, and preserves the original context, transport, session, recipient and independent lifetime. It never acquires, inspects or asserts a State assignment. Returned execution and receiver binding remain the already captured original association; the result grants no new Work or repository permission.

The new call remains bounded by the original lease and operation horizons; native inspection cannot renew either. A shorter current native expiry can shorten them. Reusing the same absolute call deadline cannot reset its monotonic cutoff. The original native owner must authenticate the actual Exchange, so changing a deadline alone supplies no enrollment. Delayed native work remains joined when cancellation or expiry retires the origin.

`inspectNative` completes with native-only currentness through a closed private gate selector. Existing full `inspect`, `assertCurrent` and full custody recognition retain their native-plus-State checks. After State establishes the new held readset and policy, original Work still uses those full fences at the existing authority boundaries. The synchronous `assertNativeCurrent` and `recognizeNative` methods check an already authenticated call; they do not enroll a later RPC themselves.
