// Modified for OpenClaw Enterprise.
// SPDX-License-Identifier: Apache-2.0

//! Rust policy-parser coverage using the selected Dream Serpent drift corpus.
//!
//! OCE retains the original fixture bytes in dataplane/testdata and checks the
//! actual Rust parser's outcomes. Historical Go verdict annotations describe the
//! source corpus; no Go reader is imported or executed by this suite. Tests of
//! handwritten Go verdict metadata are excluded from this Rust-only intake.
//!
//! The fixture coverage assertion rejects missing or unexpected YAML files.

use ds_contracts::pol1::{parse_layer, PolicyErrorCode, PolicyLayer, Rung, Tier};
use std::collections::BTreeMap;
use std::path::PathBuf;

/// The Rust reader's expected outcome for a corpus fixture: either `parse_layer`
/// ACCEPTS (returns `Ok`), or it REJECTS.
///
/// Two reject strengths, deliberately distinct:
///
///   * [`RustVerdict::Reject`] — PRESENCE: the named [`PolicyErrorCode`] must
///     appear SOMEWHERE in the collected bundle (`errs.has`). The right tool for
///     a SINGLE-cause drift class: it pins the rejection reason without over-
///     constraining a bundle that legitimately collects more than one violation.
///
///   * [`RustVerdict::RejectExact`] — EXACT SET: the bundle's DISTINCT code set
///     must equal the declared set, no more and no less. Presence-only is too
///     weak for the COMPOUND both-reject fixtures (20-23): each declares
///     INDEPENDENT causes on one artifact, so a regression that ADDED a spurious
///     extra rejection cause would still satisfy `has(code)` and slip through.
///     The exact-set arm bites that — the declared codes are the WHOLE cause set,
///     and any code outside it fails the fixture.
///
/// The compound codes are compared as a SET (distinct codes), not a multiset:
/// a bundle may collect the SAME code twice (e.g. fixture 22 surfaces
/// `MissingProvenance` once for the missing reason and once for the missing
/// provenance URL), which is benign duplication of an already-declared cause —
/// what `RejectExact` guards is the arrival of a NEW, undeclared cause CLASS.
#[derive(Clone, Copy, Debug)]
enum RustVerdict {
    Accept,
    Reject(PolicyErrorCode),
    RejectExact(&'static [PolicyErrorCode]),
}

/// The sorted, de-duplicated DEBUG labels of a code set. `PolicyErrorCode` derives
/// `Eq`/`Hash` but NOT `Ord` (and this test may not touch the production crate to
/// add it), so the stable ordering for set-equality is the `Debug` string — a
/// total, deterministic order over the variants that needs no production change.
fn sorted_code_labels<'a>(codes: impl IntoIterator<Item = &'a PolicyErrorCode>) -> Vec<String> {
    let mut labels: Vec<String> = codes.into_iter().map(|c| format!("{c:?}")).collect();
    labels.sort();
    labels.dedup();
    labels
}

/// Resolve the selected immutable fixture corpus within the dataplane intake.
fn corpus_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../testdata/policy-drift-corpus")
}

