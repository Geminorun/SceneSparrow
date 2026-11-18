mod objects;
pub(crate) mod operation;
mod retention;

use scenesparrow_domain::manuscript::ManuscriptError;
use sha2::{Digest, Sha256};

pub(crate) type Result<T> = std::result::Result<T, ManuscriptError>;
pub(crate) fn db<T>(r: std::result::Result<T, impl std::fmt::Debug>) -> Result<T> {
    r.map_err(|_| ManuscriptError("STORAGE_UNAVAILABLE", None))
}
pub(crate) fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
