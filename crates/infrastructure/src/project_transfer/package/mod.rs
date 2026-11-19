//! Complete packages share A's app-data journal, admission bound and worker lease.
use super::journal::{self, Active, Saved};
use super::*;
use crate::open_source::physical::Parent;
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    time::{SystemTime, UNIX_EPOCH},
};
pub mod archive;
mod capture;
pub(crate) use capture::copy_member;
mod expiry;
mod intake;
mod native_save;
mod pins;
mod restore;
use archive::{Descriptor, Inspected, Limits, Member};
use capture::*;
pub use intake::PackageArchiveReader;
const CACHE_TTL: i64 = 7 * 24 * 60 * 60 * 1000;
const INTAKE_TTL: i64 = 24 * 60 * 60 * 1000;
pub const MAX_CHUNK: usize = 1024 * 1024;
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}
fn large_read<T: serde::de::DeserializeOwned>(p: &Path, limit: u64) -> Result<T> {
    let mut f = crate::storage::objects::open_regular(p)?;
    if db(f.metadata())?.len() > limit {
        return Err(fail("PACKAGE_SIZE_LIMIT"));
    }
    let mut b = vec![];
    db(std::io::Read::by_ref(&mut f)
        .take(limit + 1)
        .read_to_end(&mut b))?;
    if b.len() as u64 > limit {
        return Err(fail("PACKAGE_SIZE_LIMIT"));
    }
    db(serde_json::from_slice(&b))
}
fn large_save<T: serde::Serialize>(path: &Path, value: &T, limit: u64) -> Result<()> {
    struct Bounded<W> {
        inner: W,
        remaining: u64,
        exceeded: bool,
    }
    impl<W: Write> Write for Bounded<W> {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() as u64 > self.remaining {
                self.exceeded = true;
                return Err(std::io::Error::other("package record size limit"));
            }
            let written = self.inner.write(bytes)?;
            self.remaining -= written as u64;
            Ok(written)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            self.inner.flush()
        }
    }
    let mut record = db(atomic_write_file::AtomicWriteFile::open(path))?;
    {
        let mut writer = Bounded {
            inner: std::io::BufWriter::with_capacity(64 * 1024, &mut record),
            remaining: limit,
            exceeded: false,
        };
        let result = serde_json::to_writer(&mut writer, value);
        if writer.exceeded {
            return Err(fail("PACKAGE_SIZE_LIMIT"));
        }
        db(result)?;
        db(writer.flush())?;
    }
    db(record.commit())?;
    sync(path.parent().ok_or(fail("STORAGE_UNAVAILABLE"))?)
}
fn json<T: serde::Serialize>(v: &T) -> Result<serde_json::Value> {
    db(serde_json::to_value(v))
}
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
enum Request {
    Export(ProjectPackageExportRequest),
    Work(WorkCopyPackageExportRequest),
    Inspect(PackageInspectionRequest),
    Restore(PackageRestoreRequest),
    Return(PackageReturnRequest),
}
impl Request {
    fn id(&self) -> &str {
        match self {
            Self::Export(r) => &r.request_id,
            Self::Work(r) => &r.request_id,
            Self::Inspect(r) => &r.request_id,
            Self::Restore(r) => &r.request_id,
            Self::Return(r) => &r.request_id,
        }
    }
    fn owner(&self) -> &str {
        match self {
            Self::Export(r) => &r.base.project_id,
            Self::Work(r) => &r.owner_project_id,
            Self::Inspect(r) => &r.owner_project_id,
            Self::Restore(r) => &r.owner_project_id,
            Self::Return(r) => &r.owner_project_id,
        }
    }
}
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Operation {
    request: Request,
    digest: String,
    source: String,
    owner: String,
    view: PackageOperationView,
    cancel: bool,
    attempt: u64,
    capture_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    capture_retry_until: Option<i64>,
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct JournalUpdate {
    files: Vec<(String, serde_json::Value)>,
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkCapture {
    descriptor: Descriptor,
    stage: String,
    #[serde(default)]
    expires_at: i64,
    #[serde(default)]
    expired: bool,
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ArchiveReady {
    source: String,
    digest: String,
    descriptor_hash: String,
    view: PackageArchiveView,
}
fn active(state: &PackageOperationViewState) -> bool {
    matches!(
        state,
        PackageOperationViewState::Capturing
            | PackageOperationViewState::Queued
            | PackageOperationViewState::Running
    )
}
impl ProjectTransferStore {
    fn package_path(&self, prefix: &str, id: &str) -> PathBuf {
        self.directory.join(format!("package-{prefix}-{id}.json"))
    }
    fn package_op(&self, id: &str) -> PathBuf {
        self.package_path("operation", id)
    }
    fn package_read(&self, r: &SqliteProjectRepository, id: &str) -> Result<Operation> {
        uuid(id)?;
        let op: Operation = journal::read(&self.package_op(id))?;
        if op.source != r.migration_source_identity()? {
            return Err(fail("PACKAGE_NOT_FOUND"));
        }
        Ok(op)
    }
    pub(super) fn recover_package_pending(&self) -> Result<()> {
        let mut index = self.index()?;
        if let Some(pending) = index.package_pending.take() {
            if pending.files.len() > 4 {
                return Err(fail("STORAGE_UNAVAILABLE"));
            }
            for (name, value) in pending.files {
                if !name.starts_with("package-")
                    || !name.ends_with(".json")
                    || name.contains('/')
                    || name.contains('\\')
                    || name.len() > 120
                {
                    return Err(fail("STORAGE_UNAVAILABLE"));
                }
                journal::save(&self.directory.join(name), &value)?;
                self.cut("package-file")?;
            }
            journal::save(&self.directory.join("active.json"), &index)?;
            self.cut("package-index")?;
        }
        Ok(())
    }
    fn package_commit(
        &self,
        mut index: Active,
        files: Vec<(PathBuf, serde_json::Value)>,
    ) -> Result<()> {
        index.package_pending = Some(JournalUpdate {
            files: files
                .into_iter()
                .map(|(p, v)| {
                    Ok((
                        p.file_name()
                            .and_then(|n| n.to_str())
                            .ok_or(fail("STORAGE_UNAVAILABLE"))?
                            .into(),
                        v,
                    ))
                })
                .collect::<Result<_>>()?,
        });
        journal::save(&self.directory.join("active.json"), &index)?;
        self.cut("package-pending")?;
        self.recover_package_pending()
    }
    pub(super) fn prune_packages(&self) -> Result<()> {
        let mut index = self.index()?;
        let n = index.package_ids.len();
        index.package_ids.retain(|id| {
            journal::read::<Operation>(&self.package_op(id))
                .map_or(true, |op| active(&op.view.state))
        });
        if n != index.package_ids.len() {
            journal::save(&self.directory.join("active.json"), &index)?;
        }
        Ok(())
    }
    pub(super) fn recover_packages(&self) -> Result<()> {
        let _lock = self.journal_lock()?;
        let mut index = self.index()?;
        for id in index.package_ids.clone() {
            let mut op: Operation = journal::read(&self.package_op(&id))?;
            uuid(&op.owner)?;
            let owner = db(File::options()
                .read(true)
                .write(true)
                .open(self.directory.join(format!("owner-{}.lock", op.owner))))?;
            if active(&op.view.state) && owner.try_lock().is_ok() {
                op.view.state = PackageOperationViewState::Interrupted;
                op.view.failure_code = Some("PACKAGE_INTERRUPTED".into());
                op.view.operation_revision += 1;
                journal::save(&self.package_op(&id), &op)?;
                index.package_ids.retain(|x| x != &id);
            }
        }
        journal::save(&self.directory.join("active.json"), &index)
    }
    fn check_owner(r: &SqliteProjectRepository, owner: &str) -> Result<()> {
        uuid(owner)?;
        let c = db(r.connection.lock())?;
        let p = db(read_project(&c))?.ok_or(fail("PROJECT_NOT_FOUND"))?;
        if p.id != owner {
            return Err(fail("PROJECT_NOT_FOUND"));
        }
        if r.is_quiescing() {
            return Err(fail("PROJECT_CLOSING"));
        }
        Ok(())
    }
    fn original<T: serde::de::DeserializeOwned>(
        &self,
        path: &Path,
        digest: &str,
        source: &str,
    ) -> Result<Option<T>> {
        if !path.exists() {
            return Ok(None);
        }
        let saved: Saved<T> = journal::read(path)?;
        if saved.digest != digest || saved.source != source {
            return Err(fail("PACKAGE_REQUEST_CONFLICT"));
        }
        match saved.result {
            Ok(v) => Ok(Some(v)),
            Err(code) => Err(fail(known_code(&code))),
        }
    }
    fn prepare_start(
        &self,
        r: &SqliteProjectRepository,
        request: Request,
    ) -> Result<PackageStartResponse> {
        uuid(request.id())?;
        let id = request.id().to_owned();
        let digest = hash(&db(serde_json::to_vec(&request))?);
        let source = r.migration_source_identity()?;
        let receipt = self.package_path("start", &id);
        // Serializes only this original start/capture, never other operations or status.
        let _start = journal::lock(&self.directory.join(format!("package-start-{id}.lock")))?;
        {
            let _journal = self.journal_lock()?;
            if let Some(original) =
                self.original::<PackageStartResponse>(&receipt, &digest, &source)?
            {
                return Ok(original);
            }
        }
        let _retention = if matches!(request, Request::Export(_)) {
            Some(journal::lock(
                &self.directory.join(format!("package-retention-{id}.lock")),
            )?)
        } else {
            None
        };
        {
            let _lock = self.journal_lock()?;
            if let Some(original) =
                self.original::<PackageStartResponse>(&receipt, &digest, &source)?
            {
                return Ok(original);
            }
        }
        if self.package_op(&id).exists() {
            let op = self.package_read(r, &id)?;
            if op.digest != digest {
                return Err(fail("PACKAGE_REQUEST_CONFLICT"));
            }
            let result = (|| {
                let Request::Export(export) = &request else {
                    return Err(fail("PACKAGE_REQUEST_CONFLICT"));
                };
                let capture = op
                    .capture_id
                    .as_ref()
                    .ok_or(fail("PACKAGE_CAPTURE_INVALID"))?;
                let p = Parent::open(&self.directory, capture)?;
                let root = p.bound_directory_path()?.join(&p.name);
                if r.package_capture_expiry(&id)?
                    .is_some_and(|(state, _)| state == "expired")
                {
                    return Err(fail("PACKAGE_EXPIRED"));
                }
                if !root.join("sql-capture.json").exists() {
                    return Err(fail("PACKAGE_INTERRUPTED"));
                }
                r.source_cut("package-capture-replay-proof")?;
                r.pin_package_capture(export, &root)?;
                let recorded: ProjectPackageExportRequest =
                    large_read(&root.join("capture.json"), 4 << 20)
                        .map_err(|_| fail("PACKAGE_INTERRUPTED"))?;
                if recorded != *export {
                    return Err(fail("PACKAGE_CAPTURE_INVALID"));
                }
                let mut original = op.view.clone();
                original.operation_revision = 1;
                original.state = PackageOperationViewState::Capturing;
                original.phase = PackageOperationViewPhase::Capture;
                original.failure_code = None;
                original.last_control_id = None;
                Ok(PackageStartResponse {
                    accepted: true,
                    operation: original,
                })
            })();
            let _journal = self.journal_lock()?;
            if let Some(original) =
                self.original::<PackageStartResponse>(&receipt, &digest, &source)?
            {
                return Ok(original);
            }
            let mut op = self.package_read(r, &id)?;
            if active(&op.view.state) {
                op.view.state = PackageOperationViewState::Interrupted;
                op.view.failure_code = Some("PACKAGE_INTERRUPTED".into());
                op.view.operation_revision += 1;
            }
            self.package_commit(
                self.index()?,
                vec![
                    (self.package_op(&id), json(&op)?),
                    (
                        receipt,
                        json(&Saved {
                            digest,
                            source,
                            result: result.clone().map_err(|e| e.0.to_string()),
                        })?,
                    ),
                ],
            )?;
            return result;
        }
        // Validation has no bulk I/O. The original DTO outcome always precedes it.
        let validation = (|| {
            Self::check_owner(r, request.owner())?;
            match &request {
                Request::Export(v) => {
                    if r.read_package_base()? != v.base {
                        return Err(fail("PACKAGE_BASE_MISMATCH"));
                    }
                }
                Request::Work(v) => {
                    let item = r.work_item(&v.work_item_id)?;
                    if item.project_id != v.owner_project_id
                        || item.item_revision != v.expected_work_item_revision
                        || item.origin != WorkItemViewOrigin::Copy
                        || !item.copy_available
                        || item.state != WorkItemViewState::Ready
                    {
                        return Err(fail("WORK_COPY_UNAVAILABLE"));
                    }
                }
                Request::Inspect(v) => {
                    let intake = self.intake_scoped(r, &v.intake_id)?;
                    if intake.view.state != PackageIntakeViewState::Open
                        && intake.view.state != PackageIntakeViewState::Sealed
                    {
                        return Err(fail("PACKAGE_INTAKE_CLOSED"));
                    }
                    if intake.view.received_bytes != intake.view.length {
                        return Err(fail("PACKAGE_INTAKE_INCOMPLETE"));
                    }
                }
                Request::Restore(v) => {
                    uuid(&v.target_id)?;
                    let inspection = self.inspection_record(r, &v.inspection_id)?;
                    if !inspection.view.verified_restore {
                        return Err(fail("PACKAGE_RESTORE_UNAVAILABLE"));
                    }
                    let target: restore::Target =
                        journal::read(&self.package_path("target", &v.target_id))?;
                    if target.source != source
                        || target.view.owner_project_id != v.owner_project_id
                        || target.view.inspection_id != v.inspection_id
                    {
                        return Err(fail("PACKAGE_TARGET_INVALID"));
                    }
                }
                Request::Return(v) => {
                    let inspected = self.inspection_record(r, &v.inspection_id)?;
                    if !inspected.view.trusted_return {
                        return Err(fail("PACKAGE_TRUSTED_BASE_MISSING"));
                    }
                }
            }
            Ok(())
        })();
        let _intake = match &request {
            Request::Inspect(v) => Some(journal::lock(
                &self
                    .directory
                    .join(format!("package-intake-{}.lock", v.intake_id)),
            )?),
            _ => None,
        };
        let _lock = self.journal_lock()?;
        if let Some(original) = self.original(&receipt, &digest, &source)? {
            return Ok(original);
        }
        let mut index = self.index()?;
        let mut sealed = None;
        let outcome = (|| {
            validation?;
            if let Request::Inspect(v) = &request {
                let mut intake = self.intake_scoped(r, &v.intake_id)?;
                if !matches!(
                    intake.view.state,
                    PackageIntakeViewState::Open | PackageIntakeViewState::Sealed
                ) {
                    return Err(fail("PACKAGE_INTAKE_CLOSED"));
                }
                if intake.view.received_bytes != intake.view.length {
                    return Err(fail("PACKAGE_INTAKE_INCOMPLETE"));
                }
                if intake.view.state == PackageIntakeViewState::Open {
                    intake.view.state = PackageIntakeViewState::Sealed;
                    intake.view.revision += 1;
                    intake.view.expires_at = now() + INTAKE_TTL;
                    sealed = Some(intake);
                }
            }

            if index.ids.len() + index.package_ids.len() >= 5 {
                return Err(fail("PACKAGE_QUEUE_FULL"));
            }
            let (kind, phase, state) = match &request {
                Request::Export(_) => (
                    PackageOperationViewKind::Export,
                    PackageOperationViewPhase::Capture,
                    PackageOperationViewState::Capturing,
                ),
                Request::Work(_) => (
                    PackageOperationViewKind::Workcopyexport,
                    PackageOperationViewPhase::Queued,
                    PackageOperationViewState::Queued,
                ),
                Request::Inspect(_) => (
                    PackageOperationViewKind::Inspect,
                    PackageOperationViewPhase::Seal,
                    PackageOperationViewState::Queued,
                ),
                Request::Restore(_) => (
                    PackageOperationViewKind::Restore,
                    PackageOperationViewPhase::Queued,
                    PackageOperationViewState::Queued,
                ),
                Request::Return(_) => (
                    PackageOperationViewKind::Return,
                    PackageOperationViewPhase::Queued,
                    PackageOperationViewState::Queued,
                ),
            };
            let view = PackageOperationView {
                request_id: id.clone(),
                owner_project_id: request.owner().into(),
                operation_revision: 1,
                kind,
                state,
                phase,
                completed_bytes: 0,
                completed_entries: 0,
                archive: None,
                inspection: None,
                target: None,
                candidate: None,
                failure_code: None,
                last_control_id: None,
            };
            Ok((
                PackageStartResponse {
                    accepted: true,
                    operation: view.clone(),
                },
                Operation {
                    request: request.clone(),
                    digest: digest.clone(),
                    source: source.clone(),
                    owner: self.owner.clone(),
                    view,
                    cancel: false,
                    attempt: 0,
                    capture_id: if matches!(request, Request::Export(_)) {
                        Some(format!("capture-{}", uuid::Uuid::new_v4()))
                    } else {
                        None
                    },
                    capture_retry_until: None,
                },
            ))
        })();
        let mut files = vec![];
        let result = outcome
            .as_ref()
            .map(|(v, _)| v.clone())
            .map_err(|e| e.0.to_string());
        if let Ok((_, op)) = &outcome {
            if let Some(intake) = sealed {
                files.push((
                    self.package_path("intake", &intake.view.intake_id),
                    json(&intake)?,
                ));
            }
            index.package_ids.push(id.clone());
            files.push((self.package_op(&id), json(op)?));
        }
        if !matches!(request, Request::Export(_)) || outcome.is_err() {
            files.push((
                receipt.clone(),
                json(&Saved {
                    digest: digest.clone(),
                    source: source.clone(),
                    result,
                })?,
            ));
        }
        self.package_commit(index, files)?;
        drop(_lock);
        drop(_intake);
        let (response, op) = outcome?;
        if let Request::Export(export) = &request {
            let parent = Parent::open(&self.directory, op.capture_id.as_ref().unwrap())?;
            let root = parent.bound_directory_path()?.join(&parent.name);
            let result = r
                .capture_package(
                    export,
                    &root,
                    &self.directory,
                    op.capture_id.as_ref().unwrap(),
                )
                .and_then(|()| r.pin_package_capture(export, &root));
            if result.as_ref().is_err_and(|e| e.0 == "TEST_CUT") {
                return Err(fail("TEST_CUT"));
            }
            self.cut("package-capture")?;
            parent.verify()?;
            let _lock = self.journal_lock()?;
            let mut current = self.package_read(r, &id)?;
            let captured = match result {
                Ok(()) => {
                    current.view.state = if current.cancel {
                        PackageOperationViewState::Cancelled
                    } else {
                        PackageOperationViewState::Queued
                    };
                    current.view.phase = PackageOperationViewPhase::Queued;
                    Ok(response.clone())
                }
                Err(e) => {
                    current.view.state = PackageOperationViewState::Interrupted;
                    current.view.failure_code = Some(e.0.into());
                    Err(e)
                }
            };
            current.view.operation_revision += 1;
            self.package_commit(
                self.index()?,
                vec![
                    (self.package_op(&id), json(&current)?),
                    (
                        receipt,
                        json(&Saved {
                            digest,
                            source,
                            result: captured.clone().map_err(|e| e.0.to_string()),
                        })?,
                    ),
                ],
            )?;
            return captured;
        }
        Ok(response)
    }
    pub fn start_package_export(
        &self,
        r: &SqliteProjectRepository,
        request: &ProjectPackageExportRequest,
    ) -> Result<PackageStartResponse> {
        self.prepare_start(r, Request::Export(request.clone()))
    }
    pub fn start_work_copy_package(
        &self,
        r: &SqliteProjectRepository,
        request: &WorkCopyPackageExportRequest,
    ) -> Result<PackageStartResponse> {
        self.prepare_start(r, Request::Work(request.clone()))
    }
    pub fn start_package_inspection(
        &self,
        r: &SqliteProjectRepository,
        request: &PackageInspectionRequest,
    ) -> Result<PackageStartResponse> {
        self.prepare_start(r, Request::Inspect(request.clone()))
    }
    pub fn start_package_restore(
        &self,
        r: &SqliteProjectRepository,
        request: &PackageRestoreRequest,
    ) -> Result<PackageStartResponse> {
        self.prepare_start(r, Request::Restore(request.clone()))
    }
    pub fn start_package_return(
        &self,
        r: &SqliteProjectRepository,
        request: &PackageReturnRequest,
    ) -> Result<PackageStartResponse> {
        self.prepare_start(r, Request::Return(request.clone()))
    }
    fn reconcile_archive(
        &self,
        r: &SqliteProjectRepository,
        op: &Operation,
    ) -> Result<Option<PackageArchiveView>> {
        let closing = r.quiescing.clone();
        let _cancel_scope = crate::storage::operation::Cancellation::begin(move || {
            closing.load(std::sync::atomic::Ordering::Acquire)
        });
        let id = op.request.id();
        let p = Parent::open(&self.directory, &format!("archive-{id}.zip"))?;
        let Some((mut f, _)) = p.open_file(&p.name)? else {
            return Ok(None);
        };
        let record: ArchiveReady = journal::read(&self.package_path("archive-ready", id))
            .map_err(|_| fail("PACKAGE_ARCHIVE_INVALID"))?;
        if record.source != r.migration_source_identity()?
            || record.digest != op.digest
            || record.view.archive_id != id
            || record.view.owner_project_id != op.request.owner()
        {
            return Err(fail("PACKAGE_ARCHIVE_INVALID"));
        }
        let actual = crate::storage::objects::stream_copy(
            &mut f,
            &mut std::io::sink(),
            Limits::default().compressed,
        )?;
        if actual != (record.view.hash.clone(), record.view.size as u64) {
            return Err(fail("PACKAGE_ARCHIVE_INVALID"));
        }
        let inspected = archive::inspect(&f, Limits::default(), &|| r.is_quiescing())?;
        let descriptor = inspected
            .descriptor
            .ok_or(fail("PACKAGE_ARCHIVE_INVALID"))?;
        if hash(&db(serde_json::to_vec(&descriptor))?) != record.descriptor_hash
            || descriptor.export_id != id
            || descriptor.project_id != op.request.owner()
        {
            return Err(fail("PACKAGE_ARCHIVE_INVALID"));
        }
        p.verify()?;
        Ok(Some(record.view))
    }
    pub fn package_status(
        &self,
        r: &SqliteProjectRepository,
        id: &str,
    ) -> Result<PackageOperationView> {
        let op = {
            let _lock = self.journal_lock()?;
            self.package_read(r, id)?
        };
        if op.view.state == PackageOperationViewState::Interrupted
            && matches!(op.request, Request::Export(_) | Request::Work(_))
            && let Ok(Some(archive)) = self.reconcile_archive(r, &op)
        {
            let _lock = self.journal_lock()?;
            let mut current = self.package_read(r, id)?;
            current.view.archive = Some(archive);
            current.view.state = PackageOperationViewState::Succeeded;
            current.view.phase = PackageOperationViewPhase::Ready;
            current.view.failure_code = None;
            current.view.operation_revision += 1;
            journal::save(&self.package_op(id), &current)?;
            return Ok(current.view);
        }
        if (active(&op.view.state) || op.view.state == PackageOperationViewState::Interrupted)
            && matches!(op.request, Request::Restore(_))
            && let Ok(Some(target)) = self.reconcile_restore(r, &op)
        {
            let _lock = self.journal_lock()?;
            let mut current = self.package_read(r, id)?;
            current.view.target = Some(target);
            current.view.state = PackageOperationViewState::Succeeded;
            current.view.phase = PackageOperationViewPhase::Ready;
            current.view.failure_code = None;
            current.view.operation_revision += 1;
            journal::save(&self.package_op(id), &current)?;
            return Ok(current.view);
        }
        Ok(op.view)
    }
    pub fn control_package(
        &self,
        r: &SqliteProjectRepository,
        request: &PackageControlRequest,
    ) -> Result<PackageOperationView> {
        uuid(&request.request_id)?;
        uuid(&request.operation_id)?;
        let source = r.migration_source_identity()?;
        let digest = hash(&db(serde_json::to_vec(request))?);
        let path = self.package_path("control", &request.request_id);
        {
            let _lock = self.journal_lock()?;
            if let Some(old) = self.original(&path, &digest, &source)? {
                return Ok(old);
            }
        }
        let _retention = if request.action == PackageControlRequestAction::Retry {
            Some(journal::lock(&self.directory.join(format!(
                "package-retention-{}.lock",
                request.operation_id
            )))?)
        } else {
            None
        };
        let status = self.package_status(r, &request.operation_id);
        if request.action == PackageControlRequestAction::Retry
            && let Ok(view) = &status
            && !active(&view.state)
            && view.state != PackageOperationViewState::Succeeded
            && request.expected_operation_revision == view.operation_revision
            && request.owner_project_id == view.owner_project_id
        {
            Self::check_owner(r, &request.owner_project_id)?;
            r.recover_package_capture_pins()?;
        }
        if request.action == PackageControlRequestAction::Retry
            && let Ok(view) = &status
        {
            let mut op = self.package_read(r, &request.operation_id)?;
            if let Request::Export(export) = op.request.clone() {
                let complete = op
                    .capture_id
                    .as_ref()
                    .is_some_and(|id| self.directory.join(id).join("capture.json").exists());
                if !complete && !active(&view.state) {
                    let validation = (|| {
                        Self::check_owner(r, &request.owner_project_id)?;
                        if request.owner_project_id != op.view.owner_project_id {
                            return Err(fail("PACKAGE_NOT_FOUND"));
                        }
                        if request.expected_operation_revision != view.operation_revision {
                            return Err(fail("PACKAGE_REVISION_CONFLICT"));
                        }
                        self.check_capture_retry(r, &op)?;
                        if r.package_capture_was_fixed(&export.request_id)? {
                            return Err(fail("PACKAGE_CAPTURE_INVALID"));
                        }
                        if op.capture_id.as_ref().is_some_and(|id| {
                            self.directory.join(id).join("sql-capture.json").exists()
                        }) {
                            return Err(fail("PACKAGE_CAPTURE_INVALID"));
                        }
                        if r.read_package_base()? != export.base {
                            return Err(fail("PACKAGE_BASE_MISMATCH"));
                        }
                        Ok(())
                    })();
                    if validation.is_ok() {
                        {
                            let _lock = self.journal_lock()?;
                            let mut index = self.index()?;
                            if index.ids.len() + index.package_ids.len() >= 5 {
                                self.package_commit(
                                    index,
                                    vec![(
                                        path.clone(),
                                        json(&Saved::<PackageOperationView> {
                                            digest: digest.clone(),
                                            source: source.clone(),
                                            result: Err("PACKAGE_QUEUE_FULL".into()),
                                        })?,
                                    )],
                                )?;
                                return Err(fail("PACKAGE_QUEUE_FULL"));
                            }
                            op.capture_id = Some(format!("capture-{}", uuid::Uuid::new_v4()));
                            op.owner = self.owner.clone();
                            op.cancel = false;
                            op.view.state = PackageOperationViewState::Capturing;
                            op.capture_retry_until = Some(now() + CACHE_TTL);
                            op.view.operation_revision += 1;
                            index.package_ids.push(request.operation_id.clone());
                            self.package_commit(
                                index,
                                vec![(self.package_op(&request.operation_id), json(&op)?)],
                            )?;
                        }
                        let p = Parent::open(&self.directory, op.capture_id.as_ref().unwrap())?;
                        let root = p.bound_directory_path()?.join(&p.name);
                        let captured = r
                            .capture_package(
                                &export,
                                &root,
                                &self.directory,
                                op.capture_id.as_ref().unwrap(),
                            )
                            .and_then(|()| r.pin_package_capture(&export, &root));
                        self.cut("package-retry-capture")?;
                        p.verify()?;
                        let _lock = self.journal_lock()?;
                        let mut current = self.package_read(r, &request.operation_id)?;
                        let outcome = match captured {
                            Ok(()) => {
                                current.view.state = PackageOperationViewState::Queued;
                                current.view.failure_code = None;
                                Ok(())
                            }
                            Err(e) => {
                                current.view.state = PackageOperationViewState::Interrupted;
                                current.view.failure_code = Some(e.0.into());
                                Err(e)
                            }
                        };
                        current.view.operation_revision += 1;
                        current.view.last_control_id = Some(request.request_id.clone());
                        let outcome = outcome.map(|()| current.view.clone());
                        let mut files = vec![
                            (self.package_op(&request.operation_id), json(&current)?),
                            (
                                path,
                                json(&Saved {
                                    digest,
                                    source,
                                    result: outcome.clone().map_err(|e| e.0.to_string()),
                                })?,
                            ),
                        ];
                        self.package_commit(self.index()?, std::mem::take(&mut files))?;
                        return outcome;
                    }
                    let e = validation.unwrap_err();
                    let _lock = self.journal_lock()?;
                    self.package_commit(
                        self.index()?,
                        vec![(
                            path,
                            json(&Saved::<PackageOperationView> {
                                digest,
                                source,
                                result: Err(e.0.into()),
                            })?,
                        )],
                    )?;
                    return Err(e);
                }
            }
        }
        let _lock = self.journal_lock()?;
        if let Some(old) = self.original(&path, &digest, &source)? {
            return Ok(old);
        }
        let mut index = self.index()?;
        let mut change = None;
        let outcome = (|| {
            let status = status?;
            Self::check_owner(r, &request.owner_project_id)?;
            if request.request_id == request.operation_id {
                return Err(fail("INVALID_REQUEST"));
            }
            let mut op = self.package_read(r, &request.operation_id)?;
            if request.owner_project_id != op.view.owner_project_id {
                return Err(fail("PACKAGE_NOT_FOUND"));
            }
            if status.state == PackageOperationViewState::Succeeded {
                return Ok(status);
            }
            if request.expected_operation_revision != op.view.operation_revision {
                return Err(fail("PACKAGE_REVISION_CONFLICT"));
            }
            match request.action {
                PackageControlRequestAction::Cancel => {
                    op.cancel = true;
                    if op.view.state != PackageOperationViewState::Running {
                        op.view.state = PackageOperationViewState::Cancelled;
                        index.package_ids.retain(|x| x != &request.operation_id);
                    }
                }
                PackageControlRequestAction::Retry => {
                    if active(&op.view.state) {
                        return Err(fail("PACKAGE_REVISION_CONFLICT"));
                    }
                    self.check_capture_retry(r, &op)?;
                    if index.ids.len() + index.package_ids.len() >= 5 {
                        return Err(fail("PACKAGE_QUEUE_FULL"));
                    }
                    if let Request::Export(export) = &op.request {
                        let capture = op
                            .capture_id
                            .as_ref()
                            .ok_or(fail("PACKAGE_CAPTURE_INVALID"))?;
                        if !self.directory.join(capture).join("capture.json").exists() {
                            return Err(fail("PACKAGE_CAPTURE_INVALID"));
                        }
                        let _ = export;
                    }
                    op.cancel = false;
                    op.owner = self.owner.clone();
                    op.view.state = PackageOperationViewState::Queued;
                    if matches!(op.request, Request::Export(_) | Request::Work(_)) {
                        op.capture_retry_until = Some(now() + CACHE_TTL);
                    }
                    op.view.failure_code = None;
                    index.package_ids.push(request.operation_id.clone());
                }
            }
            op.view.operation_revision += 1;
            op.view.last_control_id = Some(request.request_id.clone());
            let view = op.view.clone();
            change = Some(op);
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
        if let Some(op) = change {
            files.push((self.package_op(&request.operation_id), json(&op)?));
        }
        self.package_commit(index, files)?;
        outcome
    }
    fn cancelled(&self, r: &SqliteProjectRepository, id: &str) -> bool {
        r.is_quiescing()
            || journal::read::<Operation>(&self.package_op(id)).map_or(true, |op| op.cancel)
    }
    pub(super) fn run_next_package(&self, r: &SqliteProjectRepository) -> Result<bool> {
        let mut op = {
            let _lock = self.journal_lock()?;
            let source = r.migration_source_identity()?;
            let mut selected = None;
            for id in self.index()?.package_ids {
                let op: Operation = journal::read(&self.package_op(&id))?;
                if op.source == source
                    && op.owner == self.owner
                    && op.view.state == PackageOperationViewState::Queued
                {
                    selected = Some(op);
                    break;
                }
            }
            let Some(mut op) = selected else {
                return Ok(false);
            };
            op.view.state = PackageOperationViewState::Running;
            op.view.phase = match op.request {
                Request::Export(_) | Request::Work(_) => PackageOperationViewPhase::Copy,
                Request::Inspect(_) => PackageOperationViewPhase::Seal,
                Request::Restore(_) => PackageOperationViewPhase::Verify,
                Request::Return(_) => PackageOperationViewPhase::Prepare,
            };
            op.view.operation_revision += 1;
            op.attempt += 1;
            journal::save(&self.package_op(op.request.id()), &op)?;
            op
        };
        #[cfg(test)]
        {
            let hook = db(self.hook.lock())?.take();
            if let Some(hook) = hook {
                hook();
            }
        }
        let result = self.execute_package(r, &mut op);
        self.cut("package-result")?;
        let _lock = self.journal_lock()?;
        let mut current = self.package_read(r, op.request.id())?;
        if current.attempt != op.attempt {
            return Err(fail("PACKAGE_REVISION_CONFLICT"));
        }
        if current.view.state != PackageOperationViewState::Succeeded {
            match result {
                Ok(()) => {
                    current.view.archive = op.view.archive;
                    current.view.inspection = op.view.inspection;
                    current.view.target = op.view.target;
                    current.view.candidate = op.view.candidate;
                    current.view.state = PackageOperationViewState::Succeeded;
                    current.view.phase = PackageOperationViewPhase::Ready;
                    current.view.failure_code = None;
                    current.view.completed_bytes = op.view.completed_bytes;
                    current.view.completed_entries = op.view.completed_entries;
                }
                Err(e) => {
                    let cancelled =
                        current.cancel || r.is_quiescing() || e.0 == "PACKAGE_CANCELLED";
                    current.view.state = if e.0 == "TEST_CUT" {
                        PackageOperationViewState::Interrupted
                    } else if cancelled {
                        PackageOperationViewState::Cancelled
                    } else {
                        PackageOperationViewState::Failed
                    };
                    current.view.failure_code = Some(
                        if e.0 == "TEST_CUT" {
                            "PACKAGE_INTERRUPTED"
                        } else if cancelled {
                            "PACKAGE_CANCELLED"
                        } else {
                            known_code(e.0)
                        }
                        .into(),
                    );
                }
            }
            current.view.operation_revision += 1;
            journal::save(&self.package_op(current.request.id()), &current)?;
        }
        let mut index = self.index()?;
        index.package_ids.retain(|id| id != current.request.id());
        journal::save(&self.directory.join("active.json"), &index)?;
        Ok(true)
    }
    fn package_progress(
        &self,
        r: &SqliteProjectRepository,
        id: &str,
        phase: PackageOperationViewPhase,
        bytes: u64,
        entries: u64,
    ) -> Result<()> {
        let _lock = self.journal_lock()?;
        let mut op = self.package_read(r, id)?;
        if op.cancel || r.is_quiescing() {
            return Err(fail("PACKAGE_CANCELLED"));
        }
        op.view.phase = phase;
        op.view.completed_bytes = op.view.completed_bytes.max(bytes as i64);
        op.view.completed_entries = op.view.completed_entries.max(entries as i64);
        op.view.operation_revision += 1;
        journal::save(&self.package_op(id), &op)
    }
    fn execute_package(&self, r: &SqliteProjectRepository, op: &mut Operation) -> Result<()> {
        let closing = r.quiescing.clone();
        let record = self.package_op(op.request.id());
        let _cancel_scope = crate::storage::operation::Cancellation::begin(move || {
            closing.load(std::sync::atomic::Ordering::Acquire)
                || journal::read::<Operation>(&record).map_or(true, |op| op.cancel)
        });
        let cancel = || self.cancelled(r, op.request.id());
        if matches!(op.request, Request::Export(_) | Request::Work(_))
            && let Some(archive) = self.reconcile_archive(r, op)?
        {
            op.view.archive = Some(archive);
            return Ok(());
        }

        match &op.request {
            Request::Export(request) => {
                let parent = Parent::open(
                    &self.directory,
                    op.capture_id
                        .as_ref()
                        .ok_or(fail("PACKAGE_CAPTURE_INVALID"))?,
                )?;
                let root = parent.bound_directory_path()?.join(&parent.name);
                let materialized = format!("materialized-{}-{}", request.request_id, op.attempt);
                let output = Parent::open(&self.directory, &materialized)?;
                let stage = output.bound_directory_path()?.join(&output.name);
                let descriptor = r.materialize_package(request, &root, &stage, &cancel)?;
                let materialized = r
                    .package_materialized_token(&request.request_id)?
                    .ok_or(fail("PACKAGE_CAPTURE_INVALID"))?;
                let output = Parent::open(&self.directory, &materialized)?;
                let stage = output.bound_directory_path()?.join(&output.name);
                op.view.completed_bytes =
                    descriptor.members.iter().map(|m| m.size).sum::<u64>() as i64;
                op.view.completed_entries = descriptor.members.len() as i64;
                self.package_progress(
                    r,
                    op.request.id(),
                    PackageOperationViewPhase::Archive,
                    op.view.completed_bytes as u64,
                    op.view.completed_entries as u64,
                )?;
                op.view.archive = Some(self.publish_archive(r, op, &stage, &descriptor)?);
                parent.verify()?;
                output.verify()?;
            }
            Request::Work(request) => {
                let inventory = self.package_path("work-inventory", &request.request_id);
                let capture = if inventory.exists() {
                    large_read::<WorkCapture>(&inventory, 16 << 20)?
                } else {
                    let stage = format!("work-capture-{}-{}", request.request_id, op.attempt);
                    let parent = Parent::open(&self.directory, &stage)?;
                    let root = parent.bound_directory_path()?.join(&parent.name);
                    let descriptor = r.capture_work_package(request, &root, &cancel)?;
                    let capture = WorkCapture {
                        descriptor,
                        stage,
                        expires_at: now() + CACHE_TTL,
                        expired: false,
                    };
                    large_save(&inventory, &capture, 16 << 20)?;
                    parent.verify()?;
                    capture
                };
                if capture.expired {
                    return Err(fail("PACKAGE_EXPIRED"));
                }
                if !capture
                    .stage
                    .starts_with(&format!("work-capture-{}-", request.request_id))
                    || !capture
                        .stage
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-')
                {
                    return Err(fail("PACKAGE_CAPTURE_INVALID"));
                }
                let parent = Parent::open(&self.directory, &capture.stage)?;
                let root = parent.bound_directory_path()?.join(&parent.name);
                let descriptor = capture.descriptor;
                op.view.completed_bytes =
                    descriptor.members.iter().map(|m| m.size).sum::<u64>() as i64;
                op.view.completed_entries = descriptor.members.len() as i64;
                self.package_progress(
                    r,
                    op.request.id(),
                    PackageOperationViewPhase::Archive,
                    op.view.completed_bytes as u64,
                    op.view.completed_entries as u64,
                )?;
                op.view.archive = Some(self.publish_archive(r, op, &root, &descriptor)?);
                parent.verify()?;
            }
            Request::Inspect(request) => {
                let record = self.inspect_intake(r, request, &cancel)?;
                op.view.completed_bytes = record.inspected.expanded as i64;
                op.view.completed_entries = record.inspected.entry_count as i64;
                op.view.inspection = Some(record.view);
            }
            Request::Restore(request) => {
                op.view.target = Some(self.restore_package(r, op, request, &cancel)?);
            }
            Request::Return(request) => {
                op.view.candidate = Some(self.return_package(r, request, &cancel)?);
            }
        }
        Ok(())
    }
    fn publish_archive(
        &self,
        r: &SqliteProjectRepository,
        op: &Operation,
        root: &Path,
        descriptor: &Descriptor,
    ) -> Result<PackageArchiveView> {
        let id = op.request.id();
        let p = Parent::open(&self.directory, &format!("archive-{id}.zip"))?;
        let temp = format!(".archive-{id}-{}.zip", op.attempt);
        let output = p.create_file(&temp)?;
        r.source_cut("package-archive-write")?;
        archive::write_archive(output, root, &descriptor.members, descriptor, &|| {
            self.cancelled(r, id)
        })?;
        let (mut f, _) = p.open_file(&temp)?.ok_or(fail("PACKAGE_ARCHIVE_INVALID"))?;
        let (hash, size) = crate::storage::objects::stream_copy(
            &mut f,
            &mut std::io::sink(),
            Limits::default().compressed,
        )?;
        let inspected = archive::inspect(&f, Limits::default(), &|| self.cancelled(r, id))?;
        let view = PackageArchiveView {
            archive_id: id.into(),
            owner_project_id: op.request.owner().into(),
            kind: if descriptor.kind == "project" {
                PackageArchiveViewKind::Project
            } else {
                PackageArchiveViewKind::Workcopy
            },
            filename: format!("scenesparrow-{}.zip", &id[..8]),
            hash,
            size: size as i64,
            entry_count: inspected.entry_count as i64,
            expanded_bytes: inspected.expanded as i64,
            expires_at: now() + CACHE_TTL,
        };
        journal::save(
            &self.package_path("archive-ready", id),
            &ArchiveReady {
                source: r.migration_source_identity()?,
                digest: op.digest.clone(),
                descriptor_hash: crate::storage::hash(&db(serde_json::to_vec(descriptor))?),
                view: view.clone(),
            },
        )?;
        r.source_cut("package-archive-ready")?;
        if self.cancelled(r, id) {
            return Err(fail("PACKAGE_CANCELLED"));
        }
        p.verify()?;
        p.rename_no_replace(&temp, &p.name)?;
        p.sync()?;
        self.cut("package-archive-promoted")?;
        Ok(view)
    }
}
pub(super) fn safe_code(code: &str) -> Option<&'static str> {
    Some(match code {
        "PACKAGE_ARCHIVE_INVALID" => "PACKAGE_ARCHIVE_INVALID",
        "PACKAGE_PATH_INVALID" => "PACKAGE_PATH_INVALID",
        "PACKAGE_SIZE_LIMIT" => "PACKAGE_SIZE_LIMIT",
        "PACKAGE_CANCELLED" => "PACKAGE_CANCELLED",
        "PACKAGE_INTERRUPTED" => "PACKAGE_INTERRUPTED",
        "PACKAGE_NOT_FOUND" => "PACKAGE_NOT_FOUND",
        "PACKAGE_NATIVE_REQUIRED" => "PACKAGE_NATIVE_REQUIRED",
        "PACKAGE_BASE_MISMATCH" => "PACKAGE_BASE_MISMATCH",
        "PACKAGE_REQUEST_CONFLICT" => "PACKAGE_REQUEST_CONFLICT",
        "PACKAGE_QUEUE_FULL" => "PACKAGE_QUEUE_FULL",
        "PACKAGE_REVISION_CONFLICT" => "PACKAGE_REVISION_CONFLICT",
        "PACKAGE_CAPTURE_INVALID" => "PACKAGE_CAPTURE_INVALID",
        "PACKAGE_MEMBER_MISSING" => "PACKAGE_MEMBER_MISSING",
        "PACKAGE_MANAGEMENT_CHANGED" => "PACKAGE_MANAGEMENT_CHANGED",
        "PACKAGE_TARGET_INVALID" => "PACKAGE_TARGET_INVALID",
        "PACKAGE_TARGET_EXISTS" => "PACKAGE_TARGET_EXISTS",
        "PACKAGE_RESTORE_UNAVAILABLE" => "PACKAGE_RESTORE_UNAVAILABLE",
        "PACKAGE_TRUSTED_BASE_MISSING" => "PACKAGE_TRUSTED_BASE_MISSING",
        "PACKAGE_INTAKE_CLOSED" => "PACKAGE_INTAKE_CLOSED",
        "PACKAGE_INTAKE_INCOMPLETE" => "PACKAGE_INTAKE_INCOMPLETE",
        "PACKAGE_CHUNK_CONFLICT" => "PACKAGE_CHUNK_CONFLICT",
        "PACKAGE_HASH_MISMATCH" => "PACKAGE_HASH_MISMATCH",
        "PACKAGE_EXPIRED" => "PACKAGE_EXPIRED",
        "WORK_COPY_UNAVAILABLE" => "WORK_COPY_UNAVAILABLE",
        _ => return None,
    })
}
#[cfg(test)]
pub(crate) mod tests;

fn known_code(code: &str) -> &'static str {
    if let Some(code) = safe_code(code) {
        return code;
    }
    if code == "PROJECT_CLOSING" {
        return "PROJECT_CLOSING";
    }
    let value = serde_json::json!({"error":code});
    SqliteProjectRepository::decode(&value.to_string())
        .err()
        .map_or("STORAGE_UNAVAILABLE", |e| e.0)
}