/// Expected outcomes from the actual Rust parser. Trailing Go annotations record
/// the historical source corpus only; OCE neither executes nor credits that reader.
/// RejectExact compares the complete observed error set, including unexpected errors.
fn rust_corpus_expectations() -> BTreeMap<&'static str, RustVerdict> {
    use PolicyErrorCode::*;
    use RustVerdict::*;
    let mut m: BTreeMap<&'static str, RustVerdict> = BTreeMap::new();

    m.insert("00-good-baseline.pol1.yaml", Accept); // Historical Go: accept (control)
    m.insert("17-duplicate-fqdn.pol1.yaml", Accept); // Historical Go: accept (benign dup)
    m.insert("18-reordered-families.pol1.yaml", Accept); // Historical Go: accept (order-insensitive)
    m.insert("19-comment-only-families.pol1.yaml", Accept); // Historical Go: accept (comments stripped)

    m.insert("01-missing-blocklist.pol1.yaml", Accept); // Historical Go: reject (NoBlocklistSection)
    m.insert("02-empty-blocklist.pol1.yaml", Accept); // Historical Go: reject (EmptyBlocklist)
    m.insert("03-wildcard-fqdn.pol1.yaml", Accept); // Historical Go: reject (BadFQDN)
    m.insert("04-uppercase-fqdn.pol1.yaml", Accept); // Historical Go: reject (BadFQDN)
    m.insert("05-entry-missing-rung.pol1.yaml", Accept); // Historical Go: reject (EntryMissingFields)
    m.insert("06-entry-missing-reason.pol1.yaml", Accept); // Historical Go: reject (EntryMissingFields)
    m.insert("07-flow-blocklist.pol1.yaml", Accept); // Historical Go: reject (UnsupportedShape)
    m.insert("08-quoted-keys.pol1.yaml", Accept); // Historical Go: reject (NoBlocklistSection)

    m.insert("09-anchor-alias-families.pol1.yaml", Reject(Syntax)); // Historical Go: reject (UnsupportedShape)

    m.insert("10-unknown-tier.pol1.yaml", Reject(BadValue)); // Historical Go: accept
    m.insert("11-empty-family-tier.pol1.yaml", Reject(BadValue)); // Historical Go: accept
    m.insert(
        "12-entry-missing-provenance.pol1.yaml",
        Reject(MissingProvenance),
    ); // Historical Go: accept
    m.insert("13-missing-rung-guardrail.pol1.yaml", Reject(MissingRung)); // Historical Go: accept
    m.insert("14-bad-rung-token.pol1.yaml", Reject(BadRung)); // Historical Go: accept
    m.insert("15-multi-document.pol1.yaml", Reject(Syntax)); // Historical Go: accept
    m.insert("16-tab-indent.pol1.yaml", Reject(Syntax)); // Historical Go: accept

    m.insert(
        "20-quoted-key-unknown-tier.pol1.yaml",
        RejectExact(&[BadValue]),
    ); // Historical Go: reject (NoBlocklistSection)
    m.insert(
        "21-flow-blocklist-bad-guardrail-rung.pol1.yaml",
        RejectExact(&[BadRung]),
    ); // Historical Go: reject (UnsupportedShape)
    m.insert(
        "22-entry-missing-reason-missing-provenance.pol1.yaml",
        RejectExact(&[MissingProvenance]),
    ); // Historical Go: reject (EntryMissingFields)
    m.insert(
        "23-uppercase-fqdn-missing-guardrail-rung.pol1.yaml",
        RejectExact(&[MissingRung]),
    ); // Historical Go: reject (BadFQDN)
    m.insert(
        "27-uppercase-fqdn-unknown-tier-missing-provenance.pol1.yaml",
        RejectExact(&[BadValue, MissingProvenance]),
    ); // Historical Go: reject (BadFQDN)

    m.insert("24-duplicate-fqdn-provenanced-entry.pol1.yaml", Accept); // Historical Go: accept (benign dup)
    m.insert("25-reordered-families-guardrail-rung.pol1.yaml", Accept); // Historical Go: accept (reordered families)
    m.insert("26-comment-only-guardrails-enabled-tier.pol1.yaml", Accept); // Historical Go: accept (comment-only guardrails)

    m
}

/// The sorted set of fixture filenames present on disk (`*.pol1.yaml`; the
/// `.provenance` sidecars are excluded). Ground truth for the coverage check.
fn list_corpus_fixtures() -> Vec<String> {
    let dir = corpus_dir();
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("reading the drift corpus dir {}: {e}", dir.display()))
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".pol1.yaml"))
        .collect();
    assert!(
        !names.is_empty(),
        "the drift corpus at {} is empty — expected the selected policy fixtures",
        dir.display()
    );
    names.sort();
    names
}

