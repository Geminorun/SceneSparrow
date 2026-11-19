use super::*;
use crate::{
    Connection, backup,
    worker_process::{self, WorkerChild},
};
use rusqlite::{OpenFlags, params};
use scenesparrow_domain::{manuscript::BusinessSnapshot, source};
use std::{
    fs::File,
    io::{Read, Write},
    time::{Duration, Instant},
};

/// Private trusted filesystem seam. Public transports use journal capabilities.
pub struct MigrationPaths<'a> {
    pub source: &'a Path,
    pub backup: &'a Path,
    pub staging: &'a Path,
    pub target: &'a Path,
    pub target_id: &'a str,
}
fn read_only(path: &Path) -> Result<Connection> {
    if !db(std::fs::symlink_metadata(path))?.is_file() {
        return Err(fail("MIGRATION_SOURCE_INVALID"));
    }
    db(Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    ))
}
fn legacy_connection(root: &Path) -> Result<Connection> {
    if !db(std::fs::symlink_metadata(root))?.is_dir()
        || root.file_name().is_some_and(|n| n == ".scenesparrow")
        || ["project.json", ".scenesparrow", "managed.json"]
            .iter()
            .any(|n| std::fs::symlink_metadata(root.join(n)).is_ok())
    {
        return Err(fail("MIGRATION_LEGACY_REQUIRED"));
    }
    let c = read_only(&root.join("project.sqlite"))?;
    let version: i64 = db(c.pragma_query_value(None, "user_version", |r| r.get(0)))?;
    if !(1..=14).contains(&version) {
        return Err(fail("SCHEMA_UNSUPPORTED"));
    }
    if version >= 11 {
        let count: i64 = db(c.query_row("SELECT COUNT(*) FROM authored_source", [], |r| r.get(0)))?;
        if count != 0 {
            return Err(fail("MIGRATION_LEGACY_REQUIRED"));
        }
    }
    Ok(c)
}
pub fn inspect_legacy(root: &Path) -> Result<LegacyMigrationInspection> {
    let c = legacy_connection(root)?;
    db(c.execute_batch("BEGIN"))?;
    let repository = SqliteProjectRepository::detached(root, c);
    // Same transaction verifies roots and computes stable saved-content identity.
    db(repository.portable_inventory_locked())?;
    inspection(&repository)
}
fn inspection(repository: &SqliteProjectRepository) -> Result<LegacyMigrationInspection> {
    let c = db(repository.connection.lock())?;
    let project = db(read_project(&c))?.ok_or(fail("PROJECT_NOT_FOUND"))?;
    uuid(&project.id)?;
    let version: i64 = db(c.pragma_query_value(None, "user_version", |r| r.get(0)))?;
    let mut block_count = 0;
    let mut business = None;
    let mut working = None;
    if version >= 2 {
        let state = repository.load(&c)?;
        block_count = state.blocks.len() as i64;
        business = Some(SqliteProjectRepository::business(&c, &state)?);
        working = Some(state);
    }
    let mut histories = vec![];
    let (history_revision, cursor) = if version >= 3 {
        let mut q =
            db(c.prepare("SELECT before_hash,after_hash FROM history_entries ORDER BY position"))?;
        for row in db(q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))))? {
            histories.push(db(row)?);
        }
        db(c.query_row(
            "SELECT history_revision,cursor FROM history_cursor",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ))?
    } else {
        (0, 0)
    };
    let content_base = hash(&db(serde_json::to_vec(
        &serde_json::json!({"project": {"id":project.id,"title":project.title,"revision":project.working_revision,"approved":project.approved_baseline},"schema":version,"working":working,"business":business,"history":histories,"historyRevision":history_revision,"cursor":cursor}),
    ))?);
    Ok(LegacyMigrationInspection {
        project_id: project.id,
        legacy_schema: version,
        working_revision: project.working_revision,
        history_revision,
        cursor,
        history_count: histories.len() as i64,
        block_count,
        retained_object_count: repository.retention_roots(&c)?.len() as i64,
        content_base,
        supported: true,
    })
}
fn sync(path: &Path) -> Result<()> {
    db(File::open(path).and_then(|f| f.sync_all()))
}
fn write(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut f = db(File::options().write(true).create_new(true).open(path))?;
    db(f.write_all(bytes))?;
    db(f.sync_all())
}
fn serialize(blocks: &[NewBlock], cancelled: &dyn Fn() -> bool) -> Result<String> {
    const ENVELOPE: u64 = 32 * 1024 * 1024;
    let bytes = db(serde_json::to_vec(blocks))?;
    if bytes.len() as u64 > ENVELOPE {
        return Err(fail("MIGRATION_SIZE_LIMIT"));
    }
    let entry = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../workers/document/src/migration-entry.mjs");
    let mut child = WorkerChild(
        worker_process::document_command(&entry)
            .spawn()
            .map_err(|_| fail("MIGRATION_WORKER_UNAVAILABLE"))?,
    );
    let mut stdin = child
        .stdin
        .take()
        .ok_or(fail("MIGRATION_WORKER_UNAVAILABLE"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or(fail("MIGRATION_WORKER_UNAVAILABLE"))?;
    let writer = std::thread::spawn(move || stdin.write_all(&bytes));
    let reader = std::thread::spawn(move || {
        let mut bytes = vec![];
        stdout
            .take(ENVELOPE + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let start = Instant::now();
    let result = loop {
        if cancelled() {
            break Err(fail("MIGRATION_CANCELLED"));
        }
        if start.elapsed() > Duration::from_secs(30) {
            break Err(fail("MIGRATION_WORKER_UNAVAILABLE"));
        }
        #[cfg(target_os = "linux")]
        if worker_process::resident_kib(child.id()).is_some_and(|k| k > 512 * 1024) {
            break Err(fail("MIGRATION_SIZE_LIMIT"));
        }
        match child.try_wait() {
            Ok(Some(_)) => break Ok(()),
            Ok(None) => {}
            Err(_) => break Err(fail("MIGRATION_WORKER_UNAVAILABLE")),
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let _ = child.kill();
    let _ = child.wait();
    let written = writer.join().ok().is_some_and(|r| r.is_ok());
    let output = reader
        .join()
        .ok()
        .and_then(|r| r.ok())
        .ok_or(fail("MIGRATION_WORKER_UNAVAILABLE"))?;
    result?;
    if !written || output.len() as u64 > ENVELOPE {
        return Err(fail("MIGRATION_SIZE_LIMIT"));
    }
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Response {
        source: Option<String>,
        serializer: Option<String>,
        error: Option<String>,
    }
    let output: Response =
        serde_json::from_slice(&output).map_err(|_| fail("MIGRATION_UNSUPPORTED"))?;
    if output.error.as_deref() == Some("MIGRATION_SIZE_LIMIT") {
        return Err(fail("MIGRATION_SIZE_LIMIT"));
    }
    let text = output.source.ok_or(fail("MIGRATION_UNSUPPORTED"))?;
    if output.serializer.as_deref() != Some("legacy-mdast-2.1.2-markers-v1")
        || text.len() > 4 * 1024 * 1024
    {
        return Err(fail("MIGRATION_SIZE_LIMIT"));
    }
    let ids = blocks.iter().map(|b| b.id.as_str()).collect::<Vec<_>>();
    let parsed =
        source::read_source(text.as_bytes(), &ids).map_err(|_| fail("MIGRATION_UNSUPPORTED"))?;
    let projected = source::project(&parsed).map_err(|_| fail("MIGRATION_UNSUPPORTED"))?;
    if projected != blocks {
        return Err(fail("MIGRATION_UNSUPPORTED"));
    }
    Ok(text)
}
fn derived(
    repository: &SqliteProjectRepository,
    blocks: &[NewBlock],
    cache: &mut std::collections::BTreeMap<String, String>,
    cancelled: &dyn Fn() -> bool,
) -> Result<String> {
    if cancelled() {
        return Err(fail("MIGRATION_CANCELLED"));
    }
    let key = hash(&db(serde_json::to_vec(blocks))?);
    if let Some(h) = cache.get(&key) {
        return Ok(h.clone());
    }
    let text = serialize(blocks, cancelled)?;
    let h = repository.object(text.as_bytes())?;
    cache.insert(key, h.clone());
    Ok(h)
}
/// Convert only a captured verified generation; never mutates or opens the source writer.
/// Phase callback is also the cancellation/checkpoint seam. Residual private bytes
/// are retained after any failure; replay never reconstructs deletion authority.
pub fn migrate_legacy(
    paths: MigrationPaths<'_>,
    request: &LegacyMigrationRequest,
    mut report_phase: impl FnMut(MigrationOperationViewPhase, Option<&str>) -> Result<()>,
    cancelled: impl Fn() -> bool,
) -> Result<String> {
    uuid(&request.request_id)?;
    uuid(&request.project_id)?;
    uuid(&request.target_id)?;
    if !sha(&request.content_base) || request.target_id != paths.target_id {
        return Err(fail("INVALID_REQUEST"));
    }
    let prospective = |path: &Path| -> Result<PathBuf> {
        if std::fs::symlink_metadata(path).is_ok() {
            return Err(fail("MIGRATION_TARGET_INVALID"));
        }
        let parent = db(std::fs::canonicalize(
            path.parent().ok_or(fail("MIGRATION_TARGET_INVALID"))?,
        ))?;
        Ok(parent.join(path.file_name().ok_or(fail("MIGRATION_TARGET_INVALID"))?))
    };
    let source_root = db(std::fs::canonicalize(paths.source))?;
    let outputs = [
        prospective(paths.backup)?,
        prospective(paths.staging)?,
        prospective(paths.target)?,
    ];
    for (i, path) in outputs.iter().enumerate() {
        if path.starts_with(&source_root)
            || source_root.starts_with(path)
            || outputs[..i]
                .iter()
                .any(|p| p.starts_with(path) || path.starts_with(p))
        {
            return Err(fail("MIGRATION_TARGET_INVALID"));
        }
    }
    if outputs[1].parent() != outputs[2].parent() {
        return Err(fail("MIGRATION_TARGET_INVALID"));
    }
    // Canonical comparison alone is insufficient: aliases and even plain parent
    // pathnames can change after a callback. All output I/O stays beneath held
    // descriptors, while path proofs report replacement instead of retargeting.
    use crate::open_source::physical::Parent;
    let bind_parent = |path: &Path| -> Result<Parent> {
        let parent = path.parent().ok_or(fail("MIGRATION_TARGET_INVALID"))?;
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or(fail("MIGRATION_TARGET_INVALID"))?;
        Parent::open(parent, name).map_err(|_| fail("MIGRATION_TARGET_INVALID"))
    };
    let backup_parent = bind_parent(&outputs[0])?;
    let target_parent = bind_parent(&outputs[2])?;
    let stage_name = outputs[1]
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or(fail("MIGRATION_TARGET_INVALID"))?;
    scenesparrow_domain::open_project::validate_portable_paths(&[stage_name])
        .map_err(|_| fail("MIGRATION_TARGET_INVALID"))?;
    let backup_bound = backup_parent
        .bound_directory_path()?
        .join(&backup_parent.name);
    let target_directory = target_parent.bound_directory_path()?;
    let stage_bound = target_directory.join(stage_name);
    let target_bound = target_directory.join(&target_parent.name);
    let paths = MigrationPaths {
        source: paths.source,
        backup: &backup_bound,
        staging: &stage_bound,
        target: &target_bound,
        target_id: paths.target_id,
    };
    let mut phase = |phase, backup: Option<&str>| -> Result<()> {
        report_phase(phase, backup)?;
        backup_parent
            .verify()
            .map_err(|_| fail("MIGRATION_TARGET_INVALID"))?;
        target_parent
            .verify()
            .map_err(|_| fail("MIGRATION_TARGET_INVALID"))
    };
    let c = legacy_connection(paths.source)?;
    db(c.execute_batch("BEGIN"))?;
    let captured = SqliteProjectRepository::detached(paths.source, c);
    let inspected = inspection(&captured)?;
    if inspected.project_id != request.project_id || inspected.content_base != request.content_base
    {
        return Err(fail("MIGRATION_BASE_MISMATCH"));
    }
    phase(MigrationOperationViewPhase::Backup, None)?;
    {
        let c = db(captured.connection.lock())?;
        backup::snapshot_controlled(&c, paths.source, paths.backup, None, &cancelled).map_err(
            |_| {
                if cancelled() {
                    fail("MIGRATION_CANCELLED")
                } else {
                    fail("STORAGE_UNAVAILABLE")
                }
            },
        )?;
    }
    drop(captured);
    let original_backup_id = db(backup::manifest_identity(paths.backup))?;
    phase(
        MigrationOperationViewPhase::Backup,
        Some(&original_backup_id),
    )?;
    // Source may progress after the base check. This backup is the actual captured
    // generation; reject changes in saved content, while runtime progress may vary.
    let backup_repository = SqliteProjectRepository::detached(
        paths.backup,
        read_only(&paths.backup.join("project.sqlite"))?,
    );
    if inspection(&backup_repository)?.content_base != request.content_base {
        return Err(fail("MIGRATION_BASE_MISMATCH"));
    }
    if cancelled() {
        return Err(fail("MIGRATION_CANCELLED"));
    }
    phase(MigrationOperationViewPhase::Upgrade, None)?;
    db(std::fs::create_dir(paths.staging))?;
    let management = paths.staging.join(".scenesparrow");
    let backup_id =
        backup::copy_verified_storage(paths.backup, &management, &cancelled).map_err(|_| {
            if cancelled() {
                fail("MIGRATION_CANCELLED")
            } else {
                fail("STORAGE_UNAVAILABLE")
            }
        })?;
    phase(MigrationOperationViewPhase::Upgrade, Some(&backup_id))?;
    let mut repository = db(SqliteProjectRepository::open_storage_mode(
        &management,
        true,
        None,
        false,
    ))?;
    repository.creative_root = Some(paths.staging.to_path_buf());
    phase(MigrationOperationViewPhase::Serialize, Some(&backup_id))?;
    let mut cache = std::collections::BTreeMap::new();
    let mut c = db(repository.connection.lock())?;
    let tx = db(c.transaction())?;
    // Original immutable roots remain generic provenance, never raw-source pins.
    for hash in backup_repository.retention_roots(&*db(backup_repository.connection.lock())?)? {
        db(tx.execute(
            "INSERT OR IGNORE INTO external_object_pins VALUES(?1,?2)",
            params![format!("migration:{}", request.request_id), hash],
        ))?;
    }
    let state = repository.load(&tx)?;
    let current = BusinessSnapshot::capture(&state).blocks;
    let current_hash = derived(&repository, &current, &mut cache, &cancelled)?;
    let histories = {
        let mut q = db(tx.prepare(
            "SELECT position,before_hash,after_hash FROM history_entries ORDER BY position",
        ))?;
        db(q.query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        }))?
        .map(db)
        .collect::<Result<Vec<_>>>()?
    };
    for (position, before, after) in histories {
        let mut convert = |h: &str| -> Result<String> {
            let mut root = repository.read_business(h)?;
            root.source_hash = Some(derived(&repository, &root.blocks, &mut cache, &cancelled)?);
            repository.object(&db(serde_json::to_vec(&root))?)
        };
        let b = convert(&before)?;
        let a = convert(&after)?;
        db(tx.execute(
            "UPDATE history_entries SET before_hash=?1,after_hash=?2 WHERE position=?3",
            params![b, a, position],
        ))?;
    }
    let approvals = {
        let mut q = db(tx.prepare("SELECT id,manifest_hash FROM approved_manifests"))?;
        db(q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))))?
            .map(db)
            .collect::<Result<Vec<_>>>()?
    };
    for (id, h) in approvals {
        let mut approved: crate::finalization::ApprovedManifest =
            db(serde_json::from_slice(&repository.read_object(&h)?))?;
        let blocks = approved
            .blocks
            .iter()
            .map(|lock| {
                let b: Block = db(serde_json::from_slice(
                    &repository.read_object(&lock.content_hash)?,
                ))?;
                Ok(NewBlock {
                    id: b.id,
                    kind: b.kind,
                    attrs: b.attrs,
                    runs: b.runs,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        approved.source_hash = Some(derived(&repository, &blocks, &mut cache, &cancelled)?);
        let h = repository.object(&db(serde_json::to_vec(&approved))?)?;
        db(tx.execute(
            "UPDATE approved_manifests SET manifest_hash=?1 WHERE id=?2",
            params![h, id],
        ))?;
    }
    db(tx.execute(
        "INSERT INTO authored_source VALUES(1,?1,'manuscript.md',?2,0)",
        params![request.project_id, current_hash],
    ))?;
    // Open edit groups cannot survive as runtime capabilities, but original
    // acknowledged receipts and all history identities/cursor remain untouched.
    db(tx.execute("UPDATE edit_groups SET closed=1 WHERE closed=0", []))?;
    db(tx.commit())?;
    drop(c);
    let project =
        db(read_project(&*db(repository.connection.lock())?))?.ok_or(fail("PROJECT_NOT_FOUND"))?;
    write(
        &paths.staging.join("project.json"),
        &db(serde_json::to_vec(
            &serde_json::json!({"format":"scenesparrow","formatVersion":1,"projectId":project.id,"name":project.title,"manuscript":"manuscript.md"}),
        ))?,
    )?;
    write(
        &paths.staging.join("manuscript.md"),
        &repository.read_object(&current_hash)?,
    )?;
    write(
        &management.join("managed.json"),
        &db(serde_json::to_vec(
            &serde_json::json!({"version":1,"projectId":project.id,"state":"ready"}),
        ))?,
    )?;
    repository.register_file_graph()?;
    phase(MigrationOperationViewPhase::Verify, Some(&backup_id))?;
    // New stage pathname/file identity forces the recovered-origin branch. Never
    // register copied SQL as original before this fence.
    scenesparrow_application::ai::AiExecutionPort::reconcile_execution(&repository)
        .map_err(|_| fail("MIGRATION_VERIFY_FAILED"))?;
    repository.recover_documents()?;
    repository.initialize_planning()?;
    {
        let c = db(repository.connection.lock())?;
        db(c.execute("DELETE FROM external_object_pins WHERE owner_id IN (SELECT id FROM planning_preparations)",[]))?;
        db(c.execute("DELETE FROM planning_preparations", []))?;
    }
    {
        let c = db(repository.connection.lock())?;
        db(c.execute("UPDATE export_jobs SET status='interrupted',attempt=attempt+1,error='EXPORT_INTERRUPTED' WHERE status IN ('queued','running')",[]))?;
    }
    repository.recover_exports()?;
    {
        let c = db(repository.connection.lock())?;
        db(c.execute(
            "UPDATE downstream_inputs SET status='cancelled' WHERE status='using'",
            [],
        ))?;
        db(c.execute("UPDATE work_operations SET status='interrupted',failure_code='WORK_OPERATION_INTERRUPTED' WHERE status IN ('queued','running')",[]))?;
        db(c.execute(
            "UPDATE work_items SET state='interrupted' WHERE state IN ('preparing','inspecting')",
            [],
        ))?;
        db(c.execute("DELETE FROM work_copy_locations", []))?;
        db(c.execute("DELETE FROM work_preparations", []))?;
    }
    repository.verify_source_state()?;
    db(repository.verify_manuscript())?;
    db(SqliteProjectRepository::inspect_project(&management))?;
    if cancelled() {
        return Err(fail("MIGRATION_CANCELLED"));
    }
    let result = hash(&db(serde_json::to_vec(
        &serde_json::json!({"request":request,"backupId":backup_id,"sourceHash":current_hash,"serializer":"legacy-mdast-2.1.2-markers-v1"}),
    ))?);
    write(
        &management.join("migration-ready.json"),
        &db(serde_json::to_vec(
            &serde_json::json!({"version":1,"requestId":request.request_id,"targetId":request.target_id,"projectId":request.project_id,"resultId":result,"backupId":backup_id,"sourceHash":current_hash,"normalizedOrigin":true}),
        ))?,
    )?;
    {
        let c = db(repository.connection.lock())?;
        db(c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)"))?;
    }
    drop(repository);
    sync(&management)?;
    sync(paths.staging)?;
    phase(MigrationOperationViewPhase::Promote, Some(&backup_id))?;
    if cancelled() {
        return Err(fail("MIGRATION_CANCELLED"));
    }
    target_parent
        .rename_no_replace(stage_name, &target_parent.name)
        .map_err(|_| fail("MIGRATION_TARGET_EXISTS"))?;
    target_parent.sync()?;
    phase(MigrationOperationViewPhase::Ready, Some(&backup_id))?;
    Ok(result)
}
#[cfg(test)]
pub(super) fn serialize_for_test(blocks: &[NewBlock]) -> Result<String> {
    serialize(blocks, &|| false)
}
