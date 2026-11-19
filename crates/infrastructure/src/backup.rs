use super::*;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, io::Write, path::PathBuf};
fn digest(b: &[u8]) -> String {
    format!("{:x}", Sha256::digest(b))
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Inventory {
    pub(crate) schema: i64,
    pub(crate) objects: std::collections::BTreeSet<String>,
    pub(crate) exports: BTreeMap<String, String>,
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    version: u32,
    schema: i64,
    files: BTreeMap<String, String>,
}
fn flush(path: &Path) -> Result<(), Error> {
    storage(
        File::options()
            .read(true)
            .write(true)
            .open(path)
            .and_then(|f| f.sync_all()),
    )
}
fn sync_dir(path: &Path) -> Result<(), Error> {
    #[cfg(unix)]
    storage(File::open(path).and_then(|f| f.sync_all()))?;
    let _ = path;
    Ok(())
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct AuthoredBackup {
    manifest: String,
    managed: String,
}
pub(crate) fn snapshot(
    c: &Connection,
    source: &Path,
    target: &Path,
    creative: Option<&Path>,
) -> Result<(), Error> {
    snapshot_controlled(c, source, target, creative, &|| false)
}
pub(crate) fn snapshot_controlled(
    c: &Connection,
    source: &Path,
    target: &Path,
    creative: Option<&Path>,
    cancelled: &dyn Fn() -> bool,
) -> Result<(), Error> {
    // Materialize a WAL-aware read snapshot before SQLite backup. Inventory and
    // authored descriptors are then read from the completed backup, never a later
    // independent source connection.
    let transaction = if c.is_autocommit() {
        Some(storage(c.unchecked_transaction())?)
    } else {
        None
    };
    let _: i64 = storage(c.query_row("SELECT COUNT(*) FROM sqlite_master", [], |r| r.get(0)))?;
    storage(std::fs::create_dir(target))?;
    let mut backup = storage(Connection::open(target.join("project.sqlite")))?;
    {
        let writer = storage(rusqlite::backup::Backup::new(c, &mut backup))?;
        loop {
            if cancelled() {
                return Err(Error::Closing);
            }
            match storage(writer.step(32))? {
                rusqlite::backup::StepResult::Done => break,
                rusqlite::backup::StepResult::More => {}
                _ => std::thread::sleep(Duration::from_millis(10)),
            }
        }
    }
    storage(backup.execute_batch("PRAGMA journal_mode=DELETE"))?;
    if let Some(transaction) = transaction {
        storage(transaction.commit())?;
    }
    let schema = storage(backup.pragma_query_value(None, "user_version", |r| r.get(0)))?;
    let repository = SqliteProjectRepository::detached(source, backup);
    let inventory = repository.portable_inventory_locked()?;
    let backed_up = storage(repository.connection.lock())?;
    let c = &*backed_up;
    let mut files = BTreeMap::new();
    files.insert(
        "project.sqlite".into(),
        verify_file(&target.join("project.sqlite"))?,
    );
    flush(&target.join("project.sqlite"))?;
    for folder in ["objects", "exports"] {
        storage(std::fs::create_dir(target.join(folder)))?;
        let names: BTreeMap<String, String> = if folder == "objects" {
            inventory
                .objects
                .iter()
                .map(|h| (h.clone(), h.clone()))
                .collect()
        } else {
            inventory.exports.clone()
        };
        for (name, expected) in names {
            let original = source.join(folder).join(&name);
            if !storage(std::fs::symlink_metadata(&original))?.is_file() {
                return Err(Error::Storage);
            }
            let relative = format!("{folder}/{name}");
            let output = target.join(&relative);
            copy_verified_controlled(&original, &output, &expected, cancelled)?;
            files.insert(relative, expected);
        }
        sync_dir(&target.join(folder))?;
    }
    if let Some(root) = creative {
        let (mut manifest, managed) =
            SqliteProjectRepository::capture_source_descriptor(c, root, source)
                .map_err(|_| Error::Storage)?;
        if schema >= 13 {
            let graph: Option<String> = storage(
                c.query_row(
                    "SELECT graph_hash FROM accepted_file_graph WHERE singleton=1",
                    [],
                    |r| r.get(0),
                )
                .optional(),
            )?;
            if let Some(hash) = graph {
                let bytes = storage(std::fs::read(source.join("objects").join(&hash)))?;
                let graph: crate::open_source::graph::FileGraph =
                    storage(serde_json::from_slice(&bytes))?;
                let member = graph
                    .files
                    .iter()
                    .find(|f| f.path == "project.json")
                    .ok_or(Error::Storage)?;
                manifest = storage(String::from_utf8(storage(std::fs::read(
                    source.join("objects").join(&member.hash),
                ))?))?;
            }
        }
        let authored = AuthoredBackup { manifest, managed };
        let bytes = storage(serde_json::to_vec(&authored))?;
        let path = target.join("authored-project.json");
        let mut file = storage(File::options().write(true).create_new(true).open(&path))?;
        storage(file.write_all(&bytes))?;
        storage(file.sync_all())?;
        files.insert("authored-project.json".into(), digest(&bytes));
    }
    SqliteProjectRepository::inspect_project(target)?;
    // Completion is the last durable file. Incomplete directories cannot restore.
    let bytes = storage(serde_json::to_vec(&Manifest {
        version: 1,
        schema,
        files,
    }))?;
    let mut f = storage(
        File::options()
            .write(true)
            .create_new(true)
            .open(target.join("manifest.json")),
    )?;
    storage(f.write_all(&bytes))?;
    storage(f.sync_all())?;
    drop(f);
    sync_dir(target)?;
    sync_dir(target.parent().ok_or(Error::Storage)?)?;
    Ok(())
}
pub(super) fn migration_backup(
    c: &Connection,
    directory: &Path,
    version: u32,
) -> Result<(), Error> {
    snapshot(
        c,
        directory,
        &directory.join(format!(
            "pre-migration-{version:03}-{}",
            uuid::Uuid::new_v4()
        )),
        None,
    )
}
impl SqliteProjectRepository {
    pub fn verified_backup(&self) -> Result<PathBuf, Error> {
        let _operation = crate::storage::operation::Operation::begin("backup");
        if let Some(root) = &self.creative_root {
            let manifest = match Self::inspect_format(root).map_err(|_| Error::Storage)? {
                crate::open_source::ProjectInspection::Managed(manifest) => manifest,
                _ => return Err(Error::Storage),
            };
            if (manifest.audio.is_some() || manifest.video.is_some())
                && self
                    .accepted_file_graph()
                    .map_err(|_| Error::Storage)?
                    .is_none()
            {
                return Err(Error::Storage);
            }
        }
        let c = storage(self.connection.lock())?;
        let state = self.load(&c).map_err(|_| Error::Storage)?;
        self.verify_history(&c, &state)
            .map_err(|_| Error::Storage)?;
        self.verify_file_graph_history(&c)
            .map_err(|_| Error::Storage)?;

        self.verify_finalization(&c, &state)
            .map_err(|_| Error::Storage)?;
        for hash in self.retention_roots(&c).map_err(|_| Error::Storage)? {
            self.verify_object_stream(&hash)
                .map_err(|_| Error::Storage)?;
        }
        let mut q = storage(c.prepare("SELECT id FROM export_jobs WHERE status='ready'"))?;
        for id in storage(q.query_map([], |r| r.get::<_, String>(0)))? {
            let id = storage(id)?;
            let j = super::exports::read_job(&c, &id).map_err(|_| Error::Storage)?;
            let path = self.directory.join("exports").join(&id);
            if j.artifact_hash.as_deref() != Some(verify_file(&path)?.as_str())
                || j.size != storage(std::fs::metadata(&path))?.len() as i64
            {
                return Err(Error::Storage);
            }
        }
        let target = self
            .directory
            .join(format!("backup-{}", uuid::Uuid::new_v4()));
        if self.directory.join("source-intent.json").exists() {
            return Err(Error::Storage);
        }
        snapshot(&c, &self.directory, &target, self.creative_root.as_deref())?;
        Ok(target)
    }
    pub fn restore_verified_copy(source: &Path, target: &Path) -> Result<Self, Error> {
        if target.exists() {
            return Err(Error::Conflict);
        }
        let manifest: Manifest = storage(serde_json::from_slice(&storage(std::fs::read(
            source.join("manifest.json"),
        ))?))?;
        if manifest.version != 1
            || manifest.schema > 15
            || !manifest.files.contains_key("project.sqlite")
        {
            return Err(Error::Storage);
        }
        let inventory = Self::portable_inventory(source)?;
        if inventory.schema != manifest.schema {
            return Err(Error::Storage);
        }
        for name in inventory
            .objects
            .iter()
            .map(|h| format!("objects/{h}"))
            .chain(inventory.exports.keys().map(|id| format!("exports/{id}")))
        {
            if !manifest.files.contains_key(&name) {
                return Err(Error::Storage);
            }
        }
        for (name, h) in &manifest.files {
            let valid = name == "project.sqlite"
                || name == "authored-project.json"
                || name.strip_prefix("objects/").is_some_and(|n| {
                    n.len() == 64
                        && n.bytes()
                            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
                })
                || name
                    .strip_prefix("exports/")
                    .is_some_and(scenesparrow_domain::manuscript::uuid4);
            if !valid
                || (name.starts_with("objects/")
                    && name.strip_prefix("objects/") != Some(h.as_str()))
                || !storage(std::fs::symlink_metadata(source.join(name)))?.is_file()
                || verify_file(&source.join(name))? != *h
            {
                return Err(Error::Storage);
            }
        }
        let authored: Option<AuthoredBackup> =
            if manifest.files.contains_key("authored-project.json") {
                Some(storage(serde_json::from_slice(&storage(std::fs::read(
                    source.join("authored-project.json"),
                ))?))?)
            } else {
                None
            };
        let authored_manifest = authored
            .as_ref()
            .map(|descriptor| {
                match scenesparrow_domain::open_project::inspect_project_manifest(storage(
                    serde_json::from_str(&descriptor.manifest),
                )?)
                .map_err(|_| Error::Storage)?
                {
                    scenesparrow_domain::open_project::ManifestInspection::Supported(manifest) => {
                        Ok(manifest)
                    }
                    _ => Err(Error::Storage),
                }
            })
            .transpose()?;
        // Verify first, then make a new owner-locked copy; never replace the original.
        storage(std::fs::create_dir(target))?;
        let owned = storage(file_id::get_file_id(target))?;
        let result = (|| {
            let storage_target = if authored.is_some() {
                target.join(".scenesparrow")
            } else {
                target.to_path_buf()
            };
            storage(std::fs::create_dir_all(&storage_target))?;
            for (name, h) in &manifest.files {
                if name == "authored-project.json" {
                    continue;
                }
                let to = storage_target.join(name);
                storage(std::fs::create_dir_all(to.parent().ok_or(Error::Storage)?))?;
                copy_verified(&source.join(name), &to, h)?;
            }
            for directory in [
                storage_target.join("objects"),
                storage_target.join("exports"),
            ] {
                if directory.exists() {
                    sync_dir(&directory)?;
                }
            }
            sync_dir(target)?;
            sync_dir(target.parent().ok_or(Error::Storage)?)?;
            Self::inspect_project(&storage_target)?;
            if let (Some(descriptor), Some(project_manifest)) = (&authored, &authored_manifest) {
                let c = storage(Connection::open_with_flags(
                    storage_target.join("project.sqlite"),
                    rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
                ))?;
                let (project_id,relative_path,accepted_hash):(String,String,String)=storage(c.query_row("SELECT project_id,relative_path,accepted_hash FROM authored_source WHERE singleton=1",[],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))))?;
                if project_id != project_manifest.project_id
                    || relative_path != project_manifest.manuscript
                {
                    return Err(Error::Storage);
                }
                let bytes = storage(std::fs::read(
                    storage_target.join("objects").join(&accepted_hash),
                ))?;
                if digest(&bytes) != accepted_hash {
                    return Err(Error::Storage);
                }
                let manuscript_path = target.join(&relative_path);
                storage(std::fs::create_dir_all(
                    manuscript_path.parent().ok_or(Error::Storage)?,
                ))?;
                storage(std::fs::write(&manuscript_path, &bytes))?;
                flush(&manuscript_path)?;
                storage(std::fs::write(
                    target.join("project.json"),
                    &descriptor.manifest,
                ))?;
                flush(&target.join("project.json"))?;
                storage(std::fs::write(
                    storage_target.join("managed.json"),
                    &descriptor.managed,
                ))?;
                flush(&storage_target.join("managed.json"))?;
                let version: i64 =
                    storage(c.pragma_query_value(None, "user_version", |r| r.get(0)))?;
                if version >= 13 {
                    let graph: Option<String> = storage(
                        c.query_row(
                            "SELECT graph_hash FROM accepted_file_graph WHERE singleton=1",
                            [],
                            |r| r.get(0),
                        )
                        .optional(),
                    )?;
                    if let Some(hash) = graph {
                        let bytes =
                            storage(std::fs::read(storage_target.join("objects").join(&hash)))?;
                        if digest(&bytes) != hash {
                            return Err(Error::Storage);
                        }
                        let graph: crate::open_source::graph::FileGraph =
                            storage(serde_json::from_slice(&bytes))?;
                        for file in graph.files {
                            scenesparrow_domain::open_project::validate_portable_paths(&[
                                &file.path
                            ])
                            .map_err(|_| Error::Storage)?;
                            let output = target.join(&file.path);
                            storage(std::fs::create_dir_all(
                                output.parent().ok_or(Error::Storage)?,
                            ))?;
                            // These paths are in a fresh, private restore directory.
                            if output.exists() {
                                storage(std::fs::remove_file(&output))?;
                            }
                            copy_verified(
                                &storage_target.join("objects").join(&file.hash),
                                &output,
                                &file.hash,
                            )?;
                            sync_dir(output.parent().ok_or(Error::Storage)?)?;
                        }
                    }
                }
                sync_dir(&storage_target)?;
                sync_dir(target)?;
            }
            // Unknown native identity fences every copied nonterminal run, queued too.
            Self::open(target)
        })();
        if result.is_err()
            && std::fs::symlink_metadata(target)
                .is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink())
            && file_id::get_file_id(target).is_ok_and(|id| id == owned)
        {
            let _ = std::fs::remove_dir_all(target);
        }
        result
    }
}
impl SqliteProjectRepository {
    /// Read-only preflight never activates copied queues or creates a database.
    pub fn inspect_available_project(directory: &Path) -> Result<(), Error> {
        if directory.join("project.json").exists() || directory.join(".scenesparrow").exists() {
            if !matches!(
                Self::inspect_format(directory).map_err(|_| Error::Storage)?,
                crate::open_source::ProjectInspection::Managed(_)
            ) {
                return Err(Error::Storage);
            }
            return Self::inspect_available_project(&directory.join(".scenesparrow"));
        }
        let lock = directory.join(".core.lock");
        let _owner = if lock.exists() {
            if !storage(std::fs::symlink_metadata(&lock))?.is_file() {
                return Err(Error::Storage);
            }
            let file = storage(File::options().read(true).write(true).open(lock))?;
            Some(ProjectOwner::acquire(file)?)
        } else {
            None
        };
        Self::inspect_project(directory)
    }
    pub fn inspect_project(directory: &Path) -> Result<(), Error> {
        Self::portable_inventory(directory).map(|_| ())
    }
    fn portable_inventory(directory: &Path) -> Result<Inventory, Error> {
        for component in ["objects", "staging", "exports"] {
            let path = directory.join(component);
            if std::fs::symlink_metadata(&path)
                .is_ok_and(|m| !m.is_dir() || m.file_type().is_symlink())
            {
                return Err(Error::Storage);
            }
        }
        if !directory.is_dir() {
            return Err(Error::Storage);
        }
        if !directory.join("project.sqlite").exists() {
            return if storage(std::fs::read_dir(directory))?.next().is_none() {
                Ok(Inventory {
                    schema: 0,
                    objects: Default::default(),
                    exports: Default::default(),
                })
            } else {
                Err(Error::Storage)
            };
        }
        if !storage(std::fs::symlink_metadata(directory.join("project.sqlite")))?.is_file() {
            return Err(Error::Storage);
        }
        let c = storage(Connection::open_with_flags(
            directory.join("project.sqlite"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        ))?;
        Self::detached(directory, c).portable_inventory_locked()
    }
    pub(crate) fn detached(directory: &Path, c: Connection) -> Self {
        Self {
            creative_root: None,
            #[cfg(test)]
            source_fault: Mutex::new(None),
            #[cfg(test)]
            source_action: Mutex::new(None),
            #[cfg(test)]
            business_read_count: std::sync::atomic::AtomicUsize::new(0),
            #[cfg(test)]
            fail_export_directory_sync: std::sync::atomic::AtomicBool::new(false),
            source_observation: Mutex::new(open_source::Observation::default()),
            preparation_leases: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            preparation_worker: std::sync::atomic::AtomicBool::new(false),
            connection: Mutex::new(c),
            directory: directory.to_path_buf(),
            policy: Arc::new(scenesparrow_domain::manuscript::Unrestricted),
            ai_consumers: Mutex::new(BTreeMap::new()),
            quiescing: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            workers: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            _owner: None,
        }
    }
    pub(crate) fn portable_inventory_locked(&self) -> Result<Inventory, Error> {
        let repository = self;
        let directory = &self.directory;
        let c = storage(self.connection.lock())?;
        let version: i64 = storage(c.pragma_query_value(None, "user_version", |r| r.get(0)))?;
        if !(1..=15).contains(&version) {
            return Err(Error::SchemaUnsupported);
        }
        let integrity: String = storage(c.query_row("PRAGMA quick_check", [], |r| r.get(0)))?;
        if integrity != "ok" {
            return Err(Error::Storage);
        }
        let mut inventory = Inventory {
            schema: version,
            objects: Default::default(),
            exports: Default::default(),
        };
        let project = read_project(&c)?;
        if version >= 2 {
            if project.is_some() {
                let state = repository.load(&c).map_err(|_| Error::Storage)?;
                if project
                    .as_ref()
                    .is_some_and(|p| p.working_revision != state.working_revision)
                {
                    return Err(Error::Storage);
                }
                if version >= 3 {
                    repository
                        .verify_history(&c, &state)
                        .map_err(|_| Error::Storage)?;
                }
                if version >= 13 {
                    repository
                        .verify_file_graph_history(&c)
                        .map_err(|_| Error::Storage)?;
                }
                if version >= 8 {
                    repository
                        .verify_finalization(&c, &state)
                        .map_err(|_| Error::Storage)?;
                }
            } else {
                let count: i64 = storage(c.query_row(
                    "SELECT (SELECT COUNT(*) FROM manuscripts)+(SELECT COUNT(*) FROM blocks)",
                    [],
                    |r| r.get(0),
                ))?;
                if count != 0 {
                    return Err(Error::Storage);
                }
            }
            for h in repository.retention_roots(&c).map_err(|_| Error::Storage)? {
                repository
                    .verify_object_stream(&h)
                    .map_err(|_| Error::Storage)?;
                inventory.objects.insert(h);
            }
        }
        if version >= 5 {
            let mut q = storage(c.prepare("SELECT run_id FROM ai_runs"))?;
            for row in storage(q.query_map([], |r| r.get::<_, String>(0)))? {
                Self::ai_run(&c, &storage(row)?).map_err(|_| Error::Storage)?;
            }
        }
        if version >= 9 {
            repository
                .verify_export_records(&c)
                .map_err(|_| Error::Storage)?;
            let mut s = storage(
                c.prepare("SELECT id,artifact_hash,size FROM export_jobs WHERE status='ready'"),
            )?;
            for row in storage(s.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, u64>(2)?,
                ))
            }))? {
                let (id, h, n) = storage(row)?;
                if !scenesparrow_domain::manuscript::uuid4(&id) {
                    return Err(Error::Storage);
                }
                let path = directory.join("exports").join(&id);
                if storage(std::fs::metadata(&path))?.len() != n || verify_file(&path)? != h {
                    return Err(Error::Storage);
                }
                inventory.exports.insert(id, h);
            }
        }
        Ok(inventory)
    }
}