/// Verify fixture intake placement; this does not exercise a second-language reader.
#[test]
fn corpus_path_identity() {
    let canonical = corpus_dir()
        .canonicalize()
        .expect("selected fixture corpus exists");
    assert!(canonical.ends_with("dataplane/testdata/policy-drift-corpus"));
}

/// Parse all selected YAML fixtures and assert their actual acceptance or errors.
/// RejectExact requires equality with the entire returned distinct error set.
#[test]
fn drift_corpus_rust_verdicts() {
    let dir = corpus_dir();
    let table = rust_corpus_expectations();
    for name in list_corpus_fixtures() {
        let Some(want) = table.get(name.as_str()) else {
            // Coverage is asserted in the dedicated test below; skip the body so
            // that test owns the fail-closed message.
            continue;
        };
        let path = dir.join(&name);
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("reading corpus fixture {}: {e}", path.display()));
        let result = parse_layer(&text);
        match want {
            RustVerdict::Accept => {
                assert!(
                    result.is_ok(),
                    "fixture {name} must ACCEPT on the Rust schema reader (it is a \
                     well-formed-or-Rust-benign shape), got reject: {:?}",
                    result.err()
                );
            }
            RustVerdict::Reject(code) => {
                let errs = match result {
                    Ok(_) => panic!(
                        "fixture {name} must REJECT on the Rust schema reader (drift class \
                         {:?}), got a clean accept — silent acceptance of a malformed shape \
                         is the failure this corpus exists to catch",
                        class_of(&name)
                    ),
                    Err(e) => e,
                };
                assert!(
                    errs.has(*code),
                    "fixture {name}: Rust reader rejected for the WRONG reason — want code \
                     {code:?} in the bundle, got {errs}"
                );
            }
            RustVerdict::RejectExact(codes) => {
                let errs = match result {
                    Ok(_) => panic!(
                        "fixture {name} must REJECT on the Rust schema reader (compound drift \
                         class {:?}), got a clean accept — silent acceptance of a malformed \
                         shape is the failure this corpus exists to catch",
                        class_of(&name)
                    ),
                    Err(e) => e,
                };
                // EXACT-SET bite: build the SORTED, distinct collected code set from
                // the bundle's public `PolicyErrors(pub Vec<PolicyError>)` field
                // (each `PolicyError` exposes a public `code`) and assert it equals
                // the declared set. Unlike `errs.has(code)`, this FAILS if the bundle
                // carries ANY code outside the declared set — so a regression that
                // ADDED a spurious extra rejection cause to a compound fixture (which
                // a presence-only check would still pass) is caught here.
                let got = sorted_code_labels(errs.0.iter().map(|e| &e.code));
                let want = sorted_code_labels(codes.iter());
                assert_eq!(
                    got, want,
                    "fixture {name}: Rust reader's compound bundle code SET drifted — want \
                     exactly {want:?} (no more, no less), got {got:?}. The compound both-reject \
                     fixtures (20-23) declare INDEPENDENT causes; an extra cause class beyond \
                     the declared set means a spurious rejection crept in. Full bundle: {errs}"
                );
            }
        }
    }
}

/// Every selected fixture must have one expectation, and every expectation must
/// refer to an existing fixture. This checks completeness of the Rust corpus.
#[test]
fn drift_corpus_fixture_completeness() {
    let on_disk = list_corpus_fixtures();
    let table = rust_corpus_expectations();

    for name in &on_disk {
        assert!(
            table.contains_key(name.as_str()),
            "corpus fixture {name} has NO Rust verdict expectation — every shared fixture \
             must be wired into rust_corpus_expectations (every selected fixture needs an actual Rust parser expectation)"
        );
    }
    for name in table.keys() {
        assert!(
            on_disk.iter().any(|d| d == name),
            "rust_corpus_expectations lists {name} but no such fixture exists on disk \
             (stale expectation — deleting a fixture must drop its row here)"
        );
    }
    assert_eq!(
        table.len(),
        on_disk.len(),
        "drift-corpus count mismatch: {} fixtures on disk, {} Rust expectations — the Rust \
         reader's coverage must enumerate the corpus exactly (lockstep fail-closed)",
        on_disk.len(),
        table.len()
    );
}

