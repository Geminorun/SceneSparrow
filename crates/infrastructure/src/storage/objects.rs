use super::{Result, db, hash};
use crate::SqliteProjectRepository;
use scenesparrow_domain::manuscript::ManuscriptError;
use std::fs::File;
#[cfg(not(target_os = "linux"))]
use std::io::Write;

impl SqliteProjectRepository {
    pub(crate) fn object(&self, bytes: &[u8]) -> Result<String> {
        #[cfg(target_os = "linux")]
        {
            let digest = hash(bytes);
            let parent =
                crate::open_source::physical::Parent::open(&self.directory, "objects/member")
                    .map_err(management_error)?;
            if parent
                .open_file(&digest)
                .map_err(management_error)?
                .is_some()
            {
                if self
                    .verify_object_stream(&digest)
                    .map_err(management_error)?
                    != bytes.len() as u64
                {
                    return Err(ManuscriptError("STORAGE_UNAVAILABLE", None));
                }
                return Ok(digest);
            }
            self.object_stream(&mut std::io::Cursor::new(bytes), bytes.len() as u64)
                .map(|p| p.0)
                .map_err(management_error)
        }
        #[cfg(not(target_os = "linux"))]
        {
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
    }
    pub(crate) fn read_object(&self, digest: &str) -> Result<Vec<u8>> {
        if digest.len() != 64
            || !digest
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return Err(ManuscriptError("STORAGE_UNAVAILABLE", None));
        }
        #[cfg(target_os = "linux")]
        {
            let parent = crate::open_source::physical::Parent::open(
                &self.directory,
                &format!("objects/{digest}"),
            )?;
            let (file, _) = parent
                .open_file(digest)?
                .ok_or(ManuscriptError("STORAGE_UNAVAILABLE", None))?;
            let bytes = db(crate::storage::operation::read(
                &self.directory.join("objects").join(digest),
                digest,
                file,
            ))?;
            parent.verify()?;
            Ok(bytes)
        }
        #[cfg(not(target_os = "linux"))]
        db(crate::storage::operation::read(
            &self.directory.join("objects").join(digest),
            digest,
            open_regular(&self.directory.join("objects").join(digest))?,
        ))
    }
}

