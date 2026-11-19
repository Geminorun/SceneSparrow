use super::*;
use rusqlite::params;
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Intake {
    pub(super) source: String,
    pub(super) view: PackageIntakeView,
    #[serde(default)]
    pub(super) stamp: Option<Stamp>,
}
#[derive(Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Stamp {
    length: u64,
    device: u64,
    inode: u64,
    modified: i64,
    modified_nanos: i64,
    changed: i64,
    changed_nanos: i64,
}
impl Stamp {
    pub(super) fn read(f: &File) -> Result<Self> {
        let m = db(f.metadata())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            Ok(Self {
                length: m.len(),
                device: m.dev(),
                inode: m.ino(),
                modified: m.mtime(),
                modified_nanos: m.mtime_nsec(),
                changed: m.ctime(),
                changed_nanos: m.ctime_nsec(),
            })
        }
        #[cfg(not(unix))]
        {
            let _ = m;
            Err(fail("SOURCE_CAPABILITY_UNSUPPORTED"))
        }
    }
}
/// A continuously held immutable file; network backpressure never owns the writer.
pub struct PackageArchiveReader {
    file: File,
    view: PackageArchiveView,
    _lease: journal::Lease,
    _active: ActiveReader,
}
struct ActiveReader {
    workers: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    closing: std::sync::Arc<std::sync::atomic::AtomicBool>,
}
impl Drop for ActiveReader {
    fn drop(&mut self) {
        self.workers
            .fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
    }
}
impl PackageArchiveReader {
    pub fn cancellation_flag(&self) -> std::sync::Arc<std::sync::atomic::AtomicBool> {
        self._active.closing.clone()
    }
    pub fn view(&self) -> &PackageArchiveView {
        &self.view
    }
    pub fn stream(mut self, out: &mut impl Write) -> Result<u64> {
        struct Checked<'a> {
            file: &'a mut File,
            closing: &'a std::sync::atomic::AtomicBool,
        }
        impl Read for Checked<'_> {
            fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
                if self.closing.load(std::sync::atomic::Ordering::Acquire) {
                    return Err(std::io::Error::other("project closing"));
                }
                self.file.read(b)
            }
        }
        let actual = crate::storage::objects::stream_copy(
            &mut Checked {
                file: &mut self.file,
                closing: &self._active.closing,
            },
            out,
            self.view.size as u64,
        )?;
        if actual != (self.view.hash, self.view.size as u64) {
            return Err(fail("PACKAGE_ARCHIVE_INVALID"));
        }
        Ok(actual.1)
    }
}
impl ProjectTransferStore {
    pub(super) fn intake_scoped(&self, r: &SqliteProjectRepository, id: &str) -> Result<Intake> {
        uuid(id)?;
        let mut intake: Intake = journal::read(&self.package_path("intake", id))?;
        r.source_cut("package-intake-observed")?;
        if intake.source != r.migration_source_identity()? {
            return Err(fail("PACKAGE_NOT_FOUND"));
        }
        let retained = {
            let c = db(r.connection.lock())?;
            db(c.query_row("SELECT EXISTS(SELECT 1 FROM package_intake_leases l JOIN work_candidates c ON c.id=l.candidate_id WHERE l.intake_id=?1 AND (c.disposition='pending' OR l.retain_until>?2))",params![id,now()],|r|r.get::<_,bool>(0)))?
        };
        if intake.view.expires_at < now()
            && !retained
            && matches!(
                intake.view.state,
                PackageIntakeViewState::Open
                    | PackageIntakeViewState::Sealed
                    | PackageIntakeViewState::Cancelled
            )
        {
            intake.view.state = PackageIntakeViewState::Expired;
            // Expiry is a read-only projection. A poll may have observed an old
            // record while a leased writer renews or seals the current record.
        }
        Ok(intake)
    }
    pub fn create_package_intake(
        &self,
        r: &SqliteProjectRepository,
        request: &PackageIntakeRequest,
    ) -> Result<PackageIntakeView> {
        uuid(&request.request_id)?;
        let digest = hash(&db(serde_json::to_vec(request))?);
        let source = r.migration_source_identity()?;
        let receipt = self.package_path("intake-request", &request.request_id);
        let _lock = self.journal_lock()?;
        if let Some(old) = self.original(&receipt, &digest, &source)? {
            return Ok(old);
        }
        let mut new = None;
        let outcome = (|| {
            Self::check_owner(r, &request.owner_project_id)?;
            if !sha(&request.hash)
                || request.length <= 0
                || request.length as u64 > Limits::default().compressed
                || request.filename.is_empty()
                || request.filename.len() > 120
                || request
                    .filename
                    .chars()
                    .any(|c| c.is_control() || matches!(c, '/' | '\\' | '"'))
            {
                return Err(fail("INVALID_REQUEST"));
            }
            let view = PackageIntakeView {
                intake_id: request.request_id.clone(),
                owner_project_id: request.owner_project_id.clone(),
                filename: request.filename.clone(),
                length: request.length,
                hash: request.hash.clone(),
                received_bytes: 0,
                revision: 1,
                state: PackageIntakeViewState::Open,
                expires_at: now() + INTAKE_TTL,
            };
            new = Some(Intake {
                source: source.clone(),
                view: view.clone(),
                stamp: None,
            });
            Ok(view)
        })();
        let mut files = vec![(
            receipt,
            json(&Saved {
                digest,
                source,
                result: outcome.clone().map_err(|e| e.0.to_string()),
            })?,
        )];
        if let Some(intake) = new {
            files.push((
                self.package_path("intake", &request.request_id),
                json(&intake)?,
            ));
        }
        self.package_commit(self.index()?, files)?;
        outcome
    }
    pub fn package_intake(
        &self,
        r: &SqliteProjectRepository,
        id: &str,
    ) -> Result<PackageIntakeView> {
        self.intake_scoped(r, id).map(|i| i.view)
    }
    pub fn write_package_chunk(
        &self,
        r: &SqliteProjectRepository,
        request: &PackageChunkRequest,
        bytes: &[u8],
    ) -> Result<PackageChunkAck> {
        let _worker = r.worker_guard();
        uuid(&request.intake_id)?;
        if request.offset < 0
            || request.length <= 0
            || request.length as usize > MAX_CHUNK
            || request.length as usize != bytes.len()
            || !sha(&request.hash)
            || hash(bytes) != request.hash
        {
            return Err(fail("INVALID_REQUEST"));
        }
        let _lock = journal::lock(
            &self
                .directory
                .join(format!("package-intake-{}.lock", request.intake_id)),
        )?;
        {
            // Finish an older multi-file seal before loading this leased record.
            // The per-intake lease then excludes every fresh updater; no archive
            // write or fsync needs to retain the global journal lock.
            let _journal = self.journal_lock()?;
        }
        let mut intake = self.intake_scoped(r, &request.intake_id)?;
        r.source_cut("package-chunk-loaded")?;
        Self::check_owner(r, &request.owner_project_id)?;
        if intake.view.owner_project_id != request.owner_project_id {
            return Err(fail("PACKAGE_NOT_FOUND"));
        }
        let end = request
            .offset
            .checked_add(request.length)
            .ok_or(fail("INVALID_REQUEST"))?;
        if end > intake.view.length || request.offset > intake.view.received_bytes {
            return Err(fail("PACKAGE_CHUNK_CONFLICT"));
        }
        let p = Parent::open(
            &self.directory,
            &format!("intake-{}.zip", request.intake_id),
        )?;
        if request.offset < intake.view.received_bytes {
            if end > intake.view.received_bytes {
                return Err(fail("PACKAGE_CHUNK_CONFLICT"));
            }
            let (mut f, _) = p
                .open_file(&p.name)?
                .ok_or(fail("PACKAGE_CHUNK_CONFLICT"))?;
            db(f.seek(SeekFrom::Start(request.offset as u64)))?;
            let mut stored = vec![0; bytes.len()];
            db(f.read_exact(&mut stored))?;
            if stored != bytes {
                return Err(fail("PACKAGE_CHUNK_CONFLICT"));
            }
            if matches!(
                intake.view.state,
                PackageIntakeViewState::Open | PackageIntakeViewState::Sealed
            ) {
                intake.view.expires_at = now() + INTAKE_TTL;
                intake.view.revision += 1;
                journal::save(&self.package_path("intake", &request.intake_id), &intake)?;
            }
            return Ok(PackageChunkAck {
                intake_id: request.intake_id.clone(),
                offset: request.offset,
                length: request.length,
                hash: request.hash.clone(),
                acknowledged_end: end,
            });
        }
        if intake.view.state != PackageIntakeViewState::Open {
            return Err(fail("PACKAGE_INTAKE_CLOSED"));
        }
        let bound = p.bound_directory_path()?.join(&p.name);
        let mut f = if p.open_file(&p.name)?.is_some() {
            db(File::options()
                .read(true)
                .write(true)
                .custom_flags_no_follow()
                .open(&bound))?
        } else {
            p.create_file(&p.name)?
        };
        let size = db(f.metadata())?.len();
        if size == request.offset as u64 {
            db(f.seek(SeekFrom::Start(size)))?;
            db(f.write_all(bytes))?;
            db(f.sync_all())?;
            self.cut("package-chunk-flush")?;
        } else if size == end as u64 {
            db(f.seek(SeekFrom::Start(request.offset as u64)))?;
            let mut old = vec![0; bytes.len()];
            db(f.read_exact(&mut old))?;
            if old != bytes {
                return Err(fail("PACKAGE_CHUNK_CONFLICT"));
            }
        } else {
            return Err(fail("PACKAGE_CHUNK_CONFLICT"));
        }
        p.verify()?;
        intake.stamp = Some(Stamp::read(&f)?);
        intake.view.received_bytes = end;
        intake.view.revision += 1;
        intake.view.expires_at = now() + INTAKE_TTL;
        journal::save(&self.package_path("intake", &request.intake_id), &intake)?;
        self.cut("package-chunk-ack")?;
        Ok(PackageChunkAck {
            intake_id: request.intake_id.clone(),
            offset: request.offset,
            length: request.length,
            hash: request.hash.clone(),
            acknowledged_end: end,
        })
    }
    pub(super) fn seal_intake(&self, r: &SqliteProjectRepository, id: &str) -> Result<()> {
        let _lock = journal::lock(&self.directory.join(format!("package-intake-{id}.lock")))?;
        {
            let _journal = self.journal_lock()?;
        }
        let mut intake = self.intake_scoped(r, id)?;
        if intake.view.state == PackageIntakeViewState::Sealed {
            return Ok(());
        }
        if intake.view.state != PackageIntakeViewState::Open {
            return Err(fail("PACKAGE_INTAKE_CLOSED"));
        }
        if intake.view.received_bytes != intake.view.length {
            return Err(fail("PACKAGE_INTAKE_INCOMPLETE"));
        }
        // Hashing is the asynchronous inspection operation's first phase.
        intake.view.state = PackageIntakeViewState::Sealed;
        intake.view.revision += 1;
        intake.view.expires_at = now() + INTAKE_TTL;
        journal::save(&self.package_path("intake", id), &intake)
    }
    pub fn control_package_intake(
        &self,
        r: &SqliteProjectRepository,
        request: &PackageIntakeControlRequest,
    ) -> Result<PackageIntakeView> {
        uuid(&request.request_id)?;
        uuid(&request.intake_id)?;
        let digest = hash(&db(serde_json::to_vec(request))?);
        let source = r.migration_source_identity()?;
        let path = self.package_path("intake-control", &request.request_id);
        let _intake = journal::lock(
            &self
                .directory
                .join(format!("package-intake-{}.lock", request.intake_id)),
        )?;
        let _lock = self.journal_lock()?;
        if let Some(old) = self.original(&path, &digest, &source)? {
            return Ok(old);
        }
        let mut changed = None;
        let outcome = (|| {
            Self::check_owner(r, &request.owner_project_id)?;
            let mut intake = self.intake_scoped(r, &request.intake_id)?;
            if intake.view.owner_project_id != request.owner_project_id {
                return Err(fail("PACKAGE_NOT_FOUND"));
            }
            if intake.view.revision != request.expected_revision {
                return Err(fail("PACKAGE_REVISION_CONFLICT"));
            }
            if intake.view.state == PackageIntakeViewState::Sealed {
                return Err(fail("PACKAGE_INTAKE_CLOSED"));
            }
            intake.view.state = PackageIntakeViewState::Cancelled;
            intake.view.revision += 1;
            let view = intake.view.clone();
            changed = Some(intake);
            Ok(view)
        })();
        let mut files = vec![(
            path,
            json(&Saved {
                digest,
                source,
                result: outcome.clone().map_err(|e| e.0.to_string()),
            })?,
        )];
        if let Some(i) = changed {
            files.push((self.package_path("intake", &request.intake_id), json(&i)?));
        }
        self.package_commit(self.index()?, files)?;
        outcome
    }
    pub fn read_package_archive(
        &self,
        r: &SqliteProjectRepository,
        id: &str,
    ) -> Result<PackageArchiveReader> {
        if r.is_quiescing() {
            return Err(fail("PROJECT_CLOSING"));
        }
        let op = self.package_read(r, id)?;
        let view = op.view.archive.ok_or(fail("PACKAGE_NOT_FOUND"))?;
        if op.view.state != PackageOperationViewState::Succeeded {
            return Err(fail("PACKAGE_NOT_FOUND"));
        }
        if view.expires_at < now() {
            return Err(fail("PACKAGE_EXPIRED"));
        }
        let f = db(File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.directory.join(format!("package-reader-{id}.lock"))))?;
        db(f.try_lock_shared()).map_err(|_| fail("PACKAGE_REVISION_CONFLICT"))?;
        let lease = journal::Lease(f);
        let p = Parent::open(&self.directory, &format!("archive-{id}.zip"))?;
        let (file, _) = p.open_file(&p.name)?.ok_or(fail("PACKAGE_NOT_FOUND"))?;
        if db(file.metadata())?.len() != view.size as u64 {
            return Err(fail("PACKAGE_ARCHIVE_INVALID"));
        }
        p.verify()?;
        r.workers.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        let active = ActiveReader {
            workers: r.workers.clone(),
            closing: r.quiescing.clone(),
        };
        if r.is_quiescing() {
            return Err(fail("PROJECT_CLOSING"));
        }
        Ok(PackageArchiveReader {
            file,
            view,
            _lease: lease,
            _active: active,
        })
    }
}
trait NoFollow {
    fn custom_flags_no_follow(&mut self) -> &mut Self;
}
impl NoFollow for std::fs::OpenOptions {
    fn custom_flags_no_follow(&mut self) -> &mut Self {
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            self.custom_flags(libc::O_NOFOLLOW);
        }
        self
    }
}