/// Return the fixture class prefix used by the parsed-policy assertions.
fn class_of(fixture: &str) -> String {
    let base = fixture.strip_suffix(".pol1.yaml").unwrap_or(fixture);
    let bytes = base.as_bytes();
    if bytes.len() >= 3
        && bytes[0].is_ascii_digit()
        && bytes[1].is_ascii_digit()
        && bytes[2] == b'-'
    {
        base[3..].to_string()
    } else {
        base.to_string()
    }
}

/// Read a retained fixture and require successful parsing by the actual Rust reader.
fn parse_accepting_fixture(name: &str) -> PolicyLayer {
    let path = corpus_dir().join(name);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("reading corpus fixture {}: {e}", path.display()));
    parse_layer(&text).unwrap_or_else(|errs| {
        panic!(
            "fixture {name} must ACCEPT on the Rust schema reader for the parse-equivalence \
             premise (it is a both-ACCEPT corpus row), got reject: {errs}"
        )
    })
}

/// The PARSE-EQUIVALENCE premise for the compound both-ACCEPT pairs (25 vs 18,
/// 26 vs 19). The wave-1 corpus walk (`drift_corpus_rust_verdicts`) pins only
/// Ok-NESS for these rows: it proves each parses without a `PolicyError`, but it
/// never looks INSIDE the parsed [`PolicyLayer`]. So a Rust regression that kept
/// the compound ACCEPT yet silently DROPPED or PERTURBED one benign-axis content
/// ONLY in the compound presence of the other axis would still satisfy that
/// Ok-only gate. This premise closes that gap — the symmetric companion of the
/// wave-1 Go premise, which pinned the OTHER half (that the Go LINE SCANNER is
/// blind to the `baseline_pack.families` / `guardrails` sections).
///
/// Each compound fixture is the both-ACCEPT join of a single-axis sibling and one
/// EXTRA, INDEPENDENT benign axis on ONE artifact:
///
///   * 25 (reordered-families + valid guardrail rung) joins 18 (reordered-families)
///     with a guardrail rule carrying a valid `rung`. The SHARED benign axis is the
///     reordered `baseline_pack.families` mapping; the COMPOUND-ONLY axis is the
///     guardrail rung on `guardrails`.
///   * 26 (comment-only-guardrails + enabled family tier) joins 19 (comment-only-
///     families) with a `baseline_pack` family carrying a valid `tier: enabled`. The
///     SHARED benign axis is the comment-stripped-to-EMPTY `guardrails` sequence
///     (plus the intact `blocklist`); the COMPOUND-ONLY axis is the family `Tier`.
///
/// For each pair this asserts, over STABLE PUBLIC PROJECTIONS of the fully-`pub`
/// [`PolicyLayer`] (typed views with `PartialEq`/`Eq` — `baseline_pack.families:
/// BTreeMap<String, Tier>`, `guardrails: Vec<GuardrailRule>`, `blocklist:
/// Vec<BlockEntry>` — NOT `Debug` dumps):
///
///   (a) BOTH accept (via [`parse_accepting_fixture`]);
///   (b) the parsed projections AGREE wherever the EXTRA benign axis must NOT
///       perturb them (the compound parse equals the sibling parse on that axis);
///   (c) the COMPOUND-ONLY axis (the guardrail rung / the family tier) SURVIVES
///       into the parsed structure EXACTLY AS DECLARED — it is neither dropped nor
///       perturbed by the presence of the other benign axis.
///
/// Asserting (b) and (c) is what bites where the Ok-only walk cannot: dropping the
/// guardrail from 25 (but not its sibling-shared family reorder), or perturbing /
/// dropping the `core` family tier in 26 (but not its sibling-shared empty
/// guardrails), keeps the ACCEPT yet breaks this premise.
#[test]
fn compound_accept_parse_equivalence_premise() {
    // ── 25 vs 18 — SHARED axis: reordered `baseline_pack.families`; COMPOUND-ONLY
    //    axis: the guardrail rung on `guardrails`. ─────────────────────────────
    let p25 = parse_accepting_fixture("25-reordered-families-guardrail-rung.pol1.yaml");
    let p18 = parse_accepting_fixture("18-reordered-families.pol1.yaml");

    // (b) The reordered families mapping is the SHARED benign axis: the compound's
    //     `BTreeMap` projection (order-insensitive by construction) must EQUAL the
    //     single-axis sibling's. The added guardrail must NOT perturb the families
    //     mapping. Drop or perturb a family only-when-a-guardrail-is-present and
    //     this disagrees.
    assert_eq!(
        p25.baseline_pack.families, p18.baseline_pack.families,
        "compound 25 vs sibling 18: the reordered `baseline_pack.families` projection \
         (the SHARED benign axis) must AGREE — the extra guardrail-rung axis present only \
         in 25 must NOT perturb the order-insensitive families mapping. 25 families: {:?}, \
         18 families: {:?}",
        p25.baseline_pack.families, p18.baseline_pack.families
    );
    // The sibling shares 25's blocklist too; pin it so a perturbation of the shared
    // resolver-lock shape in the compound presence is caught here as well.
    assert_eq!(
        p25.blocklist, p18.blocklist,
        "compound 25 vs sibling 18: the shared `blocklist` projection must AGREE — the \
         compound-only guardrail-rung axis must not perturb it"
    );

    // (c) The COMPOUND-ONLY axis — the guardrail rung — must SURVIVE into the parsed
    //     structure AS DECLARED. 18 has NO guardrails (empty `Vec`); 25 declares
    //     exactly one rule whose rung is the declared `block+log`. A regression that
    //     dropped the guardrail in the compound presence would empty this `Vec` and
    //     fail here while the Ok-only walk still passes.
    assert!(
        p18.guardrails.is_empty(),
        "sibling 18 must declare NO guardrails (the compound-only axis is absent in the \
         single-axis sibling), got {:?}",
        p18.guardrails
    );
    assert_eq!(
        p25.guardrails.len(),
        1,
        "compound 25 must carry its ONE declared guardrail rule (the compound-only axis) \
         through parse, got {} rule(s): {:?}",
        p25.guardrails.len(),
        p25.guardrails
    );
    assert_eq!(
        p25.guardrails[0].rung,
        Rung::BlockLog,
        "compound 25: the guardrail rung (the compound-only axis) must SURVIVE parse AS \
         DECLARED (`block+log` -> Rung::BlockLog), got {:?}",
        p25.guardrails[0].rung
    );

    // ── 26 vs 19 — SHARED axis: comment-stripped-to-EMPTY `guardrails` (plus the
    //    intact `blocklist`); COMPOUND-ONLY axis: the `core` family `Tier`. ──────
    let p26 = parse_accepting_fixture("26-comment-only-guardrails-enabled-tier.pol1.yaml");
    let p19 = parse_accepting_fixture("19-comment-only-families.pol1.yaml");

    // (b) The comment-only guardrails block parses to an EMPTY sequence on BOTH
    //     sides (19 declares no guardrails; 26's are comment-only) — the SHARED
    //     benign axis. The added family tier must NOT perturb the guardrails
    //     projection. The intact blocklist is shared too.
    assert_eq!(
        p26.guardrails, p19.guardrails,
        "compound 26 vs sibling 19: the `guardrails` projection (the SHARED benign axis — \
         comment-stripped to EMPTY on both) must AGREE; the compound-only family-tier axis \
         must not perturb it. 26 guardrails: {:?}, 19 guardrails: {:?}",
        p26.guardrails, p19.guardrails
    );
    assert!(
        p26.guardrails.is_empty(),
        "compound 26: the comment-only `guardrails` block must strip to an EMPTY sequence \
         (a comment-only block yields no rules), got {:?}",
        p26.guardrails
    );
    assert_eq!(
        p26.blocklist, p19.blocklist,
        "compound 26 vs sibling 19: the shared `blocklist` projection must AGREE — the \
         compound-only family-tier axis must not perturb it"
    );

    // (c) The COMPOUND-ONLY axis — the `core` family `Tier` — must SURVIVE into the
    //     parsed `baseline_pack.families` map AS DECLARED. 19 has comment-only (EMPTY)
    //     families; 26 declares `core: { tier: enabled }`. A regression that dropped
    //     or perturbed the family tier in the compound presence would change this
    //     projection while the Ok-only walk still passes.
    assert!(
        p19.baseline_pack.families.is_empty(),
        "sibling 19 must parse its comment-only families to an EMPTY map (the compound-only \
         axis is absent in the single-axis sibling), got {:?}",
        p19.baseline_pack.families
    );
    let mut want_families: BTreeMap<String, Tier> = BTreeMap::new();
    want_families.insert("core".to_string(), Tier::Enabled);
    assert_eq!(
        p26.baseline_pack.families, want_families,
        "compound 26: the family tier (the compound-only axis) must SURVIVE parse AS \
         DECLARED (`core: {{ tier: enabled }}` -> {{core: Enabled}}), got {:?}",
        p26.baseline_pack.families
    );
}

