use crate::manuscript::hash;
use scenesparrow_domain::{ai::*, contracts::*};
fn safe<T>(result: std::result::Result<T, impl std::fmt::Debug>) -> Result<T> {
    result.map_err(|_| AiError("STORAGE_UNAVAILABLE"))
}
pub mod settings;

pub mod actions;
mod execution;
#[cfg(test)]
mod tests;
pub mod worker;