/// Fixed-buffer verification used for creative binaries, retention and backups.
/// No operation-scoped whole-object cache is populated by these paths.
pub(crate) fn stream_copy(
    input: &mut impl std::io::Read,
    output: &mut impl std::io::Write,
    limit: u64,
) -> Result<(String, u64)> {
    stream_copy_with_buffer(input, output, limit, &mut [0u8; 64 * 1024])
}
pub(crate) fn stream_copy_with_buffer(
    input: &mut impl std::io::Read,
    output: &mut impl std::io::Write,
    limit: u64,
    buffer: &mut [u8],
) -> Result<(String, u64)> {
    use sha2::{Digest, Sha256};
    if buffer.is_empty() {
        return Err(ManuscriptError("INVALID_REQUEST", None));
    }
    let mut hasher = Sha256::new();
    let mut size = 0u64;
    loop {
        let n = db(input.read(buffer))?;
        if n == 0 {
            break;
        }
        size = size
            .checked_add(n as u64)
            .filter(|n| *n <= limit)
            .ok_or(ManuscriptError("GRAPH_BUDGET_EXCEEDED", None))?;
        hasher.update(&buffer[..n]);
        db(output.write_all(&buffer[..n]))?;
    }
    Ok((format!("{:x}", hasher.finalize()), size))
}
pub(crate) fn open_regular(path: &std::path::Path) -> Result<File> {
    let mut options = File::options();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = db(options.open(path))?;
    if !db(file.metadata())?.is_file() {
        return Err(ManuscriptError("SOURCE_PATH_UNSAFE", None));
    }
    Ok(file)
}
impl SqliteProjectRepository {
    pub(crate) fn object_stream(
        &self,
        input: &mut impl std::io::Read,
        limit: u64,
    ) -> Result<(String, u64)> {
        #[cfg(target_os = "linux")]
        {
            let parent =
                crate::open_source::physical::Parent::open(&self.directory, "staging/member")
                    .map_err(management_error)?;
            let objects =
                crate::open_source::physical::Parent::open(&self.directory, "objects/member")
                    .map_err(management_error)?;
            let temporary = format!(".object-stage-{}", uuid::Uuid::new_v4());
            (|| {
                let mut output = parent.create_file(&temporary)?;
                let (hash, size) = stream_copy(input, &mut output, limit)?;
                db(output.sync_all())?;
                #[cfg(test)]
                self.source_cut(&format!("object-stage-written:{hash}"))?;
                parent.sync()?;
                verify_written_object(&parent, &temporary, &output, &hash, size)?;
                if objects.open_file(&hash)?.is_some() {
                    if self.verify_object_stream(&hash)? != size {
                        return Err(ManuscriptError("STORAGE_UNAVAILABLE", None));
                    }
                    // Only a verified slot belonging to the held writer can be
                    // discarded. Failed writes retain potentially external bytes.
                    verify_written_object(&parent, &temporary, &output, &hash, size)?;
                    parent.unlink(&temporary)?;
                } else {
                    if let Err(error) = parent.rename_into(&temporary, &objects, &hash) {
                        // A concurrent preparation/source save may publish the same
                        // hash. Deduplicate only verified bytes and our held stage.
                        if objects.open_file(&hash)?.is_none()
                            || self.verify_object_stream(&hash)? != size
                        {
                            return Err(error);
                        }
                        verify_written_object(&parent, &temporary, &output, &hash, size)?;
                        parent.unlink(&temporary)?;
                        return Ok((hash, size));
                    }
                    #[cfg(test)]
                    self.source_cut(&format!("object-stage-promoted:{hash}"))?;
                    verify_written_object(&objects, &hash, &output, &hash, size)?;
                }
                Ok((hash, size))
            })()
            .map_err(management_error)
        }
        #[cfg(not(target_os = "linux"))]
        {
            let staging = self
                .directory
                .join("staging")
                .join(uuid::Uuid::new_v4().to_string());
            let result = (|| {
                let mut output = db(File::options().write(true).create_new(true).open(&staging))?;
                let (digest, size) = stream_copy(input, &mut output, limit)?;
                db(output.sync_all())?;
                drop(output);
                let target = self.directory.join("objects").join(&digest);
                if target.exists() {
                    if self.verify_object_stream(&digest)? != size {
                        return Err(ManuscriptError("STORAGE_UNAVAILABLE", None));
                    }
                } else {
                    // A hard link is only between two core-owned immutable slots;
                    // mutable creative files are always copied into fresh inodes.
                    db(std::fs::hard_link(&staging, &target))?;
                    #[cfg(unix)]
                    db(File::open(self.directory.join("objects")).and_then(|f| f.sync_all()))?;
                }
                Ok((digest, size))
            })();
            let _ = std::fs::remove_file(&staging);
            result
        }
    }
    pub(crate) fn stream_object_to(
        &self,
        digest: &str,
        output: &mut impl std::io::Write,
    ) -> Result<u64> {
        if digest.len() != 64
            || !digest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(ManuscriptError("STORAGE_UNAVAILABLE", None));
        }
        #[cfg(target_os = "linux")]
        let (mut input, _identity) = {
            let parent = crate::open_source::physical::Parent::open(
                &self.directory,
                &format!("objects/{digest}"),
            )?;
            let file = parent
                .open_file(digest)?
                .ok_or(ManuscriptError("STORAGE_UNAVAILABLE", None))?;
            parent.verify()?;
            file
        };
        #[cfg(not(target_os = "linux"))]
        let mut input = open_regular(&self.directory.join("objects").join(digest))?;
        let before = db(input.metadata())?;
        let (actual, size) = stream_copy(&mut input, output, u64::MAX)?;
        let after = db(input.metadata())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if before.ctime() != after.ctime() || before.ctime_nsec() != after.ctime_nsec() {
                return Err(ManuscriptError("STORAGE_UNAVAILABLE", None));
            }
        }
        if actual != digest
            || before.len() != size
            || after.len() != size
            || before.modified().ok() != after.modified().ok()
        {
            return Err(ManuscriptError("STORAGE_UNAVAILABLE", None));
        }
        #[cfg(test)]
        counted_stream(digest, size);
        Ok(size)
    }
    pub(crate) fn verify_object_stream(&self, digest: &str) -> Result<u64> {
        self.stream_object_to(digest, &mut std::io::sink())
    }
}