/// Map compound fixtures to their independent single-axis sibling fixtures.
/// The retained test parses both sides and compares the observed compound error
/// set with the union of observed errors from its rejecting siblings.
fn compound_sibling_map() -> BTreeMap<&'static str, Vec<&'static str>> {
    let mut m: BTreeMap<&'static str, Vec<&'static str>> = BTreeMap::new();
    m.insert(
        "20-quoted-key-unknown-tier.pol1.yaml",
        vec!["08-quoted-keys.pol1.yaml", "10-unknown-tier.pol1.yaml"],
    );
    m.insert(
        "21-flow-blocklist-bad-guardrail-rung.pol1.yaml",
        vec!["07-flow-blocklist.pol1.yaml", "14-bad-rung-token.pol1.yaml"],
    );
    m.insert(
        "22-entry-missing-reason-missing-provenance.pol1.yaml",
        vec![
            "06-entry-missing-reason.pol1.yaml",
            "12-entry-missing-provenance.pol1.yaml",
        ],
    );
    m.insert(
        "23-uppercase-fqdn-missing-guardrail-rung.pol1.yaml",
        vec![
            "04-uppercase-fqdn.pol1.yaml",
            "13-missing-rung-guardrail.pol1.yaml",
        ],
    );
    m.insert(
        "27-uppercase-fqdn-unknown-tier-missing-provenance.pol1.yaml",
        vec![
            "04-uppercase-fqdn.pol1.yaml",
            "10-unknown-tier.pol1.yaml",
            "12-entry-missing-provenance.pol1.yaml",
        ],
    );
    m
}