fn verify_file(path: &Path) -> Result<String, Error> {
    let mut input = crate::storage::objects::open_regular(path).map_err(|_| Error::Storage)?;
    crate::storage::objects::stream_copy(&mut input, &mut std::io::sink(), u64::MAX)
        .map(|p| p.0)
        .map_err(|_| Error::Storage)
}
fn copy_verified(source: &Path, target: &Path, expected: &str) -> Result<(), Error> {
    copy_verified_controlled(source, target, expected, &|| false)
}
fn copy_verified_controlled(
    source: &Path,
    target: &Path,
    expected: &str,
    cancelled: &dyn Fn() -> bool,
) -> Result<(), Error> {
    let mut input = crate::storage::objects::open_regular(source).map_err(|_| Error::Storage)?;
    let mut output = storage(File::options().write(true).create_new(true).open(target))?;
    use std::io::Read;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        if cancelled() {
            return Err(Error::Closing);
        }
        let n = storage(input.read(&mut buffer))?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
        storage(output.write_all(&buffer[..n]))?;
    }
    let actual = format!("{:x}", hasher.finalize());
    storage(output.sync_all())?;
    drop(output);
    if actual != expected || verify_file(target)? != expected {
        return Err(Error::Storage);
    }
    Ok(())
}

/// Byte-only preparation: it deliberately does not run normal repository startup.
pub(crate) fn copy_verified_storage(
    source: &Path,
    target: &Path,
    cancelled: &dyn Fn() -> bool,
) -> Result<String, Error> {
    if target.exists() {
        return Err(Error::Conflict);
    }
    let bytes = storage(std::fs::read(source.join("manifest.json")))?;
    let manifest: Manifest = storage(serde_json::from_slice(&bytes))?;
    if manifest.version != 1 || !(1..=15).contains(&manifest.schema) {
        return Err(Error::Storage);
    }
    let inventory = SqliteProjectRepository::portable_inventory(source)?;
    let expected: std::collections::BTreeSet<String> = std::iter::once("project.sqlite".into())
        .chain(inventory.objects.iter().map(|h| format!("objects/{h}")))
        .chain(inventory.exports.keys().map(|h| format!("exports/{h}")))
        .collect();
    if inventory.schema != manifest.schema
        || manifest
            .files
            .keys()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>()
            != expected
    {
        return Err(Error::Storage);
    }
    for (name, hash) in &manifest.files {
        if verify_file(&source.join(name))? != *hash {
            return Err(Error::Storage);
        }
    }
    storage(std::fs::create_dir(target))?;
    for directory in ["objects", "exports", "staging"] {
        storage(std::fs::create_dir(target.join(directory)))?;
    }
    for (name, hash) in &manifest.files {
        copy_verified_controlled(&source.join(name), &target.join(name), hash, cancelled)?;
    }
    sync_dir(target)?;
    Ok(digest(&bytes))
}

