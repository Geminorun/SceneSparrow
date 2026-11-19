//! Recorded external work owns authorization and operational state. The manuscript
//! coordinator remains the only business receipt, history and journal writer.
use super::*;
mod decisions;
mod lifecycle;
mod package;
mod readers;
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Clone)]
pub(crate) enum WorkGraphAction {
    Accept(WorkCandidateAcceptRequest),
    Discard(WorkItemDiscardRequest),
    Locks(ProductionFileLockRequest),
}
struct Lease(Arc<AtomicUsize>);
impl Lease {
    fn acquire(counter: &Arc<AtomicUsize>) -> Self {
        counter.fetch_add(1, Ordering::SeqCst);
        Self(counter.clone())
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}
/// Authenticated descriptor and collector lease. No project writer is held while
/// the receiver waits on network backpressure or a native save dialog.
pub struct WorkMemberReader {
    file: File,
    hash: String,
    size: u64,
    _lease: Lease,
}
impl WorkMemberReader {
    pub fn hash(&self) -> &str {
        &self.hash
    }
    pub fn size(&self) -> u64 {
        self.size
    }
    pub fn stream(mut self, output: &mut impl std::io::Write) -> Result<u64> {
        let before = db(self.file.metadata())?;
        let actual = crate::storage::objects::stream_copy(&mut self.file, output, self.size)?;
        let after = db(self.file.metadata())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if before.ctime() != after.ctime() || before.ctime_nsec() != after.ctime_nsec() {
                return Err(fail("STORAGE_UNAVAILABLE"));
            }
        }
        if actual != (self.hash, self.size)
            || before.len() != self.size
            || after.len() != self.size
            || before.modified().ok() != after.modified().ok()
        {
            return Err(fail("STORAGE_UNAVAILABLE"));
        }
        Ok(self.size)
    }
}
fn json<T: serde::Serialize>(value: &T) -> Result<String> {
    db(serde_json::to_string(value))
}
fn parse<T: serde::de::DeserializeOwned>(value: &str) -> Result<T> {
    db(serde_json::from_str(value))
}
fn id(value: &str) -> Result<()> {
    if manuscript::uuid4(value) {
        Ok(())
    } else {
        Err(fail("INVALID_REQUEST"))
    }
}
fn digest<T: serde::Serialize>(value: &T) -> Result<String> {
    Ok(hash(json(value)?.as_bytes()))
}
fn page<T: Clone>(
    records: Vec<T>,
    cursor: Option<&str>,
    scope: &str,
) -> Result<(Vec<T>, Option<String>)> {
    let key = hash(scope.as_bytes());
    let offset = match cursor {
        None => 0,
        Some(c) => {
            let (k, n) = c.split_once(':').ok_or(fail("WORK_CURSOR_INVALID"))?;
            if k != key {
                return Err(fail("WORK_CURSOR_INVALID"));
            }
            n.parse::<usize>()
                .map_err(|_| fail("WORK_CURSOR_INVALID"))?
        }
    };
    if offset > records.len() {
        return Err(fail("WORK_CURSOR_INVALID"));
    }
    let end = (offset + 100).min(records.len());
    Ok((
        records[offset..end].to_vec(),
        (end < records.len()).then(|| format!("{key}:{end}")),
    ))
}
#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct ContextMember {
    id: String,
    title: String,
    url: Option<String>,
    hash: Option<String>,
    size: Option<i64>,
}
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContextProtection {
    working_revision: i64,
    locked_block_ids: Vec<String>,
    production_file_locks: Vec<ProductionFileLockView>,
    approved_baseline: Option<i64>,
}
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkContext {
    members: Vec<ContextMember>,
    protection: ContextProtection,
}
impl SqliteProjectRepository {
    pub fn file_graph_view(&self) -> Result<FileGraphView> {
        let c = db(self.connection.lock())?;
        self.file_graph_view_locked(&c)
    }
    fn file_graph_view_locked(&self, c: &Connection) -> Result<FileGraphView> {
        let p = read_project(c)
            .map_err(|_| fail("STORAGE_UNAVAILABLE"))?
            .ok_or(fail("PROJECT_NOT_FOUND"))?;
        let graph = self.file_graph_locked(c)?;
        let source = source_row(c)?;
        let manifest_name = if let Some(g) = &graph {
            Some(
                self.validate_graph(c, &g.graph)?
                    .name
                    .unwrap_or_else(|| "Untitled project".into()),
            )
        } else if let Some(root) = &self.creative_root {
            let bytes = Parent::open(root, "project.json")?
                .read("project.json", false)?
                .ok_or(fail("SOURCE_READ_UNAVAILABLE"))?
                .0;
            let raw: serde_json::Value =
                serde_json::from_slice(&bytes).map_err(|_| fail("FORMAT_INVALID"))?;
            Some(
                raw["name"]
                    .as_str()
                    .unwrap_or("Untitled project")
                    .to_owned(),
            )
        } else {
            None
        };
        Ok(FileGraphView {
            manuscript_path: source.map(|r| r.1),
            manifest_name,
            project_id: p.id,
            registered: graph.is_some(),
            graph_hash: graph.as_ref().map(|g| g.hash.clone()),
            generation: graph.as_ref().map_or(0, |g| g.generation),
            file_count: graph.as_ref().map_or(0, |g| g.graph.files.len() as i64),
            code_execution: false,
            file_directory_transitions: false,
        })
    }
    pub fn graph_files_page(&self, cursor: Option<&str>) -> Result<GraphFilePage> {
        let c = db(self.connection.lock())?;
        let g = self
            .file_graph_locked(&c)?
            .ok_or(fail("GRAPH_REGISTRATION_REQUIRED"))?;
        let locks = Self::production_locks_locked(&c)?;
        let records = g
            .graph
            .files
            .into_iter()
            .map(|f| GraphFileView {
                locked: locks.iter().any(|l| l.path == f.path && l.hash == f.hash),
                path: f.path,
                hash: f.hash,
                size: f.size as i64,
            })
            .collect();
        let (records, continuation) = page(
            records,
            cursor,
            &format!("files:{}:{}", g.hash, g.generation),
        )?;
        Ok(GraphFilePage {
            records,
            continuation,
        })
    }
    fn check_base(
        &self,
        c: &Connection,
        project: &str,
        revision: i64,
        hash: &str,
        generation: i64,
    ) -> Result<GraphSnapshot> {
        id(project)?;
        let p = read_project(c)
            .map_err(|_| fail("STORAGE_UNAVAILABLE"))?
            .ok_or(fail("PROJECT_NOT_FOUND"))?;
        if p.id != project {
            return Err(fail("PROJECT_NOT_FOUND"));
        }
        if p.working_revision != revision {
            return Err(fail("REVISION_CONFLICT"));
        }
        let g = self
            .file_graph_locked(c)?
            .ok_or(fail("GRAPH_REGISTRATION_REQUIRED"))?;
        if g.hash != hash || g.generation != generation {
            return Err(fail("GRAPH_BASE_MISMATCH"));
        }
        Ok(g)
    }
    fn validate_grant(&self, c: &Connection, g: &CreativeGrant) -> Result<()> {
        if g.whole_tree && (!g.files.is_empty() || !g.directories.is_empty()) {
            return Err(fail("WORK_SCOPE_INVALID"));
        }
        let paths = g
            .files
            .iter()
            .chain(&g.directories)
            .map(String::as_str)
            .collect::<Vec<_>>();
        scenesparrow_domain::open_project::validate_portable_paths(&paths)
            .map_err(|_| fail("WORK_SCOPE_INVALID"))?;
        if paths.iter().any(|p| {
            p.split('/')
                .any(|s| inventory::excluded(s, true).unwrap_or(true))
        }) {
            return Err(fail("WORK_SCOPE_INVALID"));
        }
        let ids = &g.manuscript_scope.block_ids;
        if (g.manuscript_scope.kind == CreativeGrantManuscriptScopeKind::Blocks) != !ids.is_empty()
            || ids.iter().collect::<BTreeSet<_>>().len() != ids.len()
        {
            return Err(fail("WORK_SCOPE_INVALID"));
        }
        let state = self.load(c)?;
        if ids
            .iter()
            .any(|id| !state.blocks.iter().any(|b| b.id == *id))
        {
            return Err(fail("WORK_SCOPE_INVALID"));
        }
        Ok(())
    }
    pub(crate) fn work_item_locked(&self, c: &Connection, item: &str) -> Result<WorkItemView> {
        id(item)?;
        type ItemRow = (
            String,
            String,
            String,
            i64,
            i64,
            String,
            String,
            i64,
            String,
            String,
            Option<String>,
        );
        let row:Option<ItemRow>=db(c.query_row("SELECT project_id,origin,base_hash,base_generation,creation_revision,grant_json,reference_ids_json,revision,state,operation_id,latest_candidate FROM work_items WHERE id=?1",[item],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?,r.get(9)?,r.get(10)?))).optional())?;
        let (
            p,
            origin,
            base,
            generation,
            revision,
            grant,
            refs,
            epoch,
            state,
            operation,
            candidate,
        ) = row.ok_or(fail("WORK_ITEM_NOT_FOUND"))?;
        Ok(WorkItemView {
            copy_available: origin == "copy" && self.copy_available(c, item)?,
            project_id: p,
            work_item_id: item.into(),
            origin: parse(&json(&origin)?)?,
            base_graph_hash: base,
            base_graph_generation: generation,
            creation_revision: revision,
            grant: parse(&grant)?,
            reference_ids: parse(&refs)?,
            item_revision: epoch,
            state: parse(&json(&state)?)?,
            operation_request_id: operation,
            latest_candidate: candidate
                .map(|x| self.work_candidate_locked(c, item, &x))
                .transpose()?,
        })
    }
    pub fn work_item(&self, item: &str) -> Result<WorkItemView> {
        let c = db(self.connection.lock())?;
        self.work_item_locked(&c, item)
    }
    pub fn work_items_page(&self, cursor: Option<&str>) -> Result<WorkItemPage> {
        let c = db(self.connection.lock())?;
        let p = read_project(&c)
            .map_err(|_| fail("STORAGE_UNAVAILABLE"))?
            .ok_or(fail("PROJECT_NOT_FOUND"))?;
        let scope = format!("items:{}", p.id);
        let key = hash(scope.as_bytes());
        let offset = if let Some(cursor) = cursor {
            let (k, n) = cursor.split_once(':').ok_or(fail("WORK_CURSOR_INVALID"))?;
            if k != key {
                return Err(fail("WORK_CURSOR_INVALID"));
            }
            n.parse::<i64>()
                .ok()
                .filter(|n| *n >= 0)
                .ok_or(fail("WORK_CURSOR_INVALID"))?
        } else {
            0
        };
        let mut q = db(c.prepare("SELECT id FROM work_items ORDER BY rowid LIMIT 101 OFFSET ?1"))?;
        let mut ids = db(q.query_map([offset], |row| row.get::<_, String>(0)))?
            .map(db)
            .collect::<Result<Vec<_>>>()?;
        let more = ids.len() > 100;
        ids.truncate(100);
        if cursor.is_some() && ids.is_empty() {
            return Err(fail("WORK_CURSOR_INVALID"));
        }
        let records = ids
            .iter()
            .map(|id| self.work_item_locked(&c, id))
            .collect::<Result<Vec<_>>>()?;
        Ok(WorkItemPage {
            records,
            continuation: more.then(|| format!("{key}:{}", offset + 100)),
        })
    }
    fn work_candidate_locked(
        &self,
        c: &Connection,
        item: &str,
        candidate: &str,
    ) -> Result<WorkCandidateView> {
        id(candidate)?;
        type CandidateRow = (
            String,
            String,
            String,
            String,
            Option<String>,
            i64,
            i64,
            String,
        );
        let row:Option<CandidateRow>=db(c.query_row("SELECT view_json,raw_hash,prepared_hash,preparation_json,observation_json,inspected_revision,graph_generation,digest FROM work_candidates WHERE id=?1 AND item_id=?2",params![candidate,item],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?))).optional())?;
        let (
            raw,
            original_hash,
            prepared_hash,
            preparation,
            observation,
            revision,
            generation,
            stored_digest,
        ) = row.ok_or(fail("WORK_CANDIDATE_STALE"))?;
        let view: WorkCandidateView = parse(&raw)?;
        let preparation: PreparedGraphCandidate = parse(&preparation)?;
        let observation: Option<GraphObservation> =
            observation.map(|raw| parse(&raw)).transpose()?;
        if view.work_item_id != item
            || view.candidate_id != candidate
            || view.original_graph_hash != original_hash
            || view.prepared_graph_hash != prepared_hash
            || preparation.original_hash != original_hash
            || preparation.prepared_hash != prepared_hash
            || view.inspected_working_revision != revision
            || view.inspected_graph_generation != generation
            || view.candidate_digest != stored_digest
            || digest(&(
                item,
                &original_hash,
                &preparation,
                &observation,
                revision,
                generation,
            ))? != stored_digest
        {
            return Err(fail("WORK_CANDIDATE_STALE"));
        }
        Ok(view)
    }
    pub fn work_candidate(&self, item: &str, candidate: &str) -> Result<WorkCandidateView> {
        let c = db(self.connection.lock())?;
        self.work_item_locked(&c, item)?;
        self.work_candidate_locked(&c, item, candidate)
    }
    fn work_operation_locked(&self, c: &Connection, request: &str) -> Result<WorkOperationView> {
        id(request)?;
        type OperationRow = (
            String,
            String,
            String,
            String,
            Option<String>,
            i64,
            Option<String>,
        );
        let row:Option<OperationRow>=db(c.query_row("SELECT project_id,item_id,kind,status,failure_code,progress,candidate_json FROM work_operations WHERE request_id=?1",[request],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))).optional())?;
        let (p, item, kind, status, failure, progress, candidate) =
            row.ok_or(fail("OBJECT_NOT_FOUND"))?;
        let receipt =
            Self::outcome(c, request)?.and_then(|(_, outcome)| Self::decode(&outcome).ok());
        Ok(WorkOperationView {
            request_id: request.into(),
            project_id: p,
            work_item_id: item,
            kind: parse(&json(&kind)?)?,
            status: parse(&json(&status)?)?,
            failure_code: failure,
            progress,
            receipt,
            candidate: candidate.map(|raw| parse(&raw)).transpose()?,
        })
    }
    pub fn work_operation(&self, request: &str) -> Result<WorkOperationView> {
        let c = db(self.connection.lock())?;
        self.work_operation_locked(&c, request)
    }
    fn work_response_locked(&self, c: &Connection, request: &str) -> Result<WorkMutationResponse> {
        let operation = self.work_operation_locked(c, request)?;
        let item = if operation.work_item_id.is_empty() {
            None
        } else {
            self.work_item_locked(c, &operation.work_item_id).ok()
        };
        let result = operation
            .receipt
            .clone()
            .map(|receipt| {
                Ok(AuthoredSourceSaveResponse {
                    receipt,
                    snapshot: self.source_snapshot_locked(c)?,
                })
            })
            .transpose()?;
        Ok(WorkMutationResponse {
            operation,
            item,
            result,
        })
    }
    fn replay_work_start<T: serde::Serialize>(
        &self,
        c: &Connection,
        request: &str,
        payload: &T,
    ) -> Result<Option<WorkMutationResponse>> {
        id(request)?;
        let expected = digest(payload)?;
        if let Some((previous, outcome)) = Self::outcome(c, request)? {
            if previous != expected {
                return Err(fail("REQUEST_ID_CONFLICT"));
            }
            Self::decode(&outcome)?;
            return Err(fail("REQUEST_ID_CONFLICT"));
        }
        let previous: Option<String> = db(c
            .query_row(
                "SELECT digest FROM work_operations WHERE request_id=?1",
                [request],
                |r| r.get(0),
            )
            .optional())?;
        previous
            .map(|d| {
                if d != expected {
                    Err(fail("REQUEST_ID_CONFLICT"))
                } else {
                    self.work_response_locked(c, request)
                }
            })
            .transpose()
    }
    fn persist_work_start_error<T: serde::Serialize>(
        &self,
        c: &Connection,
        request: &str,
        payload: &T,
        error: &ManuscriptError,
    ) -> Result<()> {
        if !matches!(error.0, "STORAGE_UNAVAILABLE" | "REQUEST_ID_CONFLICT")
            && manuscript::uuid4(request)
            && Self::outcome(c, request)?.is_none()
        {
            db(c.execute(
                "INSERT INTO command_receipts VALUES(?1,?2,?3)",
                params![
                    request,
                    digest(payload)?,
                    json(&serde_json::json!({"error":error.0,"details":error.1}))?
                ],
            ))?;
        }
        Ok(())
    }
    fn record_operation<T: serde::Serialize>(
        c: &Connection,
        request: &str,
        payload: &T,
        project: &str,
        item: &str,
        kind: &str,
        status: &str,
    ) -> Result<()> {
        db(c.execute("INSERT INTO work_operations(request_id,digest,payload_json,project_id,item_id,kind,status) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![request,digest(payload)?,json(payload)?,project,item,kind,status]))?;
        Ok(())
    }
    fn admit_work_operation(c: &Connection) -> Result<()> {
        if db(c.query_row(
            "SELECT COUNT(*) FROM work_operations WHERE status IN ('queued','running')",
            [],
            |row| row.get::<_, i64>(0),
        ))? >= 5
        {
            return Err(fail("QUEUE_FULL"));
        }
        Ok(())
    }
    pub fn create_work_item(&self, r: &WorkItemCreateRequest) -> Result<WorkMutationResponse> {
        let mut c = db(self.connection.lock())?;
        let outcome = (|| {
            if let Some(v) = self.replay_work_start(&c, &r.request_id, r)? {
                return Ok(v);
            }
            if r.origin == WorkItemCreateRequestOrigin::Copy {
                self.guard_source_application(&c)?;
            } else {
                self.guard_source_recovery()?;
            }
            let g = self.check_base(
                &c,
                &r.project_id,
                r.expected_working_revision,
                &r.expected_graph_hash,
                r.expected_graph_generation,
            )?;
            self.validate_grant(&c, &r.grant)?;
            if r.origin == WorkItemCreateRequestOrigin::Copy
                && db(c.query_row(
                    "SELECT COUNT(*) FROM work_items WHERE origin='copy' AND state!='discarded'",
                    [],
                    |r| r.get::<_, i64>(0),
                ))? >= 5
            {
                return Err(fail("WORK_COPY_LIMIT"));
            }
            Self::admit_work_operation(&c)?;
            if r.reference_ids.iter().collect::<BTreeSet<_>>().len() != r.reference_ids.len() {
                return Err(fail("INVALID_REQUEST"));
            }
            let sources = Self::source_members(&c)?;
            let mut context = vec![];
            for reference in &r.reference_ids {
                let source = sources
                    .iter()
                    .find(|s| s.id == *reference)
                    .ok_or(fail("OBJECT_NOT_FOUND"))?;
                context.push(ContextMember {
                    id: source.id.clone(),
                    title: source.title.clone(),
                    url: source.url.clone(),
                    hash: source.object_hash.clone(),
                    size: source.size,
                });
            }
            let project = read_project(&c)
                .map_err(|_| fail("STORAGE_UNAVAILABLE"))?
                .ok_or(fail("PROJECT_NOT_FOUND"))?;
            let context = WorkContext {
                members: context,
                protection: ContextProtection {
                    working_revision: r.expected_working_revision,
                    locked_block_ids: Self::user_lock_ids(&c)?,
                    production_file_locks: Self::production_locks_locked(&c)?,
                    approved_baseline: project.approved_baseline,
                },
            };
            if json(&context)?.len() > 16 * 1024 * 1024 {
                return Err(fail("GRAPH_BUDGET_EXCEEDED"));
            }
            let item = uuid::Uuid::new_v4().to_string();
            let tx = db(c.transaction())?;
            Self::pin_file_graph_locked(&tx, &format!("work:{item}:base"), &g.hash)?;
            for member in &context.members {
                if let Some(h) = &member.hash {
                    db(tx.execute(
                        "INSERT OR IGNORE INTO external_object_pins(owner_id,object_hash) VALUES(?1,?2)",
                        params![format!("work:{item}:context"), h],
                    ))?;
                }
            }
            Self::record_operation(
                &tx,
                &r.request_id,
                r,
                &r.project_id,
                &item,
                "create",
                "queued",
            )?;
            db(tx.execute(
                "INSERT INTO work_items VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,0,'preparing',?10,NULL)",
                params![
                    item,
                    r.project_id,
                    if r.origin == WorkItemCreateRequestOrigin::Copy {
                        "copy"
                    } else {
                        "live"
                    },
                    g.hash,
                    g.generation,
                    r.expected_working_revision,
                    json(&r.grant)?,
                    json(&r.reference_ids)?,
                    json(&context)?,
                    r.request_id
                ],
            ))?;
            db(tx.commit())?;
            self.work_response_locked(&c, &r.request_id)
        })();
        if let Err(error) = &outcome {
            self.persist_work_start_error(&c, &r.request_id, r, error)?;
        }
        outcome
    }
    pub fn inspect_work_item(&self, r: &WorkItemInspectRequest) -> Result<WorkMutationResponse> {
        let mut c = db(self.connection.lock())?;
        let outcome = (|| {
            if let Some(v) = self.replay_work_start(&c, &r.request_id, r)? {
                return Ok(v);
            }
            self.guard_source_recovery()?;
            let g = self.check_base(
                &c,
                &r.project_id,
                r.expected_working_revision,
                &r.expected_graph_hash,
                r.expected_graph_generation,
            )?;
            let item = self.work_item_locked(&c, &r.work_item_id)?;
            if item.origin == WorkItemViewOrigin::Copy && !item.copy_available {
                return Err(fail("WORK_COPY_UNAVAILABLE"));
            }
            if item.item_revision != r.expected_item_revision
                || item.base_graph_hash != g.hash
                || matches!(item.state, WorkItemViewState::Discarded)
            {
                return Err(fail("WORK_ITEM_STALE"));
            }
            if matches!(
                item.state,
                WorkItemViewState::Preparing | WorkItemViewState::Inspecting
            ) {
                return Err(fail("WORK_OPERATION_ACTIVE"));
            }
            Self::admit_work_operation(&c)?;
            let tx = db(c.transaction())?;
            Self::record_operation(
                &tx,
                &r.request_id,
                r,
                &r.project_id,
                &r.work_item_id,
                "inspect",
                "queued",
            )?;
            db(tx.execute("UPDATE work_items SET state='inspecting',operation_id=?2,revision=revision+1 WHERE id=?1",params![r.work_item_id,r.request_id]))?;
            db(tx.commit())?;
            self.work_response_locked(&c, &r.request_id)
        })();
        if let Err(error) = &outcome {
            self.persist_work_start_error(&c, &r.request_id, r, error)?;
        }
        outcome
    }
    /// Location is a privileged native capability and never serialized by a view.
    pub fn reveal_work_item_location(&self, item: &str) -> Result<PathBuf> {
        let c = db(self.connection.lock())?;
        let item = self.work_item_locked(&c, item)?;
        if !item.copy_available {
            return Err(fail("WORK_COPY_UNAVAILABLE"));
        }
        if item.origin != WorkItemViewOrigin::Copy
            || matches!(
                item.state,
                WorkItemViewState::Preparing | WorkItemViewState::Discarded
            )
        {
            return Err(fail("SOURCE_CAPABILITY_UNSUPPORTED"));
        }
        let parent = Parent::open(
            &self.directory,
            &format!("work-items/{}/project/__work__", item.work_item_id),
        )?;
        parent.verify()?;
        let root = self.work_root(&item.work_item_id);
        plain_directory(&root)?;
        Ok(root)
    }
    fn work_root(&self, item: &str) -> PathBuf {
        self.directory.join("work-items").join(item)
    }
    pub(super) fn work_cancelled(&self, request: &str) -> Result<()> {
        let c = db(self.connection.lock())?;
        let op = self.work_operation_locked(&c, request)?;
        if op.status != WorkOperationViewStatus::Running || self.is_quiescing() {
            Err(fail("WORK_CANCELLED"))
        } else {
            Ok(())
        }
    }
}
impl SqliteProjectRepository {
    pub fn register_work_file_graph(
        &self,
        request: &GraphRegisterRequest,
    ) -> Result<AuthoredSourceSaveResponse> {
        let mut c = db(self.connection.lock())?;
        if let Some(result) = self.action_replay(&c, &request.request_id, request)? {
            return Ok(result);
        }
        let result = (|| {
            id(&request.project_id)?;
            let project = read_project(&c)
                .map_err(|_| fail("STORAGE_UNAVAILABLE"))?
                .ok_or(fail("PROJECT_NOT_FOUND"))?;
            if project.id != request.project_id {
                return Err(fail("PROJECT_NOT_FOUND"));
            }
            if project.working_revision != request.expected_working_revision {
                return Err(fail("REVISION_CONFLICT"));
            }
            let (_, _, source, generation) =
                source_row(&c)?.ok_or(fail("SOURCE_CAPABILITY_UNSUPPORTED"))?;
            if source != request.expected_source_hash
                || generation != request.expected_source_generation
            {
                return Err(fail("SOURCE_BASE_MISMATCH"));
            }
            if self.file_graph_locked(&c)?.is_some() {
                return Err(fail("GRAPH_BASE_MISMATCH"));
            }
            self.register_file_graph_locked(&mut c, Some(request))?;
            Ok(())
        })();
        if let Err(error) = result {
            if error.0 != "STORAGE_UNAVAILABLE" {
                db(c.execute(
                    "INSERT INTO command_receipts VALUES(?1,?2,?3)",
                    params![
                        request.request_id,
                        digest(request)?,
                        json(&serde_json::json!({"error":error.0}))?
                    ],
                ))?;
            }
            return Err(error);
        }
        let (_, outcome) =
            Self::outcome(&c, &request.request_id)?.ok_or(fail("STORAGE_UNAVAILABLE"))?;
        Ok(AuthoredSourceSaveResponse {
            receipt: Self::decode(&outcome)?,
            snapshot: self.source_snapshot_locked(&c)?,
        })
    }
}
