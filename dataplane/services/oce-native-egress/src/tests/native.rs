//! Explicitly selected real-client compatibility fixture. All listeners and
//! upstream dials are loopback; no production authority or public traffic.
use super::*;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    process::Stdio,
};
use tokio::{process::Command, sync::watch};

pub(crate) async fn command(
    path: &Path,
    args: &[&str],
    env: &BTreeMap<String, String>,
    input: Option<Vec<u8>>,
) -> std::process::Output {
    let mut cmd = Command::new(path);
    cmd.args(args)
        .env_clear()
        .envs(env)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .process_group(0);
    let mut child = cmd.spawn().unwrap();
    let pid = child.id().unwrap();
    let stdin = child.stdin.take();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    // Drain output concurrently with input, and retain the child across timeout
    // so process-group cancellation still joins its original process owner.
    let work = async {
        let write = async move {
            if let (Some(mut pipe), Some(bytes)) = (stdin, input) {
                pipe.write_all(&bytes).await?;
            }
            Ok::<_, std::io::Error>(())
        };
        let read = |pipe: Box<dyn tokio::io::AsyncRead + Unpin + Send>| async move {
            let mut bytes = Vec::new();
            pipe.take(4 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .await?;
            if bytes.len() > 4 * 1024 * 1024 {
                return Err(std::io::Error::other("fixture output limit"));
            }
            Ok(bytes)
        };
        let (_, stdout, stderr, status) = tokio::try_join!(
            write,
            read(Box::new(stdout)),
            read(Box::new(stderr)),
            child.wait()
        )?;
        Ok::<_, std::io::Error>(std::process::Output {
            status,
            stdout,
            stderr,
        })
    };
    match timeout(Duration::from_secs(15), work).await {
        Ok(Ok(output)) => output,
        _ => {
            let _ = Command::new("/bin/kill")
                .args(["-KILL", "--", &format!("-{pid}")])
                .status()
                .await;
            let _ = child.start_kill();
            let _ = child.wait().await;
            panic!("Controlled native subprocess failed its bounded lifecycle");
        }
    }
}
pub(crate) async fn success(path: &Path, args: &[&str], env: &BTreeMap<String, String>) -> String {
    let output = command(path, args, env, None).await;
    assert!(
        output.status.success(),
        "native command failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}
pub(crate) fn base_environment(home: &Path, exec_path: &str) -> BTreeMap<String, String> {
    [
        ("PATH", "/usr/bin:/bin"),
        ("HOME", home.to_str().unwrap()),
        ("LANG", "C"),
        ("GIT_EXEC_PATH", exec_path),
        ("GIT_CONFIG_NOSYSTEM", "1"),
        ("GIT_CONFIG_GLOBAL", "/dev/null"),
        ("GIT_CONFIG_SYSTEM", "/dev/null"),
        ("GIT_TERMINAL_PROMPT", "0"),
        ("GIT_AUTHOR_NAME", "Native fixture"),
        ("GIT_AUTHOR_EMAIL", "fixture@local.invalid"),
        ("GIT_COMMITTER_NAME", "Native fixture"),
        ("GIT_COMMITTER_EMAIL", "fixture@local.invalid"),
    ]
    .into_iter()
    .map(|(k, v)| (k.into(), v.into()))
    .collect()
}

// Synthetic GitHub response shapes copied from the maintained native endpoint
// fixture. This receiver supplies protocol data; its query matching is never
// used by the firewall as GraphQL authorization.
fn graphql_response(bytes: &[u8], creates: &AtomicUsize) -> serde_json::Value {
    use serde_json::json;
    let packet: serde_json::Value = serde_json::from_slice(bytes).unwrap();
    let query = packet["query"].as_str().unwrap();
    let variables = &packet["variables"];
    let issue = json!({"number":7,"title":"Native fixture issue","state":"OPEN","url":"https://github.com/fixture/repo/issues/7","body":"Selected native issue body","__typename":"Issue","id":"I_native_fixture"});
    let pull = json!({"number":9,"title":"Existing fixture PR","state":"OPEN","url":"https://github.com/fixture/repo/pull/9","isDraft":true,"baseRefName":"main","headRefName":"existing"});
    let repo = json!({"id":"R_native_fixture","name":"repo","nameWithOwner":"fixture/repo","owner":{"id":"O_native_fixture","login":"fixture"},"url":"https://github.com/fixture/repo","isPrivate":true,"isFork":false,"isArchived":false,"hasIssuesEnabled":true,"viewerPermission":"WRITE","defaultBranchRef":{"name":"main"},"parent":null});
    if query.contains("createPullRequest") {
        assert_eq!(creates.fetch_add(1, Ordering::SeqCst), 0);
        let input = &variables["input"];
        assert_eq!(input["repositoryId"], "R_native_fixture");
        assert_eq!(input["baseRefName"], "main");
        assert_eq!(input["headRefName"], "native-test");
        assert_eq!(input["draft"], true);
        assert_eq!(input["maintainerCanModify"], false);
        json!({"data":{"createPullRequest":{"pullRequest":{"id":"PR_native_created","number":10,"url":"https://github.com/fixture/repo/pull/10"}}}})
    } else if query.contains("IssueList") {
        json!({"data":{"repository":{"hasIssuesEnabled":true,"issues":{"totalCount":1,"nodes":[issue],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}})
    } else if query.contains("issue(") || query.contains("issueOrPullRequest(") {
        json!({"data":{"repository":{"hasIssuesEnabled":true,"issue":issue}}})
    } else if query.contains("pullRequest(") {
        json!({"data":{"repository":{"pullRequest":pull}}})
    } else if query.contains("pullRequests(") {
        json!({"data":{"repository":{"pullRequests":{"totalCount":0,"nodes":[],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}})
    } else {
        assert!(query.contains("repository("));
        json!({"data":{"repository":repo}})
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit prepared native artifact manifest and private scratch"]
async fn pinned_git_and_gh_use_actual_two_leg_transport() {
    let manifest_path =
        std::env::var("OCE_NATIVE_FIREWALL_TOOLS").expect("explicit native tool manifest");
    let scratch_parent = PathBuf::from(
        std::env::var("OCE_NATIVE_FIREWALL_SCRATCH").expect("explicit private scratch"),
    );
    assert!(scratch_parent.is_absolute() && scratch_parent.is_dir());
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(manifest_path).unwrap()).unwrap();
    assert_eq!(manifest["execution"], "local-synthetic-only");
    assert_eq!(manifest["git"]["version"], "2.55.0");
    assert_eq!(
        manifest["git"]["commit"],
        "e9019fcafe0040228b8631c30f97ae1adb61bcdc"
    );
    assert_eq!(manifest["gh"]["version"], "2.93.0");
    assert_eq!(
        manifest["gh"]["commit"],
        "f96972ce1c11fdb8eaa556257fde962a363dffde"
    );
    let home = scratch_parent.join(format!(
        "native-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&home).unwrap();
    let base = base_environment(&home, manifest["gitExecPath"].as_str().unwrap());
    // Recheck all referenced artifacts, not just the top-level Git executable.
    for name in [
        "git",
        "gh",
        "gitRemoteHttp",
        "gitRemoteHttps",
        "gitHttpBackend",
    ] {
        let path = manifest[name]["path"].as_str().unwrap();
        assert!(Path::new(path).is_absolute());
        let hash = success(Path::new("/usr/bin/sha256sum"), &[path], &base).await;
        assert_eq!(
            hash.split_whitespace().next().unwrap(),
            manifest[name]["sha256"].as_str().unwrap()
        );
    }
    let git = PathBuf::from(manifest["git"]["path"].as_str().unwrap());
    let gh = PathBuf::from(manifest["gh"]["path"].as_str().unwrap());
    let backend = PathBuf::from(manifest["gitHttpBackend"]["path"].as_str().unwrap());
    assert_eq!(
        success(&git, &["--version"], &base).await.trim(),
        "git version 2.55.0"
    );
    assert!(success(&gh, &["--version"], &base)
        .await
        .starts_with("gh version 2.93.0 ("));
    let seed = home.join("seed");
    let bare_root = home.join("bare");
    let bare = bare_root.join("fixture/repo.git");
    let checkout = home.join("checkout");
    std::fs::create_dir_all(bare.parent().unwrap()).unwrap();
    success(
        &git,
        &[
            "-c",
            "init.templateDir=",
            "init",
            "--initial-branch=main",
            seed.to_str().unwrap(),
        ],
        &base,
    )
    .await;
    std::fs::write(seed.join("file.txt"), "controlled native graph\n").unwrap();
    success(
        &git,
        &["-C", seed.to_str().unwrap(), "add", "file.txt"],
        &base,
    )
    .await;
    success(
        &git,
        &[
            "-C",
            seed.to_str().unwrap(),
            "-c",
            "commit.gpgSign=false",
            "commit",
            "-m",
            "Fixture base",
        ],
        &base,
    )
    .await;
    let commit = success(
        &git,
        &["-C", seed.to_str().unwrap(), "rev-parse", "HEAD"],
        &base,
    )
    .await
    .trim()
    .to_owned();
    success(
        &git,
        &[
            "clone",
            "--bare",
            seed.to_str().unwrap(),
            bare.to_str().unwrap(),
        ],
        &base,
    )
    .await;
    success(
        &git,
        &[
            "--git-dir",
            bare.to_str().unwrap(),
            "config",
            "http.receivepack",
            "true",
        ],
        &base,
    )
    .await;

    let (up_server, up_trust, _) = certificate_bundle(&["github.com", "api.github.com"]);
    let (down_server, _, down_pem) = certificate_bundle(&["github.com", "api.github.com"]);
    let ca = home.join("native-ca.pem");
    std::fs::write(&ca, down_pem).unwrap();
    let upstream = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let endpoint = match upstream.local_addr().unwrap() {
        std::net::SocketAddr::V4(v) => v,
        _ => unreachable!(),
    };
    let calls = Arc::new(Mutex::new(Vec::<String>::new()));
    let up_calls = calls.clone();
    let creates = Arc::new(AtomicUsize::new(0));
    let upstream_creates = creates.clone();
    let (shutdown, stop) = watch::channel(false);
    let mut tasks = Vec::new();
    let backend_env = base.clone();
    let backend_commit = commit.clone();
    let mut upstream_stop = stop.clone();
    tasks.push(tokio::spawn(async move {
        let mut owned=tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                _=upstream_stop.changed()=>break,
                accepted=upstream.accept()=>{
                    let (socket,_)=accepted.unwrap(); let server=up_server.clone(); let calls=up_calls.clone();
                    let creates=upstream_creates.clone(); let backend=backend.clone(); let env=backend_env.clone(); let root=bare_root.clone(); let commit=backend_commit.clone();
                    owned.spawn(async move {
                        let tls=TlsAcceptor::from(server).accept(socket).await.unwrap();
                        let handler=service_fn(move |req:Request<hyper::body::Incoming>| {
                            let creates=creates.clone(); let backend=backend.clone(); let mut env=env.clone(); let root=root.clone(); let commit=commit.clone();
                            calls.lock().unwrap().push(req.uri().to_string());
                            async move {
                                let (parts,body)=req.into_parts();
                                let auth=parts.headers.get("authorization").unwrap().to_str().unwrap();
                                assert!(auth=="Basic eC1hY2Nlc3MtdG9rZW46c3ludGhldGljLW5hdGl2ZQ==" || auth=="token synthetic-native" || auth=="Bearer synthetic-native");
                                let bytes=body.collect().await.unwrap().to_bytes();
                                let response=if parts.uri.path().starts_with("/fixture/repo.git/") {
                                    env.insert("GIT_PROJECT_ROOT".into(),root.to_str().unwrap().into());
                                    env.insert("GIT_HTTP_EXPORT_ALL".into(),"1".into());
                                    env.insert("PATH_INFO".into(),parts.uri.path().into());
                                    env.insert("QUERY_STRING".into(),parts.uri.query().unwrap_or("").into());
                                    env.insert("REQUEST_METHOD".into(),parts.method.as_str().into());
                                    env.insert("CONTENT_TYPE".into(),parts.headers.get("content-type").and_then(|v|v.to_str().ok()).unwrap_or("").into());
                                    env.insert("CONTENT_LENGTH".into(),bytes.len().to_string());
                                    if let Some(v)=parts.headers.get("git-protocol"){env.insert("HTTP_GIT_PROTOCOL".into(),v.to_str().unwrap().into());}
                                    let output=command(&backend,&[],&env,Some(bytes.to_vec())).await;
                                    assert!(output.status.success());
                                    let split=output.stdout.windows(4).position(|w|w==b"\r\n\r\n").unwrap();
                                    let headers=std::str::from_utf8(&output.stdout[..split]).unwrap();
                                    let mut response=Response::builder();
                                    for line in headers.split("\r\n") {
                                        let (name,value)=line.split_once(':').unwrap();
                                        if name.eq_ignore_ascii_case("status") {response=response.status(value.trim().split_whitespace().next().unwrap().parse::<u16>().unwrap());}
                                        else {response=response.header(name,value.trim());}
                                    }
                                    response.body(Full::new(Bytes::copy_from_slice(&output.stdout[split+4..]))).unwrap()
                                } else {
                                    let body=if parts.uri.path()=="/graphql" {graphql_response(&bytes,&creates).to_string()} else if parts.uri.path().ends_with("/issues") || parts.uri.path().ends_with("/pulls") {"[]".to_owned()}
                                    else if parts.uri.path().contains("/commits/") {format!("{{\"sha\":\"{commit}\"}}")}
                                    else {"{\"id\":1,\"full_name\":\"fixture/repo\",\"private\":true,\"default_branch\":\"main\"}".into()};
                                    Response::builder().header("content-type","application/json").body(Full::new(Bytes::from(body))).unwrap()
                                };
                                Ok::<_,Infallible>(response)
                            }
                        });
                        let _=hyper::server::conn::http1::Builder::new().keep_alive(false).serve_connection(TokioIo::new(tls),handler).await;
                    });
                }
            }
        }
        owned.shutdown().await;
    }));

    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let firewall_address = listener.local_addr().unwrap();
    let mut firewall = Firewall::new(
        Repository::new("fixture", "repo", &commit).unwrap(),
        down_server,
        limits(),
    )
    .unwrap();
    firewall.admission = admission::Source::Fixture {
        endpoint,
        trust: up_trust,
        deadline: Instant::now() + Duration::from_secs(60),
        request_deadline: None,
    };
    let firewall = Arc::new(firewall);
    let mut firewall_stop = stop.clone();
    tasks.push(tokio::spawn(async move {
        let mut owned=tokio::task::JoinSet::new();
        loop {tokio::select!{
            _=firewall_stop.changed()=>break,
            accepted=listener.accept()=>{let(socket,_)=accepted.unwrap();let f=firewall.clone();owned.spawn(async move {f.serve(socket).await});}
        }}
        owned.shutdown().await;
    }));
    // This test-only router accepts only the two exact CONNECT authorities and
    // always dials the fixed loopback firewall. It is not a product proxy path.
    let proxy = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let proxy_url = format!("http://{}", proxy.local_addr().unwrap());
    let mut proxy_stop = stop.clone();
    tasks.push(tokio::spawn(async move {
        let mut owned=tokio::task::JoinSet::new();
        loop{tokio::select!{
            _=proxy_stop.changed()=>break,
            accepted=proxy.accept()=>{let(mut socket,_)=accepted.unwrap();owned.spawn(async move{
                let mut header=Vec::new();let mut byte=[0];
                while !header.ends_with(b"\r\n\r\n") && header.len()<8192 {if socket.read_exact(&mut byte).await.is_err(){return;}header.push(byte[0]);}
                let first=std::str::from_utf8(&header).unwrap().lines().next().unwrap();
                assert!(matches!(first,"CONNECT github.com:443 HTTP/1.1"|"CONNECT api.github.com:443 HTTP/1.1"));
                let mut target=TcpStream::connect(firewall_address).await.unwrap();socket.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n").await.unwrap();
                let _=tokio::io::copy_bidirectional(&mut socket,&mut target).await;
            });}
        }}owned.shutdown().await;
    }));
    let mut native = base.clone();
    for (name, value) in [
        ("HTTPS_PROXY", proxy_url.as_str()),
        ("https_proxy", proxy_url.as_str()),
        ("GIT_SSL_CAINFO", ca.to_str().unwrap()),
        ("SSL_CERT_FILE", ca.to_str().unwrap()),
        ("GH_TOKEN", "synthetic-native"),
        ("GH_PROMPT_DISABLED", "1"),
        ("GIT_CONFIG_COUNT", "3"),
        ("GIT_CONFIG_KEY_0", "http.extraHeader"),
        (
            "GIT_CONFIG_VALUE_0",
            "Authorization: Basic eC1hY2Nlc3MtdG9rZW46c3ludGhldGljLW5hdGl2ZQ==",
        ),
        ("GIT_CONFIG_KEY_1", "http.version"),
        ("GIT_CONFIG_VALUE_1", "HTTP/1.1"),
        ("GIT_CONFIG_KEY_2", "http.followRedirects"),
        ("GIT_CONFIG_VALUE_2", "false"),
    ] {
        native.insert(name.into(), value.into());
    }
    success(
        &git,
        &[
            "clone",
            "--no-checkout",
            "--no-recurse-submodules",
            "https://github.com/fixture/repo.git",
            checkout.to_str().unwrap(),
        ],
        &native,
    )
    .await;
    success(
        &git,
        &["-C", checkout.to_str().unwrap(), "fetch", "origin", &commit],
        &native,
    )
    .await;
    success(
        &git,
        &[
            "-C",
            checkout.to_str().unwrap(),
            "checkout",
            "--detach",
            &commit,
        ],
        &native,
    )
    .await;
    assert_eq!(
        std::fs::read_to_string(checkout.join("file.txt")).unwrap(),
        "controlled native graph\n"
    );
    success(
        &git,
        &[
            "-C",
            checkout.to_str().unwrap(),
            "push",
            "origin",
            &format!("{commit}:refs/heads/native-test"),
        ],
        &native,
    )
    .await;
    assert_eq!(
        success(
            &git,
            &[
                "--git-dir",
                bare.to_str().unwrap(),
                "rev-parse",
                "refs/heads/native-test"
            ],
            &base
        )
        .await
        .trim(),
        commit
    );
    for route in [
        "repos/fixture/repo".into(),
        format!("repos/fixture/repo/commits/{commit}"),
        "repos/fixture/repo/issues?state=open&per_page=20".into(),
        "repos/fixture/repo/pulls?state=open&per_page=20".into(),
    ] {
        let output = success(
            &gh,
            &[
                "api",
                "--hostname",
                "github.com",
                "--method",
                "GET",
                &route,
                "-H",
                "X-GitHub-Api-Version: 2026-03-10",
            ],
            &native,
        )
        .await;
        let value: serde_json::Value = serde_json::from_str(&output).unwrap();
        if route.contains("/commits/") {
            assert_eq!(value["sha"], commit);
        } else if route.contains('?') {
            assert_eq!(value, serde_json::json!([]));
        } else {
            assert_eq!(value["id"], 1);
            assert_eq!(value["full_name"], "fixture/repo");
            assert_eq!(value["private"], true);
            assert_eq!(value["default_branch"], "main");
        }
    }
    // Execute the actual pinned G07–G11 command shapes. These are compatibility
    // checks of transport and native clients, not proofs of provider permission.
    for (index, args) in [
        vec![
            "repo",
            "view",
            "github.com/fixture/repo",
            "--json",
            "nameWithOwner,url,isPrivate,defaultBranchRef",
        ],
        vec![
            "issue",
            "list",
            "--repo",
            "github.com/fixture/repo",
            "--state",
            "open",
            "--limit",
            "20",
            "--json",
            "number,title,state,url",
        ],
        vec![
            "issue",
            "view",
            "7",
            "--repo",
            "github.com/fixture/repo",
            "--json",
            "number,title,state,url,body",
        ],
        vec![
            "pr",
            "view",
            "9",
            "--repo",
            "github.com/fixture/repo",
            "--json",
            "number,title,state,url,isDraft,baseRefName,headRefName",
        ],
    ]
    .into_iter()
    .enumerate()
    {
        let output = success(&gh, &args, &native).await;
        let value: serde_json::Value = serde_json::from_str(&output).unwrap();
        match index {
            0 => {
                assert_eq!(value["nameWithOwner"], "fixture/repo");
                assert_eq!(value["url"], "https://github.com/fixture/repo");
                assert_eq!(value["isPrivate"], true);
                assert_eq!(value["defaultBranchRef"]["name"], "main");
            }
            1 => {
                let issues = value.as_array().unwrap();
                assert_eq!(issues.len(), 1);
                assert_eq!(issues[0]["number"], 7);
                assert_eq!(issues[0]["title"], "Native fixture issue");
                assert_eq!(issues[0]["state"], "OPEN");
                assert_eq!(issues[0]["url"], "https://github.com/fixture/repo/issues/7");
            }
            2 => {
                assert_eq!(value["number"], 7);
                assert_eq!(value["title"], "Native fixture issue");
                assert_eq!(value["state"], "OPEN");
                assert_eq!(value["url"], "https://github.com/fixture/repo/issues/7");
                assert_eq!(value["body"], "Selected native issue body");
            }
            3 => {
                assert_eq!(value["number"], 9);
                assert_eq!(value["title"], "Existing fixture PR");
                assert_eq!(value["state"], "OPEN");
                assert_eq!(value["url"], "https://github.com/fixture/repo/pull/9");
                assert_eq!(value["isDraft"], true);
                assert_eq!(value["baseRefName"], "main");
                assert_eq!(value["headRefName"], "existing");
            }
            _ => unreachable!(),
        }
    }
    let pr_body = home.join("pr-body.txt");
    std::fs::write(&pr_body, "Controlled native draft body\n").unwrap();
    let created = success(
        &gh,
        &[
            "pr",
            "create",
            "--repo",
            "github.com/fixture/repo",
            "--base",
            "main",
            "--head",
            "native-test",
            "--draft",
            "--title",
            "Controlled native draft",
            "--body-file",
            pr_body.to_str().unwrap(),
            "--no-maintainer-edit",
        ],
        &native,
    )
    .await;
    assert_eq!(created.trim(), "https://github.com/fixture/repo/pull/10");
    assert_eq!(creates.load(Ordering::SeqCst), 1);
    shutdown.send(true).unwrap();
    for task in tasks {
        timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap();
    }
    let paths = calls.lock().unwrap();
    assert!(paths.iter().any(|p| p.ends_with("/git-upload-pack")));
    assert_eq!(
        paths
            .iter()
            .filter(|p| p.ends_with("/git-receive-pack"))
            .count(),
        1
    );
    assert!(paths
        .iter()
        .any(|p| p.ends_with("/pulls?state=open&per_page=20")));
    // Keep the small newly owned graph as private verification evidence. It
    // contains synthetic content only and no token in remote URLs/config.
    let config = std::fs::read_to_string(checkout.join(".git/config")).unwrap();
    assert!(!config.contains("synthetic-native"));
}
