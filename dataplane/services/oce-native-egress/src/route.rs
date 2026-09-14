use crate::Refusal;

/// Exact retained repository/commit input. This validates syntax, not a grant.
pub struct Repository {
    path: String,
}
impl Repository {
    pub(crate) fn components(&self) -> (&str, &str) {
        self.path
            .split_once('/')
            .expect("validated repository path")
    }
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
        })
    }
}
