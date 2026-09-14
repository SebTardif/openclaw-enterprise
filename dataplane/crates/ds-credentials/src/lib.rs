// SPDX-License-Identifier: Apache-2.0
// Modified for OpenClaw Enterprise: extracted credential ownership and substitution.
//! Secret-owning buffers for a trusted upstream credential substitution boundary.
//!
//! These helpers perform no authorization, validation, fetching, or transport.
//! The caller must validate the scheme and credential for its selected protocol,
//! authorize the exact request, and supply a secret-free fingerprint. Borrowed
//! bytes remain sensitive; copies made by callers have their own erasure lifetime.
//!
//! Secret owners intentionally implement neither `Clone` nor `Display`.
//! ```compile_fail
//! use ds_credentials::{FetchedCredential, Fingerprint};
//! let secret = FetchedCredential::new(vec![42], Fingerprint::new("fixture"));
//! let copied = secret.clone();
//! ```
//! ```compile_fail
//! use ds_credentials::{FetchedCredential, Fingerprint};
//! let secret = FetchedCredential::new(vec![42], Fingerprint::new("fixture"));
//! println!("{}", secret);
//! ```
//! ```compile_fail
//! use ds_credentials::{substitute_authorization, FetchedCredential, Fingerprint};
//! let secret = FetchedCredential::new(vec![42], Fingerprint::new("fixture"));
//! let header = substitute_authorization("Bearer", &secret);
//! let copied = header.clone();
//! ```
//! ```compile_fail
//! use ds_credentials::{substitute_authorization, FetchedCredential, Fingerprint};
//! let secret = FetchedCredential::new(vec![42], Fingerprint::new("fixture"));
//! println!("{}", substitute_authorization("Bearer", &secret));
//! ```
#![forbid(unsafe_code)]
use std::fmt;
use zeroize::Zeroizing;

/// A caller-supplied, loggable identifier. Never put a credential in this value.
/// This type does not compute a hash or establish that an identifier is safe.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Fingerprint(String);

impl Fingerprint {
    /// Wrap a credential fingerprint (the loggable, secret-free identifier the
    /// upstream contract supplies). The caller is responsible for passing a
    /// fingerprint and never a credential byte — the credential value lives in a
    /// distinct zeroizing newtype that has no path into this constructor.
    pub fn new(fingerprint: impl Into<String>) -> Fingerprint {
        Fingerprint(fingerprint.into())
    }

    /// The fingerprint string for a log or wire field.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for Fingerprint {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Owns fetched credential bytes, wiped on drop. Debug reveals length and the
/// caller-supplied fingerprint, never the secret buffer.
pub struct FetchedCredential {
    value: Zeroizing<Vec<u8>>,
    fingerprint: Fingerprint,
}

impl FetchedCredential {
    /// Wrap the fetched long-lived credential `value` + its loggable
    /// `fingerprint`. Takes ownership of the bytes (wiped on drop). The
    /// fingerprint is the secret-free identifier the store supplies — never
    /// derived from the bytes here.
    pub fn new(value: impl Into<Vec<u8>>, fingerprint: Fingerprint) -> FetchedCredential {
        FetchedCredential {
            value: Zeroizing::new(value.into()),
            fingerprint,
        }
    }

    /// Borrow the credential bytes for the duration of the substitution write.
    /// No owned copy is returned. The caller must keep any copies secret and
    /// erase them after the upstream write.
    pub fn expose(&self) -> &[u8] {
        self.value.as_slice()
    }

    /// The loggable, secret-free fingerprint supplied with the credential.
    pub fn fingerprint(&self) -> &Fingerprint {
        &self.fingerprint
    }
}

impl fmt::Debug for FetchedCredential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FetchedCredential")
            .field("len", &self.value.len())
            .field("fingerprint", &self.fingerprint)
            .finish()
    }
}

/// Owns the substituted header bytes, wiped on drop. Debug reveals only length.
pub struct SubstitutedHeader(Zeroizing<Vec<u8>>);

impl SubstitutedHeader {
    /// Borrow the substituted header bytes for the write onto the upstream
    /// request. Never handed out by value.
    pub fn expose(&self) -> &[u8] {
        self.0.as_slice()
    }
}

impl fmt::Debug for SubstitutedHeader {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SubstitutedHeader")
            .field("len", &self.0.len())
            .finish()
    }
}

/// Join a validated scheme and credential with one ASCII space, or return the
/// bare value for an empty scheme. The caller owns HTTP validation and dispatch.
pub fn substitute_authorization(scheme: &str, fetched: &FetchedCredential) -> SubstitutedHeader {
    let cred = fetched.expose();
    let mut buf: Vec<u8> = Vec::with_capacity(scheme.len() + 1 + cred.len());
    if !scheme.is_empty() {
        buf.extend_from_slice(scheme.as_bytes());
        buf.push(b' ');
    }
    buf.extend_from_slice(cred);
    SubstitutedHeader(Zeroizing::new(buf))
}

#[cfg(test)]
mod tests {
    use super::*;
    use zeroize::{Zeroize, ZeroizeOnDrop};

    #[test]
    fn owned_secret_buffers_use_zeroizing_erasure() {
        fn erased_on_drop<T: ZeroizeOnDrop>(_: &T) {}
        let mut fetched =
            FetchedCredential::new(b"test-only-secret".to_vec(), Fingerprint::new("fp"));
        let mut header = substitute_authorization("Bearer", &fetched);
        erased_on_drop(&fetched.value);
        erased_on_drop(&header.0);
        // Observe erasure while allocations are still alive. Reading freed memory
        // after Drop would be undefined behavior and cannot prove this property.
        fetched.value.as_mut_slice().zeroize();
        header.0.as_mut_slice().zeroize();
        assert!(fetched.expose().iter().all(|byte| *byte == 0));
        assert!(header.expose().iter().all(|byte| *byte == 0));
    }
}
