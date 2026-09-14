// SPDX-License-Identifier: Apache-2.0
// Modified for OpenClaw Enterprise: isolate credential regressions from proxy execution.
use ds_credentials::{substitute_authorization, FetchedCredential, Fingerprint};

const LONG_CRED: &[u8] = b"test-only-upstream-credential-canary";

#[test]
fn substitute_authorization_joins_scheme_and_credential_and_supports_bare_value() {
    let fetched = FetchedCredential::new(LONG_CRED.to_vec(), Fingerprint::new("fp-long-github"));
    // scheme + cred
    let h = substitute_authorization("Bearer", &fetched);
    let mut want = b"Bearer ".to_vec();
    want.extend_from_slice(LONG_CRED);
    assert_eq!(h.expose(), want.as_slice());
    // bare value (empty scheme) — no leading space.
    let bare = substitute_authorization("", &fetched);
    assert_eq!(bare.expose(), LONG_CRED);
}
#[test]
fn neither_the_fetched_nor_substituted_newtype_renders_the_credential() {
    // The substituted header + the fetched credential newtypes both Debug to
    // length-only (the boundary canary grep covers every log surface).
    let fetched = FetchedCredential::new(LONG_CRED.to_vec(), Fingerprint::new("fp-long-github"));
    let dbg_fetched = format!("{fetched:?}");
    assert!(!dbg_fetched
        .as_bytes()
        .windows(LONG_CRED.len())
        .any(|w| w == LONG_CRED));
    assert!(dbg_fetched.contains("len"));
    assert!(dbg_fetched.contains("fp-long-github")); // fingerprint is loggable

    let header = substitute_authorization("Bearer", &fetched);
    let dbg_header = format!("{header:?}");
    assert!(!dbg_header
        .as_bytes()
        .windows(LONG_CRED.len())
        .any(|w| w == LONG_CRED));
    assert!(dbg_header.contains("len"));
}
