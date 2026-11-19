use super::*;
use rusqlite::{Connection, OptionalExtension, params};
use std::io::Write;
impl SqliteProjectRepository {
    pub fn read_package_base(&self) -> Result<ProjectPackageBase> {
        let c = db(self.connection.lock())?;
        self.package_base_locked(&c)
    }
    pub(super) fn package_base_locked(&self, c: &Connection) -> Result<ProjectPackageBase> {
        self.guard_source_recovery()?;
        self.recorded_package_base(c)
    }
    pub(super) fn recorded_package_base(&self, c: &Connection) -> Result<ProjectPackageBase> {
        let p = db(read_project(c))?.ok_or(fail("PROJECT_NOT_FOUND"))?;
        let (_, _, source_hash, source_generation) =
            crate::open_source::source_row(c)?.ok_or(fail("PACKAGE_NATIVE_REQUIRED"))?;
        let (graph_hash, graph_generation) =
            crate::open_source::graph::graph_row(c)?.ok_or(fail("GRAPH_REGISTRATION_REQUIRED"))?;
        let history_revision = db(c.query_row(
            "SELECT history_revision FROM history_cursor WHERE singleton=1",
            [],
            |r| r.get(0),
        ))?;
        Ok(ProjectPackageBase {
            project_id: p.id,
            working_revision: p.working_revision,
            history_revision,
            source_hash,
            source_generation,
            graph_hash,
            graph_generation,
        })
    }
    pub(super) fn capture_package(
        &self,
        r: &ProjectPackageExportRequest,
        root: &Path,
        store: &Path,
        token: &str,
    ) -> Result<()> {
        let c = db(self.connection.lock())?;
        let digest = hash(&db(serde_json::to_vec(r))?);
        let saved: Option<(String, String,Option<String>,Option<String>)> = db(c
            .query_row(
                "SELECT request_digest,base_json,capture_store,capture_owner FROM package_exports WHERE export_id=?1",
                [&r.request_id],
                |r| Ok((r.get(0)?, r.get(1)?,r.get(2)?,r.get(3)?)),
            )
            .optional())?;
        if let Some((old, base, stored, owner)) = saved {
            if stored.as_deref() != Some(pins::register_store(store)?.as_str())
                || owner.as_deref() != Some(self.migration_source_identity()?.as_str())
            {
                return Err(fail("PACKAGE_REQUEST_CONFLICT"));
            }
            if old != digest || db(serde_json::from_str::<ProjectPackageBase>(&base))? != r.base {
                return Err(fail("PACKAGE_REQUEST_CONFLICT"));
            }
        } else {
            if self.package_base_locked(&c)? != r.base {
                return Err(fail("PACKAGE_BASE_MISMATCH"));
            }
            self.guard_source_application(&c)?;
            db(c.execute(
                "INSERT INTO package_exports(export_id,request_digest,base_json,capture_state,capture_store,capture_token,capture_owner,capture_expires_at) VALUES(?1,?2,?3,'capturing',?4,?5,?6,?7)",
                params![r.request_id, digest, db(serde_json::to_string(&r.base))?,pins::register_store(store)?,token,self.migration_source_identity()?,now()+CACHE_TTL],
            ))?;
        }
        db(c.execute("UPDATE package_exports SET capture_store=?2,capture_token=?3,capture_owner=?4,capture_state='capturing',capture_failure=NULL WHERE export_id=?1 AND roots_hash IS NULL",params![r.request_id,pins::register_store(store)?,token,self.migration_source_identity()?]))?;
        if root.join("capture.json").exists() {
            let saved: ProjectPackageExportRequest =
                large_read(&root.join("capture.json"), 4 << 20)?;
            if saved == *r {
                return Ok(());
            }
            return Err(fail("PACKAGE_CAPTURE_INVALID"));
        }
        if self.package_base_locked(&c)? != r.base {
            return Err(fail("PACKAGE_BASE_MISMATCH"));
        }
        let pages: u64 = db(c.pragma_query_value(None, "page_count", |r| r.get(0)))?;
        let page_size: u64 = db(c.pragma_query_value(None, "page_size", |r| r.get(0)))?;
        if pages
            .checked_mul(page_size)
            .is_none_or(|bytes| bytes > Limits::default().file)
        {
            return Err(fail("PACKAGE_SIZE_LIMIT"));
        }
        // Incomplete residual captures are preserved; an explicit retry cannot overwrite them.
        db(std::fs::create_dir(root))?;
        let held = Parent::open(root, "__capture__")?;
        let bound = held.bound_directory_path()?;
        let root = bound.as_path();
        db(std::fs::create_dir(root.join(".scenesparrow")))?;
        let management_held = Parent::open(root, ".scenesparrow/__capture__")?;
        let management = management_held.bound_directory_path()?;
        self.source_cut("package-capture-held")?;
        let mut output = db(Connection::open(management.join("project.sqlite")))?;
        {
            let backup = db(rusqlite::backup::Backup::new(&c, &mut output))?;
            db(backup.run_to_completion(32, std::time::Duration::from_millis(1), None))?;
        }
        db(output.execute_batch("PRAGMA journal_mode=DELETE"))?;
        drop(output);
        db(File::open(management.join("project.sqlite")).and_then(|f| f.sync_all()))?;
        let creative = self
            .creative_root
            .as_ref()
            .ok_or(fail("PACKAGE_NATIVE_REQUIRED"))?;
        let (_, managed) = Self::capture_source_descriptor(&c, creative, &self.directory)?;
        write_new(&management.join("managed.json"), managed.as_bytes())?;
        write_new(&root.join("sql-capture.json"), &db(serde_json::to_vec(r))?)?;
        held.verify()?;
        management_held.verify()?;
        db(c.execute(
            "UPDATE package_exports SET capture_state='sql-captured' WHERE export_id=?1",
            [&r.request_id],
        ))?;
        Ok(())
    }
    pub(super) fn materialize_package(
        &self,
        r: &ProjectPackageExportRequest,
        captured_root: &Path,
        root: &Path,
        cancel: &dyn Fn() -> bool,
    ) -> Result<Descriptor> {
        let materialized_token = root
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or(fail("PACKAGE_CAPTURE_INVALID"))?
            .to_owned();
        let suffix = materialized_token
            .strip_prefix(&format!("materialized-{}-", r.request_id))
            .ok_or(fail("PACKAGE_CAPTURE_INVALID"))?;
        if suffix.parse::<u64>().is_err() {
            return Err(fail("PACKAGE_CAPTURE_INVALID"));
        }
        let captured_held = Parent::open(captured_root, ".scenesparrow/__snapshot__")?;
        let roots_hash: String = {
            let c = db(self.connection.lock())?;
            db(c.query_row(
                "SELECT roots_hash FROM package_exports WHERE export_id=?1 AND capture_owner=?2",
                params![r.request_id, self.migration_source_identity()?],
                |row| row.get(0),
            ))?
        };
        let roots: pins::CaptureRoots = db(serde_json::from_slice(
            &self.read_bounded_object(&roots_hash, 16 << 20)?,
        ))?;
        if roots.version != 1 || roots.request != *r {
            return Err(fail("PACKAGE_CAPTURE_INVALID"));
        }
        let mut planned = roots.verified_controls(captured_root)?;
        // A failed archive write can already own a complete immutable staging
        // tree. Reuse its verified original inventory rather than accumulating
        // another complete cache on every explicit retry.
        if let Some(token) = self.package_materialized_token(&r.request_id)?
            && token
                .strip_prefix(&format!("materialized-{}-", r.request_id))
                .is_some_and(|suffix| suffix.parse::<u64>().is_ok())
            && let Ok((base, descriptor)) = self.trusted_package_base(&r.request_id)
            && base == r.base
            && descriptor.capture.as_ref() == Some(&r.base)
            && descriptor.export_id == r.request_id
        {
            let cache = Parent::open(
                root.parent().ok_or(fail("PACKAGE_CAPTURE_INVALID"))?,
                &token,
            )?;
            let path = cache.bound_directory_path()?.join(&token);
            let mut valid = true;
            for member in &descriptor.members {
                if cancel() {
                    return Err(fail("PACKAGE_CANCELLED"));
                }
                match member_at(&path, &member.path) {
                    Ok(actual) if actual == *member => {}
                    Err(error) if error.0 == "PACKAGE_CANCELLED" => return Err(error),
                    _ => {
                        valid = false;
                        break;
                    }
                }
            }
            if valid {
                cache.verify()?;
                return Ok(descriptor);
            }
        }
        let c = db(Connection::open_with_flags(
            captured_held.bound_directory_path()?.join("project.sqlite"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        ))?;
        let captured = Self::detached(&self.directory, c);
        let inventory = crate::backup::Inventory {
            schema: 15,
            objects: roots.objects,
            exports: roots
                .exports
                .into_iter()
                .map(|(id, m)| (id, m.hash))
                .collect(),
        };
        let graph = captured.read_file_graph(&r.base.graph_hash)?;
        for hash in &inventory.objects {
            let path = format!("objects/{hash}");
            let p = Parent::open(&self.directory, &path)?;
            let (f, _) = p
                .open_file(&p.name)?
                .ok_or(fail("PACKAGE_MEMBER_MISSING"))?;
            planned.push(Member {
                path: format!(".scenesparrow/{path}"),
                hash: hash.clone(),
                size: db(f.metadata())?.len(),
            });
        }
        for (id, hash) in &inventory.exports {
            let path = format!("exports/{id}");
            let p = Parent::open(&self.directory, &path)?;
            let (f, _) = p
                .open_file(&p.name)?
                .ok_or(fail("PACKAGE_MEMBER_MISSING"))?;
            planned.push(Member {
                path: format!(".scenesparrow/{path}"),
                hash: hash.clone(),
                size: db(f.metadata())?.len(),
            });
        }
        planned.extend(graph.files.iter().map(|m| Member {
            path: m.path.clone(),
            hash: m.hash.clone(),
            size: m.size,
        }));
        planned.sort_by(|a, b| a.path.cmp(&b.path));
        let planned_descriptor = Descriptor {
            version: 1,
            kind: "project".into(),
            project_id: r.base.project_id.clone(),
            export_id: r.request_id.clone(),
            capture: Some(r.base.clone()),
            work_item_id: None,
            base_graph_hash: None,
            base_graph_generation: None,
            members: planned,
        };
        archive::admit_members(
            &planned_descriptor.members,
            db(serde_json::to_vec(&planned_descriptor))?.len() as u64,
            Limits::default(),
        )?;
        // Only metadata was read above; no closure bytes are copied before admission.
        db(std::fs::create_dir(root))?;
        let held = Parent::open(root, "__materialized__")?;
        let bound = held.bound_directory_path()?;
        let root = bound.as_path();
        db(std::fs::create_dir(root.join(".scenesparrow")))?;
        for m in planned_descriptor.members.iter().filter(|m| {
            matches!(
                m.path.as_str(),
                ".scenesparrow/project.sqlite" | ".scenesparrow/managed.json"
            )
        }) {
            copy_member(captured_root, &m.path, root, &m.path, &m.hash, cancel)?;
        }
        let mut members = vec![];
        for name in ["project.sqlite", "managed.json"] {
            let path = format!(".scenesparrow/{name}");
            members.push(member_at(root, &path)?);
        }
        for folder in ["objects", "exports"] {
            db(std::fs::create_dir(root.join(".scenesparrow").join(folder)))?;
            let entries = if folder == "objects" {
                inventory
                    .objects
                    .iter()
                    .map(|h| (h.clone(), h.clone()))
                    .collect::<Vec<_>>()
            } else {
                inventory
                    .exports
                    .iter()
                    .map(|(id, h)| (id.clone(), h.clone()))
                    .collect()
            };
            for (name, expected) in entries {
                if cancel() {
                    return Err(fail("PACKAGE_CANCELLED"));
                }
                let relative = format!(".scenesparrow/{folder}/{name}");
                copy_member(
                    &self.directory,
                    &format!("{folder}/{name}"),
                    root,
                    &relative,
                    &expected,
                    cancel,
                )?;
                members.push(member_at(root, &relative)?);
            }
        }
        for m in graph.files {
            copy_member(
                &self.directory,
                &format!("objects/{}", m.hash),
                root,
                &m.path,
                &m.hash,
                cancel,
            )?;
            members.push(Member {
                path: m.path,
                hash: m.hash,
                size: m.size,
            });
        }
        members.sort_by(|a, b| a.path.cmp(&b.path));
        let descriptor = Descriptor {
            version: 1,
            kind: "project".into(),
            project_id: r.base.project_id.clone(),
            export_id: r.request_id.clone(),
            capture: Some(r.base.clone()),
            work_item_id: None,
            base_graph_hash: None,
            base_graph_generation: None,
            members,
        };
        let bytes = db(serde_json::to_vec(&descriptor))?;
        let c = db(self.connection.lock())?;
        let h = self.object(&bytes)?;
        db(c.execute("UPDATE package_exports SET inventory_hash=?2,capture_state='complete',materialized_token=?3 WHERE export_id=?1",params![r.request_id,h,materialized_token]))?;
        held.verify()?;
        captured_held.verify()?;
        Ok(descriptor)
    }
    pub(super) fn trusted_package_base(
        &self,
        id: &str,
    ) -> Result<(ProjectPackageBase, Descriptor)> {
        uuid(id)?;
        let c = db(self.connection.lock())?;
        let row:Option<(String,String)>=db(c.query_row("SELECT base_json,inventory_hash FROM package_exports WHERE export_id=?1 AND inventory_hash IS NOT NULL",[id],|r|Ok((r.get(0)?,r.get(1)?))).optional())?;
        let (base, inventory) = row.ok_or(fail("PACKAGE_TRUSTED_BASE_MISSING"))?;
        Ok((
            db(serde_json::from_str(&base))?,
            db(serde_json::from_slice(
                &self.read_bounded_object(&inventory, 16 << 20)?,
            ))?,
        ))
    }
    pub(super) fn package_materialized_token(&self, id: &str) -> Result<Option<String>> {
        let c = db(self.connection.lock())?;
        db(c.query_row(
            "SELECT materialized_token FROM package_exports WHERE export_id=?1",
            [id],
            |row| row.get(0),
        ))
    }
}
pub(super) fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut f = db(File::options().write(true).create_new(true).open(path))?;
    db(f.write_all(bytes))?;
    db(f.sync_all())?;
    sync(path.parent().ok_or(fail("STORAGE_UNAVAILABLE"))?)
}
pub(super) fn sync(path: &Path) -> Result<()> {
    db(File::open(path).and_then(|f| f.sync_all()))
}
pub(super) fn member_at(root: &Path, path: &str) -> Result<Member> {
    let p = Parent::open(root, path)?;
    let (h, n, _) = p
        .streamed(&p.name, Limits::default().file)?
        .ok_or(fail("PACKAGE_MEMBER_MISSING"))?;
    Ok(Member {
        path: path.into(),
        hash: h,
        size: n,
    })
}
pub(crate) fn copy_member(
    source: &Path,
    name: &str,
    target: &Path,
    path: &str,
    expected: &str,
    cancel: &dyn Fn() -> bool,
) -> Result<()> {
    let input = Parent::open(source, name)?;
    let (mut f, _) = input
        .open_file(&input.name)?
        .ok_or(fail("PACKAGE_MEMBER_MISSING"))?;
    let p = Parent::open_creating(target, path)?;
    if let Some((mut existing, _)) = p.open_file(&p.name)? {
        let actual = crate::storage::objects::stream_copy(
            &mut existing,
            &mut std::io::sink(),
            Limits::default().file,
        )?;
        if actual.0 == expected {
            return Ok(());
        }
        return Err(fail("PACKAGE_CAPTURE_INVALID"));
    }
    let mut output = p.create_file(&p.name)?;
    let mut b = [0u8; 64 * 1024];
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut hasher = Sha256::new();
    let mut size = 0u64;
    loop {
        if cancel() {
            return Err(fail("PACKAGE_CANCELLED"));
        }
        let n = db(f.read(&mut b))?;
        if n == 0 {
            break;
        }
        size = size
            .checked_add(n as u64)
            .ok_or(fail("PACKAGE_SIZE_LIMIT"))?;
        if size > Limits::default().file {
            return Err(fail("PACKAGE_SIZE_LIMIT"));
        }
        hasher.update(&b[..n]);
        db(output.write_all(&b[..n]))?;
    }
    if format!("{:x}", hasher.finalize()) != expected {
        return Err(fail("PACKAGE_MEMBER_MISSING"));
    }
    db(output.sync_all())?;
    p.sync()?;
    input.verify()?;
    p.verify()
}