#[cfg(target_os = "linux")]
pub(crate) fn verify_written_object(
    parent: &crate::open_source::physical::Parent,
    name: &str,
    written: &File,
    digest: &str,
    size: u64,
) -> Result<()> {
    use std::os::unix::fs::MetadataExt;
    let unavailable = || ManuscriptError("STORAGE_UNAVAILABLE", None);
    let (mut member, identity) = parent.open_file(name)?.ok_or_else(unavailable)?;
    let owner = db(written.metadata())?;
    let before = db(member.metadata())?;
    if owner.dev() != before.dev() || owner.ino() != before.ino() || owner.nlink() != 1 {
        return Err(unavailable());
    }
    let actual = stream_copy(&mut member, &mut std::io::sink(), size).map_err(|_| unavailable())?;
    let after = db(member.metadata())?;
    let (_, named_identity) = parent.open_file(name)?.ok_or_else(unavailable)?;
    if actual != (digest.into(), size)
        || before.len() != size
        || after.len() != size
        || before.mtime() != after.mtime()
        || before.mtime_nsec() != after.mtime_nsec()
        || before.ctime() != after.ctime()
        || before.ctime_nsec() != after.ctime_nsec()
        || identity != named_identity
    {
        return Err(unavailable());
    }
    parent.verify()
}

impl SqliteProjectRepository {
    pub(crate) fn read_bounded_object(&self, digest: &str, limit: u64) -> Result<Vec<u8>> {
        let size = {
            #[cfg(target_os = "linux")]
            {
                let parent = crate::open_source::physical::Parent::open(
                    &self.directory,
                    &format!("objects/{digest}"),
                )?;
                let (file, _) = parent
                    .open_file(digest)?
                    .ok_or(ManuscriptError("STORAGE_UNAVAILABLE", None))?;
                db(file.metadata())?.len()
            }
            #[cfg(not(target_os = "linux"))]
            {
                db(open_regular(&self.directory.join("objects").join(digest))?.metadata())?.len()
            }
        };
        if size > limit {
            return Err(ManuscriptError("GRAPH_BUDGET_EXCEEDED", None));
        }
        let mut bytes = Vec::new();
        struct Bounded<'a> {
            bytes: &'a mut Vec<u8>,
            limit: u64,
        }
        impl std::io::Write for Bounded<'_> {
            fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
                if (self.bytes.len() as u64)
                    .checked_add(data.len() as u64)
                    .is_none_or(|n| n > self.limit)
                {
                    return Err(std::io::Error::other("bounded control object exceeded"));
                }
                self.bytes.extend_from_slice(data);
                Ok(data.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        self.stream_object_to(
            digest,
            &mut Bounded {
                bytes: &mut bytes,
                limit,
            },
        )?;
        if bytes.len() as u64 > limit || hash(&bytes) != digest {
            return Err(ManuscriptError("STORAGE_UNAVAILABLE", None));
        }
        Ok(bytes)
    }
}

fn management_error(error: ManuscriptError) -> ManuscriptError {
    if error.0 == "GRAPH_BUDGET_EXCEEDED" {
        error
    } else {
        ManuscriptError("STORAGE_UNAVAILABLE", None)
    }
}

#[cfg(test)]
thread_local! {pub(crate) static STREAMED:std::cell::RefCell<std::collections::BTreeMap<String,u64>>=const{std::cell::RefCell::new(std::collections::BTreeMap::new())};}
#[cfg(test)]
pub(crate) fn counted_stream(hash: &str, size: u64) {
    STREAMED.with(|reads| {
        *reads.borrow_mut().entry(hash.into()).or_default() += size;
    });
}
