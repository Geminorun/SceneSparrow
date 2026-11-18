use super::{Result, db, hash};
use crate::SqliteProjectRepository;
use scenesparrow_domain::manuscript::ManuscriptError;
use std::{fs::File, io::Write};

impl SqliteProjectRepository {
    pub(crate) fn object(&self, bytes: &[u8]) -> Result<String> {
        let digest = hash(bytes);
        let path = self.directory.join("objects").join(&digest);
        if path.exists() {
            if !db(std::fs::symlink_metadata(&path))?.is_file() {
                return Err(ManuscriptError("STORAGE_UNAVAILABLE", None));
            }
            if db(std::fs::read(&path))? != bytes {
                return Err(ManuscriptError("STORAGE_UNAVAILABLE", None));
            }
            return Ok(digest);
        }
        let staging = self
            .directory
            .join("staging")
            .join(uuid::Uuid::new_v4().to_string());
        let mut file = db(File::options().create_new(true).write(true).open(&staging))?;
        db(file.write_all(bytes))?;
        db(file.sync_all())?;
        drop(file);
        db(std::fs::rename(&staging, &path))?;
        #[cfg(unix)]
        db(File::open(self.directory.join("objects")).and_then(|f| f.sync_all()))?;
        Ok(digest)
    }
    pub(crate) fn read_object(&self, digest: &str) -> Result<Vec<u8>> {
        if digest.len() != 64
            || !digest
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return Err(ManuscriptError("STORAGE_UNAVAILABLE", None));
        }
        db(crate::storage::operation::read(
            &self.directory.join("objects").join(digest),
            digest,
        ))
    }
}
