use super::*;
struct CopyCleanup {
    item: String,
    entry: Parent,
    owner: Parent,
}
impl SqliteProjectRepository {
    pub(super) fn action_replay<T: serde::Serialize>(
        &self,
        c: &Connection,
        request: &str,
        payload: &T,
    ) -> Result<Option<AuthoredSourceSaveResponse>> {
        id(request)?;
        if let Some((previous, outcome)) = Self::outcome(c, request)? {
            if previous != digest(payload)? {
                return Err(fail("REQUEST_ID_CONFLICT"));
            }
            return Ok(Some(AuthoredSourceSaveResponse {
                receipt: Self::decode(&outcome)?,
                snapshot: self.source_snapshot_locked(c)?,
            }));
        }
        let previous: Option<String> = db(c
            .query_row(
                "SELECT digest FROM work_operations WHERE request_id=?1",
                [request],
                |row| row.get(0),
            )
            .optional())?;
        let expected = digest(payload)?;
        if previous.is_some_and(|previous| previous != expected) {
            return Err(fail("REQUEST_ID_CONFLICT"));
        }
        Ok(None)
    }
    pub fn accept_work_candidate(
        &self,
        r: &WorkCandidateAcceptRequest,
    ) -> Result<AuthoredSourceSaveResponse> {
        let mut c = db(self.connection.lock())?;
        if let Some(v) = self.action_replay(&c, &r.request_id, r)? {
            return Ok(v);
        }
        // Candidate lookup lives in the ordinary coordinator's guarded preflight;
        // a missing/pruned payload cannot retire the original receipt identity.
        let candidate: Option<String> = db(c
            .query_row(
                "SELECT prepared_hash FROM work_candidates WHERE id=?1 AND item_id=?2",
                params![r.candidate_id, r.work_item_id],
                |r| r.get(0),
            )
            .optional())?;
        let action = GraphAction {
            batch: GraphBatch {
                request_id: r.request_id.clone(),
                project_id: r.project_id.clone(),
                expected_working_revision: r.expected_working_revision,
                base_hash: r.expected_graph_hash.clone(),
                expected_generation: r.expected_graph_generation,
                candidate_hash: candidate.unwrap_or_else(|| r.expected_graph_hash.clone()),
            },
            digest: digest(r)?,
            rename: None,
            observation: self.candidate_observation(&c, &r.work_item_id, &r.candidate_id)?,
            work: Some(WorkGraphAction::Accept(r.clone())),
        };
        let receipt = self.execute_graph_action_locked(&mut c, &action)?;
        Ok(AuthoredSourceSaveResponse {
            receipt,
            snapshot: self.source_snapshot_locked(&c)?,
        })
    }
    fn candidate_observation(
        &self,
        c: &Connection,
        item: &str,
        candidate: &str,
    ) -> Result<Option<GraphObservation>> {
        let raw: Option<Option<String>> = db(c
            .query_row(
                "SELECT observation_json FROM work_candidates WHERE id=?1 AND item_id=?2",
                params![candidate, item],
                |r| r.get(0),
            )
            .optional())?;
        raw.flatten().map(|v| parse(&v)).transpose()
    }
    pub fn discard_work_item(
        &self,
        r: &WorkItemDiscardRequest,
    ) -> Result<AuthoredSourceSaveResponse> {
        let mut c = db(self.connection.lock())?;
        if let Some(v) = self.action_replay(&c, &r.request_id, r)? {
            // The business outcome replays; destructive filesystem ownership
            // never does. Interrupted physical cleanup remains incomplete.
            return Ok(v);
        }
        let observation = if r.disposition == WorkItemDiscardRequestDisposition::RestoreAcceptedLive
        {
            r.candidate_id
                .as_ref()
                .map(|id| self.candidate_observation(&c, &r.work_item_id, id))
                .transpose()?
                .flatten()
        } else {
            None
        };
        let action = GraphAction {
            batch: GraphBatch {
                request_id: r.request_id.clone(),
                project_id: r.project_id.clone(),
                expected_working_revision: r.expected_working_revision,
                base_hash: r.expected_graph_hash.clone(),
                expected_generation: r.expected_graph_generation,
                candidate_hash: r.expected_graph_hash.clone(),
            },
            digest: digest(r)?,
            rename: None,
            observation,
            work: Some(WorkGraphAction::Discard(r.clone())),
        };
        let receipt = self.execute_graph_action_locked(&mut c, &action)?;
        let response = AuthoredSourceSaveResponse {
            receipt,
            snapshot: self.source_snapshot_locked(&c)?,
        };
        let cleanup = self.detach_discarded_copy(&c, r)?;
        drop(c);
        if let Some(cleanup) = cleanup {
            self.finish_copy_cleanup(cleanup)?;
        }
        Ok(response)
    }
    fn detach_discarded_copy(
        &self,
        c: &Connection,
        r: &WorkItemDiscardRequest,
    ) -> Result<Option<CopyCleanup>> {
        if r.disposition != WorkItemDiscardRequestDisposition::DiscardCopy {
            return Ok(None);
        }
        id(&r.work_item_id)?;
        let state: Option<String> = db(c
            .query_row(
                "SELECT state FROM work_items WHERE id=?1",
                [&r.work_item_id],
                |row| row.get(0),
            )
            .optional())?;
        if state.as_deref() != Some("discarded") {
            return Ok(None);
        }
        let recorded: Option<(String, String)> = db(c
            .query_row(
                "SELECT identity_json,cleanup_state FROM work_copy_locations WHERE item_id=?1",
                [&r.work_item_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional())?;
        let Some((identity, state)) = recorded else {
            return Ok(None);
        };
        if state != "owned" {
            return Ok(None);
        }
        let root = self.work_root(&r.work_item_id);
        if !root.try_exists().map_err(|_| fail("STORAGE_UNAVAILABLE"))? {
            return Ok(None);
        }
        let owner = Parent::open(
            &self.directory,
            &format!("work-items/{}/__work__", r.work_item_id),
        )?;
        if json(&owner.directory_identity()?)? != identity {
            return Ok(None);
        }
        owner.verify()?;
        let stage = format!(".discard-work-{}", uuid::Uuid::new_v4());
        // This first invocation alone holds the destructive capability. Persist
        // intent before detachment, but never reconstruct ownership on replay.
        db(c.execute("UPDATE work_copy_locations SET cleanup_state='detaching',cleanup_stage=?2 WHERE item_id=?1",params![r.work_item_id,stage]))?;
        self.source_cut("work-discard-before-detach")?;
        let source = Parent::open(&self.directory, &format!("work-items/{}", r.work_item_id))?;
        let destination = Parent::open(&self.directory, &format!("staging/{stage}"))?;
        source.rename_into(&source.name, &destination, &stage)?;
        // Move the original directory descriptor into cleanup; do not drop it
        // and reopen the stage from a persisted device/inode identity.
        let owner = owner.relocated_directory(&format!("staging/{stage}/__work__"))?;
        db(c.execute(
            "UPDATE work_copy_locations SET cleanup_state='detached' WHERE item_id=?1",
            [&r.work_item_id],
        ))?;
        self.source_cut("work-discard-detached")?;
        db(c.execute(
            "UPDATE work_copy_locations SET cleanup_state='consumed' WHERE item_id=?1",
            [&r.work_item_id],
        ))?;
        Ok(Some(CopyCleanup {
            item: r.work_item_id.clone(),
            entry: destination,
            owner,
        }))
    }
    fn finish_copy_cleanup(&self, cleanup: CopyCleanup) -> Result<()> {
        self.source_cut("work-discard-cleanup-consumed")?;
        cleanup.owner.verify()?;
        self.source_cut("work-discard-after-stage-verification")?;
        cleanup.owner.remove_discarded_container(&cleanup.entry)?;
        let c = db(self.connection.lock())?;
        db(c.execute("UPDATE work_copy_locations SET cleanup_state='complete' WHERE item_id=?1 AND cleanup_state='consumed'",[cleanup.item]))?;
        Ok(())
    }
    pub fn set_production_file_locks(
        &self,
        r: &ProductionFileLockRequest,
    ) -> Result<AuthoredSourceSaveResponse> {
        let mut c = db(self.connection.lock())?;
        if let Some(v) = self.action_replay(&c, &r.request_id, r)? {
            return Ok(v);
        }
        let action = GraphAction {
            batch: GraphBatch {
                request_id: r.request_id.clone(),
                project_id: r.project_id.clone(),
                expected_working_revision: r.expected_working_revision,
                base_hash: r.expected_graph_hash.clone(),
                expected_generation: r.expected_graph_generation,
                candidate_hash: r.expected_graph_hash.clone(),
            },
            digest: digest(r)?,
            rename: None,
            observation: None,
            work: Some(WorkGraphAction::Locks(r.clone())),
        };
        let receipt = self.execute_graph_action_locked(&mut c, &action)?;
        Ok(AuthoredSourceSaveResponse {
            receipt,
            snapshot: self.source_snapshot_locked(&c)?,
        })
    }
    pub(crate) fn work_action_changes_locks(
        &self,
        c: &Connection,
        action: Option<&GraphAction>,
    ) -> Result<bool> {
        let Some(WorkGraphAction::Locks(r)) = action.and_then(|a| a.work.as_ref()) else {
            return Ok(false);
        };
        let current = Self::production_locks_locked(c)?;
        Ok(r.targets.iter().any(|target| {
            r.locked
                != current
                    .iter()
                    .any(|l| l.path == target.path && l.hash == target.hash)
        }))
    }
    pub(crate) fn guard_work_action(&self, c: &Connection, action: &GraphAction) -> Result<()> {
        let Some(work) = &action.work else {
            return Ok(());
        };
        let batch = &action.batch;
        let current = self.check_base(
            c,
            &batch.project_id,
            batch.expected_working_revision,
            &batch.base_hash,
            batch.expected_generation,
        )?;
        match work {
            WorkGraphAction::Accept(r) => {
                id(&r.candidate_id)?;
                let item = self.work_item_locked(c, &r.work_item_id)?;
                let candidate = self.work_candidate_locked(c, &r.work_item_id, &r.candidate_id)?;
                if item.project_id != r.project_id
                    || item.base_graph_hash != current.hash
                    || item.item_revision != r.expected_item_revision
                    || item
                        .latest_candidate
                        .as_ref()
                        .is_none_or(|v| v.candidate_id != r.candidate_id)
                    || item.state != WorkItemViewState::Ready
                    || candidate.candidate_digest != r.candidate_digest
                    || candidate.inspected_working_revision != r.expected_working_revision
                    || candidate.inspected_graph_generation != current.generation
                {
                    return Err(fail("WORK_CANDIDATE_STALE"));
                }
                let disposition: String = db(c.query_row(
                    "SELECT disposition FROM work_candidates WHERE id=?1",
                    [&r.candidate_id],
                    |row| row.get(0),
                ))?;
                if disposition != "pending" {
                    return Err(fail("WORK_CANDIDATE_STALE"));
                }
                if item.origin == WorkItemViewOrigin::Copy {
                    let parent = Parent::open(
                        &self.directory,
                        &format!("work-items/{}/project/__work__", item.work_item_id),
                    )?;
                    let actual = self.inventory_graph_locked(
                        &self.work_root(&item.work_item_id).join("project"),
                        true,
                        GraphBudgets::default(),
                    )?;
                    parent.verify()?;
                    if digest(&actual)? != candidate.original_graph_hash {
                        return Err(fail("WORK_CANDIDATE_STALE"));
                    }
                } else if let Some(o) = &action.observation {
                    self.revalidate_graph_observation(o)?;
                } else {
                    return Err(fail("WORK_CANDIDATE_STALE"));
                }
                self.guard_work_scope(
                    c,
                    &item,
                    &self.read_file_graph(&candidate.prepared_graph_hash)?,
                )?;
            }
            WorkGraphAction::Discard(r) => {
                let item = self.work_item_locked(c, &r.work_item_id)?;
                if item.project_id != r.project_id
                    || item.item_revision != r.expected_item_revision
                    || matches!(
                        item.state,
                        WorkItemViewState::Preparing
                            | WorkItemViewState::Inspecting
                            | WorkItemViewState::Discarded
                    )
                {
                    return Err(fail("WORK_ITEM_STALE"));
                }
                if let Some(candidate) = &r.candidate_id
                    && item
                        .latest_candidate
                        .as_ref()
                        .is_none_or(|v| v.candidate_id != *candidate)
                {
                    return Err(fail("WORK_CANDIDATE_STALE"));
                }
                if r.disposition == WorkItemDiscardRequestDisposition::RestoreAcceptedLive {
                    if item.origin != WorkItemViewOrigin::Live
                        || item.base_graph_hash != current.hash
                    {
                        return Err(fail("WORK_ITEM_STALE"));
                    }
                    self.revalidate_graph_observation(
                        action
                            .observation
                            .as_ref()
                            .ok_or(fail("WORK_CANDIDATE_STALE"))?,
                    )?;
                }
                if r.disposition == WorkItemDiscardRequestDisposition::DiscardCopy
                    && item.origin != WorkItemViewOrigin::Copy
                {
                    return Err(fail("INVALID_REQUEST"));
                }
            }
            WorkGraphAction::Locks(r) => {
                if r.targets.is_empty() || r.targets.len() > 20_000 {
                    return Err(fail("INVALID_REQUEST"));
                }
                let (_, source, _, _) = source_row(c)?.ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
                let mut seen = BTreeSet::new();
                for target in &r.targets {
                    if target.path == source
                        || target.path == "project.json"
                        || !seen.insert(&target.path)
                        || current.graph.file(&target.path)?.hash != target.hash
                    {
                        return Err(fail("INVALID_REQUEST"));
                    }
                }
            }
        }
        Ok(())
    }
    pub(crate) fn commit_work_action(
        &self,
        c: &Connection,
        command: &ManuscriptCommand,
        action: Option<&GraphAction>,
        entry: Option<&str>,
    ) -> Result<()> {
        // History restoration is deliberate user policy; candidates never supply
        // lock state. Snapshot sidecars follow stable retained entry identities.
        if let Some(target) = self.history_lock_target(c, command)? {
            Self::replace_production_locks(c, &target)?;
        }
        if let Some(action) = action
            && let Some(work) = &action.work
        {
            match work {
                WorkGraphAction::Accept(r) => {
                    db(c.execute("UPDATE work_candidates SET disposition='accepted' WHERE id=?1 AND disposition='pending'",[&r.candidate_id]))?;
                    db(c.execute("UPDATE work_items SET state='accepted',revision=revision+1,operation_id=?2 WHERE id=?1",params![r.work_item_id,r.request_id]))?;
                    Self::record_operation(
                        c,
                        &r.request_id,
                        r,
                        &r.project_id,
                        &r.work_item_id,
                        "accept",
                        "succeeded",
                    )?;
                }
                WorkGraphAction::Discard(r) => {
                    if let Some(candidate) = &r.candidate_id {
                        db(c.execute(
                            "UPDATE work_candidates SET disposition='discarded' WHERE id=?1",
                            [candidate],
                        ))?;
                    }
                    db(c.execute("UPDATE work_items SET state=?3,revision=revision+1,operation_id=?2,latest_candidate=NULL WHERE id=?1",params![r.work_item_id,r.request_id,if r.disposition==WorkItemDiscardRequestDisposition::DiscardCandidate{"ready"}else{"discarded"}]))?;
                    Self::record_operation(
                        c,
                        &r.request_id,
                        r,
                        &r.project_id,
                        &r.work_item_id,
                        "discard",
                        "succeeded",
                    )?;
                    // Compact identities remain; releasing bulk roots requires
                    // a definite committed disposition, not a transient ACK.
                    if r.disposition != WorkItemDiscardRequestDisposition::DiscardCandidate {
                        db(c.execute(
                            "DELETE FROM file_graph_pins WHERE owner_id LIKE ?1",
                            [format!("work:{}:%", r.work_item_id)],
                        ))?;
                        db(c.execute(
                            "DELETE FROM external_object_pins WHERE owner_id=?1",
                            [format!("work:{}:context", r.work_item_id)],
                        ))?;
                    }
                }
                WorkGraphAction::Locks(r) => {
                    let before = Self::production_locks_locked(c)?;
                    let mut after = before.clone();
                    for target in &r.targets {
                        after.retain(|x| x.path != target.path);
                        if r.locked {
                            after.push(ProductionFileLockView {
                                path: target.path.clone(),
                                hash: target.hash.clone(),
                            });
                        }
                    }
                    after.sort_by(|a, b| a.path.cmp(&b.path));
                    Self::replace_production_locks(c, &after)?;
                    if before != after {
                        db(c.execute(
                            "INSERT INTO history_production_locks VALUES(?1,?2,?3)",
                            params![
                                entry.ok_or(fail("STORAGE_UNAVAILABLE"))?,
                                json(&before)?,
                                json(&after)?
                            ],
                        ))?;
                    }
                    Self::record_operation(
                        c,
                        &r.request_id,
                        r,
                        &r.project_id,
                        "",
                        "lock",
                        "succeeded",
                    )?;
                }
            }
        }

        Ok(())
    }
    pub(super) fn production_locks_locked(c: &Connection) -> Result<Vec<ProductionFileLockView>> {
        let mut q =
            db(c.prepare("SELECT path,content_hash FROM production_file_locks ORDER BY path"))?;
        db(q.query_map([], |r| {
            Ok(ProductionFileLockView {
                path: r.get(0)?,
                hash: r.get(1)?,
            })
        }))?
        .map(db)
        .collect()
    }
    fn replace_production_locks(c: &Connection, values: &[ProductionFileLockView]) -> Result<()> {
        db(c.execute("DELETE FROM production_file_locks", []))?;
        for v in values {
            db(c.execute(
                "INSERT INTO production_file_locks VALUES(?1,?2)",
                params![v.path, v.hash],
            ))?;
        }
        Ok(())
    }
    pub(crate) fn history_lock_target(
        &self,
        c: &Connection,
        command: &ManuscriptCommand,
    ) -> Result<Option<Vec<ProductionFileLockView>>> {
        let redo = match command {
            ManuscriptCommand::UndoProject { .. } => false,
            ManuscriptCommand::RedoProject { .. } => true,
            _ => return Ok(None),
        };
        let history = Self::history_metadata(c)?;
        let row:Option<(String,String)>=db(c.query_row("SELECT l.before_json,l.after_json FROM history_production_locks l JOIN history_entry_identities i ON i.entry_id=l.entry_id WHERE i.position=?1",[history.cursor+i64::from(redo)],|r|Ok((r.get(0)?,r.get(1)?))).optional())?;
        row.map(|(before, after)| {
            let (expected, target) = if redo {
                (before, after)
            } else {
                (after, before)
            };
            if parse::<Vec<ProductionFileLockView>>(&expected)? != Self::production_locks_locked(c)?
            {
                return Err(fail("HISTORY_DIVERGED"));
            }
            parse(&target)
        })
        .transpose()
    }
    pub fn production_file_locks_page(
        &self,
        cursor: Option<&str>,
    ) -> Result<ProductionFileLockPage> {
        let c = db(self.connection.lock())?;
        let locks = Self::production_locks_locked(&c)?;
        let (records, continuation) =
            page(locks.clone(), cursor, &format!("locks:{}", digest(&locks)?))?;
        Ok(ProductionFileLockPage {
            records,
            continuation,
        })
    }
    pub fn control_work_item(&self, r: &WorkItemControlRequest) -> Result<WorkMutationResponse> {
        let mut c = db(self.connection.lock())?;
        let outcome = (|| {
            if let Some(v) = self.replay_work_start(&c, &r.request_id, r)? {
                return Ok(v);
            }
            let item = self.work_item_locked(&c, &r.work_item_id)?;
            if r.project_id != item.project_id || r.expected_item_revision != item.item_revision {
                return Err(fail("WORK_ITEM_STALE"));
            }
            let op = self.work_operation_locked(&c, &item.operation_request_id)?;
            let tx = db(c.transaction())?;
            match r.action {
                WorkItemControlRequestAction::Cancel => {
                    if !matches!(
                        op.status,
                        WorkOperationViewStatus::Running | WorkOperationViewStatus::Queued
                    ) {
                        return Err(fail("INVALID_REQUEST"));
                    }
                    db(tx.execute("UPDATE work_operations SET status='cancelled',failure_code='WORK_CANCELLED' WHERE request_id=?1",[&op.request_id]))?;
                    db(tx.execute(
                        "UPDATE work_items SET state='interrupted',revision=revision+1 WHERE id=?1",
                        [&r.work_item_id],
                    ))?;
                }
                WorkItemControlRequestAction::Retry => {
                    if !matches!(
                        op.status,
                        WorkOperationViewStatus::Interrupted
                            | WorkOperationViewStatus::Failed
                            | WorkOperationViewStatus::Cancelled
                    ) {
                        return Err(fail("INVALID_RETRY"));
                    }
                    Self::admit_work_operation(&tx)?;
                    let payload: String = db(tx.query_row(
                        "SELECT payload_json FROM work_operations WHERE request_id=?1",
                        [&op.request_id],
                        |row| row.get(0),
                    ))?;
                    // Explicit retry gets its own original action identity. The start
                    // that was interrupted remains an immutable terminal outcome.
                    db(tx.execute("INSERT INTO work_operations(request_id,digest,payload_json,project_id,item_id,kind,status) VALUES(?1,?2,?3,?4,?5,?6,'queued')",params![r.request_id,digest(r)?,payload,r.project_id,r.work_item_id,if op.kind==WorkOperationViewKind::Create{"create"}else{"inspect"}]))?;
                    db(tx.execute("UPDATE work_items SET state=?2,operation_id=?3,revision=revision+1 WHERE id=?1",params![r.work_item_id,if op.kind==WorkOperationViewKind::Create{"preparing"}else{"inspecting"},r.request_id]))?;
                }
            }
            if r.action == WorkItemControlRequestAction::Cancel {
                Self::record_operation(
                    &tx,
                    &r.request_id,
                    r,
                    &r.project_id,
                    &r.work_item_id,
                    "control",
                    "succeeded",
                )?;
            }
            db(tx.commit())?;
            self.work_response_locked(&c, &r.request_id)
        })();
        if let Err(error) = &outcome {
            self.persist_work_start_error(&c, &r.request_id, r, error)?;
        }
        outcome
    }
}

impl SqliteProjectRepository {
    pub(crate) fn verify_production_file_locks(&self, c: &Connection) -> Result<()> {
        let version: i64 = db(c.pragma_query_value(None, "user_version", |row| row.get(0)))?;
        if version < 14 {
            return Ok(());
        }
        let current = Self::production_locks_locked(c)?;
        let graph = self.file_graph_locked(c)?;
        let Some(graph) = graph else {
            return if current.is_empty() {
                Ok(())
            } else {
                Err(fail("GRAPH_INVALID"))
            };
        };
        let (_, source, _, _) = source_row(c)?.ok_or(fail("GRAPH_INVALID"))?;
        let verify = |locks: &[ProductionFileLockView], graph: &FileGraph| -> Result<()> {
            let mut paths = BTreeSet::new();
            for lock in locks {
                if lock.path == source
                    || lock.path == "project.json"
                    || !paths.insert(&lock.path)
                    || graph.file(&lock.path)?.hash != lock.hash
                {
                    return Err(fail("GRAPH_INVALID"));
                }
            }
            Ok(())
        };
        verify(&current, &graph.graph)?;
        let history = Self::history_metadata(c)?;
        let mut expected = None;
        let mut previous = None;
        let mut q=db(c.prepare("SELECT h.position,h.label,g.before_hash,g.after_hash,l.before_json,l.after_json FROM history_entries h JOIN history_entry_identities i ON i.position=h.position LEFT JOIN history_file_graphs g ON g.entry_id=i.entry_id LEFT JOIN history_production_locks l ON l.entry_id=i.entry_id ORDER BY h.position"))?;
        type LockHistoryRow = (
            i64,
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
        );
        for row in db(q.query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
            ))
        }))? {
            let (position, label, before_graph, after_graph, before, after): LockHistoryRow =
                db(row)?;
            if (label == "fileLocks") != before.is_some() || before.is_some() != after.is_some() {
                return Err(fail("GRAPH_INVALID"));
            }
            if let (Some(before), Some(after)) = (before, after) {
                let before: Vec<ProductionFileLockView> = parse(&before)?;
                let after: Vec<ProductionFileLockView> = parse(&after)?;
                verify(
                    &before,
                    &self.read_file_graph(&before_graph.ok_or(fail("GRAPH_INVALID"))?)?,
                )?;
                verify(
                    &after,
                    &self.read_file_graph(&after_graph.ok_or(fail("GRAPH_INVALID"))?)?,
                )?;
                if previous
                    .as_ref()
                    .is_some_and(|previous| previous != &before)
                {
                    return Err(fail("HISTORY_DIVERGED"));
                }
                if expected.is_none() {
                    expected = Some(before.clone());
                }
                if position <= history.cursor {
                    expected = Some(after.clone());
                }
                previous = Some(after);
            }
        }
        if expected.is_some_and(|expected| expected != current) {
            return Err(fail("HISTORY_DIVERGED"));
        }
        Ok(())
    }
}
