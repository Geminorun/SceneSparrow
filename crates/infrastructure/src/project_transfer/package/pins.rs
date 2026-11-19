//! Durable capture custody. Enumeration reads only the recorded SQL and bounded
//! immutable controls; binary payload verification belongs to materialization.
use super::*;
use rusqlite::{Connection, params};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Mutex, OnceLock},
};
static STORES: OnceLock<Mutex<BTreeMap<String, PathBuf>>> = OnceLock::new();
pub(super) fn register_store(path: &Path) -> Result<String> {
    let key = identity(path)?;
    db(STORES.get_or_init(Default::default).lock())?
        .insert(key.clone(), db(std::fs::canonicalize(path))?);
    Ok(key)
}
fn resolve_store(key: &str) -> Result<PathBuf> {
    if !sha(key) {
        return Err(fail("PACKAGE_CAPTURE_INVALID"));
    }
    if let Some(path) = db(STORES.get_or_init(Default::default).lock())?
        .get(key)
        .cloned()
        && identity(&path).ok().as_deref() == Some(key)
    {
        return Ok(path);
    }
    let path = crate::ai::settings::app_data_directory().join("project-transfers");
    if identity(&path).ok().as_deref() != Some(key) {
        return Err(fail("PACKAGE_CAPTURE_INVALID"));
    }
    Ok(path)
}
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ExportRoot {
    pub(super) hash: String,
    pub(super) size: u64,
}
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CaptureRoots {
    pub(super) version: u32,
    pub(super) request: ProjectPackageExportRequest,
    pub(super) objects: BTreeSet<String>,
    pub(super) exports: BTreeMap<String, ExportRoot>,
    pub(super) controls: BTreeMap<String, ExportRoot>,
}
impl CaptureRoots {
    pub(super) fn verified_controls(&self, root: &Path) -> Result<Vec<Member>> {
        if self.controls.len() != 2 {
            return Err(fail("PACKAGE_CAPTURE_INVALID"));
        }
        let mut members = vec![];
        for (path, limit) in [
            (".scenesparrow/project.sqlite", Limits::default().file),
            (".scenesparrow/managed.json", 4 << 20),
        ] {
            let recorded = self
                .controls
                .get(path)
                .ok_or(fail("PACKAGE_CAPTURE_INVALID"))?;
            if !sha(&recorded.hash) || recorded.size > limit {
                return Err(fail("PACKAGE_CAPTURE_INVALID"));
            }
            let parent = Parent::open(root, path)?;
            let actual = parent
                .streamed(&parent.name, recorded.size)
                .map_err(|_| fail("PACKAGE_CAPTURE_INVALID"))?
                .ok_or(fail("PACKAGE_CAPTURE_INVALID"))?;
            if actual.0 != recorded.hash || actual.1 != recorded.size {
                return Err(fail("PACKAGE_CAPTURE_INVALID"));
            }
            members.push(Member {
                path: path.into(),
                hash: recorded.hash.clone(),
                size: recorded.size,
            });
        }
        Ok(members)
    }
}
#[derive(Clone)]
struct Pending {
    id: String,
    digest: String,
    base: String,
    store: Option<String>,
    token: Option<String>,
    owner: Option<String>,
}
impl SqliteProjectRepository {
    /// Startup/GC can finish a cut before pin installation, but only from the
    /// original owner root's recorded app-data capture. No live generation is read.
    pub(crate) fn recover_package_capture_pins(&self) -> Result<()> {
        let pending = {
            let c = db(self.connection.lock())?;
            let version: i64 = db(c.pragma_query_value(None, "user_version", |r| r.get(0)))?;
            if version < 15 {
                return Ok(());
            }
            let mut q=db(c.prepare("SELECT export_id,request_digest,base_json,capture_store,capture_token,capture_owner FROM package_exports WHERE capture_state IN ('capturing','sql-captured') OR (capture_state='pinned' AND roots_hash IS NOT NULL)"))?;
            db(q.query_map([], |r| {
                Ok(Pending {
                    id: r.get(0)?,
                    digest: r.get(1)?,
                    base: r.get(2)?,
                    store: r.get(3)?,
                    token: r.get(4)?,
                    owner: r.get(5)?,
                })
            }))?
            .map(db)
            .collect::<Result<Vec<_>>>()?
        };
        for record in pending {
            let current = self.migration_source_identity()?;
            if record.owner.as_deref() != Some(current.as_str()) {
                let mut c = db(self.connection.lock())?;
                let tx = db(c.transaction())?;
                db(tx.execute(
                    "DELETE FROM package_capture_pins WHERE export_id=?1",
                    [&record.id],
                ))?;
                db(tx.execute("UPDATE package_exports SET capture_state='portable',roots_hash=NULL,capture_store=NULL,capture_token=NULL,capture_owner=NULL,capture_expires_at=NULL,materialized_token=NULL WHERE export_id=?1",[&record.id]))?;
                db(tx.commit())?;
                continue;
            }
            let result = (|| {
                uuid(&record.id)?;
                let base: ProjectPackageBase = db(serde_json::from_str(&record.base))?;
                let request = ProjectPackageExportRequest {
                    request_id: record.id.clone(),
                    base,
                };
                if hash(&db(serde_json::to_vec(&request))?) != record.digest {
                    return Err(fail("PACKAGE_CAPTURE_INVALID"));
                }
                let directory = resolve_store(
                    record
                        .store
                        .as_deref()
                        .ok_or(fail("PACKAGE_CAPTURE_INVALID"))?,
                )?;
                let token = record
                    .token
                    .as_deref()
                    .ok_or(fail("PACKAGE_CAPTURE_INVALID"))?;
                capture_token(token)?;
                let parent = Parent::open(&directory, token)?;
                let root = parent.bound_directory_path()?.join(token);
                self.pin_package_capture(&request, &root)?;
                parent.verify()
            })();
            if let Err(error) = result {
                if matches!(error.0, "MIGRATION_BUSY" | "TEST_CUT") {
                    return Err(error);
                }
                self.fail_capture(&record.id, "PACKAGE_CAPTURE_INVALID")?;
            }
        }
        Ok(())
    }
    fn fail_capture(&self, id: &str, code: &str) -> Result<()> {
        let mut c = db(self.connection.lock())?;
        let tx = db(c.transaction())?;
        // Evidence is committed in the same transaction that removes the coarse fence.
        db(tx.execute("UPDATE package_exports SET capture_state='failed',capture_failure=?2 WHERE export_id=?1 AND roots_hash IS NULL AND capture_state!='expired'",params![id,code]))?;
        db(tx.commit())?;
        Ok(())
    }
    pub(super) fn pin_package_capture(
        &self,
        request: &ProjectPackageExportRequest,
        root: &Path,
    ) -> Result<()> {
        let outcome = self.pin_capture_inner(request, root);
        if let Err(error) = &outcome
            && !matches!(error.0, "MIGRATION_BUSY" | "TEST_CUT")
        {
            self.fail_capture(&request.request_id, "PACKAGE_CAPTURE_INVALID")?;
        }
        outcome
    }
    fn pin_capture_inner(&self, request: &ProjectPackageExportRequest, _root: &Path) -> Result<()> {
        if self
            .package_capture_expiry(&request.request_id)?
            .is_some_and(|(state, _)| state == "expired")
        {
            return Err(fail("PACKAGE_EXPIRED"));
        }
        let (owner, store) = {
            let c = db(self.connection.lock())?;
            db(c.query_row(
                "SELECT capture_owner,capture_store FROM package_exports WHERE export_id=?1",
                [&request.request_id],
                |r| {
                    Ok((
                        r.get::<_, Option<String>>(0)?,
                        r.get::<_, Option<String>>(1)?,
                    ))
                },
            ))?
        };
        if owner.as_deref() != Some(self.migration_source_identity()?.as_str()) {
            return Err(fail("PACKAGE_CAPTURE_INVALID"));
        }
        let store = resolve_store(store.as_deref().ok_or(fail("PACKAGE_CAPTURE_INVALID"))?)?;
        let _lease =
            journal::lock(&store.join(format!("package-pins-{}.lock", request.request_id)))?;
        // Start and GC may both have observed an unfinished record before the
        // lease. Only the state read under this lease decides idempotent reuse.
        let (owner, current_store, token, roots_hash, failure) = {
            let c = db(self.connection.lock())?;
            db(c.query_row("SELECT capture_owner,capture_store,capture_token,roots_hash,capture_failure FROM package_exports WHERE export_id=?1",[&request.request_id],|r|Ok((r.get::<_,Option<String>>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,Option<String>>(3)?,r.get::<_,Option<String>>(4)?))))?
        };
        if owner.as_deref() != Some(self.migration_source_identity()?.as_str()) {
            return Err(fail("PACKAGE_CAPTURE_INVALID"));
        }
        if current_store.as_deref() != Some(register_store(&store)?.as_str()) {
            return Err(fail("MIGRATION_BUSY"));
        }
        if failure.is_some() {
            return Err(fail("PACKAGE_CAPTURE_INVALID"));
        }
        let token = token.ok_or(fail("PACKAGE_CAPTURE_INVALID"))?;
        capture_token(&token)?;
        let root_parent = Parent::open(&store, &token)?;
        let original_root = root_parent.bound_directory_path()?.join(&token);
        let held = Parent::open(&original_root, "__roots__")?;
        let bound = held.bound_directory_path()?;
        let root = bound.as_path();
        if let Some(hash) = roots_hash {
            let record: CaptureRoots = db(serde_json::from_slice(
                &self.read_bounded_object(&hash, 16 << 20)?,
            ))?;
            if record.version != 1
                || record.objects.len() > 20_000
                || record.objects.iter().any(|h| !sha(h))
                || record.request != *request
            {
                return Err(fail("PACKAGE_CAPTURE_INVALID"));
            }
            record.verified_controls(root)?;
            if !root.join("capture.json").exists() {
                write_new(
                    &root.join("capture.json"),
                    &db(serde_json::to_vec(request))?,
                )?;
            } else if large_read::<ProjectPackageExportRequest>(
                &root.join("capture.json"),
                4 << 20,
            )? != *request
            {
                return Err(fail("PACKAGE_CAPTURE_INVALID"));
            }
            held.verify()?;
            let c = db(self.connection.lock())?;
            db(c.execute("UPDATE package_exports SET capture_state='ready-pinned' WHERE export_id=?1 AND capture_state='pinned'",[&request.request_id]))?;
            return Ok(());
        }
        let original: ProjectPackageExportRequest =
            large_read(&root.join("sql-capture.json"), 4 << 20)?;
        if original != *request {
            return Err(fail("PACKAGE_CAPTURE_INVALID"));
        }
        let management = Parent::open(root, ".scenesparrow/__roots__")?;
        let path = management.bound_directory_path()?.join("project.sqlite");
        let mut connection = db(Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE,
        ))?;
        // Portable SQL keeps compact export provenance, never original-machine cache
        // custody or a recursive link to its own/future capture.
        if db(connection.query_row("SELECT EXISTS(SELECT 1 FROM package_capture_pins) OR EXISTS(SELECT 1 FROM file_graph_pins WHERE owner_id LIKE 'package:%') OR EXISTS(SELECT 1 FROM package_exports WHERE capture_state!='portable' OR roots_hash IS NOT NULL OR capture_store IS NOT NULL OR capture_token IS NOT NULL OR capture_owner IS NOT NULL OR capture_expires_at IS NOT NULL OR materialized_token IS NOT NULL)",[],|r|r.get::<_,bool>(0)))? {
            let tx = db(connection.transaction())?;
            db(tx.execute_batch("DELETE FROM package_capture_pins;DELETE FROM file_graph_pins WHERE owner_id LIKE 'package:%';UPDATE package_exports SET capture_state='portable',roots_hash=NULL,capture_store=NULL,capture_token=NULL,capture_owner=NULL,capture_expires_at=NULL,materialized_token=NULL;"))?;
            db(tx.commit())?;
        }
        let captured = Self::detached(&self.directory, connection);
        let c = db(captured.connection.lock())?;
        if captured.recorded_package_base(&c)? != request.base {
            return Err(fail("PACKAGE_CAPTURE_INVALID"));
        }
        let mut objects = captured.retention_roots_mode(&c, false)?;
        let managed: serde_json::Value =
            large_read(&root.join(".scenesparrow/managed.json"), 4 << 20)?;
        if let Some(hash) = managed["adoptionOriginalHash"].as_str() {
            if !sha(hash) {
                return Err(fail("PACKAGE_CAPTURE_INVALID"));
            }
            objects.insert(hash.into());
        }
        let mut exports = BTreeMap::new();
        let mut q =
            db(c.prepare("SELECT id,artifact_hash,size FROM export_jobs WHERE status='ready'"))?;
        for row in db(q.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, u64>(2)?,
            ))
        }))? {
            let (id, hash, size) = db(row)?;
            uuid(&id)?;
            if !sha(&hash) || size > Limits::default().file {
                return Err(fail("PACKAGE_CAPTURE_INVALID"));
            }
            exports.insert(id, ExportRoot { hash, size });
        }
        let graph = captured.read_file_graph(&request.base.graph_hash)?;
        if objects
            .len()
            .checked_add(exports.len())
            .and_then(|n| n.checked_add(graph.files.len() + 3))
            .is_none_or(|n| n > Limits::default().entries as usize)
        {
            return Err(fail("PACKAGE_SIZE_LIMIT"));
        }
        // All referenced controls have been content-address/depth/size checked; no
        // media, Library binary or ready-export payload was opened here.
        drop(q);
        drop(c);
        drop(captured);
        db(
            File::open(management.bound_directory_path()?.join("project.sqlite"))
                .and_then(|f| f.sync_all()),
        )?;
        let mut controls = BTreeMap::new();
        for path in [".scenesparrow/project.sqlite", ".scenesparrow/managed.json"] {
            let member = member_at(root, path)?;
            controls.insert(
                path.into(),
                ExportRoot {
                    hash: member.hash,
                    size: member.size,
                },
            );
        }
        let record = CaptureRoots {
            version: 1,
            request: request.clone(),
            objects,
            exports,
            controls,
        };
        let bytes = db(serde_json::to_vec(&record))?;
        if bytes.len() > 16 << 20 {
            return Err(fail("PACKAGE_SIZE_LIMIT"));
        }
        let file = root.join("capture-roots.json");
        let mut output = db(atomic_write_file::AtomicWriteFile::open(&file))?;
        db(output.write_all(&bytes))?;
        db(output.commit())?;
        sync(root)?;
        if self.source_cut("package-pins-before-install").is_err() {
            return Err(fail("TEST_CUT"));
        }
        {
            let mut c = db(self.connection.lock())?;
            let tx = db(c.transaction())?;
            let hash = self.object(&bytes)?;
            for object in record.objects.iter().chain(std::iter::once(&hash)) {
                db(tx.execute(
                    "INSERT OR IGNORE INTO package_capture_pins VALUES(?1,?2)",
                    params![request.request_id, object],
                ))?;
            }
            db(tx.execute("UPDATE package_exports SET roots_hash=?2,capture_state='pinned',capture_failure=NULL WHERE export_id=?1",params![request.request_id,hash]))?;
            db(tx.execute(
                "DELETE FROM file_graph_pins WHERE owner_id=?1",
                [format!("package:{}", request.request_id)],
            ))?;
            db(tx.commit())?;
        }
        if self.source_cut("package-pins-after-install").is_err() {
            return Err(fail("TEST_CUT"));
        }
        write_new(
            &root.join("capture.json"),
            &db(serde_json::to_vec(request))?,
        )?;
        held.verify()?;
        management.verify()?;
        let c = db(self.connection.lock())?;
        db(c.execute(
            "UPDATE package_exports SET capture_state='ready-pinned' WHERE export_id=?1 AND capture_state='pinned' AND roots_hash IS NOT NULL",
            [&request.request_id],
        ))?;
        Ok(())
    }
}
fn capture_token(token: &str) -> Result<()> {
    let id = token
        .strip_prefix("capture-")
        .ok_or(fail("PACKAGE_CAPTURE_INVALID"))?;
    uuid(id)
}
