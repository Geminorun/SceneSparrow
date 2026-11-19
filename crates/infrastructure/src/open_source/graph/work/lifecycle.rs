use super::*;
impl SqliteProjectRepository {
    /// One preparation owner per project; durable queue claiming uses the same
    /// connection as ordinary saves, while bulk I/O runs after releasing it.
    pub fn run_next_work_operation(&self) -> Result<bool> {
        if self
            .preparation_worker
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Ok(false);
        }
        struct Worker<'a>(&'a std::sync::atomic::AtomicBool);
        impl Drop for Worker<'_> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::SeqCst);
            }
        }
        let _worker = Worker(&self.preparation_worker);
        let _business_worker = self.worker_guard();
        let (request, kind, item, path, protected, context, lease) = {
            let mut c = db(self.connection.lock())?;
            if self.is_quiescing() {
                return Ok(false);
            }
            let next:Option<(String,String,String)>=db(c.query_row("SELECT request_id,kind,item_id FROM work_operations WHERE status='queued' AND kind IN ('create','inspect') ORDER BY rowid LIMIT 1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional())?;
            let Some((request, kind, item_id)) = next else {
                return Ok(false);
            };
            let item = self.work_item_locked(&c, &item_id)?;
            let (_, path, _, _) = source_row(&c)?.ok_or(fail("SOURCE_CAPABILITY_UNSUPPORTED"))?;
            let protected = Self::user_lock_ids(&c)?;
            let context: String = db(c.query_row(
                "SELECT context_json FROM work_items WHERE id=?1",
                [&item_id],
                |r| r.get(0),
            ))?;
            let lease = Lease::acquire(&self.preparation_leases);
            let tx = db(c.transaction())?;
            db(tx.execute(
                "UPDATE work_operations SET status='running' WHERE request_id=?1",
                [&request],
            ))?;
            db(tx.commit())?;
            (
                request,
                kind,
                item,
                path,
                protected,
                parse::<WorkContext>(&context)?,
                lease,
            )
        };
        let outcome = if kind == "create" {
            self.materialize_work_item(&request, &item, &context)
        } else {
            self.prepare_work_inspection(&request, &item, &path, &protected)
        };
        let mut c = db(self.connection.lock())?;
        let op = self.work_operation_locked(&c, &request)?;
        if op.status == WorkOperationViewStatus::Running {
            let tx = db(c.transaction())?;
            match &outcome {
                Ok(()) => {
                    db(tx.execute("UPDATE work_operations SET status='succeeded',progress=100 WHERE request_id=?1",[&request]))?;
                    db(tx.execute("UPDATE work_items SET state='ready',revision=revision+1 WHERE id=?1 AND operation_id=?2",params![item.work_item_id,request]))?;
                }
                Err(error) => {
                    db(tx.execute("UPDATE work_operations SET status='failed',failure_code=?2 WHERE request_id=?1",params![request,error.0]))?;
                    db(tx.execute("UPDATE work_items SET state='failed',revision=revision+1 WHERE id=?1 AND operation_id=?2",params![item.work_item_id,request]))?;
                }
            }
            db(tx.commit())?;
        }
        drop(lease);
        outcome.map(|_| true)
    }
    fn materialize_work_item(
        &self,
        request: &str,
        item: &WorkItemView,
        context: &WorkContext,
    ) -> Result<()> {
        self.work_cancelled(request)?;
        self.source_cut("work-copy-held")?;
        if item.origin == WorkItemViewOrigin::Live {
            return Ok(());
        }
        let graph = self.read_file_graph(&item.base_graph_hash)?;
        let root = self.work_root(&item.work_item_id);
        self.create_private_work_directory(&root)?;
        let parent = Parent::open(
            &self.directory,
            &format!("work-items/{}/__work__", item.work_item_id),
        )?;
        let identity = json(&parent.directory_identity()?)?;
        {
            let c = db(self.connection.lock())?;
            db(c.execute(
                "INSERT OR IGNORE INTO work_copy_locations(item_id,identity_json) VALUES(?1,?2)",
                params![item.work_item_id, identity],
            ))?;
            let recorded: String = db(c.query_row(
                "SELECT identity_json FROM work_copy_locations WHERE item_id=?1",
                [&item.work_item_id],
                |row| row.get(0),
            ))?;
            if recorded != identity {
                return Err(fail("WORK_CANDIDATE_STALE"));
            }
        }
        parent.verify()?;
        let project = root.join("project");
        self.create_private_work_directory(&project)?;
        let context_root = root.join("context");
        self.create_private_work_directory(&context_root)?;
        for member in &graph.files {
            self.work_cancelled(request)?;
            self.copy_work_member(request, &project, &member.path, &member.hash, member.size)?;
        }
        for member in &context.members {
            self.work_cancelled(request)?;
            if let Some(h) = &member.hash {
                self.copy_work_member(
                    request,
                    &context_root,
                    &format!("{}.bin", member.id),
                    h,
                    member.size.ok_or(fail("STORAGE_UNAVAILABLE"))? as u64,
                )?;
            }
        }
        let guidance = json(
            &serde_json::json!({"projectId":item.project_id,"baseGraphHash":item.base_graph_hash,"grant":item.grant,"references":context.members,"protection":context.protection,"executionAvailable":false}),
        )?;
        let summary = self.object(guidance.as_bytes())?;
        self.copy_work_member(
            request,
            &context_root,
            "scope.json",
            &summary,
            guidance.len() as u64,
        )?;
        self.work_cancelled(request)
    }
    fn create_private_work_directory(&self, path: &Path) -> Result<()> {
        // Each intermediate component is core-selected. Verify each component
        // before descending; Parent retains descriptor containment at file I/O.
        let relative = path
            .strip_prefix(&self.directory)
            .map_err(|_| fail("SOURCE_PATH_UNSAFE"))?;
        let mut current = self.directory.clone();
        for component in relative.components() {
            current.push(component);
            match std::fs::create_dir(&current) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(_) => return Err(fail("STORAGE_UNAVAILABLE")),
            };
            plain_directory(&current)?;
        }
        Ok(())
    }
    #[cfg(target_os = "linux")]
    fn copy_work_member(
        &self,
        request: &str,
        root: &Path,
        path: &str,
        hash: &str,
        size: u64,
    ) -> Result<()> {
        use crate::storage::objects::verify_written_object;
        use sha2::{Digest, Sha256};
        let relative = root
            .strip_prefix(&self.directory)
            .map_err(|_| fail("SOURCE_PATH_UNSAFE"))?
            .join(path);
        let relative = relative.to_str().ok_or(fail("SOURCE_PATH_UNSAFE"))?;
        let parent = Parent::open_creating(&self.directory, relative)?;
        if let Some((mut file, _)) = parent.open_file(&parent.name)? {
            if crate::storage::objects::stream_copy(&mut file, &mut std::io::sink(), size)?
                != (hash.into(), size)
            {
                return Err(fail("WORK_CANDIDATE_STALE"));
            }
        } else {
            let staging = Parent::open(&self.directory, "staging/member")?;
            let name = format!(".work-copy-{}", uuid::Uuid::new_v4());
            let mut file = staging.create_file(&name)?;
            struct CopyOutput<'a> {
                repo: &'a SqliteProjectRepository,
                request: &'a str,
                file: &'a mut File,
                digest: Sha256,
                size: u64,
            }
            impl std::io::Write for CopyOutput<'_> {
                fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                    self.repo
                        .work_cancelled(self.request)
                        .map_err(|_| std::io::Error::other("work cancelled"))?;
                    let count = self.file.write(bytes)?;
                    self.digest.update(&bytes[..count]);
                    self.size += count as u64;
                    Ok(count)
                }
                fn flush(&mut self) -> std::io::Result<()> {
                    self.file.flush()
                }
            }
            let mut output = CopyOutput {
                repo: self,
                request,
                file: &mut file,
                digest: Sha256::new(),
                size: 0,
            };
            let copied = self.stream_object_to(hash, &mut output);
            let written_size = output.size;
            let written_hash = format!("{:x}", output.digest.finalize());
            let result = self.work_cancelled(request).and(copied).and_then(|actual| {
                if actual == size {
                    Ok(())
                } else {
                    Err(fail("STORAGE_UNAVAILABLE"))
                }
            });
            if let Err(error) = result {
                // Delete only our held descriptor's verified written prefix. A
                // substituted or rewritten stage remains as recovery evidence.
                if verify_written_object(&staging, &name, &file, &written_hash, written_size)
                    .is_ok()
                {
                    staging.unlink(&name)?;
                }
                return Err(error);
            }
            db(file.sync_all())?;
            staging.sync()?;
            verify_written_object(&staging, &name, &file, hash, size)?;
            staging.rename_into(&name, &parent, &parent.name)?;
            verify_written_object(&parent, &parent.name, &file, hash, size)?;
        }
        parent.verify()
    }
    #[cfg(not(target_os = "linux"))]
    fn copy_work_member(
        &self,
        _request: &str,
        _root: &Path,
        _path: &str,
        _hash: &str,
        _size: u64,
    ) -> Result<()> {
        Err(fail("SOURCE_CAPABILITY_UNSUPPORTED"))
    }
    fn prepare_work_inspection(
        &self,
        request: &str,
        item: &WorkItemView,
        path: &str,
        protected: &[String],
    ) -> Result<()> {
        self.work_cancelled(request)?;
        let root = if item.origin == WorkItemViewOrigin::Live {
            self.creative_root
                .clone()
                .ok_or(fail("SOURCE_CAPABILITY_UNSUPPORTED"))?
        } else {
            self.work_root(&item.work_item_id).join("project")
        };
        let private_parent = if item.origin == WorkItemViewOrigin::Copy {
            Some(Parent::open(
                &self.directory,
                &format!("work-items/{}/project/__work__", item.work_item_id),
            )?)
        } else {
            None
        };
        let (raw, identities) = self.scan_graph_cancellable(
            &root,
            item.origin == WorkItemViewOrigin::Copy,
            GraphBudgets::default(),
            Some(&item.project_id),
            Some(request),
        )?;
        if let Some(parent) = private_parent {
            parent.verify()?;
        }
        let raw_hash = self.object(&db(serde_json::to_vec(&raw))?)?;
        self.source_cut("work-inspection-held")?;
        let observation = if item.origin == WorkItemViewOrigin::Live {
            Some(GraphObservation {
                base_hash: item.base_graph_hash.clone(),
                generation: item.base_graph_generation,
                graph_hash: raw_hash.clone(),
                identities,
            })
        } else {
            None
        };
        let reused = {
            let c = db(self.connection.lock())?;
            db(c.query_row(
                "SELECT preparation_json FROM work_preparations WHERE item_id=?1 AND raw_hash=?2",
                params![item.work_item_id, raw_hash],
                |r| r.get::<_, String>(0),
            )
            .optional())?
        };
        let prepared = match reused {
            Some(p) => parse::<PreparedGraphCandidate>(&p)?,
            None => self.prepare_file_graph_captured(&raw_hash, path, protected)?,
        };
        let after = self.read_file_graph(&prepared.prepared_hash)?;
        let before = self.read_file_graph(&item.base_graph_hash)?;
        let mut changes = self.work_changes(&before, &after)?;
        self.work_cancelled(request)?;
        let mut c = db(self.connection.lock())?;
        let current = self
            .file_graph_locked(&c)?
            .ok_or(fail("GRAPH_REGISTRATION_REQUIRED"))?;
        if current.hash != item.base_graph_hash {
            return Err(fail("GRAPH_BASE_MISMATCH"));
        }
        let current_item = self.work_item_locked(&c, &item.work_item_id)?;
        if current_item.operation_request_id != request
            || self.work_operation_locked(&c, request)?.status != WorkOperationViewStatus::Running
        {
            return Err(fail("WORK_CANCELLED"));
        }
        self.validate_graph(&c, &raw)?;
        self.validate_graph(&c, &after)?;
        let mut blockers = vec![];
        if let Err(e) = Self::guard_graph_topology(&before, &after) {
            blockers.push(e.0.into());
        }
        if let Err(e) = self.guard_work_scope(&c, item, &after) {
            blockers.push(e.0.into());
        }
        if let Err(e) = self.guard_graph_production(&c, &before, &after) {
            blockers.push(e.0.into());
        }
        let revision = read_project(&c)
            .map_err(|_| fail("STORAGE_UNAVAILABLE"))?
            .ok_or(fail("PROJECT_NOT_FOUND"))?
            .working_revision;
        let candidate = uuid::Uuid::new_v4().to_string();
        for change in &mut changes {
            change.member_id = digest(&(
                &item.work_item_id,
                &candidate,
                &change.path,
                &change.before_hash,
                &change.after_hash,
            ))?;
        }
        let mut observation = observation;
        if let Some(o) = &mut observation {
            o.generation = current.generation;
        }
        let candidate_digest = digest(&(
            item.work_item_id.clone(),
            &raw_hash,
            &prepared,
            &observation,
            revision,
            current.generation,
        ))?;
        let production = self.scoped_graph_paths(&c, &before, &after)?.is_none();
        let view = WorkCandidateView {
            project_id: item.project_id.clone(),
            work_item_id: item.work_item_id.clone(),
            candidate_id: candidate.clone(),
            candidate_digest: candidate_digest.clone(),
            original_graph_hash: raw_hash.clone(),
            prepared_graph_hash: prepared.prepared_hash.clone(),
            inspected_working_revision: revision,
            inspected_graph_generation: current.generation,
            change_count: changes.len() as i64,
            blockers,
            impact: if production {
                WorkCandidateViewImpact::Production
            } else if changes.is_empty() {
                WorkCandidateViewImpact::None
            } else {
                WorkCandidateViewImpact::Source
            },
            assigned_ids: prepared.assigned.len() as i64,
            provenance: self.narration_provenance(&c, &after)?,
        };
        let tx = db(c.transaction())?;
        // Persist the original-address/new-ID mapping and all roots before ACK.
        db(tx.execute(
            "INSERT OR IGNORE INTO work_preparations VALUES(?1,?2,?3)",
            params![item.work_item_id, raw_hash, json(&prepared)?],
        ))?;
        for (role, h) in [("raw", &raw_hash), ("prepared", &prepared.prepared_hash)] {
            Self::pin_file_graph_locked(
                &tx,
                &format!("work:{}:{role}:{raw_hash}", item.work_item_id),
                h,
            )?;
        }
        db(tx.execute(
            "INSERT INTO work_candidates VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'pending')",
            params![
                candidate,
                item.work_item_id,
                candidate_digest,
                raw_hash,
                prepared.prepared_hash,
                json(&prepared)?,
                observation.as_ref().map(json).transpose()?,
                revision,
                current.generation,
                json(&view)?,
                json(&changes)?
            ],
        ))?;
        db(tx.execute(
            "UPDATE work_items SET latest_candidate=?2 WHERE id=?1",
            params![item.work_item_id, candidate],
        ))?;
        db(tx.execute(
            "UPDATE work_operations SET candidate_json=?2 WHERE request_id=?1",
            params![request, json(&view)?],
        ))?;
        db(tx.commit())?;
        Ok(())
    }
    pub(super) fn guard_work_scope(
        &self,
        c: &Connection,
        item: &WorkItemView,
        after: &FileGraph,
    ) -> Result<()> {
        let before = self.read_file_graph(&item.base_graph_hash)?;
        let old = before.index();
        let new = after.index();
        for p in old
            .keys()
            .chain(new.keys())
            .filter(|p| old.get(*p) != new.get(*p))
        {
            if !item.grant.whole_tree
                && !item.grant.files.iter().any(|f| f == p)
                && !item
                    .grant
                    .directories
                    .iter()
                    .any(|d| p.starts_with(&format!("{d}/")))
            {
                return Err(fail("WORK_OUT_OF_SCOPE"));
            }
        }
        let (_, path, accepted, generation) =
            source_row(c)?.ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
        if before.file(&path)?.hash != after.file(&path)?.hash {
            if item.grant.manuscript_scope.kind == CreativeGrantManuscriptScopeKind::None {
                return Err(fail("WORK_OUT_OF_SCOPE"));
            }
            let source = String::from_utf8(self.read_bounded_object(
                &after.file(&path)?.hash,
                manuscript::MAX_DOCUMENT_BYTES as u64,
            )?)
            .map_err(|_| fail("SOURCE_UTF8_INVALID"))?;
            let state = self.load(c)?;
            let mut identities = BTreeMap::new();
            let mut q = db(c.prepare("SELECT id,high_water FROM object_identities"))?;
            for row in db(q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))))? {
                let (id, rev) = db(row)?;
                identities.insert(id, rev);
            }
            let t = self.source_edit_transition(
                c,
                &SourceSaveRequest {
                    request_id: uuid::Uuid::new_v4().to_string(),
                    project_id: item.project_id.clone(),
                    expected_working_revision: state.working_revision,
                    expected_hash: accepted,
                    expected_generation: generation,
                    source,
                    group: EditGroup {
                        group_id: uuid::Uuid::new_v4().to_string(),
                        client_session_id: uuid::Uuid::new_v4().to_string(),
                        group_sequence: 1,
                        kind: EditGroupKind::Discrete,
                    },
                },
                &state,
                &identities,
            )?;
            if item.grant.manuscript_scope.kind == CreativeGrantManuscriptScopeKind::Blocks
                && t.affected
                    .iter()
                    .any(|id| !item.grant.manuscript_scope.block_ids.contains(id))
            {
                return Err(fail("WORK_OUT_OF_SCOPE"));
            }
            Self::guard_finalization(c, &state, &t)?;
        }
        Ok(())
    }
    fn narration_provenance(
        &self,
        c: &Connection,
        after: &FileGraph,
    ) -> Result<Vec<WorkNarrationProvenance>> {
        let manifest = self.validate_graph(c, after)?;
        let Some(audio) = manifest.audio else {
            return Ok(vec![]);
        };
        let raw: AudioPlanDeclaration = db(serde_json::from_slice(&self.read_bounded_object(
            &after.file(&audio.plan)?.hash,
            manuscript::MAX_DOCUMENT_BYTES as u64,
        )?))?;
        let state = self.load(c)?;
        Ok(raw
            .segments
            .into_iter()
            .take(100)
            .map(|segment| {
                let current = state
                    .blocks
                    .iter()
                    .find(|block| block.id == segment.source_block_id);
                WorkNarrationProvenance {
                    segment_id: segment.id,
                    source_block_id: segment.source_block_id,
                    source_revision: segment.source_revision,
                    current_revision: current.map(|block| block.revision),
                    status: match current {
                        None => WorkNarrationProvenanceStatus::Missing,
                        Some(block) if block.revision == segment.source_revision => {
                            WorkNarrationProvenanceStatus::Available
                        }
                        _ => WorkNarrationProvenanceStatus::Diverged,
                    },
                    adapted: current.is_some_and(|block| {
                        block
                            .runs
                            .iter()
                            .map(|run| run.text.as_str())
                            .collect::<String>()
                            != segment.narration_text
                    }),
                }
            })
            .collect())
    }
    fn work_changes(&self, before: &FileGraph, after: &FileGraph) -> Result<Vec<WorkChangeView>> {
        let old = before.index();
        let new = after.index();
        let paths = old
            .keys()
            .chain(new.keys())
            .copied()
            .collect::<BTreeSet<_>>();
        let mut removed: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
        let mut added: BTreeMap<&str, usize> = BTreeMap::new();
        for file in &before.files {
            if !new.contains_key(file.path.as_str()) {
                removed.entry(&file.hash).or_default().push(&file.path);
            }
        }
        for file in &after.files {
            if !old.contains_key(file.path.as_str()) {
                *added.entry(&file.hash).or_default() += 1;
            }
        }
        let mut changes = vec![];
        for path in paths {
            let a = old.get(path);
            let b = new.get(path);
            if a == b {
                continue;
            }
            let rename_hint = if a.is_none() {
                b.and_then(|file| {
                    removed
                        .get(file.hash.as_str())
                        .filter(|paths| {
                            paths.len() == 1 && added.get(file.hash.as_str()) == Some(&1)
                        })
                        .map(|paths| paths[0].to_owned())
                })
            } else {
                None
            };
            changes.push(WorkChangeView {
                member_id: digest(&(path, b.map(|f| &f.hash), a.map(|f| &f.hash)))?,
                path: path.into(),
                kind: if a.is_none() {
                    WorkChangeViewKind::Add
                } else if b.is_none() {
                    WorkChangeViewKind::Delete
                } else {
                    WorkChangeViewKind::Replace
                },
                before_hash: a.map(|f| f.hash.clone()),
                after_hash: b.map(|f| f.hash.clone()),
                before_size: a.map_or(0, |f| f.size as i64),
                after_size: b.map_or(0, |f| f.size as i64),
                rename_hint,
                truncated: true,
                text: None,
            });
        }
        if json(&changes)?.len() > 16 * 1024 * 1024 {
            return Err(fail("GRAPH_BUDGET_EXCEEDED"));
        }
        Ok(changes)
    }
    fn work_change_preview(&self, change: &mut WorkChangeView) -> Result<()> {
        let preview = |hash: Option<&String>, size: i64| -> Result<Option<String>> {
            let Some(hash) = hash else {
                return Ok(Some(String::new()));
            };
            if size > 128 * 1024 {
                return Ok(None);
            }
            Ok(
                String::from_utf8(self.read_bounded_object(hash, 128 * 1024)?)
                    .ok()
                    .filter(|text| {
                        !text
                            .chars()
                            .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
                    }),
            )
        };
        let (Some(left), Some(right)) = (
            preview(change.before_hash.as_ref(), change.before_size)?,
            preview(change.after_hash.as_ref(), change.after_size)?,
        ) else {
            return Ok(());
        };
        let left = left.lines().collect::<Vec<_>>();
        let right = right.lines().collect::<Vec<_>>();
        let prefix = left.iter().zip(&right).take_while(|(a, b)| a == b).count();
        let mut suffix = 0;
        while suffix < left.len() - prefix
            && suffix < right.len() - prefix
            && left[left.len() - 1 - suffix] == right[right.len() - 1 - suffix]
        {
            suffix += 1;
        }
        let removed = &left[prefix..left.len() - suffix];
        let added = &right[prefix..right.len() - suffix];
        let mut text = removed
            .iter()
            .map(|line| format!("- {line}"))
            .chain(added.iter().map(|line| format!("+ {line}")))
            .take(120)
            .collect::<Vec<_>>()
            .join("\n");
        change.truncated = removed.len() + added.len() > 120 || text.len() > 128 * 1024;
        let mut end = text.len().min(128 * 1024);
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        change.text = Some(text);
        Ok(())
    }
    pub fn work_changes_page(
        &self,
        item: &str,
        candidate: &str,
        cursor: Option<&str>,
    ) -> Result<WorkChangePage> {
        let c = db(self.connection.lock())?;
        self.work_candidate_locked(&c, item, candidate)?;
        let raw: String = db(c.query_row(
            "SELECT changes_json FROM work_candidates WHERE id=?1 AND item_id=?2",
            params![candidate, item],
            |row| row.get(0),
        ))?;
        let (mut records, continuation) = page(
            parse::<Vec<WorkChangeView>>(&raw)?,
            cursor,
            &format!("changes:{item}:{candidate}"),
        )?;
        if self.preparation_leases.load(Ordering::SeqCst) >= 5 {
            return Err(fail("QUEUE_FULL"));
        }
        let _lease = Lease::acquire(&self.preparation_leases);
        drop(c);
        // Preview only this bounded page, outside the writer. Large binary/text
        // objects stay as hashes and exact authorized attachment streams.
        for change in &mut records {
            self.work_change_preview(change)?;
        }
        Ok(WorkChangePage {
            records,
            continuation,
        })
    }
}