pub(crate) fn manifest_identity(directory: &Path) -> Result<String, Error> {
    verify_file(&directory.join("manifest.json"))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use scenesparrow_application::{ProjectRepository, manuscript::ManuscriptRepository};
    pub(crate) fn downgrade(repo: &SqliteProjectRepository, version: i64) {
        let c = repo.connection.lock().unwrap();
        c.pragma_update(None, "foreign_keys", false).unwrap();
        if (9..12).contains(&version) {
            c.execute_batch("ALTER TABLE export_jobs DROP COLUMN serializer_version")
                .unwrap();
        }
        if version < 15 {
            c.execute_batch("DROP TRIGGER IF EXISTS package_intake_decision_retention")
                .unwrap();
        }
        let migrations = [
            (15, include_str!("../migrations/015_project_packages.sql")),
            (13, include_str!("../migrations/013_file_graph.sql")),
            (14, include_str!("../migrations/014_external_work.sql")),
            (11, include_str!("../migrations/011_open_source.sql")),
            (12, include_str!("../migrations/012_source_candidates.sql")),
            (10, include_str!("../migrations/010_project_metadata.sql")),
            (9, include_str!("../migrations/009_exports.sql")),
            (8, include_str!("../migrations/008_finalization.sql")),
            (7, include_str!("../migrations/007_review.sql")),
            (6, include_str!("../migrations/006_planning.sql")),
            (5, include_str!("../migrations/005_shared_ai.sql")),
            (4, include_str!("../migrations/004_sources_import.sql")),
            (3, include_str!("../migrations/003_history.sql")),
        ];
        for (number, sql) in migrations {
            if number > version {
                let tokens = sql.split_whitespace().collect::<Vec<_>>();
                for words in tokens.windows(3) {
                    if words[0] == "CREATE" && words[1] == "TABLE" {
                        let table = words[2].split('(').next().unwrap();
                        c.execute_batch(&format!("DROP TABLE IF EXISTS {table}"))
                            .unwrap();
                    }
                }
            }
        }
        if version < 3 {
            c.execute_batch("ALTER TABLE edit_groups DROP COLUMN scope_block_id;ALTER TABLE edit_groups DROP COLUMN last_commit_ms;").unwrap();
        }
        c.pragma_update(None, "user_version", version).unwrap();
        c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").unwrap();
    }
    #[test]
    fn legacy_active_only_roots_are_verified_without_mutating_a_rejected_selection_or_completing_backup()
     {
        for version in [4, 5, 6, 7] {
            let d = tempfile::tempdir().unwrap();
            let r = SqliteProjectRepository::open(d.path()).unwrap();
            r.create("legacy", "Legacy graph").unwrap();
            downgrade(&r, version);
            let missing = "a".repeat(64);
            {
                let c = r.connection.lock().unwrap();
                if version == 4 {
                    c.execute("INSERT INTO document_attempts VALUES(?1,1,'queued','import',?2,'input.txt',0,NULL,NULL,NULL,NULL)",params![uuid::Uuid::new_v4().to_string(),missing]).unwrap();
                } else if version <= 6 {
                    c.execute("INSERT INTO ai_input_snapshots VALUES(?1,?1,1)", [&missing])
                        .unwrap();
                } else {
                    c.execute("INSERT INTO review_tasks(run_id,thread_id,request_version,context_hash,operation) VALUES(?1,?2,1,?3,'question')",params![uuid::Uuid::new_v4().to_string(),uuid::Uuid::new_v4().to_string(),missing]).unwrap();
                }
                c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").unwrap();
            }
            drop(r);
            let before = std::fs::read(d.path().join("project.sqlite")).unwrap();
            assert!(SqliteProjectRepository::inspect_project(d.path()).is_err());
            assert_eq!(
                std::fs::read(d.path().join("project.sqlite")).unwrap(),
                before
            );
            let c = Connection::open(d.path().join("project.sqlite")).unwrap();
            let target = d.path().join("incomplete-backup");
            assert!(snapshot(&c, d.path(), &target, None).is_err());
            assert!(!target.join("manifest.json").exists());
            assert_eq!(
                c.pragma_query_value::<i64, _>(None, "user_version", |r| r.get(0))
                    .unwrap(),
                version
            );
        }
    }
    #[test]
    fn every_supported_legacy_schema_upgrades_to_latest_and_backup_manifest_verifies_its_actual_graph()
     {
        for version in 1..=11 {
            let d = tempfile::tempdir().unwrap();
            let r = SqliteProjectRepository::open(d.path()).unwrap();
            r.create("legacy", "Legacy direct upgrade").unwrap();
            if version == 1 {
                let c = r.connection.lock().unwrap();
                c.pragma_update(None, "foreign_keys", false).unwrap();
                let tables = {
                    let mut q=c.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('project','sqlite_sequence')").unwrap();
                    q.query_map([], |row| row.get::<_, String>(0))
                        .unwrap()
                        .collect::<std::result::Result<Vec<_>, _>>()
                        .unwrap()
                };
                for table in tables {
                    c.execute_batch(&format!("DROP TABLE {table}")).unwrap();
                }
                c.pragma_update(None, "user_version", 1).unwrap();
            } else {
                downgrade(&r, version);
            }
            drop(r);
            SqliteProjectRepository::inspect_project(d.path()).unwrap();
            let opened = SqliteProjectRepository::open(d.path())
                .unwrap_or_else(|e| panic!("legacy version {version}: {e:?}"));
            assert_eq!(
                opened.read().unwrap().unwrap().title,
                "Legacy direct upgrade"
            );
            assert_eq!(opened.read_manuscript().unwrap().blocks.len(), 0);
            assert_eq!(
                opened
                    .connection
                    .lock()
                    .unwrap()
                    .pragma_query_value::<i64, _>(None, "user_version", |r| r.get(0))
                    .unwrap(),
                15
            );
            let backup = opened.verified_backup().unwrap();
            assert!(backup.join("manifest.json").is_file());
            SqliteProjectRepository::inspect_project(&backup).unwrap();
        }
    }
}
