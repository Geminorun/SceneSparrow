//! Explicit legacy conversion and durable lifecycle receipts, outside project SQL.
mod conversion;
mod journal;
pub mod package;
use crate::storage::{Result, db, hash};
use crate::{SqliteProjectRepository, read_project};
pub use conversion::{MigrationPaths, inspect_legacy, migrate_legacy};
pub use journal::ProjectTransferStore;
use scenesparrow_domain::{
    contracts::*,
    manuscript::{self, ManuscriptError},
};
use std::path::{Path, PathBuf};
fn fail(code: &'static str) -> ManuscriptError {
    ManuscriptError(code, None)
}
fn uuid(id: &str) -> Result<()> {
    if manuscript::uuid4(id) {
        Ok(())
    } else {
        Err(fail("INVALID_REQUEST"))
    }
}
fn sha(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn identity(path: &Path) -> Result<String> {
    let path = db(std::fs::canonicalize(path))?;
    Ok(hash(
        format!("{}:{:?}", path.display(), db(file_id::get_file_id(&path))?).as_bytes(),
    ))
}
impl SqliteProjectRepository {
    pub fn inspect_legacy_migration(&self) -> Result<LegacyMigrationInspection> {
        if self.creative_root.is_some() {
            return Err(fail("MIGRATION_LEGACY_REQUIRED"));
        }
        inspect_legacy(&self.directory)
    }
    pub fn migration_source_identity(&self) -> Result<String> {
        identity(&self.directory)
    }
    pub fn migration_source_directory(&self) -> &Path {
        &self.directory
    }
}
#[cfg(test)]
pub(crate) mod tests;
