use super::*;
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Inspection {
    pub(super) source: String,
    pub(super) view: PackageInspectionView,
    pub(super) inspected: Inspected,
}
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Target {
    pub(super) source: String,
    pub(super) view: PackageRestoreTarget,
}
impl ProjectTransferStore {
    fn trusted_export(
        &self,
        r: &SqliteProjectRepository,
        id: &str,
    ) -> Result<(ProjectPackageBase, Descriptor)> {
        let op = self
            .package_read(r, id)
            .map_err(|_| fail("PACKAGE_TRUSTED_BASE_MISSING"))?;
        if !matches!(op.request, Request::Export(_))
            || op.view.state != PackageOperationViewState::Succeeded
        {
            return Err(fail("PACKAGE_TRUSTED_BASE_MISSING"));
        }
        let record: ArchiveReady = journal::read(&self.package_path("archive-ready", id))?;
        let (base, descriptor) = r.trusted_package_base(id)?;
        if record.source != r.migration_source_identity()?
            || record.digest != op.digest
            || record.descriptor_hash != hash(&db(serde_json::to_vec(&descriptor))?)
        {
            return Err(fail("PACKAGE_TRUSTED_BASE_MISSING"));
        }
        Ok((base, descriptor))
    }
    pub(super) fn inspection_record(
        &self,
        r: &SqliteProjectRepository,
        id: &str,
    ) -> Result<Inspection> {
        uuid(id)?;
        let record: Inspection = large_read(&self.package_path("inspection", id), 16 << 20)?;
        if record.source != r.migration_source_identity()? {
            return Err(fail("PACKAGE_NOT_FOUND"));
        }
        Ok(record)
    }
    pub fn package_inspection(
        &self,
        r: &SqliteProjectRepository,
        id: &str,
    ) -> Result<PackageInspectionView> {
        self.inspection_record(r, id).map(|i| i.view)
    }
    fn open_intake_file(&self, r: &SqliteProjectRepository, id: &str) -> Result<File> {
        let i = self.intake_scoped(r, id)?;
        if i.view.state != PackageIntakeViewState::Sealed {
            return Err(fail("PACKAGE_INTAKE_CLOSED"));
        }
        let p = Parent::open(&self.directory, &format!("intake-{id}.zip"))?;
        let (f, _) = p.open_file(&p.name)?.ok_or(fail("PACKAGE_NOT_FOUND"))?;
        p.verify()?;
        Ok(f)
    }
    pub(super) fn inspect_intake(
        &self,
        r: &SqliteProjectRepository,
        request: &PackageInspectionRequest,
        cancel: &dyn Fn() -> bool,
    ) -> Result<Inspection> {
        if self
            .package_path("inspection", &request.request_id)
            .exists()
        {
            return self.inspection_record(r, &request.request_id);
        }
        self.seal_intake(r, &request.intake_id)?;
        let intake = self.intake_scoped(r, &request.intake_id)?;
        let mut f = self.open_intake_file(r, &request.intake_id)?;
        let actual = crate::storage::objects::stream_copy(
            &mut f,
            &mut std::io::sink(),
            intake.view.length as u64,
        )?;
        if actual != (intake.view.hash, intake.view.length as u64) {
            return Err(fail("PACKAGE_HASH_MISMATCH"));
        }
        self.package_progress(
            r,
            &request.request_id,
            PackageOperationViewPhase::Inspect,
            intake.view.length as u64,
            0,
        )?;
        let inspected = archive::inspect(&f, Limits::default(), cancel)?;
        let parent = Parent::open(
            &self.directory,
            &format!(
                "inspection-stage-{}-{}",
                request.request_id,
                uuid::Uuid::new_v4()
            ),
        )?;
        let root = parent.bound_directory_path()?.join(&parent.name);
        db(std::fs::create_dir(&root))?;
        let held = Parent::open(&root, "__inspection__")?;
        let bound = held.bound_directory_path()?;
        archive::extract(&f, &bound, &inspected, cancel)?;
        let verified = inspected
            .descriptor
            .as_ref()
            .is_some_and(|d| d.kind == "project")
            && inspected.unchanged;
        if verified {
            self.package_progress(
                r,
                &request.request_id,
                PackageOperationViewPhase::Verify,
                inspected.expanded,
                inspected.entry_count,
            )?;
            let captured = validate_native(&bound, false)?;
            if inspected
                .descriptor
                .as_ref()
                .and_then(|d| d.capture.as_ref())
                != Some(&captured)
            {
                return Err(fail("PACKAGE_ARCHIVE_INVALID"));
            }
        }
        let trusted = match &inspected.descriptor {
            Some(d) if d.kind == "project" => {
                self.trusted_export(r, &d.export_id)
                    .is_ok_and(|(base, original)| {
                        original
                            .members
                            .iter()
                            .filter(|m| m.path.starts_with(".scenesparrow/"))
                            .eq(d
                                .members
                                .iter()
                                .filter(|m| m.path.starts_with(".scenesparrow/")))
                            && r.read_package_base().is_ok_and(|current| {
                                current.graph_hash == base.graph_hash
                                    && current.graph_generation == base.graph_generation
                            })
                    })
            }
            Some(d) => r
                .work_item(d.work_item_id.as_deref().unwrap_or(""))
                .is_ok_and(|item| {
                    item.project_id == d.project_id
                        && item.copy_available
                        && item.state != WorkItemViewState::Discarded
                        && d.base_graph_hash.as_deref() == Some(item.base_graph_hash.as_str())
                        && d.base_graph_generation == Some(item.base_graph_generation)
                }),
            None => false,
        };
        let view = PackageInspectionView {
            inspection_id: request.request_id.clone(),
            owner_project_id: request.owner_project_id.clone(),
            intake_id: request.intake_id.clone(),
            kind: match inspected.descriptor.as_ref().map(|d| d.kind.as_str()) {
                Some("project") => PackageInspectionViewKind::Project,
                Some(_) => PackageInspectionViewKind::Workcopy,
                None => PackageInspectionViewKind::Unmanaged,
            },
            result_project_id: Some(inspected.manifest_project.clone()),
            export_id: inspected.descriptor.as_ref().map(|d| d.export_id.clone()),
            work_item_id: inspected
                .descriptor
                .as_ref()
                .and_then(|d| d.work_item_id.clone()),
            entry_count: inspected.entry_count as i64,
            expanded_bytes: inspected.expanded as i64,
            verified_restore: verified,
            trusted_return: trusted,
            management_policy: if verified {
                PackageInspectionViewManagementPolicy::Verified
            } else if inspected.descriptor.is_some() {
                PackageInspectionViewManagementPolicy::Ignored
            } else {
                PackageInspectionViewManagementPolicy::Absent
            },
        };
        let record = Inspection {
            source: r.migration_source_identity()?,
            view,
            inspected,
        };
        let bytes = db(serde_json::to_vec(&record))?;
        if bytes.len() > 16 << 20 {
            return Err(fail("PACKAGE_SIZE_LIMIT"));
        }
        write_new(
            &self.package_path("inspection", &request.request_id),
            &bytes,
        )?;
        held.verify()?;
        parent.verify()?;
        Ok(record)
    }
    pub fn issue_package_restore_target(
        &self,
        r: &SqliteProjectRepository,
        request: &PackageRestoreTargetRequest,
    ) -> Result<PackageRestoreTarget> {
        uuid(&request.request_id)?;
        let source = r.migration_source_identity()?;
        let digest = hash(&db(serde_json::to_vec(request))?);
        let receipt = self.package_path("target-request", &request.request_id);
        let _lock = self.journal_lock()?;
        if let Some(old) = self.original(&receipt, &digest, &source)? {
            return Ok(old);
        }
        let mut target = None;
        let outcome = (|| {
            Self::check_owner(r, &request.owner_project_id)?;
            let inspection = self.inspection_record(r, &request.inspection_id)?;
            if !inspection.view.verified_restore {
                return Err(fail("PACKAGE_RESTORE_UNAVAILABLE"));
            }
            let view = PackageRestoreTarget {
                target_id: uuid::Uuid::new_v4().to_string(),
                owner_project_id: request.owner_project_id.clone(),
                inspection_id: request.inspection_id.clone(),
                result_project_id: inspection
                    .view
                    .result_project_id
                    .ok_or(fail("PACKAGE_TARGET_INVALID"))?,
                destination: PackageRestoreTargetDestination::Managed,
            };
            target = Some(Target {
                source: source.clone(),
                view: view.clone(),
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
        if let Some(t) = target {
            files.push((self.package_path("target", &t.view.target_id), json(&t)?));
        }
        self.package_commit(self.index()?, files)?;
        outcome
    }
    pub(super) fn restore_package(
        &self,
        r: &SqliteProjectRepository,
        op: &Operation,
        request: &PackageRestoreRequest,
        cancel: &dyn Fn() -> bool,
    ) -> Result<PackageRestoreTarget> {
        if let Some(ready) = self.reconcile_restore(r, op)? {
            return Ok(ready);
        }
        let inspection = self.inspection_record(r, &request.inspection_id)?;
        if !inspection.view.verified_restore {
            return Err(fail("PACKAGE_RESTORE_UNAVAILABLE"));
        }
        let target: Target = journal::read(&self.package_path("target", &request.target_id))?;
        if target.source != r.migration_source_identity()?
            || target.view.inspection_id != request.inspection_id
        {
            return Err(fail("PACKAGE_TARGET_INVALID"));
        }
        let parent = Parent::open(&self.roots, &request.target_id)?;
        let directory = parent.bound_directory_path()?;
        let target_bound = directory.join(&parent.name);
        if target_bound.exists() {
            return Err(fail("PACKAGE_TARGET_EXISTS"));
        }
        let stage = format!(".restore-{}-{}", request.request_id, op.attempt);
        let root = directory.join(&stage);
        db(std::fs::create_dir(&root))?;
        let held = Parent::open(&root, "__restore__")?;
        let bound = held.bound_directory_path()?;
        let root = bound;
        r.source_cut("package-restore-held")?;
        let f = self.open_intake_file(r, &inspection.view.intake_id)?;
        archive::extract(&f, &root, &inspection.inspected, cancel)?;
        validate_native(&root, true)?;
        let marker = serde_json::json!({"version":1,"requestId":request.request_id,"target":target.view,"intakeId":inspection.view.intake_id,"archiveHash":self.intake_scoped(r,&inspection.view.intake_id)?.view.hash});
        write_new(
            &root.join(".scenesparrow/package-ready.json"),
            &db(serde_json::to_vec(&marker))?,
        )?;
        sync(&root.join(".scenesparrow"))?;
        sync(&root)?;
        if cancel() {
            return Err(fail("PACKAGE_CANCELLED"));
        }
        self.package_progress(
            r,
            &request.request_id,
            PackageOperationViewPhase::Promote,
            inspection.inspected.expanded,
            inspection.inspected.entry_count,
        )?;
        held.verify()?;
        parent.verify()?;
        self.cut("package-before-promote")?;
        held.verify()?;
        parent
            .rename_no_replace(&stage, &parent.name)
            .map_err(|_| fail("PACKAGE_TARGET_EXISTS"))?;
        parent.sync()?;
        self.cut("package-promoted")?;
        r.source_cut("package-promoted-io")?;
        Ok(target.view)
    }
    pub(super) fn reconcile_restore(
        &self,
        r: &SqliteProjectRepository,
        op: &Operation,
    ) -> Result<Option<PackageRestoreTarget>> {
        let Request::Restore(request) = &op.request else {
            return Ok(None);
        };
        let target: Target = journal::read(&self.package_path("target", &request.target_id))?;
        if target.source != r.migration_source_identity()? {
            return Err(fail("PACKAGE_TARGET_INVALID"));
        }
        let parent = Parent::open(&self.roots, &request.target_id)?;
        let root = parent.bound_directory_path()?.join(&parent.name);
        if !root.exists() {
            return Ok(None);
        }
        let Ok(held) = Parent::open(&self.roots, &format!("{}/__ready__", request.target_id))
        else {
            return Ok(None);
        };
        let bound = held.bound_directory_path()?;
        let root = bound.as_path();
        let Ok(marker_parent) = Parent::open(root, ".scenesparrow/package-ready.json") else {
            return Ok(None);
        };
        let Ok(marker) = large_read::<serde_json::Value>(
            &marker_parent
                .bound_directory_path()?
                .join("package-ready.json"),
            4 << 20,
        ) else {
            return Ok(None);
        };
        let inspection = self.inspection_record(r, &request.inspection_id)?;
        let expected = serde_json::json!({"version":1,"requestId":request.request_id,"target":target.view,"intakeId":inspection.view.intake_id,"archiveHash":self.intake_scoped(r,&inspection.view.intake_id)?.view.hash});
        if marker != expected {
            return Ok(None);
        }
        validate_native(root, false).map_err(|_| fail("PACKAGE_TARGET_INVALID"))?;
        held.verify()?;
        marker_parent.verify()?;
        parent.verify()?;
        Ok(Some(target.view))
    }
    pub(super) fn return_package(
        &self,
        r: &SqliteProjectRepository,
        request: &PackageReturnRequest,
        cancel: &dyn Fn() -> bool,
    ) -> Result<WorkCandidateView> {
        let lease = {
            let _c = db(r.connection.lock())?;
            r.preparation_leases
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            PreparationLease(r.preparation_leases.clone())
        };
        let inspection = self.inspection_record(r, &request.inspection_id)?;
        let d = inspection
            .inspected
            .descriptor
            .as_ref()
            .ok_or(fail("PACKAGE_TRUSTED_BASE_MISSING"))?;
        let base = if d.kind == "work-copy" {
            let item_id = request
                .work_item_id
                .as_ref()
                .ok_or(fail("PACKAGE_TRUSTED_BASE_MISSING"))?;
            if d.work_item_id.as_ref() != Some(item_id) || request.grant.is_some() {
                return Err(fail("PACKAGE_TRUSTED_BASE_MISSING"));
            }
            let item = r.work_item(item_id)?;
            crate::open_source::graph::GraphSnapshot {
                hash: item.base_graph_hash.clone(),
                generation: item.base_graph_generation,
                graph: r.read_file_graph(&item.base_graph_hash)?,
            }
        } else {
            if request.work_item_id.is_some() {
                return Err(fail("INVALID_REQUEST"));
            }
            let (base, original) = self.trusted_export(r, &d.export_id)?;
            if original
                .members
                .iter()
                .filter(|m| m.path.starts_with(".scenesparrow/"))
                .ne(d
                    .members
                    .iter()
                    .filter(|m| m.path.starts_with(".scenesparrow/")))
            {
                return Err(fail("PACKAGE_MANAGEMENT_CHANGED"));
            }
            crate::open_source::graph::GraphSnapshot {
                hash: base.graph_hash.clone(),
                generation: base.graph_generation,
                graph: r.read_file_graph(&base.graph_hash)?,
            }
        };
        let f = self.open_intake_file(r, &inspection.view.intake_id)?;
        let mut z = db(zip::ZipArchive::new(f))?;
        let mut files = vec![];
        // Populate immutable objects only. Supplied management never enters active SQL.
        for m in &inspection.inspected.members {
            let path = if d.kind == "work-copy" {
                let Some(p) = m.path.strip_prefix("project/") else {
                    continue;
                };
                p
            } else {
                if m.path.starts_with(".scenesparrow/") {
                    continue;
                }
                m.path.as_str()
            };
            if cancel() {
                return Err(fail("PACKAGE_CANCELLED"));
            }
            let mut input = db(z.by_name(&m.path))?;
            let (hash, size) = r.object_stream(&mut input, m.size)?;
            if hash != m.hash || size != m.size {
                return Err(fail("PACKAGE_ARCHIVE_INVALID"));
            }
            files.push(crate::open_source::graph::GraphFile {
                path: path.into(),
                hash,
                size,
            });
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));
        let raw = crate::open_source::graph::FileGraph {
            version: 1,
            project_id: request.owner_project_id.clone(),
            files,
        };
        let candidate = r.prepare_package_return(request, &base, raw)?;
        {
            let c = db(r.connection.lock())?;
            db(c.execute(
                "INSERT OR IGNORE INTO package_intake_leases VALUES(?1,?2,?3,NULL)",
                rusqlite::params![
                    request.request_id,
                    inspection.view.intake_id,
                    candidate.candidate_id
                ],
            ))?;
        }
        drop(lease);

        let _intake = journal::lock(
            &self
                .directory
                .join(format!("package-intake-{}.lock", inspection.view.intake_id)),
        )?;
        {
            let _journal = self.journal_lock()?;
        }
        let mut intake = self.intake_scoped(r, &inspection.view.intake_id)?;
        intake.view.expires_at = now() + CACHE_TTL;
        intake.view.revision += 1;
        journal::save(
            &self.package_path("intake", &intake.view.intake_id),
            &intake,
        )?;
        Ok(candidate)
    }
}
/// No normal startup runs before these invariants and recovered-origin fences.
fn validate_native(root: &Path, fence: bool) -> Result<ProjectPackageBase> {
    let held = Parent::open(root, "__validated__")?;
    let bound = held.bound_directory_path()?;
    let root = bound.as_path();
    let management_held = Parent::open(root, ".scenesparrow/__validated__")?;
    let manifest = match SqliteProjectRepository::inspect_format(root)? {
        crate::open_source::ProjectInspection::Managed(m) => m,
        _ => return Err(fail("PACKAGE_ARCHIVE_INVALID")),
    };
    let management = management_held.bound_directory_path()?;
    db(SqliteProjectRepository::inspect_project(&management))?;
    let mut repository = if fence {
        db(SqliteProjectRepository::open_storage_mode(
            &management,
            true,
            None,
            false,
        ))?
    } else {
        SqliteProjectRepository::detached(
            &management,
            db(crate::Connection::open_with_flags(
                management.join("project.sqlite"),
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            ))?,
        )
    };
    repository.creative_root = Some(root.to_path_buf());
    repository.verify_source_state()?;
    db(repository.verify_manuscript())?;
    let graph = repository
        .accepted_file_graph()?
        .ok_or(fail("PACKAGE_ARCHIVE_INVALID"))?;
    if graph.graph.project_id != manifest.project_id {
        return Err(fail("PACKAGE_ARCHIVE_INVALID"));
    }
    for m in graph.graph.files {
        if member_at(root, &m.path)?
            != (Member {
                path: m.path,
                hash: m.hash,
                size: m.size,
            })
        {
            return Err(fail("PACKAGE_ARCHIVE_INVALID"));
        }
    }
    if fence {
        scenesparrow_application::ai::AiExecutionPort::reconcile_execution(&repository)
            .map_err(|_| fail("PACKAGE_ARCHIVE_INVALID"))?;
        repository.recover_documents()?;
        repository.initialize_planning()?;
        let c = db(repository.connection.lock())?;
        repository.fence_copied_project_work(&c)?;
        db(c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)"))?;
        drop(c);
        repository.recover_exports()?;
    }
    db(SqliteProjectRepository::inspect_project(&management))?;
    held.verify()?;
    management_held.verify()?;
    repository.read_package_base()
}

impl SqliteProjectRepository {
    pub(crate) fn fence_copied_project_work(&self, c: &crate::Connection) -> Result<()> {
        db(c.execute_batch("DELETE FROM external_object_pins WHERE owner_id IN (SELECT id FROM planning_preparations);DELETE FROM planning_preparations;UPDATE export_jobs SET status='interrupted',attempt=attempt+1,error='EXPORT_INTERRUPTED' WHERE status IN ('queued','running');UPDATE downstream_inputs SET status='cancelled' WHERE status='using';UPDATE work_operations SET status='interrupted',failure_code='WORK_OPERATION_INTERRUPTED' WHERE status IN ('queued','running');UPDATE work_items SET state='interrupted' WHERE state IN ('preparing','inspecting');INSERT OR REPLACE INTO work_copy_availability SELECT id,0 FROM work_items WHERE origin='copy';DELETE FROM work_copy_locations;DELETE FROM work_preparations;DELETE FROM package_capture_pins;UPDATE package_exports SET capture_state='portable',capture_store=NULL,capture_token=NULL,capture_owner=NULL,roots_hash=NULL,capture_expires_at=NULL,materialized_token=NULL;UPDATE edit_groups SET closed=1 WHERE closed=0;"))?;
        Ok(())
    }
}

struct PreparationLease(std::sync::Arc<std::sync::atomic::AtomicUsize>);
impl Drop for PreparationLease {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}
