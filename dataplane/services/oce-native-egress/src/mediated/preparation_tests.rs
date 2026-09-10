use super::*;
use std::{io::Write, time::Duration};

fn gzip(bytes: &[u8]) -> Vec<u8> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    encoder.write_all(bytes).unwrap();
    encoder.finish().unwrap()
}

#[test]
fn gzip_requires_one_complete_integrity_checked_member_with_both_bounds() {
    let original = b"0014command=ls-refs\n0017object-format=sha1\n00010009peel\n000csymrefs\n0000";
    let compressed = gzip(original);
    let decoded = normalize_git_body(Zeroizing::new(compressed.clone()), true, 4096).unwrap();
    assert_eq!(decoded.as_slice(), original);
    assert_eq!(git_protocol::request(&decoded), Ok(Command::LsRefs));
    assert_eq!(
        broker_rpc::sha256(&decoded),
        "sha256:30f5149ff5f5a60ddababe9b0932fd61736653a3e2e310b7ae2d9f2138ebdb9d"
    );
    // Every premature EOF is rejected, including footer CRC/size truncation.
    for end in 0..compressed.len() {
        assert!(
            normalize_git_body(Zeroizing::new(compressed[..end].to_vec()), true, 4096).is_err(),
            "accepted truncated gzip at {end}"
        );
    }
    for tail in [b"tail".to_vec(), vec![0], compressed.clone(), gzip(b"")] {
        let mut invalid = compressed.clone();
        invalid.extend(tail);
        assert!(normalize_git_body(Zeroizing::new(invalid), true, 4096).is_err());
    }
    let mut bad_crc = compressed.clone();
    let at = bad_crc.len() - 8;
    bad_crc[at] ^= 1;
    assert!(normalize_git_body(Zeroizing::new(bad_crc), true, 4096).is_err());
    let mut bad_size = compressed.clone();
    let at = bad_size.len() - 4;
    bad_size[at] ^= 1;
    assert!(normalize_git_body(Zeroizing::new(bad_size), true, 4096).is_err());
    assert!(matches!(
        normalize_git_body(
            Zeroizing::new(compressed.clone()),
            true,
            compressed.len() as u64 - 1
        ),
        Err(Refusal::Bounds)
    ));
    let bomb = gzip(&vec![b'x'; 8192]);
    assert!(matches!(
        normalize_git_body(Zeroizing::new(bomb), true, 4096),
        Err(Refusal::Bounds)
    ));
    let exact = gzip(&vec![b'x'; 4096]);
    assert_eq!(
        normalize_git_body(Zeroizing::new(exact), true, 4096)
            .unwrap()
            .len(),
        4096
    );
}

#[test]
fn git_canonical_vectors_and_basic_auth_match_the_closed_profile() {
    assert_eq!(
        git_request_digest(
            Operation::Discovery,
            "/example/project.git/info/refs?service=git-upload-pack",
            0,
            &broker_rpc::sha256(b"")
        ),
        "sha256:1d558dc32779e5b4aca0c37defcdf0a5018f1517ff7716f42419a2e531cc069a"
    );
    let body = b"0014command=ls-refs\n0017object-format=sha1\n00010009peel\n000csymrefs\n0000";
    assert_eq!(
        git_request_digest(
            Operation::UploadPack,
            "/example/project.git/git-upload-pack",
            body.len(),
            &broker_rpc::sha256(body)
        ),
        "sha256:792994a0d426f5dd513a227dfb83ac91381eba7d8e40c1e47916f3bde4435f62"
    );
    let token = FetchedCredential::new(
        b"synthetic-git-read-installation-token".to_vec(),
        Fingerprint::new("test"),
    );
    assert_eq!(
        git_credential(&token).unwrap().expose(),
        b"eC1hY2Nlc3MtdG9rZW46c3ludGhldGljLWdpdC1yZWFkLWluc3RhbGxhdGlvbi10b2tlbg=="
    );
}

