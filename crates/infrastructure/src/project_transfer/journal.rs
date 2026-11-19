use super::*;
use atomic_write_file::AtomicWriteFile;
use serde::{Serialize, de::DeserializeOwned};
use std::{
    fs::File,
    io::Write,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Saved<T> {
    pub(super) digest: String,
    pub(super) source: String,
    pub(super) result: std::result::Result<T, String>,
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct TargetRecord {
    target: MigrationTarget,
    pub(super) source: String,
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Operation {
    request: LegacyMigrationRequest,
    pub(super) source: String,
    pub(super) owner: String,
    view: MigrationOperationView,
    cancel: bool,
    attempt: u64,
}
#[derive(Default, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Active {
    pub(super) ids: Vec<String>,
    #[serde(default)]
    pending: Option<JournalUpdate>,
    #[serde(default)]
    pub(super) package_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) package_pending: Option<super::package::JournalUpdate>,
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct JournalUpdate {
    operation: Option<Operation>,
    target: Option<TargetRecord>,
    receipt_name: String,
    receipt: serde_json::Value,
}
pub(super) struct Lease(pub(super) File);
impl Drop for Lease {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}
/// Short durable record updates never own the long copy/serializer lease.
pub struct ProjectTransferStore {
    pub(super) directory: PathBuf,
    pub(super) roots: PathBuf,
    pub(super) owner: String,
    _session: Lease,
    working: AtomicBool,
    #[cfg(test)]
    pub(super) fault: std::sync::Mutex<Option<&'static str>>,
    #[cfg(test)]
    pub(super) hook: std::sync::Mutex<Option<std::sync::Arc<dyn Fn() + Send + Sync>>>,
    #[cfg(test)]
    install_hook: std::sync::Mutex<Option<std::sync::Arc<dyn Fn() + Send + Sync>>>,
}
pub(super) fn read<T: DeserializeOwned>(path: &Path) -> Result<T> {
    if !db(std::fs::symlink_metadata(path))?.is_file()
        || db(std::fs::metadata(path))?.len() > 64 * 1024
    {
        return Err(fail("STORAGE_UNAVAILABLE"));
    }
    db(serde_json::from_slice(&db(std::fs::read(path))?))
}
pub(super) fn save<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let bytes = db(serde_json::to_vec(value))?;
    if bytes.len() > 64 * 1024 {
        return Err(fail("STORAGE_UNAVAILABLE"));
    }
    let mut file = db(AtomicWriteFile::open(path))?;
    db(file.write_all(&bytes))?;
    db(file.commit())?;
    #[cfg(unix)]
    db(File::open(path.parent().ok_or(fail("STORAGE_UNAVAILABLE"))?).and_then(|f| f.sync_all()))?;
    Ok(())
}
pub(super) fn lock(path: &Path) -> Result<Lease> {
    let f = db(File::options()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path))?;
    // This is only the bounded journal critical section, never bulk I/O.
    for _ in 0..100 {
        if f.try_lock().is_ok() {
            return Ok(Lease(f));
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    Err(fail("MIGRATION_BUSY"))
}
fn active(state: &MigrationOperationViewState) -> bool {
    matches!(
        state,
        MigrationOperationViewState::Queued | MigrationOperationViewState::Running
    )
}
impl ProjectTransferStore {
    pub fn open_default() -> Result<Self> {
        Self::open(&crate::ai::settings::app_data_directory())
    }
    pub fn open(app_data: &Path) -> Result<Self> {
        let directory = app_data.join("project-transfers");
        let roots = app_data.join("project-roots");
        db(std::fs::create_dir_all(&directory))?;
        db(std::fs::create_dir_all(&roots))?;
        let owner = uuid::Uuid::new_v4().to_string();
        let session = lock(&directory.join(format!("owner-{owner}.lock")))?;
        let store = Self {
            directory: db(std::fs::canonicalize(directory))?,
            roots: db(std::fs::canonicalize(roots))?,
            owner,
            _session: session,
            working: AtomicBool::new(false),
            #[cfg(test)]
            fault: std::sync::Mutex::new(None),
            #[cfg(test)]
            hook: std::sync::Mutex::new(None),
            #[cfg(test)]
            install_hook: std::sync::Mutex::new(None),
        };
        let _lock = store.journal_lock()?;
        let mut index = store.index()?;
        for id in index.ids.clone() {
            uuid(&id)?;
            let mut op: Operation = read(&store.operation(&id))?;
            uuid(&op.owner)?;
            let owner_file = db(File::options()
                .read(true)
                .write(true)
                .open(store.directory.join(format!("owner-{}.lock", op.owner))))?;
            if active(&op.view.state) && owner_file.try_lock().is_ok() {
                let _old_owner = Lease(owner_file);
                op.view.state = MigrationOperationViewState::Interrupted;
                op.view.failure_code = Some("MIGRATION_INTERRUPTED".into());
                op.view.operation_revision += 1;
                save(&store.operation(&id), &op)?;
                index.ids.retain(|x| x != &id);
            }
        }
        save(&store.directory.join("active.json"), &index)?;
        drop(_lock);
        store.recover_packages()?;
        Ok(store)
    }
    pub(super) fn journal_lock(&self) -> Result<Lease> {
        let lease = lock(&self.directory.join("journal.lock"))?;
        self.recover_pending()?;
        self.recover_package_pending()?;
        self.prune_terminal()?;
        Ok(lease)
    }
    pub(super) fn cut(&self, point: &str) -> Result<()> {
        #[cfg(test)]
        {
            let mut fault = db(self.fault.lock())?;
            if *fault == Some(point) {
                *fault = None;
                return Err(fail("TEST_CUT"));
            }
        }
        let _ = point;
        Ok(())
    }
    fn recover_pending(&self) -> Result<()> {
        let mut index = self.index()?;
        if let Some(update) = index.pending.take() {
            let valid = ["start-", "control-", "target-request-"]
                .iter()
                .any(|prefix| {
                    update
                        .receipt_name
                        .strip_prefix(prefix)
                        .and_then(|n| n.strip_suffix(".json"))
                        .is_some_and(manuscript::uuid4)
                });
            if !valid {
                return Err(fail("STORAGE_UNAVAILABLE"));
            }
            if let Some(op) = update.operation {
                uuid(&op.request.request_id)?;
                save(&self.operation(&op.request.request_id), &op)?;
            }
            self.cut("operation")?;
            if let Some(target) = update.target {
                uuid(&target.target.target_id)?;
                save(
                    &self
                        .directory
                        .join(format!("target-{}.json", target.target.target_id)),
                    &target,
                )?;
            }
            save(&self.directory.join(update.receipt_name), &update.receipt)?;
            self.cut("receipt")?;
            save(&self.directory.join("active.json"), &index)?;
            self.cut("index")?;
        }
        Ok(())
    }
    fn prune_terminal(&self) -> Result<()> {
        let mut index = self.index()?;
        let before = index.ids.len();
        index.ids.retain(|id| {
            read::<Operation>(&self.operation(id)).map_or(true, |op| active(&op.view.state))
        });
        if before != index.ids.len() {
            save(&self.directory.join("active.json"), &index)?;
        }
        self.prune_packages()?;
        Ok(())
    }
    fn commit<T: Serialize>(
        &self,
        mut index: Active,
        op: Option<Operation>,
        target: Option<TargetRecord>,
        receipt_path: &Path,
        receipt: &Saved<T>,
    ) -> Result<()> {
        let name = receipt_path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or(fail("STORAGE_UNAVAILABLE"))?;
        index.pending = Some(JournalUpdate {
            operation: op,
            target,
            receipt_name: name.into(),
            receipt: db(serde_json::to_value(receipt))?,
        });
        save(&self.directory.join("active.json"), &index)?;
        self.cut("pending")?;
        self.recover_pending()
    }
    pub(super) fn index(&self) -> Result<Active> {
        let p = self.directory.join("active.json");
        if p.exists() {
            read(&p)
        } else {
            Ok(Active::default())
        }
    }
    fn operation(&self, id: &str) -> PathBuf {
        self.directory.join(format!("operation-{id}.json"))
    }
    fn target_path(&self, id: &str) -> PathBuf {
        self.roots.join(id)
    }
    fn scoped(&self, repository: &SqliteProjectRepository, id: &str) -> Result<Operation> {
        uuid(id)?;
        let op: Operation = read(&self.operation(id))?;
        if op.source != repository.migration_source_identity()? {
            return Err(fail("MIGRATION_NOT_FOUND"));
        }
        Ok(op)
    }
    pub(super) fn replay<T: DeserializeOwned>(
        &self,
        path: &Path,
        digest: &str,
        source: &str,
    ) -> Result<Option<T>> {
        if !path.exists() {
            return Ok(None);
        }
        let saved: Saved<T> = read(path)?;
        if saved.digest != digest || saved.source != source {
            return Err(fail("MIGRATION_REQUEST_CONFLICT"));
        }
        match saved.result {
            Ok(v) => Ok(Some(v)),
            Err(code) => Err(fail(safe_code(&code))),
        }
    }
    pub fn issue_target(
        &self,
        repository: &SqliteProjectRepository,
        request: &MigrationTargetRequest,
    ) -> Result<MigrationTarget> {
        uuid(&request.request_id)?;
        let digest = hash(&db(serde_json::to_vec(request))?);
        let source = repository.migration_source_identity()?;
        let path = self
            .directory
            .join(format!("target-request-{}.json", request.request_id));
        {
            let _lock = self.journal_lock()?;
            if let Some(old) = self.replay(&path, &digest, &source)? {
                return Ok(old);
            }
        }
        let inspected = repository.inspect_legacy_migration();
        let _lock = self.journal_lock()?;
        if let Some(old) = self.replay(&path, &digest, &source)? {
            return Ok(old);
        }
        let outcome = (|| {
            uuid(&request.project_id)?;
            let inspected = inspected?;
            if inspected.project_id != request.project_id {
                return Err(fail("PROJECT_NOT_FOUND"));
            }
            let target = MigrationTarget {
                target_id: uuid::Uuid::new_v4().to_string(),
                project_id: request.project_id.clone(),
                destination: MigrationTargetDestination::Managed,
            };
            Ok(target)
        })();
        let receipt = Saved {
            digest,
            source: source.clone(),
            result: outcome.clone().map_err(|e| e.0.to_string()),
        };
        let target = outcome.as_ref().ok().map(|target| TargetRecord {
            target: target.clone(),
            source,
        });
        self.commit(self.index()?, None, target, &path, &receipt)?;
        outcome
    }
    pub fn start(
        &self,
        repository: &SqliteProjectRepository,
        request: &LegacyMigrationRequest,
    ) -> Result<MigrationStartResponse> {
        uuid(&request.request_id)?;
        let digest = hash(&db(serde_json::to_vec(request))?);
        let source = repository.migration_source_identity()?;
        let path = self
            .directory
            .join(format!("start-{}.json", request.request_id));
        {
            let _lock = self.journal_lock()?;
            if let Some(old) = self.replay(&path, &digest, &source)? {
                return Ok(old);
            }
        }
        let inspected = repository.inspect_legacy_migration();
        let _lock = self.journal_lock()?;
        if let Some(old) = self.replay(&path, &digest, &source)? {
            return Ok(old);
        }
        let mut admitted = None;
        let mut next_index = self.index()?;
        let outcome = (|| {
            uuid(&request.project_id)?;
            uuid(&request.target_id)?;
            if !sha(&request.content_base) {
                return Err(fail("INVALID_REQUEST"));
            }
            if repository.is_quiescing() {
                return Err(fail("PROJECT_CLOSING"));
            }
            let target: TargetRecord = read(
                &self
                    .directory
                    .join(format!("target-{}.json", request.target_id)),
            )?;
            if target.source != source
                || target.target.project_id != request.project_id
                || self.target_path(&request.target_id).exists()
            {
                return Err(fail("MIGRATION_TARGET_INVALID"));
            }
            let inspected = inspected?;
            if inspected.project_id != request.project_id
                || inspected.content_base != request.content_base
            {
                return Err(fail("MIGRATION_BASE_MISMATCH"));
            }
            let mut index = self.index()?;
            if index.ids.len() + index.package_ids.len() >= 5 {
                return Err(fail("MIGRATION_QUEUE_FULL"));
            }
            let view = MigrationOperationView {
                request_id: request.request_id.clone(),
                project_id: request.project_id.clone(),
                target_id: request.target_id.clone(),
                content_base: request.content_base.clone(),
                operation_revision: 1,
                phase: MigrationOperationViewPhase::Queued,
                state: MigrationOperationViewState::Queued,
                completed_bytes: 0,
                completed_objects: 0,
                failure_code: None,
                backup_id: None,
                result_id: None,
                normalized_origin: true,
                last_control_id: None,
            };
            admitted = Some(Operation {
                request: request.clone(),
                source: source.clone(),
                owner: self.owner.clone(),
                view: view.clone(),
                cancel: false,
                attempt: 0,
            });
            index.ids.push(request.request_id.clone());
            next_index = index;
            Ok(MigrationStartResponse {
                accepted: true,
                operation: view,
            })
        })();
        self.commit(
            next_index,
            admitted,
            None,
            &path,
            &Saved {
                digest,
                source,
                result: outcome.clone().map_err(|e| e.0.to_string()),
            },
        )?;
        outcome
    }
    pub fn status(
        &self,
        repository: &SqliteProjectRepository,
        id: &str,
    ) -> Result<MigrationOperationView> {
        let mut op = {
            let _lock = self.journal_lock()?;
            self.scoped(repository, id)?
        };
        if op.view.state == MigrationOperationViewState::Succeeded {
            return Ok(op.view);
        }
        if self.reconcile_ready(&mut op)? {
            let _lock = self.journal_lock()?;
            let mut current = self.scoped(repository, id)?;
            if current.view.state != MigrationOperationViewState::Succeeded {
                merge_ready(&mut current, &op)?;
                save(&self.operation(id), &current)?;
                self.remove_active(id)?;
            }
            return Ok(current.view);
        }
        Ok(op.view)
    }
    fn reconcile_ready(&self, op: &mut Operation) -> Result<bool> {
        let marker = self
            .target_path(&op.request.target_id)
            .join(".scenesparrow/migration-ready.json");
        if !marker.exists() {
            return Ok(false);
        }
        let ready: serde_json::Value = read(&marker)?;
        if ready["requestId"] != op.request.request_id
            || ready["targetId"] != op.request.target_id
            || ready["projectId"] != op.request.project_id
            || !ready["resultId"].as_str().is_some_and(sha)
            || !ready["backupId"].as_str().is_some_and(sha)
        {
            return Err(fail("MIGRATION_TARGET_INVALID"));
        }
        let source_hash = ready["sourceHash"]
            .as_str()
            .filter(|h| sha(h))
            .ok_or(fail("MIGRATION_TARGET_INVALID"))?;
        let backup_id = ready["backupId"]
            .as_str()
            .ok_or(fail("MIGRATION_TARGET_INVALID"))?;
        if op.view.backup_id.as_deref().is_some_and(|h| h != backup_id) {
            return Err(fail("MIGRATION_TARGET_INVALID"));
        }
        let expected = hash(&db(serde_json::to_vec(
            &serde_json::json!({"request":op.request,"backupId":backup_id,"sourceHash":source_hash,"serializer":"legacy-mdast-2.1.2-markers-v1"}),
        ))?);
        if ready["resultId"] != expected {
            return Err(fail("MIGRATION_TARGET_INVALID"));
        }
        let target = self.target_path(&op.request.target_id);
        if !matches!(SqliteProjectRepository::inspect_format(&target)?,crate::open_source::ProjectInspection::Managed(ref m) if m.project_id==op.request.project_id)
        {
            return Err(fail("MIGRATION_TARGET_INVALID"));
        }
        db(SqliteProjectRepository::inspect_project(
            &target.join(".scenesparrow"),
        ))
        .map_err(|_| fail("MIGRATION_TARGET_INVALID"))?;
        let connection = db(crate::Connection::open_with_flags(
            target.join(".scenesparrow/project.sqlite"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        ))?;
        let mut repository =
            SqliteProjectRepository::detached(&target.join(".scenesparrow"), connection);
        repository.creative_root = Some(target.clone());
        repository
            .verify_source_state()
            .map_err(|_| fail("MIGRATION_TARGET_INVALID"))?;
        let source = crate::open_source::source_row(&*db(repository.connection.lock())?)?
            .ok_or(fail("MIGRATION_TARGET_INVALID"))?;
        if source.2 != source_hash {
            return Err(fail("MIGRATION_TARGET_INVALID"));
        }
        let graph = repository
            .accepted_file_graph()?
            .ok_or(fail("MIGRATION_TARGET_INVALID"))?;
        for file in graph.graph.files {
            let parent = crate::open_source::physical::Parent::open(&target, &file.path)
                .map_err(|_| fail("MIGRATION_TARGET_INVALID"))?;
            let (mut input, _) = parent
                .open_file(&parent.name)
                .map_err(|_| fail("MIGRATION_TARGET_INVALID"))?
                .ok_or(fail("MIGRATION_TARGET_INVALID"))?;
            let (hash, size) =
                crate::storage::objects::stream_copy(&mut input, &mut std::io::sink(), file.size)
                    .map_err(|_| fail("MIGRATION_TARGET_INVALID"))?;
            if hash != file.hash || size != file.size {
                return Err(fail("MIGRATION_TARGET_INVALID"));
            }
        }

        op.view.state = MigrationOperationViewState::Succeeded;
        op.view.phase = MigrationOperationViewPhase::Ready;
        op.view.failure_code = None;
        op.view.result_id = ready["resultId"].as_str().map(String::from);
        op.view.backup_id = ready["backupId"].as_str().map(String::from);
        op.view.operation_revision += 1;
        Ok(true)
    }
    fn remove_active(&self, id: &str) -> Result<()> {
        let mut index = self.index()?;
        index.ids.retain(|x| x != id);
        save(&self.directory.join("active.json"), &index)
    }
    pub fn control(
        &self,
        repository: &SqliteProjectRepository,
        id: &str,
        request: &MigrationControlRequest,
    ) -> Result<MigrationOperationView> {
        uuid(&request.request_id)?;
        uuid(id)?;
        let source = repository.migration_source_identity()?;
        let digest = hash(&db(serde_json::to_vec(&(id, request)))?);
        let path = self
            .directory
            .join(format!("control-{}.json", request.request_id));
        {
            let _lock = self.journal_lock()?;
            if let Some(old) = self.replay(&path, &digest, &source)? {
                return Ok(old);
            }
        }
        let status = self.status(repository, id);
        let inspected = if request.action == MigrationControlRequestAction::Retry {
            Some(repository.inspect_legacy_migration())
        } else {
            None
        };
        let _lock = self.journal_lock()?;
        if let Some(old) = self.replay(&path, &digest, &source)? {
            return Ok(old);
        }
        let mut changed = None;
        let mut next_index = self.index()?;
        let outcome = (|| {
            status?;
            if request.request_id == id {
                return Err(fail("INVALID_REQUEST"));
            }
            let mut op = self.scoped(repository, id)?;
            if request.operation_id != id || request.project_id != op.request.project_id {
                return Err(fail("MIGRATION_NOT_FOUND"));
            }
            if op.view.state == MigrationOperationViewState::Succeeded {
                return Ok(op.view);
            }
            if request.expected_operation_revision != op.view.operation_revision {
                return Err(fail("MIGRATION_REVISION_CONFLICT"));
            }
            match request.action {
                MigrationControlRequestAction::Cancel => {
                    if active(&op.view.state) {
                        op.cancel = true;
                        if op.view.state == MigrationOperationViewState::Queued {
                            op.view.state = MigrationOperationViewState::Cancelled;
                            next_index.ids.retain(|x| x != id);
                        }
                    }
                }
                MigrationControlRequestAction::Retry => {
                    if active(&op.view.state)
                        || op.view.state == MigrationOperationViewState::Succeeded
                    {
                        return Err(fail("MIGRATION_REVISION_CONFLICT"));
                    }
                    let inspected = inspected.ok_or(fail("INVALID_REQUEST"))??;
                    if inspected.content_base != op.request.content_base {
                        return Err(fail("MIGRATION_BASE_MISMATCH"));
                    }
                    if self.target_path(&op.request.target_id).exists() {
                        return Err(fail("MIGRATION_TARGET_INVALID"));
                    }
                    let mut index = self.index()?;
                    if index.ids.len() + index.package_ids.len() >= 5 {
                        return Err(fail("MIGRATION_QUEUE_FULL"));
                    }
                    op.view.state = MigrationOperationViewState::Queued;
                    op.view.phase = MigrationOperationViewPhase::Queued;
                    op.view.failure_code = None;
                    op.cancel = false;
                    op.owner = self.owner.clone();
                    index.ids.push(id.into());
                    next_index = index;
                }
            }
            op.view.last_control_id = Some(request.request_id.clone());
            op.view.operation_revision += 1;
            let view = op.view.clone();
            changed = Some(op);
            Ok(view)
        })();
        self.commit(
            next_index,
            changed,
            None,
            &path,
            &Saved {
                digest,
                source,
                result: outcome.clone().map_err(|e| e.0.to_string()),
            },
        )?;
        outcome
    }
    /// One worker lease across processes; no project writer is held over I/O.
    pub fn run_next(&self, repository: &SqliteProjectRepository) -> Result<bool> {
        if self.working.swap(true, Ordering::AcqRel) {
            return Ok(false);
        }
        struct Reset<'a>(&'a AtomicBool);
        impl Drop for Reset<'_> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::Release);
            }
        }
        let _reset = Reset(&self.working);
        let worker = db(File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.directory.join("worker.lock")))?;
        if worker.try_lock().is_err() {
            return Ok(false);
        }
        let _worker = Lease(worker);
        if repository.is_quiescing() {
            return Ok(false);
        }
        let _repository_worker = repository.worker_guard();
        if repository.is_quiescing() {
            return Ok(false);
        }
        let source = repository.migration_source_identity()?;
        let mut op = {
            let _lock = self.journal_lock()?;
            let index = self.index()?;
            let mut selected = None;
            for id in index.ids {
                let item: Operation = read(&self.operation(&id))?;
                if item.source == source
                    && item.owner == self.owner
                    && item.view.state == MigrationOperationViewState::Queued
                {
                    selected = Some(item);
                    break;
                }
            }
            let Some(mut op) = selected else {
                drop(_lock);
                return self.run_next_package(repository);
            };
            op.attempt += 1;
            op.view.state = MigrationOperationViewState::Running;
            op.view.operation_revision += 1;
            save(&self.operation(&op.request.request_id), &op)?;
            op
        };
        let id = op.request.request_id.clone();
        let target = self.target_path(&op.request.target_id);
        let staging = self.roots.join(format!(".migration-{}-{}", id, op.attempt));
        let backup = self.directory.join(format!("backup-{}-{}", id, op.attempt));
        let result = migrate_legacy(
            MigrationPaths {
                source: repository.migration_source_directory(),
                backup: &backup,
                staging: &staging,
                target: &target,
                target_id: &op.request.target_id,
            },
            &op.request,
            |phase, backup| {
                #[cfg(test)]
                if phase == MigrationOperationViewPhase::Backup {
                    let hook = db(self.hook.lock())?.take();
                    if let Some(h) = hook {
                        h();
                    }
                }
                let progress = if backup.is_some() {
                    let mut bytes = 0u64;
                    let mut objects = 0u64;
                    for folder in ["objects", "exports"] {
                        for item in db(std::fs::read_dir(
                            backup_path(&self.directory, &id, op.attempt).join(folder),
                        ))? {
                            let item = db(item)?;
                            bytes = bytes
                                .checked_add(db(item.metadata())?.len())
                                .ok_or(fail("MIGRATION_SIZE_LIMIT"))?;
                            objects += 1;
                        }
                    }
                    bytes = bytes
                        .checked_add(
                            db(std::fs::metadata(
                                backup_path(&self.directory, &id, op.attempt)
                                    .join("project.sqlite"),
                            ))?
                            .len(),
                        )
                        .ok_or(fail("MIGRATION_SIZE_LIMIT"))?;
                    if bytes > manuscript::MAX_REVISION as u64
                        || objects > manuscript::MAX_REVISION as u64
                    {
                        return Err(fail("MIGRATION_SIZE_LIMIT"));
                    }
                    Some((bytes as i64, objects as i64))
                } else {
                    None
                };
                let _lock = self.journal_lock()?;
                let mut current: Operation = read(&self.operation(&id))?;
                let cancelled = current.cancel || repository.is_quiescing();
                current.view.phase = phase;
                current.view.operation_revision += 1;
                if let Some((bytes, objects)) = progress {
                    current.view.completed_bytes = bytes;
                    current.view.completed_objects = objects;
                }
                if let Some(h) = backup {
                    current.view.backup_id = Some(h.into());
                }
                save(&self.operation(&id), &current)?;
                if cancelled {
                    Err(fail("MIGRATION_CANCELLED"))
                } else {
                    Ok(())
                }
            },
            || {
                repository.is_quiescing()
                    || read::<Operation>(&self.operation(&id)).map_or(true, |o| o.cancel)
            },
        );
        op = read(&self.operation(&id))?;
        let reconciled = self.reconcile_ready(&mut op);
        #[cfg(test)]
        {
            let hook = db(self.install_hook.lock())?.take();
            if let Some(hook) = hook {
                hook();
            }
        }
        let _lock = self.journal_lock()?;
        let mut current = self.scoped(repository, &id)?;
        same_attempt(&current, &op)?;
        if current.view.state != MigrationOperationViewState::Succeeded {
            match reconciled {
                Ok(true) => merge_ready(&mut current, &op)?,
                verification => {
                    let error = match verification {
                        Err(error) => error,
                        _ => result.err().unwrap_or(fail("MIGRATION_TARGET_INVALID")),
                    };
                    let cancelled = current.cancel
                        || repository.is_quiescing()
                        || error.0 == "MIGRATION_CANCELLED";
                    current.view.state = if cancelled {
                        MigrationOperationViewState::Cancelled
                    } else {
                        MigrationOperationViewState::Failed
                    };
                    current.view.failure_code = Some(if cancelled {
                        "MIGRATION_CANCELLED".into()
                    } else {
                        safe_code(error.0).into()
                    });
                    current.view.operation_revision =
                        manuscript::next_revision(current.view.operation_revision)?;
                }
            }
            save(&self.operation(&id), &current)?;
        }
        self.remove_active(&id)?;
        Ok(true)
    }
}
fn same_attempt(current: &Operation, captured: &Operation) -> Result<()> {
    if current.request != captured.request
        || current.source != captured.source
        || current.owner != captured.owner
        || current.attempt != captured.attempt
    {
        return Err(fail("MIGRATION_REVISION_CONFLICT"));
    }
    Ok(())
}
fn merge_ready(current: &mut Operation, verified: &Operation) -> Result<()> {
    same_attempt(current, verified)?;
    current.view.state = MigrationOperationViewState::Succeeded;
    current.view.phase = MigrationOperationViewPhase::Ready;
    current.view.failure_code = None;
    current.view.backup_id = verified.view.backup_id.clone();
    current.view.result_id = verified.view.result_id.clone();
    current.view.operation_revision = manuscript::next_revision(current.view.operation_revision)?;
    Ok(())
}
pub(super) fn safe_code(code: &str) -> &'static str {
    if let Some(code) = super::package::safe_code(code) {
        return code;
    }
    match code {
        "INVALID_REQUEST" => "INVALID_REQUEST",
        "PROJECT_NOT_FOUND" => "PROJECT_NOT_FOUND",
        "PROJECT_CLOSING" => "PROJECT_CLOSING",
        "MIGRATION_REQUEST_CONFLICT" => "MIGRATION_REQUEST_CONFLICT",
        "MIGRATION_LEGACY_REQUIRED" => "MIGRATION_LEGACY_REQUIRED",
        "MIGRATION_SOURCE_INVALID" => "MIGRATION_SOURCE_INVALID",
        "MIGRATION_TARGET_INVALID" => "MIGRATION_TARGET_INVALID",
        "MIGRATION_TARGET_EXISTS" => "MIGRATION_TARGET_EXISTS",
        "MIGRATION_BASE_MISMATCH" => "MIGRATION_BASE_MISMATCH",
        "MIGRATION_QUEUE_FULL" => "MIGRATION_QUEUE_FULL",
        "MIGRATION_CANCELLED" => "MIGRATION_CANCELLED",
        "MIGRATION_NOT_FOUND" => "MIGRATION_NOT_FOUND",
        "MIGRATION_REVISION_CONFLICT" => "MIGRATION_REVISION_CONFLICT",
        "MIGRATION_UNSUPPORTED" => "MIGRATION_UNSUPPORTED",
        "MIGRATION_SIZE_LIMIT" => "MIGRATION_SIZE_LIMIT",
        "MIGRATION_WORKER_UNAVAILABLE" => "MIGRATION_WORKER_UNAVAILABLE",
        "SCHEMA_UNSUPPORTED" => "SCHEMA_UNSUPPORTED",
        _ => "STORAGE_UNAVAILABLE",
    }
}
fn backup_path(directory: &Path, id: &str, attempt: u64) -> PathBuf {
    directory.join(format!("backup-{id}-{attempt}"))
}
#[cfg(test)]
mod tests {
    use super::*;
    use scenesparrow_application::ProjectRepository;
    fn id() -> String {
        uuid::Uuid::new_v4().to_string()
    }
    fn setup() -> (
        tempfile::TempDir,
        SqliteProjectRepository,
        ProjectTransferStore,
        LegacyMigrationRequest,
    ) {
        let d = tempfile::tempdir().unwrap();
        let r = SqliteProjectRepository::open(&d.path().join("source")).unwrap();
        let p = r.create("create", "Journal crash").unwrap();
        let store = ProjectTransferStore::open(&d.path().join("app")).unwrap();
        let target = store
            .issue_target(
                &r,
                &MigrationTargetRequest {
                    request_id: id(),
                    project_id: p.id.clone(),
                    destination: MigrationTargetRequestDestination::Managed,
                },
            )
            .unwrap();
        let i = r.inspect_legacy_migration().unwrap();
        let request = LegacyMigrationRequest {
            request_id: id(),
            project_id: p.id,
            content_base: i.content_base,
            target_id: target.target_id,
        };
        (d, r, store, request)
    }
    #[test]
    fn atomic_start_and_control_replay_survive_every_journal_write_cut() {
        for point in ["pending", "operation", "receipt", "index"] {
            let (d, r, store, request) = setup();
            *store.fault.lock().unwrap() = Some(point);
            assert_eq!(store.start(&r, &request).unwrap_err().0, "TEST_CUT");
            drop(store);
            let store = ProjectTransferStore::open(&d.path().join("app")).unwrap();
            let original = store.start(&r, &request).unwrap();
            assert_eq!(
                original.operation.state,
                MigrationOperationViewState::Queued
            );
            let status = store.status(&r, &request.request_id).unwrap();
            assert_eq!(status.state, MigrationOperationViewState::Interrupted);
            let mut changed = request.clone();
            changed.content_base = "f".repeat(64);
            assert_eq!(
                store.start(&r, &changed).unwrap_err().0,
                "MIGRATION_REQUEST_CONFLICT"
            );
            let control = MigrationControlRequest {
                request_id: id(),
                project_id: request.project_id,
                operation_id: request.request_id.clone(),
                expected_operation_revision: status.operation_revision,
                action: MigrationControlRequestAction::Retry,
            };
            *store.fault.lock().unwrap() = Some(point);
            assert_eq!(
                store
                    .control(&r, &request.request_id, &control)
                    .unwrap_err()
                    .0,
                "TEST_CUT"
            );
            drop(store);
            let store = ProjectTransferStore::open(&d.path().join("app")).unwrap();
            assert_eq!(
                store
                    .control(&r, &request.request_id, &control)
                    .unwrap()
                    .state,
                MigrationOperationViewState::Queued
            );
            let mut changed = control.clone();
            changed.action = MigrationControlRequestAction::Cancel;
            assert_eq!(
                store
                    .control(&r, &request.request_id, &changed)
                    .unwrap_err()
                    .0,
                "MIGRATION_REQUEST_CONFLICT"
            );
            assert_eq!(
                store.status(&r, &request.request_id).unwrap().state,
                MigrationOperationViewState::Interrupted
            );
        }
    }
    #[test]
    fn terminal_before_index_cleanup_never_consumes_queue_capacity() {
        let (_d, r, store, request) = setup();
        store.start(&r, &request).unwrap();
        {
            let _lock = store.journal_lock().unwrap();
            let mut op: Operation = read(&store.operation(&request.request_id)).unwrap();
            op.view.state = MigrationOperationViewState::Failed;
            save(&store.operation(&request.request_id), &op).unwrap();
        }
        let _lock = store.journal_lock().unwrap();
        assert!(store.index().unwrap().ids.is_empty());
    }
    #[test]
    fn corrupt_promoted_target_cannot_become_ready_from_marker_alone() {
        let (d, r, store, request) = setup();
        store.start(&r, &request).unwrap();
        store.run_next(&r).unwrap();
        let path = store.operation(&request.request_id);
        let mut op: Operation = read(&path).unwrap();
        op.view.state = MigrationOperationViewState::Running;
        save(&path, &op).unwrap();
        std::fs::remove_file(store.target_path(&request.target_id).join("manuscript.md")).unwrap();
        assert_eq!(
            store.status(&r, &request.request_id).unwrap_err().0,
            "MIGRATION_TARGET_INVALID"
        );
        assert!(d.path().join("source/project.sqlite").exists());
    }
}
#[cfg(test)]
mod responsiveness {
    use super::*;
    use scenesparrow_application::{ProjectRepository, manuscript::ManuscriptRepository};
    #[test]
    fn held_backup_worker_keeps_status_cancel_source_save_and_settings_responsive() {
        let d = tempfile::tempdir().unwrap();
        let r =
            std::sync::Arc::new(SqliteProjectRepository::open(&d.path().join("source")).unwrap());
        let p = r.create("create", "Held backup").unwrap();
        let store = std::sync::Arc::new(ProjectTransferStore::open(&d.path().join("app")).unwrap());
        let started = std::sync::Arc::new(std::sync::Barrier::new(2));
        let release = std::sync::Arc::new(std::sync::Barrier::new(2));
        let a = started.clone();
        let b = release.clone();
        *store.hook.lock().unwrap() = Some(std::sync::Arc::new(move || {
            a.wait();
            b.wait();
        }));
        let target = store
            .issue_target(
                &r,
                &MigrationTargetRequest {
                    request_id: uuid::Uuid::new_v4().to_string(),
                    project_id: p.id.clone(),
                    destination: MigrationTargetRequestDestination::Managed,
                },
            )
            .unwrap();
        let req = LegacyMigrationRequest {
            request_id: uuid::Uuid::new_v4().to_string(),
            project_id: p.id.clone(),
            target_id: target.target_id,
            content_base: r.inspect_legacy_migration().unwrap().content_base,
        };
        store.start(&r, &req).unwrap();
        let worker_store = store.clone();
        let source = r.clone();
        let worker = std::thread::spawn(move || worker_store.run_next(&source));
        started.wait();
        let now = std::time::Instant::now();
        let view = store.status(&r, &req.request_id).unwrap();
        assert_eq!(view.state, MigrationOperationViewState::Running);
        let command=serde_json::from_value(serde_json::json!({"type":"StartManualDraft","requestId":uuid::Uuid::new_v4().to_string(),"projectId":p.id,"expectedWorkingRevision":0,"payload":{}})).unwrap();
        r.execute_manuscript(&command).unwrap();
        let settings =
            crate::ai::settings::SettingsStore::open(&d.path().join("settings")).unwrap();
        use scenesparrow_application::ai::AiSettingsPort;
        settings.read_settings().unwrap();
        store
            .control(
                &r,
                &req.request_id,
                &MigrationControlRequest {
                    request_id: uuid::Uuid::new_v4().to_string(),
                    project_id: req.project_id.clone(),
                    operation_id: req.request_id.clone(),
                    expected_operation_revision: view.operation_revision,
                    action: MigrationControlRequestAction::Cancel,
                },
            )
            .unwrap();
        assert!(now.elapsed() < Duration::from_secs(2));
        release.wait();
        worker.join().unwrap().unwrap();
        assert_eq!(
            store.status(&r, &req.request_id).unwrap().state,
            MigrationOperationViewState::Cancelled
        );
    }
}
#[cfg(test)]
mod final_install_race {
    use super::*;
    use scenesparrow_application::{ProjectRepository, manuscript::ManuscriptRepository};
    #[test]
    fn late_cancel_control_survives_terminal_worker_install_and_original_receipt_replay() {
        let d = tempfile::tempdir().unwrap();
        let r =
            std::sync::Arc::new(SqliteProjectRepository::open(&d.path().join("source")).unwrap());
        let p = r.create("create", "Final installation").unwrap();
        let store = std::sync::Arc::new(ProjectTransferStore::open(&d.path().join("app")).unwrap());
        let target = store
            .issue_target(
                &r,
                &MigrationTargetRequest {
                    request_id: uuid::Uuid::new_v4().to_string(),
                    project_id: p.id.clone(),
                    destination: MigrationTargetRequestDestination::Managed,
                },
            )
            .unwrap();
        let req = LegacyMigrationRequest {
            request_id: uuid::Uuid::new_v4().to_string(),
            project_id: p.id.clone(),
            content_base: r.inspect_legacy_migration().unwrap().content_base,
            target_id: target.target_id,
        };
        store.start(&r, &req).unwrap();
        // Make the admitted base stale, then hold the worker after failed I/O and
        // outside-lock verification but before terminal journal installation.
        r.execute_manuscript(&serde_json::from_value(serde_json::json!({"type":"StartManualDraft","requestId":uuid::Uuid::new_v4().to_string(),"projectId":p.id,"expectedWorkingRevision":0,"payload":{}})).unwrap()).unwrap();
        let entered = std::sync::Arc::new(std::sync::Barrier::new(2));
        let release = std::sync::Arc::new(std::sync::Barrier::new(2));
        let a = entered.clone();
        let b = release.clone();
        *store.install_hook.lock().unwrap() = Some(std::sync::Arc::new(move || {
            a.wait();
            b.wait();
        }));
        let worker_store = store.clone();
        let worker_source = r.clone();
        let worker = std::thread::spawn(move || worker_store.run_next(&worker_source));
        entered.wait();
        let before = store.status(&r, &req.request_id).unwrap();
        let control = MigrationControlRequest {
            request_id: uuid::Uuid::new_v4().to_string(),
            project_id: req.project_id.clone(),
            operation_id: req.request_id.clone(),
            expected_operation_revision: before.operation_revision,
            action: MigrationControlRequestAction::Cancel,
        };
        let receipt = store.control(&r, &req.request_id, &control).unwrap();
        release.wait();
        worker.join().unwrap().unwrap();
        let final_view = store.status(&r, &req.request_id).unwrap();
        assert_eq!(final_view.state, MigrationOperationViewState::Cancelled);
        assert_eq!(
            final_view.last_control_id.as_deref(),
            Some(control.request_id.as_str())
        );
        assert!(final_view.operation_revision > receipt.operation_revision);
        assert_eq!(
            store.control(&r, &req.request_id, &control).unwrap(),
            receipt
        );
    }
    #[test]
    fn verified_ready_merge_keeps_newer_control_identity_and_cancel_facts() {
        let d = tempfile::tempdir().unwrap();
        let r = SqliteProjectRepository::open(&d.path().join("source")).unwrap();
        let p = r.create("create", "Ready merge").unwrap();
        let store = ProjectTransferStore::open(&d.path().join("app")).unwrap();
        let target = store
            .issue_target(
                &r,
                &MigrationTargetRequest {
                    request_id: uuid::Uuid::new_v4().to_string(),
                    project_id: p.id.clone(),
                    destination: MigrationTargetRequestDestination::Managed,
                },
            )
            .unwrap();
        let req = LegacyMigrationRequest {
            request_id: uuid::Uuid::new_v4().to_string(),
            project_id: p.id,
            content_base: r.inspect_legacy_migration().unwrap().content_base,
            target_id: target.target_id,
        };
        store.start(&r, &req).unwrap();
        store.run_next(&r).unwrap();
        let captured: Operation = read(&store.operation(&req.request_id)).unwrap();
        let mut current: Operation = read(&store.operation(&req.request_id)).unwrap();
        current.cancel = true;
        current.view.last_control_id = Some(uuid::Uuid::new_v4().to_string());
        current.view.operation_revision += 3;
        let control = current.view.last_control_id.clone();
        let revision = current.view.operation_revision;
        merge_ready(&mut current, &captured).unwrap();
        assert_eq!(current.view.last_control_id, control);
        assert!(current.cancel);
        assert_eq!(current.view.operation_revision, revision + 1);
        assert_eq!(current.view.state, MigrationOperationViewState::Succeeded);
    }
}