/// Parse a single named corpus fixture through the FULL POL-1 schema reader
/// [`parse_layer`] and return its SORTED, DISTINCT collected `PolicyErrorCode`
/// label set — the runtime cause set the bundle actually carries, read off the
/// public `PolicyErrors(pub Vec<PolicyError>)` field (each `PolicyError` exposes a
/// public `code`) via [`sorted_code_labels`]. The fixture MUST reject — this helper
/// feeds the reject-equivalence premise below, and an ACCEPT here is a hard failure
/// (the fixture would not be a valid reject-side premise input). Mirrors
/// [`parse_accepting_fixture`] on the reject side: that helper projects the parsed
/// STRUCTURE, this one projects the parsed ERROR-CODE SET.
fn parse_rejecting_fixture_codes(name: &str) -> Vec<String> {
    let path = corpus_dir().join(name);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("reading corpus fixture {}: {e}", path.display()));
    match parse_layer(&text) {
        Ok(_) => panic!(
            "fixture {name} must REJECT on the Rust schema reader for the reject-equivalence \
             premise (it is a both-REJECT / Rust-rejecting corpus row), got a clean accept — \
             silent acceptance of a malformed shape is the failure this corpus exists to catch"
        ),
        Err(errs) => sorted_code_labels(errs.0.iter().map(|e| &e.code)),
    }
}

