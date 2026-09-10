use crate::Refusal;
use ::http::{Method, Uri};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    Git,
    Api,
}
impl Origin {
    pub fn hostname(self) -> &'static str {
        match self {
            Self::Git => "github.com",
            Self::Api => "api.github.com",
        }
    }
    pub(crate) fn from_host(host: &str) -> Result<Self, Refusal> {
        match host {
            "github.com" => Ok(Self::Git),
            "api.github.com" => Ok(Self::Api),
            _ => Err(Refusal::Unsupported),
        }
    }
}

/// Exact retained repository/commit input. This validates syntax, not a grant.
pub struct Repository {
    path: String,
    commit: String,
}
impl Repository {
    pub fn new(owner: &str, name: &str, commit: &str) -> Result<Self, Refusal> {
        let component = |s: &str| {
            !s.is_empty()
                && s.len() <= 255
                && s.as_bytes()[0].is_ascii_alphanumeric()
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
                && s != "."
                && s != ".."
        };
        if !component(owner)
            || !component(name)
            || commit.len() != 40
            || !commit
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(Refusal::Configuration);
        }
        Ok(Self {
            path: format!("{owner}/{name}"),
            commit: commit.into(),
        })
    }

    pub(crate) fn allows(&self, origin: Origin, method: &Method, uri: &Uri) -> Result<(), Refusal> {
        if uri.scheme().is_some() || uri.authority().is_some() {
            return Err(Refusal::Unsupported);
        }
        let p = uri.path();
        let q = uri.query();
        let allowed = match origin {
            Origin::Git => {
                let base = format!("/{}.git", self.path);
                (method == Method::GET
                    && p == format!("{base}/info/refs")
                    && matches!(
                        q,
                        Some("service=git-upload-pack" | "service=git-receive-pack")
                    ))
                    || (method == Method::POST
                        && q.is_none()
                        && (p == format!("{base}/git-upload-pack")
                            || p == format!("{base}/git-receive-pack")))
            }
            Origin::Api => {
                let base = format!("/repos/{}", self.path);
                (method == Method::POST && p == "/graphql" && q.is_none())
                    || (method == Method::GET
                        && ((q.is_none()
                            && (p == base || p == format!("{base}/commits/{}", self.commit)))
                            || (q == Some("state=open&per_page=20")
                                && (p == format!("{base}/issues")
                                    || p == format!("{base}/pulls")))))
            }
        };
        // Native GraphQL is bounded by the delivered token/provider scope. This
        // route does not claim per-command or field-level human authorization.
        if allowed {
            Ok(())
        } else {
            Err(Refusal::Unsupported)
        }
    }
}
