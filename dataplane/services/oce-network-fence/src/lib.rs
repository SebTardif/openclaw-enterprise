//! Closed node attachment mechanisms. No operation authorizes an endpoint or
//! establishes an original runtime effect, grant, or effective profile.
#![cfg(target_os = "linux")]

mod activation;
pub mod cni;
pub mod ipc;
mod kernel;
pub mod linux;
pub mod owner;
mod tool;

#[derive(Debug)]
pub enum Error {
    Invalid(&'static str),
    Linux(String),
    Unavailable(&'static str),
    Unknown(&'static str),
    Io(std::io::Error),
}
impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(reason) | Self::Unavailable(reason) | Self::Unknown(reason) => {
                f.write_str(reason)
            }
            Self::Linux(reason) => f.write_str(reason),
            Self::Io(error) => error.fmt(f),
        }
    }
}
impl std::error::Error for Error {}
