//! Native immutable creative graphs. These methods are infrastructure primitives,
//! not external work-item grants; the recorded-work-item owner must authorize them.
use super::*;
mod inventory;
pub(crate) mod work;
pub use work::WorkMemberReader;
pub(super) mod journal;
mod recovery;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod work_tests;
pub use inventory::GraphBudgets;
pub use recovery::GraphRecoveryMember;
#[derive(Debug, Clone, serde::Serialize)]
pub struct GraphCapabilities {
    pub file_directory_transitions: bool,
    pub code_execution: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GraphFile {
    pub path: String,
    pub hash: String,
    pub size: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FileGraph {
    pub version: u32,
    pub project_id: String,
    pub files: Vec<GraphFile>,
}
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GraphSnapshot {
    pub hash: String,
    pub generation: i64,
    pub graph: FileGraph,
}
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GraphBatch {
    pub request_id: String,
    pub project_id: String,
    pub expected_working_revision: i64,
    pub base_hash: String,
    pub expected_generation: i64,
    pub candidate_hash: String,
}
/// Core-captured physical observation, never an authoritative accepted baseline.
/// B persists/binds this opaque native value to its scoped candidate record.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GraphObservation {
    base_hash: String,
    generation: i64,
    graph_hash: String,
    identities: BTreeMap<String, Identity>,
}
impl GraphObservation {
    pub fn graph_hash(&self) -> &str {
        &self.graph_hash
    }
    pub fn identity(&self) -> String {
        hash(&serde_json::to_vec(self).expect("serializable observation"))
    }
}
#[derive(Clone)]
pub(crate) struct GraphAction {
    pub batch: GraphBatch,
    pub digest: String,
    pub rename: Option<(String, String)>,
    pub observation: Option<GraphObservation>,
    pub work: Option<work::WorkGraphAction>,
}
#[derive(Clone)]
pub(crate) struct GraphUpdate {
    pub before: GraphSnapshot,
    pub after_hash: String,
    pub after: FileGraph,
    pub rename: Option<(String, String)>,
    pub validate_physical: bool,
    pub observation: Option<GraphObservation>,
    pub checked_paths: Option<Vec<String>>,
}
impl FileGraph {
    fn index(&self) -> BTreeMap<&str, &GraphFile> {
        self.files.iter().map(|f| (f.path.as_str(), f)).collect()
    }
    fn file(&self, path: &str) -> Result<&GraphFile> {
        self.files
            .iter()
            .find(|f| f.path == path)
            .ok_or(fail("GRAPH_REQUIRED_FILE_MISSING"))
    }
}
pub(crate) fn graph_row(c: &Connection) -> Result<Option<(String, i64)>> {
    let version: i64 = db(c.pragma_query_value(None, "user_version", |r| r.get(0)))?;
    if version < 13 {
        return Ok(None);
    }
    db(c.query_row(
        "SELECT graph_hash,generation FROM accepted_file_graph WHERE singleton=1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional())
}
impl SqliteProjectRepository {
    /// Explicit baseline registration. It does not approve content or add Undo.
    pub fn register_file_graph(&self) -> Result<GraphSnapshot> {
        let mut c = db(self.connection.lock())?;
        self.register_file_graph_locked(&mut c, None)
    }
    fn register_file_graph_locked(
        &self,
        c: &mut Connection,
        request: Option<&GraphRegisterRequest>,
    ) -> Result<GraphSnapshot> {
        self.guard_source_application(c)?;
        if let Some(snapshot) = self.file_graph_locked(c)? {
            return Ok(snapshot);
        }
        let root = self
            .creative_root
            .as_ref()
            .ok_or(fail("SOURCE_CAPABILITY_UNSUPPORTED"))?;
        let graph = self.inventory_graph_locked(root, false, GraphBudgets::default())?;
        let manifest = self.validate_graph(c, &graph)?;
        let project = read_project(c)
            .map_err(|_| fail("STORAGE_UNAVAILABLE"))?
            .ok_or(fail("PROJECT_NOT_FOUND"))?;
        if manifest.name.as_deref().unwrap_or("Untitled project") != project.title {
            return Err(fail("GRAPH_NAME_MISMATCH"));
        }
        let (_, path, accepted, _) = source_row(c)?.ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
        if graph.file(&path)?.hash != accepted {
            return Err(fail("SOURCE_EXTERNAL_CHANGE"));
        }
        let hash = self.object(&db(serde_json::to_vec(&graph))?)?;
        self.guard_source_application(c)?;
        let tx = db(c.transaction())?;
        db(tx.execute("INSERT INTO accepted_file_graph VALUES(1,?1,0)", [&hash]))?;
        // Historical approvals have no historical media graph. This pin records
        // explicit registration provenance, not a media approval at that time.
        db(tx.execute("INSERT OR IGNORE INTO approved_file_graphs SELECT id,?1,'registration' FROM approved_manifests",[&hash]))?;
        db(tx.execute("INSERT OR IGNORE INTO file_graph_pins SELECT 'downstream:'||id,?1,'registration' FROM downstream_inputs",[&hash]))?;

        if let Some(request) = request {
            let receipt = self.current_graph_receipt(&tx, &request.request_id)?;
            db(tx.execute(
                "INSERT INTO command_receipts VALUES(?1,?2,?3)",
                params![
                    request.request_id,
                    crate::storage::hash(&db(serde_json::to_vec(request))?),
                    db(serde_json::to_string(&receipt))?
                ],
            ))?;
        }
        db(tx.commit())?;
        Ok(GraphSnapshot {
            hash,
            generation: 0,
            graph,
        })
    }
    /// Cheap accepted identity read: never traverses the creative tree.
    pub fn accepted_file_graph(&self) -> Result<Option<GraphSnapshot>> {
        let c = db(self.connection.lock())?;
        self.file_graph_locked(&c)
    }
    pub(crate) fn file_graph_locked(&self, c: &Connection) -> Result<Option<GraphSnapshot>> {
        graph_row(c)?
            .map(|(hash, generation)| {
                Ok(GraphSnapshot {
                    graph: self.read_file_graph(&hash)?,
                    hash,
                    generation,
                })
            })
            .transpose()
    }
    pub(crate) fn read_file_graph(&self, hash: &str) -> Result<FileGraph> {
        let graph: FileGraph = db(serde_json::from_slice(
            &self.read_bounded_object(hash, 16 * 1024 * 1024)?,
        ))?;
        if graph.version != 1 || hash != crate::storage::hash(&db(serde_json::to_vec(&graph))?) {
            return Err(fail("GRAPH_INVALID"));
        }
        inventory::validate_members(&graph, GraphBudgets::default())?;
        Ok(graph)
    }
    pub(crate) fn validate_graph(
        &self,
        c: &Connection,
        graph: &FileGraph,
    ) -> Result<OpenProjectManifest> {
        let (id, path, _, _) = source_row(c)?.ok_or(fail("SOURCE_CAPABILITY_UNSUPPORTED"))?;
        if graph.project_id != id {
            return Err(fail("SOURCE_PROJECT_MISMATCH"));
        }
        let file = graph.file("project.json")?;
        if file.size > manuscript::MAX_DOCUMENT_BYTES as u64 {
            return Err(fail("GRAPH_BUDGET_EXCEEDED"));
        }
        let manifest = match scenesparrow_domain::open_project::inspect_project_manifest(
            serde_json::from_slice(
                &self.read_bounded_object(&file.hash, manuscript::MAX_DOCUMENT_BYTES as u64)?,
            )
            .map_err(|_| fail("FORMAT_INVALID"))?,
        )
        .map_err(format_error)?
        {
            scenesparrow_domain::open_project::ManifestInspection::Supported(m) => m,
            _ => return Err(fail("SOURCE_FUTURE_READ_ONLY")),
        };
        if manifest.project_id != id || manifest.manuscript != path {
            return Err(fail("SOURCE_PROJECT_MISMATCH"));
        }
        if graph.file(&path)?.size > manuscript::MAX_DOCUMENT_BYTES as u64 {
            return Err(fail("DOCUMENT_TOO_LARGE"));
        }
        if let Some(audio) = &manifest.audio {
            let plan = graph.file(&audio.plan)?;
            if plan.size > manuscript::MAX_DOCUMENT_BYTES as u64 {
                return Err(fail("GRAPH_BUDGET_EXCEEDED"));
            }
            let raw: serde_json::Value = serde_json::from_slice(
                &self.read_bounded_object(&plan.hash, manuscript::MAX_DOCUMENT_BYTES as u64)?,
            )
            .map_err(|_| fail("FORMAT_INVALID"))?;
            scenesparrow_domain::open_project::validate_media_declaration(&raw, true)
                .map_err(format_error)?;
            // Every declared media path must be present; arbitrary undeclared
            // creative files remain opaque and are never executed.
            if let Some(segments) = raw["segments"].as_array() {
                for segment in segments {
                    if let Some(media) = segment["media"].as_str() {
                        graph.file(media)?;
                    }
                }
            }
        }
        if let Some(video) = &manifest.video {
            graph.file(&video.entry)?;
        }
        Ok(manifest)
    }
    /// B supplies an inspected immutable candidate and recorded authorization.
    /// This entry still enforces receipts, text policy, live CAS and reservations.
    pub fn accept_file_graph(&self, batch: &GraphBatch) -> Result<CommandReceipt> {
        let mut c = db(self.connection.lock())?;
        let action = GraphAction {
            batch: batch.clone(),
            digest: hash(&db(serde_json::to_vec(batch))?),
            rename: None,
            observation: None,
            work: None,
        };
        self.execute_graph_action_locked(&mut c, &action)
    }
    pub(crate) fn execute_graph_action_locked(
        &self,
        c: &mut Connection,
        action: &GraphAction,
    ) -> Result<CommandReceipt> {
        let group = EditGroup {
            group_id: uuid::Uuid::new_v4().to_string(),
            client_session_id: uuid::Uuid::new_v4().to_string(),
            group_sequence: 1,
            kind: EditGroupKind::Discrete,
        };
        let command = ManuscriptCommand::ApplyDocumentEdit {
            request_id: action.batch.request_id.clone(),
            project_id: action.batch.project_id.clone(),
            expected_working_revision: action.batch.expected_working_revision,
            payload: EditPayload {
                expected_block_revisions: vec![],
                group,
                operations: vec![],
            },
        };
        self.execute_manuscript_graph_locked(c, &command, None, None, Some(action))
    }
    pub(crate) fn graph_source_request(
        &self,
        c: &Connection,
        action: &GraphAction,
        group: &EditGroup,
    ) -> Result<SourceSaveRequest> {
        self.guard_work_action(c, action)?;
        let current = self
            .file_graph_locked(c)?
            .ok_or(fail("GRAPH_REGISTRATION_REQUIRED"))?;
        let batch = &action.batch;
        if batch.base_hash != current.hash || batch.expected_generation != current.generation {
            return Err(fail("GRAPH_BASE_MISMATCH"));
        }
        let graph = self.read_file_graph(&batch.candidate_hash)?;
        self.validate_graph(c, &graph)?;
        let (_, path, accepted, generation) =
            source_row(c)?.ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
        let source = String::from_utf8(self.read_bounded_object(
            &graph.file(&path)?.hash,
            manuscript::MAX_DOCUMENT_BYTES as u64,
        )?)
        .map_err(|_| fail("SOURCE_UTF8_INVALID"))?;
        Ok(SourceSaveRequest {
            request_id: batch.request_id.clone(),
            project_id: batch.project_id.clone(),
            expected_working_revision: batch.expected_working_revision,
            expected_generation: generation,
            expected_hash: accepted,
            source,
            group: group.clone(),
        })
    }
    pub(crate) fn prepare_graph_transition(
        &self,
        c: &Connection,
        command: &ManuscriptCommand,
        t: &mut Transition,
        action: Option<&GraphAction>,
    ) -> Result<Option<GraphUpdate>> {
        let Some(before) = self.file_graph_locked(c)? else {
            if action.is_some() {
                return Err(fail("GRAPH_REGISTRATION_REQUIRED"));
            }
            return Ok(None);
        };
        let (_, path, _, _) = source_row(c)?.ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
        let mut after = if let Some(action) = action {
            self.read_file_graph(&action.batch.candidate_hash)?
        } else if let Some(target) = self.history_graph_target(c, command, &before.hash)? {
            self.read_file_graph(&target)?
        } else {
            before.graph.clone()
        };
        let source = t
            .source_hash
            .as_ref()
            .ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
        if action.is_some() && after.file(&path)?.hash != *source {
            return Err(fail("IDENTITY_MISSING"));
        }
        let source_size = self.verify_object_stream(source)?;
        let member = after
            .files
            .iter_mut()
            .find(|f| f.path == path)
            .ok_or(fail("GRAPH_REQUIRED_FILE_MISSING"))?;
        member.hash = source.clone();
        member.size = source_size;
        self.validate_graph(c, &after)?;
        Self::guard_graph_topology(&before.graph, &after)?;
        let after_hash = self.object(&db(serde_json::to_vec(&after))?)?;
        if before.hash != after_hash && t.state.working_revision == manuscript::envelope(command).2
        {
            t.state.working_revision = manuscript::next_revision(t.state.working_revision)?;
        }
        if self.work_action_changes_locks(c, action)?
            || self.history_lock_target(c, command)?.is_some()
        {
            t.state.working_revision = manuscript::next_revision(manuscript::envelope(command).2)?;
        }
        self.guard_graph_production(c, &before.graph, &after)?;
        let checked_paths = if action.is_some_and(|a| a.rename.is_none()) {
            None
        } else {
            self.scoped_graph_paths(c, &before.graph, &after)?
        };
        if checked_paths.is_some() {
            self.guard_graph_manifest_identity(c)?;
        }
        Ok(Some(GraphUpdate {
            before,
            after_hash,
            after,
            rename: action.and_then(|a| a.rename.clone()),
            validate_physical: action.is_some_and(|a| match a.work.as_ref() {
                Some(work::WorkGraphAction::Locks(_)) => false,
                Some(work::WorkGraphAction::Discard(r)) => {
                    r.disposition == WorkItemDiscardRequestDisposition::RestoreAcceptedLive
                }
                _ => true,
            }),
            observation: action.and_then(|a| a.observation.clone()),
            checked_paths,
        }))
    }
    /// B extends this same commit-time guard with core-owned path/hash locks.
    /// Current downstream use conservatively reserves production changes only;
    /// a text lock or review reservation does not fence independent media.
    pub(crate) fn guard_graph_production(
        &self,
        c: &Connection,
        before: &FileGraph,
        after: &FileGraph,
    ) -> Result<()> {
        let production = self.scoped_graph_paths(c, before, after)?.is_none();
        if production
            && db(c.query_row(
                "SELECT EXISTS(SELECT 1 FROM production_file_locks)",
                [],
                |r| r.get::<_, bool>(0),
            ))?
        {
            return Err(fail("PRODUCTION_FILE_LOCKED"));
        }
        if production
            && db(c.query_row(
                "SELECT EXISTS(SELECT 1 FROM downstream_inputs WHERE status='using')",
                [],
                |r| r.get::<_, bool>(0),
            ))?
        {
            return Err(fail("TASK_USING_CONTENT"));
        }
        Ok(())
    }
    pub(crate) fn graph_retention_roots(&self, c: &Connection) -> Result<BTreeSet<String>> {
        let mut roots = BTreeSet::new();
        let mut query=db(c.prepare("SELECT graph_hash FROM accepted_file_graph UNION SELECT before_hash FROM history_file_graphs UNION SELECT after_hash FROM history_file_graphs UNION SELECT graph_hash FROM file_graph_pins UNION SELECT graph_hash FROM approved_file_graphs"))?;
        let mut graphs = BTreeSet::new();
        for row in db(query.query_map([], |r| r.get::<_, String>(0)))? {
            graphs.insert(db(row)?);
        }
        if self.intent_path().exists() {
            let intent: Intent = db(serde_json::from_slice(
                &self
                    .read_intent_bytes()?
                    .ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?,
            ))?;
            if let Some(graph) = intent.graph {
                graphs.insert(graph.before_hash);
                graphs.insert(graph.after_hash);
                if let Some(observation) = graph.observation {
                    graphs.insert(observation.graph_hash);
                }
            }
        }
        for hash in graphs {
            let graph = self.read_file_graph(&hash)?;
            roots.insert(hash);
            for file in graph.files {
                if self.verify_object_stream(&file.hash)? != file.size {
                    return Err(fail("GRAPH_INVALID"));
                }
                roots.insert(file.hash);
            }
        }
        let mut query = db(c.prepare("SELECT object_hash FROM graph_recovery_members"))?;
        for row in db(query.query_map([], |r| r.get::<_, String>(0)))? {
            roots.insert(db(row)?);
        }
        Ok(roots)
    }
}
impl SqliteProjectRepository {
    pub(crate) fn rename_file_graph_locked(
        &self,
        c: &mut Connection,
        request: &str,
        project_id: &str,
        previous: &str,
        title: &str,
    ) -> std::result::Result<Project, Error> {
        let project = read_project(c)?.ok_or(Error::Conflict)?;
        let receipt:Option<(String,String,String,i64)>=storage(c.query_row("SELECT project_id,previous_title,title,sequence FROM project_rename_receipts WHERE request_id=?1",[request],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional())?;
        if let Some((id, old, name, sequence)) = receipt {
            let latest: i64 = storage(c.query_row(
                "SELECT MAX(sequence) FROM project_rename_receipts",
                [],
                |r| r.get(0),
            ))?;
            return if id == project_id
                && old == previous
                && name == title
                && project.id == id
                && project.title == name
                && sequence == latest
            {
                Ok(project)
            } else {
                Err(Error::Conflict)
            };
        }
        if project.id != project_id || project.title != previous {
            return Err(Error::Conflict);
        }
        let current = self
            .file_graph_locked(c)
            .map_err(|_| Error::Storage)?
            .ok_or(Error::Storage)?;
        let mut graph = current.graph;
        let member = graph
            .files
            .iter_mut()
            .find(|f| f.path == "project.json")
            .ok_or(Error::Storage)?;
        let bytes = self.read_object(&member.hash).map_err(|_| Error::Storage)?;
        let mut manifest: serde_json::Value = storage(serde_json::from_slice(&bytes))?;
        // Preserve exact raw bytes for an unchanged normal rename.
        if previous != title {
            manifest["name"] = title.into();
            let bytes = storage(serde_json::to_vec_pretty(&manifest))?;
            member.hash = self.object(&bytes).map_err(|_| Error::Storage)?;
            member.size = bytes.len() as u64;
        }
        let candidate_hash = self
            .object(&storage(serde_json::to_vec(&graph))?)
            .map_err(|_| Error::Storage)?;
        let action = GraphAction {
            batch: GraphBatch {
                request_id: request.into(),
                project_id: project_id.into(),
                expected_working_revision: project.working_revision,
                base_hash: current.hash,
                expected_generation: current.generation,
                candidate_hash,
            },
            digest: hash(&storage(serde_json::to_vec(&(
                request, project_id, previous, title,
            )))?),
            rename: Some((previous.into(), title.into())),
            observation: None,
            work: None,
        };
        self.execute_graph_action_locked(c, &action).map_err(|e| {
            if matches!(
                e.0,
                "REQUEST_ID_CONFLICT" | "REVISION_CONFLICT" | "GRAPH_BASE_MISMATCH"
            ) {
                Error::Conflict
            } else {
                Error::Storage
            }
        })?;
        read_project(c)?.ok_or(Error::Storage)
    }
}

impl SqliteProjectRepository {
    pub fn observe_file_graph(&self) -> Result<GraphObservation> {
        let c = db(self.connection.lock())?;
        self.guard_source_recovery()?;
        let current = self
            .file_graph_locked(&c)?
            .ok_or(fail("GRAPH_REGISTRATION_REQUIRED"))?;
        let root = self
            .creative_root
            .as_ref()
            .ok_or(fail("SOURCE_CAPABILITY_UNSUPPORTED"))?;
        let (graph, identities) = self.scan_graph_locked(
            root,
            false,
            GraphBudgets::default(),
            Some(&current.graph.project_id),
        )?;
        let graph_hash = self.object(&db(serde_json::to_vec(&graph))?)?;
        Self::pin_file_graph_locked(&c, "live-observation", &graph_hash)?;
        Ok(GraphObservation {
            base_hash: current.hash,
            generation: current.generation,
            graph_hash,
            identities,
        })
    }
    pub fn accept_observed_file_graph(
        &self,
        batch: &GraphBatch,
        observation: &GraphObservation,
    ) -> Result<CommandReceipt> {
        let mut c = db(self.connection.lock())?;
        let action = GraphAction {
            batch: batch.clone(),
            digest: hash(&db(serde_json::to_vec(&(batch, observation.identity())))?),
            rename: None,
            observation: Some(observation.clone()),
            work: None,
        };
        self.execute_graph_action_locked(&mut c, &action)
    }
    pub(super) fn revalidate_graph_observation(
        &self,
        observation: &GraphObservation,
    ) -> Result<FileGraph> {
        let root = self
            .creative_root
            .as_ref()
            .ok_or(fail("SOURCE_CAPABILITY_UNSUPPORTED"))?;
        let expected = self.read_file_graph(&observation.graph_hash)?;
        let (actual, identities) = self.scan_graph_locked(
            root,
            false,
            GraphBudgets::default(),
            Some(&expected.project_id),
        )?;
        if actual != expected || identities != observation.identities {
            return Err(fail("GRAPH_OBSERVATION_STALE"));
        }
        Ok(expected)
    }
}

impl SqliteProjectRepository {
    /// B assigns its recorded owner before releasing a candidate/observation.
    pub(crate) fn pin_file_graph_locked(
        c: &Connection,
        owner: &str,
        graph_hash: &str,
    ) -> Result<()> {
        db(c.execute("INSERT INTO file_graph_pins(owner_id,graph_hash) VALUES(?1,?2) ON CONFLICT(owner_id) DO UPDATE SET graph_hash=excluded.graph_hash",params![owner,graph_hash]))?;
        Ok(())
    }
}

impl SqliteProjectRepository {
    pub fn file_graph_capabilities(&self) -> GraphCapabilities {
        GraphCapabilities {
            file_directory_transitions: false,
            code_execution: false,
        }
    }
    pub(super) fn guard_graph_topology(before: &FileGraph, after: &FileGraph) -> Result<()> {
        let keys = |graph: &FileGraph| {
            graph
                .files
                .iter()
                .map(|f| scenesparrow_domain::open_project::portable_key(&f.path))
                .collect::<BTreeSet<_>>()
        };
        let old = keys(before);
        let new = keys(after);
        for (files, others) in [(&old, &new), (&new, &old)] {
            for path in files {
                let mut prefix = String::new();
                let segments = path.split('/').collect::<Vec<_>>();
                for segment in &segments[..segments.len() - 1] {
                    if !prefix.is_empty() {
                        prefix.push('/');
                    }
                    prefix.push_str(segment);
                    if others.contains(&prefix) {
                        return Err(fail("GRAPH_TOPOLOGY_UNSUPPORTED"));
                    }
                }
            }
        }
        Ok(())
    }
}

impl SqliteProjectRepository {
    fn scoped_graph_paths(
        &self,
        c: &Connection,
        before: &FileGraph,
        after: &FileGraph,
    ) -> Result<Option<Vec<String>>> {
        let (_, source, _, _) = source_row(c)?.ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
        let old = before.index();
        let new = after.index();
        let paths = old
            .keys()
            .chain(new.keys())
            .filter(|path| old.get(*path) != new.get(*path))
            .map(|path| (*path).to_owned())
            .collect::<BTreeSet<_>>();
        if paths.iter().any(|p| p != &source && p != "project.json") {
            return Ok(None);
        }
        if paths.contains("project.json") {
            if !old.contains_key("project.json") || !new.contains_key("project.json") {
                return Ok(None);
            }
            let read = |graph: &FileGraph| -> Result<serde_json::Value> {
                db(serde_json::from_slice(&self.read_bounded_object(
                    &graph.file("project.json")?.hash,
                    manuscript::MAX_DOCUMENT_BYTES as u64,
                )?))
            };
            let mut previous = read(before)?;
            let mut target = read(after)?;
            previous
                .as_object_mut()
                .ok_or(fail("GRAPH_INVALID"))?
                .remove("name");
            target
                .as_object_mut()
                .ok_or(fail("GRAPH_INVALID"))?
                .remove("name");
            if previous != target {
                return Ok(None);
            }
        }
        Ok(Some(paths.into_iter().collect()))
    }
}

impl SqliteProjectRepository {
    fn guard_graph_manifest_identity(&self, c: &Connection) -> Result<()> {
        let (project, path, _, _) = source_row(c)?.ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
        let root = self
            .creative_root
            .as_ref()
            .ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
        let bytes = Parent::open(root, "project.json")?
            .read("project.json", false)?
            .ok_or(fail("SOURCE_READ_UNAVAILABLE"))?
            .0;
        let manifest = match scenesparrow_domain::open_project::inspect_project_manifest(
            serde_json::from_slice(&bytes).map_err(|_| fail("FORMAT_INVALID"))?,
        )
        .map_err(format_error)?
        {
            scenesparrow_domain::open_project::ManifestInspection::Supported(m) => m,
            _ => return Err(fail("SOURCE_FUTURE_READ_ONLY")),
        };
        if manifest.project_id != project || manifest.manuscript != path {
            return Err(fail("SOURCE_PROJECT_MISMATCH"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PreparedGraphIdentity {
    pub address: String,
    pub id: String,
}
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PreparedGraphCandidate {
    pub original_hash: String,
    pub prepared_hash: String,
    pub assigned: Vec<PreparedGraphIdentity>,
}
impl SqliteProjectRepository {
    /// B persists this result by original raw digest before acknowledging an
    /// inspection. Re-running preparation is not replay: new IDs are random.
    /// Only immutable objects are prepared; no creative/SQL/history state changes.
    pub fn prepare_file_graph_candidate(
        &self,
        original_hash: &str,
    ) -> Result<PreparedGraphCandidate> {
        let c = db(self.connection.lock())?;
        self.guard_source_recovery()?;
        let graph = self.read_file_graph(original_hash)?;
        self.validate_graph(&c, &graph)?;
        let (_, path, _, _) = source_row(&c)?.ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
        let protected = Self::user_lock_ids(&c)?;
        self.prepare_file_graph_captured(original_hash, &path, &protected)
    }
    fn prepare_file_graph_captured(
        &self,
        original_hash: &str,
        path: &str,
        protected: &[String],
    ) -> Result<PreparedGraphCandidate> {
        let mut graph = self.read_file_graph(original_hash)?;
        let bytes = self.read_bounded_object(
            &graph.file(path)?.hash,
            manuscript::MAX_DOCUMENT_BYTES as u64,
        )?;
        let original = source::read_source(
            &bytes,
            &protected.iter().map(String::as_str).collect::<Vec<_>>(),
        )
        .map_err(format_error)?;
        let (prepared, mapping) = if original.source.is_empty() {
            (original.clone(), vec![])
        } else {
            prepare_source_identities(&original)?
        };
        let assigned = mapping
            .into_iter()
            .map(|(address, id)| PreparedGraphIdentity { address, id })
            .collect();
        let member = graph
            .files
            .iter_mut()
            .find(|f| f.path == path)
            .ok_or(fail("GRAPH_REQUIRED_FILE_MISSING"))?;
        member.hash = self.object(prepared.source.as_bytes())?;
        member.size = prepared.source.len() as u64;
        let prepared_hash = self.object(&db(serde_json::to_vec(&graph))?)?;
        Ok(PreparedGraphCandidate {
            original_hash: original_hash.into(),
            prepared_hash,
            assigned,
        })
    }
}

impl SqliteProjectRepository {
    pub(crate) fn verify_graph_owner_pins(&self, c: &Connection) -> Result<()> {
        let (_, path, _, _) = source_row(c)?.ok_or(fail("GRAPH_INVALID"))?;
        let mut query=db(c.prepare("SELECT g.graph_hash,g.capture_kind,a.manifest_hash FROM approved_file_graphs g JOIN approved_manifests a ON a.id=g.baseline_id UNION ALL SELECT g.graph_hash,g.capture_kind,a.manifest_hash FROM file_graph_pins g JOIN downstream_inputs d ON g.owner_id='downstream:'||d.id JOIN approved_manifests a ON a.id=d.baseline_id"))?;
        for row in db(query.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        }))? {
            let (hash, kind, approved) = db(row)?;
            let graph = self.read_file_graph(&hash)?;
            self.validate_graph(c, &graph)?;
            if kind != "registration" {
                let manifest: crate::finalization::ApprovedManifest =
                    db(serde_json::from_slice(&self.read_object(&approved)?))?;
                if manifest.source_hash.as_deref() != Some(graph.file(&path)?.hash.as_str()) {
                    return Err(fail("GRAPH_INVALID"));
                }
            }
        }
        Ok(())
    }
}
