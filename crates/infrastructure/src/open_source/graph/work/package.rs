//! Package exchange reuses the recorded grant, actual diff, prepared IDs and acceptance path.
use super::*;
impl SqliteProjectRepository {
    pub(super) fn copy_available(&self, c: &Connection, item: &str) -> Result<bool> {
        let version: i64 = db(c.pragma_query_value(None, "user_version", |r| r.get(0)))?;
        if version < 15 {
            return Ok(true);
        }
        let available: Option<bool> = db(c
            .query_row(
                "SELECT available FROM work_copy_availability WHERE item_id=?1",
                [item],
                |r| r.get(0),
            )
            .optional())?;
        Ok(available.unwrap_or(true))
    }
    pub(crate) fn prepare_package_return(
        &self,
        r: &PackageReturnRequest,
        base: &GraphSnapshot,
        raw: FileGraph,
    ) -> Result<WorkCandidateView> {
        let digest = digest(r)?;
        let (item, path, protected, _lease) = {
            let mut c = db(self.connection.lock())?;
            let old: Option<(String, String)> = db(c
                .query_row(
                    "SELECT digest,item_id FROM work_package_returns WHERE request_id=?1",
                    [&r.request_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional())?;
            let item_id = if let Some((old, item)) = old {
                if old != digest {
                    return Err(fail("PACKAGE_REQUEST_CONFLICT"));
                }
                let op = self.work_operation_locked(&c, &r.request_id)?;
                if let Some(candidate) = op.candidate {
                    return Ok(candidate);
                }
                item
            } else {
                if db(c.query_row("SELECT EXISTS(SELECT 1 FROM work_operations WHERE request_id=?1 UNION SELECT 1 FROM command_receipts WHERE request_id=?1)",[&r.request_id],|r|r.get::<_,bool>(0)))?{return Err(fail("PACKAGE_REQUEST_CONFLICT"));}
                self.guard_source_recovery()?;
                let current = self
                    .file_graph_locked(&c)?
                    .ok_or(fail("GRAPH_REGISTRATION_REQUIRED"))?;
                if current.hash != base.hash || current.generation != base.generation {
                    return Err(fail("PACKAGE_BASE_MISMATCH"));
                }
                Self::admit_work_operation(&c)?;
                let item_id = if let Some(item) = &r.work_item_id {
                    let item = self.work_item_locked(&c, item)?;
                    if item.project_id != r.owner_project_id
                        || item.base_graph_hash != base.hash
                        || item.base_graph_generation != base.generation
                        || item.state == WorkItemViewState::Discarded
                        || matches!(
                            item.state,
                            WorkItemViewState::Preparing | WorkItemViewState::Inspecting
                        )
                    {
                        return Err(fail("WORK_ITEM_STALE"));
                    }
                    if r.grant.is_some() {
                        return Err(fail("INVALID_REQUEST"));
                    }
                    item.work_item_id
                } else {
                    let grant = r.grant.as_ref().ok_or(fail("WORK_SCOPE_INVALID"))?;
                    self.validate_grant(&c, grant)?;
                    if db(c.query_row("SELECT COUNT(*) FROM work_items WHERE origin='copy' AND state!='discarded'",[],|r|r.get::<_,i64>(0)))?>=5{return Err(fail("WORK_COPY_LIMIT"));}
                    uuid::Uuid::new_v4().to_string()
                };
                let project = read_project(&c)
                    .map_err(|_| fail("STORAGE_UNAVAILABLE"))?
                    .ok_or(fail("PROJECT_NOT_FOUND"))?;
                let context = WorkContext {
                    members: vec![],
                    protection: ContextProtection {
                        working_revision: project.working_revision,
                        locked_block_ids: Self::user_lock_ids(&c)?,
                        production_file_locks: Self::production_locks_locked(&c)?,
                        approved_baseline: project.approved_baseline,
                    },
                };
                let tx = db(c.transaction())?;
                if r.work_item_id.is_none() {
                    db(tx.execute("INSERT INTO work_items VALUES(?1,?2,'copy',?3,?4,?5,?6,'[]',?7,0,'inspecting',?8,NULL)",params![item_id,r.owner_project_id,base.hash,base.generation,project.working_revision,json(r.grant.as_ref().unwrap())?,json(&context)?,r.request_id]))?;
                    Self::pin_file_graph_locked(&tx, &format!("work:{item_id}:base"), &base.hash)?;
                    db(tx.execute(
                        "INSERT INTO work_copy_availability VALUES(?1,0)",
                        [&item_id],
                    ))?;
                } else {
                    db(tx.execute("UPDATE work_items SET state='inspecting',operation_id=?2,revision=revision+1 WHERE id=?1",params![item_id,r.request_id]))?;
                }
                Self::record_operation(
                    &tx,
                    &r.request_id,
                    r,
                    &r.owner_project_id,
                    &item_id,
                    "inspect",
                    "running",
                )?;
                db(tx.execute(
                    "INSERT INTO work_package_returns VALUES(?1,?2,?3)",
                    params![r.request_id, digest, item_id],
                ))?;
                db(tx.commit())?;
                item_id
            };
            let current = self
                .file_graph_locked(&c)?
                .ok_or(fail("GRAPH_REGISTRATION_REQUIRED"))?;
            if current.hash != base.hash || current.generation != base.generation {
                return Err(fail("PACKAGE_BASE_MISMATCH"));
            }
            db(c.execute(
                "UPDATE work_operations SET status='running',failure_code=NULL WHERE request_id=?1",
                [&r.request_id],
            ))?;
            let item = self.work_item_locked(&c, &item_id)?;
            let (_, path, _, _) = source_row(&c)?.ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
            (
                item,
                path,
                Self::user_lock_ids(&c)?,
                Lease::acquire(&self.preparation_leases),
            )
        };
        let outcome = self.prepare_work_graph(
            &r.request_id,
            &item,
            &path,
            &protected,
            (raw, BTreeMap::new(), true),
        );
        let mut c = db(self.connection.lock())?;
        let tx = db(c.transaction())?;
        match &outcome {
            Ok(()) => {
                db(tx.execute("UPDATE work_operations SET status='succeeded',progress=100 WHERE request_id=?1",[&r.request_id]))?;
                db(tx.execute(
                    "UPDATE work_items SET state='ready',revision=revision+1 WHERE id=?1",
                    [&item.work_item_id],
                ))?;
            }
            Err(e) => {
                db(tx.execute("UPDATE work_operations SET status='failed',failure_code=?2 WHERE request_id=?1",params![r.request_id,e.0]))?;
                db(tx.execute(
                    "UPDATE work_items SET state='failed',revision=revision+1 WHERE id=?1",
                    [&item.work_item_id],
                ))?;
            }
        }
        db(tx.commit())?;
        outcome?;
        self.work_item_locked(&c, &item.work_item_id)?
            .latest_candidate
            .ok_or(fail("WORK_CANDIDATE_STALE"))
    }
    pub(crate) fn capture_work_package(
        &self,
        r: &WorkCopyPackageExportRequest,
        output: &Path,
        cancel: &dyn Fn() -> bool,
    ) -> Result<crate::project_transfer::package::archive::Descriptor> {
        use crate::project_transfer::package::{
            archive::{Descriptor, Member},
            copy_member,
        };
        let (item, context, _lease) = {
            let c = db(self.connection.lock())?;
            let item = self.work_item_locked(&c, &r.work_item_id)?;
            if item.project_id != r.owner_project_id
                || item.item_revision != r.expected_work_item_revision
                || !item.copy_available
                || item.origin != WorkItemViewOrigin::Copy
                || item.state != WorkItemViewState::Ready
            {
                return Err(fail("WORK_COPY_UNAVAILABLE"));
            }
            let context: String = db(c.query_row(
                "SELECT context_json FROM work_items WHERE id=?1",
                [&r.work_item_id],
                |r| r.get(0),
            ))?;
            (
                item,
                parse::<WorkContext>(&context)?,
                Lease::acquire(&self.preparation_leases),
            )
        };
        let root = self.work_root(&item.work_item_id);
        let held = Parent::open(&root, "__package__")?;
        let recorded: Option<String> = {
            let c = db(self.connection.lock())?;
            db(c.query_row("SELECT identity_json FROM work_copy_locations WHERE item_id=?1 AND cleanup_state='owned'",[&item.work_item_id],|r|r.get(0)).optional())?
        };
        if recorded.as_deref() != Some(json(&held.directory_identity()?)?.as_str()) {
            return Err(fail("WORK_COPY_UNAVAILABLE"));
        }
        let bound = held.bound_directory_path()?;
        let (graph, identities) = self.scan_graph_locked(
            &bound.join("project"),
            true,
            GraphBudgets::default(),
            Some(&r.owner_project_id),
        )?;
        let mut members = graph
            .files
            .iter()
            .map(|f| Member {
                path: format!("project/{}", f.path),
                hash: f.hash.clone(),
                size: f.size,
            })
            .collect::<Vec<_>>();
        for member in &context.members {
            if let Some(hash) = &member.hash {
                members.push(Member {
                    path: format!("context/{}.bin", member.id),
                    hash: hash.clone(),
                    size: member.size.ok_or(fail("STORAGE_UNAVAILABLE"))? as u64,
                });
            }
        }
        let guidance = json(
            &serde_json::json!({"projectId":item.project_id,"baseGraphHash":item.base_graph_hash,"grant":item.grant,"references":context.members,"protection":context.protection,"executionAvailable":false}),
        )?;
        if guidance.len() > 4 << 20 {
            return Err(fail("PACKAGE_SIZE_LIMIT"));
        }
        let scope = self.object(guidance.as_bytes())?;
        members.push(Member {
            path: "context/scope.json".into(),
            hash: scope,
            size: guidance.len() as u64,
        });
        members.sort_by(|a, b| a.path.cmp(&b.path));
        let descriptor = Descriptor {
            version: 1,
            kind: "work-copy".into(),
            project_id: r.owner_project_id.clone(),
            export_id: r.request_id.clone(),
            capture: None,
            work_item_id: Some(r.work_item_id.clone()),
            base_graph_hash: Some(item.base_graph_hash),
            base_graph_generation: Some(item.base_graph_generation),
            members,
        };
        crate::project_transfer::package::archive::admit_members(
            &descriptor.members,
            serde_json::to_vec(&descriptor)
                .map_err(|_| fail("STORAGE_UNAVAILABLE"))?
                .len() as u64,
            crate::project_transfer::package::archive::Limits::default(),
        )?;
        db(std::fs::create_dir(output))?;
        let output_held = Parent::open(output, "__work_package__")?;
        let output_bound = output_held.bound_directory_path()?;
        let output = output_bound.as_path();
        for m in &descriptor.members {
            copy_member(
                &self.directory,
                &format!("objects/{}", m.hash),
                output,
                &m.path,
                &m.hash,
                cancel,
            )?;
        }
        // A complete second observation detects additions/deletions during capture.
        let (after, after_ids) = self.scan_graph_locked(
            &bound.join("project"),
            true,
            GraphBudgets::default(),
            Some(&r.owner_project_id),
        )?;
        if graph != after || identities != after_ids {
            return Err(fail("WORK_CANDIDATE_STALE"));
        }
        held.verify()?;
        output_held.verify()?;
        Ok(descriptor)
    }
}
