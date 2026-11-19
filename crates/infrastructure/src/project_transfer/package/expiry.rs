//! Cache expiry has one fresh descriptor-bound cleanup attempt. Business replay never deletes a pathname.
use super::*;
use rusqlite::{OptionalExtension, params};
impl SqliteProjectRepository {
    pub(super) fn package_capture_expiry(&self, id: &str) -> Result<Option<(String, Option<i64>)>> {
        let c = db(self.connection.lock())?;
        db(c.query_row(
            "SELECT capture_state,capture_expires_at FROM package_exports WHERE export_id=?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional())
    }
    pub(super) fn package_capture_was_fixed(&self, id: &str) -> Result<bool> {
        let c = db(self.connection.lock())?;
        db(c.query_row("SELECT EXISTS(SELECT 1 FROM package_exports WHERE export_id=?1 AND capture_state!='capturing')",[id],|row|row.get(0)))
    }
}
impl ProjectTransferStore {
    pub(super) fn check_capture_retry(
        &self,
        r: &SqliteProjectRepository,
        op: &Operation,
    ) -> Result<()> {
        if matches!(op.request, Request::Export(_))
            && let Some((state, until)) = r.package_capture_expiry(op.request.id())?
            && (state == "expired"
                || until.unwrap_or(0).max(op.capture_retry_until.unwrap_or(0)) <= now())
        {
            return Err(fail("PACKAGE_EXPIRED"));
        }
        if matches!(op.request, Request::Work(_)) {
            let path = self.package_path("work-inventory", op.request.id());
            if path.exists() {
                let capture: WorkCapture = large_read(&path, 16 << 20)?;
                if capture.expired
                    || capture.expires_at.max(op.capture_retry_until.unwrap_or(0)) <= now()
                {
                    return Err(fail("PACKAGE_EXPIRED"));
                }
            }
        }
        Ok(())
    }
    pub fn expire_packages(&self, r: &SqliteProjectRepository) -> Result<usize> {
        if r.is_quiescing() {
            return Ok(0);
        }
        let _worker = r.worker_guard();
        let worker = db(File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.directory.join("worker.lock")))?;
        if worker.try_lock().is_err() {
            return Ok(0);
        }
        let _transfer = journal::Lease(worker);
        let closing = r.quiescing.clone();
        let _cancel = crate::storage::operation::Cancellation::begin(move || {
            closing.load(std::sync::atomic::Ordering::Acquire)
        });

        let source = r.migration_source_identity()?;
        let active_ops = {
            let _lock = self.journal_lock()?;
            self.index()?
                .package_ids
                .into_iter()
                .filter_map(|id| journal::read::<Operation>(&self.package_op(&id)).ok())
                .collect::<Vec<_>>()
        };
        let mut expired = 0;
        // Streaming directory traversal is maintenance only, never a status-poll scan.
        for entry in db(std::fs::read_dir(&self.directory))? {
            if expired >= 100 {
                break;
            }
            let entry = db(entry)?;
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if let Some(id) = name
                .strip_prefix("package-archive-ready-")
                .and_then(|n| n.strip_suffix(".json"))
            {
                if !manuscript::uuid4(id) {
                    continue;
                }
                let ready: ArchiveReady = journal::read(&entry.path())?;
                if ready.source != source || ready.view.expires_at > now() {
                    continue;
                }
                let _retention = match journal::lock(
                    &self.directory.join(format!("package-retention-{id}.lock")),
                ) {
                    Ok(lease) => lease,
                    Err(error) if error.0 == "MIGRATION_BUSY" => continue,
                    Err(error) => return Err(error),
                };
                {
                    let _journal = self.journal_lock()?;
                    let op = self.package_read(r, id)?;
                    if active(&op.view.state)
                        || op
                            .capture_retry_until
                            .unwrap_or(0)
                            .max(ready.view.expires_at)
                            > now()
                    {
                        continue;
                    }
                }
                let reader = db(File::options()
                    .read(true)
                    .write(true)
                    .create(true)
                    .truncate(false)
                    .open(self.directory.join(format!("package-reader-{id}.lock"))))?;
                if reader.try_lock().is_err() {
                    continue;
                }
                let _reader = journal::Lease(reader);
                if self.expire_file("archive", id, &ready.view.hash, ready.view.size as u64)? {
                    expired += 1;
                }
                if let Err(error) = self.expire_ready_stages(r, id, &ready)
                    && error.0 == "PACKAGE_CANCELLED"
                {
                    return Err(error);
                }
                {
                    let mut c = db(r.connection.lock())?;
                    let tx = db(c.transaction())?;
                    db(tx.execute("DELETE FROM package_capture_pins WHERE export_id=?1", [id]))?;
                    db(tx.execute("UPDATE package_exports SET roots_hash=NULL,capture_state='expired',capture_store=NULL,capture_token=NULL,capture_owner=NULL,materialized_token=NULL WHERE export_id=?1",[id]))?;
                    db(tx.commit())?;
                }
            } else if let Some(id) = name
                .strip_prefix("package-work-inventory-")
                .and_then(|name| name.strip_suffix(".json"))
            {
                if manuscript::uuid4(id) && self.expire_work_capture(r, id)? {
                    expired += 1;
                }
            } else if let Some(id) = name
                .strip_prefix("package-intake-")
                .and_then(|n| n.strip_suffix(".json"))
            {
                if !manuscript::uuid4(id) {
                    continue;
                }
                let old: intake::Intake = journal::read(&entry.path())?;
                if old.source != source || old.view.expires_at > now() {
                    continue;
                }
                let used = active_ops.iter().any(|op| match &op.request {
                    Request::Inspect(v) => v.intake_id == id,
                    Request::Restore(v) => self
                        .inspection_record(r, &v.inspection_id)
                        .is_ok_and(|i| i.view.intake_id == id),
                    Request::Return(v) => self
                        .inspection_record(r, &v.inspection_id)
                        .is_ok_and(|i| i.view.intake_id == id),
                    _ => false,
                });
                if used {
                    continue;
                }
                let lock = db(File::options()
                    .read(true)
                    .write(true)
                    .create(true)
                    .truncate(false)
                    .open(self.directory.join(format!("package-intake-{id}.lock"))))?;
                if lock.try_lock().is_err() {
                    continue;
                }
                let _intake = journal::Lease(lock);
                {
                    let _journal = self.journal_lock()?;
                }
                let current = self.intake_scoped(r, id)?;
                if current.view.state != PackageIntakeViewState::Expired {
                    continue;
                }
                let (expected, size) = if current.view.received_bytes == current.view.length {
                    (current.view.hash.clone(), current.view.length as u64)
                } else {
                    let p = Parent::open(&self.directory, &format!("intake-{id}.zip"))?;
                    let Some((mut file, _)) = p.open_file(&p.name)? else {
                        continue;
                    };
                    let before = intake::Stamp::read(&file)?;
                    if current.stamp.as_ref() != Some(&before) {
                        continue;
                    }
                    let actual = crate::storage::objects::stream_copy(
                        &mut file,
                        &mut std::io::sink(),
                        current.view.received_bytes as u64,
                    )?;
                    if intake::Stamp::read(&file)? != before {
                        continue;
                    }
                    actual
                };
                if self.expire_file("intake", id, &expected, size)? {
                    expired += 1;
                }
            }
        }
        expired += self.expire_pending_captures(r, 100usize.saturating_sub(expired))?;
        Ok(expired)
    }
    fn expire_work_capture(&self, r: &SqliteProjectRepository, id: &str) -> Result<bool> {
        let _retention =
            match journal::lock(&self.directory.join(format!("package-retention-{id}.lock"))) {
                Ok(lease) => lease,
                Err(error) if error.0 == "MIGRATION_BUSY" => return Ok(false),
                Err(error) => return Err(error),
            };
        let op = {
            let _journal = self.journal_lock()?;
            match self.package_read(r, id) {
                Ok(op) => op,
                Err(error) if error.0 == "PACKAGE_NOT_FOUND" => return Ok(false),
                Err(error) => return Err(error),
            }
        };
        let Request::Work(request) = &op.request else {
            return Ok(false);
        };
        if !matches!(
            op.view.state,
            PackageOperationViewState::Cancelled
                | PackageOperationViewState::Failed
                | PackageOperationViewState::Interrupted
        ) {
            return Ok(false);
        }
        let path = self.package_path("work-inventory", id);
        let mut capture: WorkCapture = large_read(&path, 16 << 20)?;
        if capture.expired || capture.expires_at.max(op.capture_retry_until.unwrap_or(0)) > now() {
            return Ok(false);
        }
        let reader = db(File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.directory.join(format!("package-reader-{id}.lock"))))?;
        if reader.try_lock().is_err() {
            return Ok(false);
        }
        let _reader = journal::Lease(reader);
        if let Ok(Some(archive)) = self.reconcile_archive(r, &op)
            && archive.expires_at > now()
        {
            return Ok(false);
        }
        {
            let _journal = self.journal_lock()?;
            let current = self.package_read(r, id)?;
            if active(&current.view.state) || current.capture_retry_until.unwrap_or(0) > now() {
                return Ok(false);
            }
        }
        // The retention lease and single transfer worker exclude capture/retry
        // writers; keep bounded large-record I/O outside the short journal lock.
        capture.expired = true;
        large_save(&path, &capture, 16 << 20)?;
        if capture
            .stage
            .strip_prefix(&format!("work-capture-{id}-"))
            .is_some_and(|suffix| suffix.parse::<u64>().is_ok())
            && capture.descriptor.kind == "work-copy"
            && capture.descriptor.export_id == id
            && capture.descriptor.project_id == request.owner_project_id
            && capture.descriptor.work_item_id.as_ref() == Some(&request.work_item_id)
        {
            self.expire_stage(&capture.stage, &capture.descriptor.members, false)?;
        }
        Ok(true)
    }
    fn expire_pending_captures(&self, r: &SqliteProjectRepository, budget: usize) -> Result<usize> {
        let owner = r.migration_source_identity()?;
        let store = pins::register_store(&self.directory)?;
        let ids = {
            let c = db(r.connection.lock())?;
            let mut q = db(c.prepare("SELECT export_id FROM package_exports WHERE roots_hash IS NOT NULL AND capture_owner=?1 AND capture_store=?2 AND capture_expires_at<=?3 LIMIT ?4"))?;
            db(
                q.query_map(params![owner, store, now(), budget as i64], |row| {
                    row.get::<_, String>(0)
                }),
            )?
            .map(db)
            .collect::<Result<Vec<_>>>()?
        };
        let mut expired = 0;
        for id in ids {
            uuid(&id)?;
            let _retention =
                match journal::lock(&self.directory.join(format!("package-retention-{id}.lock"))) {
                    Ok(lease) => lease,
                    Err(error) if error.0 == "MIGRATION_BUSY" => continue,
                    Err(error) => return Err(error),
                };
            let op = {
                let _journal = self.journal_lock()?;
                self.package_read(r, &id)?
            };
            if let Some(until) = op.capture_retry_until
                && until > now()
            {
                // Project only an already durable accepted retry into the SQL
                // deadline index, so renewed rows cannot starve later expiry.
                let c = db(r.connection.lock())?;
                db(c.execute("UPDATE package_exports SET capture_expires_at=MAX(capture_expires_at,?2) WHERE export_id=?1 AND capture_owner=?3",params![id,until,owner]))?;
                continue;
            }
            if !matches!(op.request, Request::Export(_))
                || !matches!(
                    op.view.state,
                    PackageOperationViewState::Cancelled
                        | PackageOperationViewState::Failed
                        | PackageOperationViewState::Interrupted
                )
            {
                continue;
            }
            let (roots_hash, token, until) = {
                let c = db(r.connection.lock())?;
                let row:Option<(String,String,i64)>=db(c.query_row("SELECT roots_hash,capture_token,capture_expires_at FROM package_exports WHERE export_id=?1 AND roots_hash IS NOT NULL AND capture_owner=?2 AND capture_store=?3",params![id,owner,store],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional())?;
                let Some(row) = row else {
                    continue;
                };
                row
            };
            if until.max(op.capture_retry_until.unwrap_or(0)) > now() {
                continue;
            }
            if op.capture_id.as_deref() != Some(token.as_str()) {
                continue;
            }
            let reader = db(File::options()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(self.directory.join(format!("package-reader-{id}.lock"))))?;
            if reader.try_lock().is_err() {
                continue;
            }
            let _reader = journal::Lease(reader);
            if let Ok(Some(archive)) = self.reconcile_archive(r, &op)
                && archive.expires_at > now()
            {
                let c = db(r.connection.lock())?;
                db(c.execute("UPDATE package_exports SET capture_expires_at=MAX(capture_expires_at,?2) WHERE export_id=?1 AND capture_owner=?3",params![id,archive.expires_at,owner]))?;
                continue;
            }
            // Own the bounded record before atomically releasing its last pin.
            // A failed proof preserves residual bytes but cannot pin forever.
            let record = r.read_bounded_object(&roots_hash, 16 << 20).ok();
            let materialized = self.recorded_materialization(r, &id)?;
            r.source_cut("package-expiry-claimed")?;
            {
                let _journal = self.journal_lock()?;
                let fresh = self.package_read(r, &id)?;
                if active(&fresh.view.state) || fresh.capture_retry_until.unwrap_or(0) > now() {
                    continue;
                }
                let mut c = db(r.connection.lock())?;
                let tx = db(c.transaction())?;
                let changed=db(tx.execute("UPDATE package_exports SET capture_state='expired',roots_hash=NULL,capture_store=NULL,capture_token=NULL,capture_owner=NULL,materialized_token=NULL WHERE export_id=?1 AND roots_hash=?2 AND capture_owner=?3",params![id,roots_hash,owner]))?;
                if changed == 0 {
                    continue;
                }
                db(tx.execute("DELETE FROM package_capture_pins WHERE export_id=?1", [&id]))?;
                db(tx.commit())?;
            }
            expired += 1;
            if let Some((token, descriptor)) = materialized {
                self.expire_stage(&token, &descriptor.members, true)?;
            }
            if let Some(bytes) = record
                && let Ok(roots) = serde_json::from_slice::<pins::CaptureRoots>(&bytes)
                && roots.version == 1
                && roots.request.request_id == id
                && let Request::Export(request) = &op.request
                && roots.request == *request
                && roots.controls.len() == 2
            {
                let mut expected = roots
                    .controls
                    .into_iter()
                    .map(|(path, record)| Member {
                        path,
                        hash: record.hash,
                        size: record.size,
                    })
                    .collect::<Vec<_>>();
                let request_bytes = db(serde_json::to_vec(request))?;
                for path in ["capture.json", "sql-capture.json"] {
                    expected.push(Member {
                        path: path.into(),
                        hash: hash(&request_bytes),
                        size: request_bytes.len() as u64,
                    });
                }
                expected.push(Member {
                    path: "capture-roots.json".into(),
                    hash: roots_hash,
                    size: bytes.len() as u64,
                });
                self.expire_stage(&token, &expected, false)?;
            }
        }
        Ok(expired)
    }
    fn recorded_materialization(
        &self,
        r: &SqliteProjectRepository,
        id: &str,
    ) -> Result<Option<(String, Descriptor)>> {
        let token: Option<String> = {
            let c = db(r.connection.lock())?;
            db(c.query_row(
                "SELECT materialized_token FROM package_exports WHERE export_id=?1",
                [id],
                |row| row.get(0),
            ))?
        };
        let Some(token) = token else {
            return Ok(None);
        };
        let Some(suffix) = token.strip_prefix(&format!("materialized-{id}-")) else {
            return Ok(None);
        };
        if suffix.parse::<u64>().is_err() {
            return Ok(None);
        }
        let Ok((base, descriptor)) = r.trusted_package_base(id) else {
            return Ok(None);
        };
        if descriptor.export_id != id || descriptor.capture.as_ref() != Some(&base) {
            return Ok(None);
        }
        Ok(Some((token, descriptor)))
    }
    fn expire_ready_stages(
        &self,
        r: &SqliteProjectRepository,
        id: &str,
        ready: &ArchiveReady,
    ) -> Result<()> {
        let op = self.package_read(r, id)?;
        if active(&op.view.state) {
            return Ok(());
        }
        let descriptor = match &op.request {
            Request::Export(_) => {
                let (_, d) = r.trusted_package_base(id)?;
                d
            }
            Request::Work(_) => {
                // The recorded private stage is the original immutable export inventory.
                let path = self.package_path("work-inventory", id);
                if !path.exists() {
                    return Ok(());
                }
                large_read::<WorkCapture>(&path, 16 << 20)?.descriptor
            }
            _ => return Ok(()),
        };
        if hash(&db(serde_json::to_vec(&descriptor))?) != ready.descriptor_hash {
            return Err(fail("PACKAGE_ARCHIVE_INVALID"));
        }
        if let Request::Export(request) = &op.request {
            if let Some(token) = &op.capture_id {
                let mut expected = descriptor
                    .members
                    .iter()
                    .filter(|m| {
                        matches!(
                            m.path.as_str(),
                            ".scenesparrow/project.sqlite" | ".scenesparrow/managed.json"
                        )
                    })
                    .cloned()
                    .collect::<Vec<_>>();
                let bytes = db(serde_json::to_vec(request))?;
                expected.push(Member {
                    path: "capture.json".into(),
                    hash: hash(&bytes),
                    size: bytes.len() as u64,
                });
                expected.push(Member {
                    path: "sql-capture.json".into(),
                    hash: hash(&bytes),
                    size: bytes.len() as u64,
                });
                let roots_hash: Option<String> = {
                    let c = db(r.connection.lock())?;
                    db(c.query_row(
                        "SELECT roots_hash FROM package_exports WHERE export_id=?1",
                        [id],
                        |r| r.get(0),
                    ))?
                };
                if let Some(hash) = roots_hash {
                    let bytes = r.read_bounded_object(&hash, 16 << 20)?;
                    expected.push(Member {
                        path: "capture-roots.json".into(),
                        hash,
                        size: bytes.len() as u64,
                    });
                }
                self.expire_stage(token, &expected, false)?;
            }
            if let Some((token, recorded)) = self.recorded_materialization(r, id)?
                && hash(&db(serde_json::to_vec(&recorded))?) == ready.descriptor_hash
            {
                self.expire_stage(&token, &recorded.members, true)?;
            }
        } else {
            let mut capture: WorkCapture =
                large_read(&self.package_path("work-inventory", id), 16 << 20)?;
            self.expire_stage(&capture.stage, &descriptor.members, false)?;
            capture.expired = true;
            large_save(&self.package_path("work-inventory", id), &capture, 16 << 20)?;
        }
        Ok(())
    }
    fn expire_stage(&self, token: &str, members: &[Member], management: bool) -> Result<()> {
        if !token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err(fail("STORAGE_UNAVAILABLE"));
        }
        let attempted = self
            .directory
            .join(format!("package-expired-stage-{token}.json"));
        if attempted.exists() {
            return Ok(());
        }
        journal::save(
            &attempted,
            &serde_json::json!({"version":1,"attemptedAt":now()}),
        )?;
        let outcome: Result<()> = (|| {
            let entry = Parent::open(&self.directory, token)?;
            if !entry.bound_directory_path()?.join(token).exists() {
                return Ok(());
            }
            let owner = Parent::open(&self.directory, &format!("{token}/__expiry__"))?;
            let bound = owner.bound_directory_path()?;
            let expected = members
                .iter()
                .map(|m| (m.path.clone(), m))
                .collect::<std::collections::BTreeMap<_, _>>();
            let mut directories = std::collections::BTreeSet::new();
            for m in members {
                let mut path = m.path.as_str();
                while let Some((parent, _)) = path.rsplit_once('/') {
                    directories.insert(parent.to_owned());
                    path = parent;
                }
            }
            if management {
                directories.extend([
                    ".scenesparrow/objects".into(),
                    ".scenesparrow/exports".into(),
                ]);
            }
            let verified = (|| {
                let mut todo = vec![(String::new(), 0usize)];
                let mut seen = std::collections::BTreeSet::new();
                let mut budget = 100_000usize;
                while let Some((prefix, depth)) = todo.pop() {
                    if depth > 64 {
                        return Err(fail("PACKAGE_SIZE_LIMIT"));
                    }
                    let parent = Parent::open(
                        &bound,
                        &if prefix.is_empty() {
                            "__expiry__".into()
                        } else {
                            format!("{prefix}/__expiry__")
                        },
                    )?;
                    for name in parent.entries(budget)? {
                        budget = budget.checked_sub(1).ok_or(fail("PACKAGE_SIZE_LIMIT"))?;
                        let path = if prefix.is_empty() {
                            name.clone()
                        } else {
                            format!("{prefix}/{name}")
                        };
                        let metadata = db(std::fs::symlink_metadata(
                            parent.bound_directory_path()?.join(&name),
                        ))?;
                        if metadata.is_dir() && !metadata.file_type().is_symlink() {
                            if !directories.contains(&path) {
                                return Err(fail("PACKAGE_ARCHIVE_INVALID"));
                            }
                            todo.push((path, depth + 1));
                        } else if metadata.is_file() && !metadata.file_type().is_symlink() {
                            let member =
                                expected.get(&path).ok_or(fail("PACKAGE_ARCHIVE_INVALID"))?;
                            let (mut file, _) = parent
                                .open_file(&name)?
                                .ok_or(fail("PACKAGE_ARCHIVE_INVALID"))?;
                            if crate::storage::objects::stream_copy(
                                &mut file,
                                &mut std::io::sink(),
                                member.size,
                            )? != (member.hash.clone(), member.size)
                            {
                                return Err(fail("PACKAGE_ARCHIVE_INVALID"));
                            }
                            seen.insert(path);
                        } else {
                            return Err(fail("PACKAGE_ARCHIVE_INVALID"));
                        }
                    }
                }
                if seen.len() != expected.len() {
                    return Err(fail("PACKAGE_ARCHIVE_INVALID"));
                }
                owner.verify()
            })();
            verified?;
            let quarantine = format!(".expired-package-{}", uuid::Uuid::new_v4());
            entry.rename_no_replace(token, &quarantine)?;
            let owner = owner.relocated_directory(&format!("{quarantine}/__expiry__"))?;
            let detached = Parent::open(&self.directory, &quarantine)?;
            owner.remove_discarded_container(&detached)
        })();
        match outcome {
            Err(error) if error.0 == "PACKAGE_CANCELLED" => Err(error),
            _ => Ok(()),
        }
    }
    fn expire_file(&self, kind: &str, id: &str, expected: &str, size: u64) -> Result<bool> {
        let attempt = self.package_path(&format!("expired-{kind}"), id);
        if attempt.exists() {
            return Ok(false);
        }
        journal::save(
            &attempt,
            &serde_json::json!({"version":1,"kind":kind,"id":id,"attemptedAt":now()}),
        )?;
        let outcome: Result<bool> = (|| {
            let parent = Parent::open(&self.directory, &format!("{kind}-{id}.zip"))?;
            let Some((mut file, identity)) = parent.open_file(&parent.name)? else {
                return Ok(false);
            };
            let actual = crate::storage::objects::stream_copy(
                &mut file,
                &mut std::io::sink(),
                Limits::default().compressed,
            )?;
            if actual != (expected.into(), size) {
                return Ok(false);
            }
            let stage = format!(".expired-package-{}", uuid::Uuid::new_v4());
            let bound = parent.bound_directory_path()?;
            db(std::fs::create_dir(bound.join(&stage)))?;
            let entry = Parent::open(&bound, &stage)?;
            let held = Parent::open(&bound, &format!("{stage}/payload"))?;
            parent.verify()?;
            parent.rename_into(&parent.name, &held, "payload")?;
            let Some((_file, detached)) = held.open_file("payload")? else {
                return Ok(false);
            };
            if detached != identity {
                return Ok(false);
            }
            held.remove_discarded_container(&entry)?;
            Ok(true)
        })();
        match outcome {
            Err(error) if error.0 == "PACKAGE_CANCELLED" => Err(error),
            Err(_) => Ok(false),
            result => result,
        }
    }
}