#[test]
fn git_http_profile_rejects_route_auth_encoding_and_framing_overrides() {
    let limits = Limits {
        header_bytes: 16384,
        header_count: 32,
        request_bytes: GIT_REQUEST_LIMIT,
        response_bytes: 64 * 1024 * 1024,
        exchange_timeout: Duration::from_secs(10),
    };
    let make = || {
        Request::builder()
            .method(Method::POST)
            .uri("/example/project.git/git-upload-pack")
            .version(Version::HTTP_11)
            .header("host", "github.com")
            .header("git-protocol", "version=2")
            .header("content-type", "application/x-git-upload-pack-request")
            .body(())
            .unwrap()
            .into_parts()
            .0
    };
    assert_eq!(
        validate_git_request(&make(), "example", "project", limits),
        Ok(Operation::UploadPack)
    );
    let mut valid_gzip = make();
    valid_gzip
        .headers
        .insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
    assert_eq!(
        validate_git_request(&valid_gzip, "example", "project", limits),
        Ok(Operation::UploadPack)
    );
    for (header, value) in [
        ("authorization", "Basic caller"),
        ("proxy-authorization", "Bearer caller"),
        ("cookie", "caller"),
        ("content-encoding", "br"),
        ("content-encoding", "gzip, gzip"),
        ("git-protocol", "version=1"),
        ("git-protocol", "version=2:server-option=escape"),
        ("host", "other.example"),
        ("content-type", "application/x-git-receive-pack-request"),
        ("content-length", "4194305"),
        ("transfer-encoding", "gzip, chunked"),
        ("trailer", "secret"),
        ("expect", "100-continue"),
    ] {
        let mut parts = make();
        parts.headers.insert(
            ::http::HeaderName::from_bytes(header.as_bytes()).unwrap(),
            HeaderValue::from_str(value).unwrap(),
        );
        assert!(
            validate_git_request(&parts, "example", "project", limits).is_err(),
            "accepted {header}"
        );
    }
    for path in [
        "/other/project.git/git-upload-pack",
        "/example/project.git/git-receive-pack",
        "/example/project.git/git-upload-pack?x=1",
        "/example/project.git/../project.git/git-upload-pack",
        "/example/project%2egit/git-upload-pack",
        "/example/project.git/info/lfs/objects/batch",
        "https://github.com/example/project.git/git-upload-pack",
    ] {
        let mut parts = make();
        parts.uri = path.parse().unwrap();
        assert!(validate_git_request(&parts, "example", "project", limits).is_err());
    }
    let mut duplicate = make();
    duplicate
        .headers
        .append("git-protocol", HeaderValue::from_static("version=2"));
    assert!(validate_git_request(&duplicate, "example", "project", limits).is_err());
}

#[test]
fn fetch_normalization_removes_only_thin_request_and_binds_resulting_bytes() {
    let packet = |line: &str| format!("{:04x}{line}", line.len() + 4);
    let raw = format!(
        "{}{}0001{}{}{}0000",
        packet("command=fetch"),
        packet("agent=git/2.55.0"),
        packet("thin-pack\n"),
        packet("ofs-delta"),
        packet("want 0123456789abcdef0123456789abcdef01234567\ndone")
    );
    // A line containing an extra command is still rejected, before normalization.
    assert!(git_protocol::without_thin_pack(Zeroizing::new(raw.into_bytes())).is_err());
    let original = format!(
        "{}{}0001{}{}{}{}0000",
        packet("command=fetch"),
        packet("agent=git/2.55.0"),
        packet("thin-pack\n"),
        packet("ofs-delta"),
        packet("want 0123456789abcdef0123456789abcdef01234567\n"),
        packet("done")
    );
    let expected = original.replace(&packet("thin-pack\n"), "");
    let normalized =
        git_protocol::without_thin_pack(Zeroizing::new(original.as_bytes().to_vec())).unwrap();
    assert_eq!(normalized.as_slice(), expected.as_bytes());
    assert_eq!(git_protocol::request(&normalized), Ok(Command::Fetch));
    assert_ne!(
        broker_rpc::sha256(original.as_bytes()),
        broker_rpc::sha256(&normalized)
    );
    assert_eq!(
        git_protocol::without_thin_pack(normalized)
            .unwrap()
            .as_slice(),
        expected.as_bytes()
    );
}