/// Collect ALL the Rust-SCHEMA-rejecting siblings of a compound both-reject row from
/// its [`compound_sibling_map`] entry — the siblings whose verdict is `Reject` /
/// `RejectExact` (the schema axes the compound shares with THIS reader), in entry
/// order. The Go-rejecting / Rust-BENIGN shape siblings (an `Accept` row on the Rust
/// column — their drift bites only the Go SHAPE surface) are filtered out: they
/// contribute no Rust schema cause to the union.
///
/// This is the ONE resolver the data-driven reject-equivalence premise drives BOTH the
/// singleton and the multi-element compounds off. A SINGLETON compound (rows 20-23 —
/// each composes ONE schema sibling and one Rust-benign Go-shape sibling) resolves to a
/// ONE-element set, so the union over it collapses to that sibling's parsed cause set
/// (`parse(compound) == parse(sibling)`). Row 27 — the FIRST committed compound that
/// composes TWO schema siblings (10 `unknown-tier` → `BadValue` ∪ 12
/// `entry-missing-provenance` → `MissingProvenance`) plus the Rust-benign Go-shape
/// sibling (04 `uppercase-fqdn`) — resolves to a TWO-element set, so the union over it
/// is the multi-element `{BadValue, MissingProvenance}`. Returning the full set (rather
/// than insisting on exactly one) is what lets the SAME loop prove both arities. This
/// REUSES the EXISTING [`compound_sibling_map`] as the single source of truth (no second
/// hand-maintained map); the union premise feeds the resolved siblings through
/// [`parse_rejecting_fixture_codes`].
fn rust_schema_rejecting_siblings<'a>(
    siblings: &'a [&'static str],
    table: &BTreeMap<&'static str, RustVerdict>,
) -> Vec<&'a &'static str> {
    siblings
        .iter()
        .filter(|s| {
            matches!(
                table.get(**s),
                Some(RustVerdict::Reject(_)) | Some(RustVerdict::RejectExact(_))
            )
        })
        .collect()
}

/// Compare observed compound errors with the union of observed sibling errors.
/// The main corpus walk separately compares each observed result with its declared
/// expected set. Both checks execute the real parser; neither uses a Go reader.
/// Require nonempty sibling errors so an empty comparison cannot pass vacuously.
#[test]
fn compound_reject_parse_equivalence_premise() {
    let table = rust_corpus_expectations();
    let sibling_map = compound_sibling_map();

    // ENUMERATE every RejectExact compound straight from the verdict table — no
    // hardcoded `covered` list to drift behind the corpus. Each such compound is a
    // both-REJECT artifact whose parsed cause set must equal the UNION over its
    // Rust-SCHEMA-rejecting siblings of each sibling's parsed cause set. The singleton
    // compounds (rows 20-23) are the 1-sibling special case (union over one); the
    // multi-element compound (row 27) is the union over two.
    let reject_exact_compounds: Vec<&'static str> = table
        .iter()
        .filter(|(_, v)| matches!(v, RustVerdict::RejectExact(_)))
        .map(|(name, _)| *name)
        .collect();

    // Sanity: the corpus has at least the known committed RejectExact compounds, so a
    // table edit that accidentally emptied the RejectExact class (turning the whole
    // loop vacuous) fails LOUDLY rather than passing on zero iterations.
    assert!(
        !reject_exact_compounds.is_empty(),
        "rust_corpus_expectations declares NO RejectExact compound rows — the reject-equivalence \
         premise has nothing to enumerate; the compound both-reject corpus (rows 20-23, 27) must \
         carry RejectExact verdicts for the data-driven union proof to bite"
    );

    for compound in reject_exact_compounds {
        let siblings = sibling_map.get(compound).unwrap_or_else(|| {
            panic!(
                "RejectExact compound row {compound} has NO entry in compound_sibling_map — the \
                 data-driven reject-equivalence premise enumerates EVERY RejectExact compound from \
                 rust_corpus_expectations and resolves its schema siblings here; a compound without \
                 a sibling-map entry is an unproven cause set (fail-closed — wire its sibling \
                 decomposition into compound_sibling_map)"
            )
        });

        // Resolve the Rust-SCHEMA-rejecting siblings off the EXISTING
        // compound_sibling_map (the single source of truth — no duplicate map) via the
        // multi-sibling verdict-kind resolver. A singleton compound (20-23) resolves to
        // ONE schema sibling (its Go-shape sibling is Rust-benign and contributes
        // nothing); row 27 resolves to TWO. The union below ranges over whatever the
        // resolver returns, so the SAME loop handles both arities.
        let schema_siblings = rust_schema_rejecting_siblings(siblings, &table);
        assert!(
            !schema_siblings.is_empty(),
            "RejectExact compound row {compound} resolves to ZERO Rust-SCHEMA-rejecting siblings \
             in compound_sibling_map (its siblings {siblings:?} are all Rust-benign) — a both-reject \
             compound that rejects on the Rust schema reader MUST compose at least one schema \
             sibling whose cause it shares; the union premise cannot anchor its parsed cause set \
             against an empty sibling set"
        );

        // (a) the compound rejects, and project its PARSED distinct cause set off the
        //     bytes (the helper panics on a clean accept).
        let compound_codes = parse_rejecting_fixture_codes(compound);

        // (b)+(c) UNION the schema siblings' PARSED cause sets — read off the bytes, not
        //         the declared table. Each sibling MUST reject (helper panics on a clean
        //         accept) and MUST contribute a NON-EMPTY set, so the union is provably
        //         non-vacuous (the singleton case yields a one-element union; row 27 a
        //         two-element one).
        let mut union_codes: Vec<String> = Vec::new();
        for sibling in &schema_siblings {
            let sibling_codes = parse_rejecting_fixture_codes(sibling);
            assert!(
                !sibling_codes.is_empty(),
                "schema sibling {sibling} of compound {compound} parsed to an EMPTY cause set — a \
                 rejecting bundle must carry at least one PolicyErrorCode; the reject-equivalence \
                 premise cannot anchor a vacuous (empty-contribution) sibling in the union"
            );
            union_codes.extend(sibling_codes);
        }
        // Collapse the per-sibling sets into ONE sorted, distinct union set for the
        // compare (the same set discipline `sorted_code_labels` enforces, applied to the
        // already-sorted-distinct labels each sibling contributed).
        union_codes.sort();
        union_codes.dedup();

        // (c) the union must be NON-VACUOUS — a both-empty equality would be a silent
        //     pass. Guaranteed by the per-sibling non-empty checks above plus the
        //     non-empty sibling SET, but pinned explicitly so the proof's anchor is
        //     visible at the comparison site.
        assert!(
            !union_codes.is_empty(),
            "compound row {compound}: the UNION of its schema siblings' parsed cause sets is EMPTY \
             — a rejecting compound must share at least one non-empty schema cause with its \
             siblings; the reject-equivalence premise cannot anchor a vacuous comparison"
        );

        // Compare independently parsed inputs. Combining malformed fields must
        // preserve the errors produced by the corresponding sibling inputs.
        assert_eq!(
            compound_codes, union_codes,
            "compound {compound}: its PARSED collected cause set {compound_codes:?} does NOT equal \
             the UNION of its single-axis Rust-SCHEMA siblings' parsed cause sets {union_codes:?} \
             (schema siblings: {schema_siblings:?}). The compound joins its schema siblings' drifts \
             with a Rust-benign Go-shape axis on ONE artifact; EVERY shared SCHEMA cause must reject \
             IDENTICALLY (same codes, same axes) whether or not the Go-shape axis is present — a \
             divergence means a regression relocated, dropped, or added a Rust cause ONLY in the \
             compound presence of the other axis"
        );
    }
}
