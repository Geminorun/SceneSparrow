//! Authored-file storage coordinated with the existing manuscript writer.
use crate::{
    storage::{Result, db, hash},
    *,
};
use scenesparrow_domain::{
    contracts::*,
    manuscript::{self, ManuscriptError, Transition},
    source::{self, SourceDocument},
};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Write,
    path::PathBuf,
};
pub mod graph;
mod inspection;
pub(crate) mod physical;
mod reconciliation;
mod recovery;
pub(crate) use inspection::Observation;
use physical::{Identity, Parent};
#[cfg(test)]
pub(super) type TestAction = Box<dyn FnOnce() + Send>;
fn fail(code: &'static str) -> ManuscriptError {
    ManuscriptError(code, None)
}
fn format_error(error: scenesparrow_domain::open_project::FormatError) -> ManuscriptError {
    fail(error.code)
}
pub type SourceSaveRequest = AuthoredSourceSaveRequest;
pub type SourceSnapshot = AuthoredSourceSnapshot;
pub type SourceSaveResponse = AuthoredSourceSaveResponse;
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectInspection {
    Legacy,
    Unmanaged(OpenProjectManifest),
    Managed(OpenProjectManifest),
    FutureReadOnly {
        format_version: i64,
        raw: serde_json::Value,
    },
    RecoveryRequired,
}
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct FileChange {
    relative_path: String,
    before_hash: Option<String>,
    after_hash: Option<String>,
    before_identity: Option<Identity>,
    after_identity: Option<Identity>,
    staged_name: String,
}
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Intent {
    version: u32,
    request_id: String,
    digest: String,
    project_id: String,
    expected_generation: i64,
    changes: Vec<FileChange>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    accepted: Option<AcceptedChange>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    resolution: Option<BoundResolution>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    graph: Option<graph::journal::GraphIntent>,
}
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct AcceptedChange {
    before_hash: String,
    after_hash: String,
}
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct BoundResolution {
    candidate_id: String,
    base_hash: String,
    base_generation: i64,
    live_hash: Option<String>,
    disposition: String,
}
fn sync_directory(path: &Path) -> Result<()> {
    #[cfg(unix)]
    db(File::open(path).and_then(|f| f.sync_all()))?;
    let _ = path;
    Ok(())
}
fn plain_directory(path: &Path) -> Result<()> {
    let meta = db(std::fs::symlink_metadata(path))?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err(fail("SOURCE_PATH_UNSAFE"));
    }
    Ok(())
}
impl SqliteProjectRepository {
    pub fn inspect_format(root: &Path) -> Result<ProjectInspection> {
        plain_directory(root)?;
        for entry in db(std::fs::read_dir(root))? {
            let name = db(entry)?.file_name();
            let name = name.to_string_lossy();
            if scenesparrow_domain::open_project::is_protected_root_alias(&name) {
                return Err(fail("SOURCE_PATH_UNSAFE"));
            }
        }
        let manifest_path = root.join("project.json");
        if std::fs::symlink_metadata(&manifest_path).is_err() {
            return Ok(if root.join("project.sqlite").is_file() {
                ProjectInspection::Legacy
            } else if root.join(".scenesparrow").exists() {
                ProjectInspection::RecoveryRequired
            } else {
                return Err(fail("PROJECT_NOT_FOUND"));
            });
        }
        let parent = Parent::open(root, "project.json")?;
        let (bytes, _) = parent
            .read("project.json", false)?
            .ok_or(fail("SOURCE_READ_UNAVAILABLE"))?;
        let inspection = scenesparrow_domain::open_project::inspect_project_manifest(db(
            serde_json::from_slice(&bytes),
        )?)
        .map_err(format_error)?;
        let manifest = match inspection {
            scenesparrow_domain::open_project::ManifestInspection::FutureReadOnly {
                format_version,
                raw,
            } => {
                return Ok(ProjectInspection::FutureReadOnly {
                    format_version,
                    raw,
                });
            }
            scenesparrow_domain::open_project::ManifestInspection::Supported(value) => value,
        };
        if root.join(".scenesparrow").exists() {
            plain_directory(&root.join(".scenesparrow"))?;
            let management = root.join(".scenesparrow");
            for name in ["project.sqlite", "managed.json"] {
                let Ok(meta) = std::fs::symlink_metadata(management.join(name)) else {
                    return Ok(ProjectInspection::RecoveryRequired);
                };
                if !meta.is_file() || meta.file_type().is_symlink() {
                    return Err(fail("SOURCE_PATH_UNSAFE"));
                }
            }
            let marker = Parent::open(&management, "managed.json")?
                .read("managed.json", false)?
                .ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?
                .0;
            let marker: serde_json::Value = db(serde_json::from_slice(&marker))?;
            if marker["projectId"] != manifest.project_id {
                return Err(fail("SOURCE_PROJECT_MISMATCH"));
            }
            if marker["version"] != 1 || marker["state"] != "ready" {
                return Ok(ProjectInspection::RecoveryRequired);
            }
            Ok(ProjectInspection::Managed(manifest))
        } else {
            let source = Parent::open(root, &manifest.manuscript)?;
            source
                .read(&source.name, false)?
                .ok_or(fail("SOURCE_READ_UNAVAILABLE"))?;
            Ok(ProjectInspection::Unmanaged(manifest))
        }
    }
    /// Explicit new text-only creation; never initializes an existing directory.
    pub fn create_format(root: &Path) -> Result<Self> {
        if root.exists() {
            return Err(fail("SOURCE_ADOPTION_REQUIRED"));
        }
        db(std::fs::create_dir_all(root))?;
        let project_id = uuid::Uuid::new_v4().to_string();
        let manifest: OpenProjectManifest = db(serde_json::from_value(
            serde_json::json!({"format":"scenesparrow","formatVersion":1,"projectId":project_id,"manuscript":"manuscript.md"}),
        ))?;
        write_new(
            &root.join("project.json"),
            &db(serde_json::to_vec_pretty(&manifest))?,
        )?;
        write_new(&root.join("manuscript.md"), b"")?;
        sync_directory(root)?;
        Self::adopt_format(root)
    }
    /// Explicit adoption is the only entry that initializes trusted management.
    pub fn adopt_format(root: &Path) -> Result<Self> {
        // Existing legacy management is never reclassified as an unlocked
        // unmanaged source directory. OP5 owns explicit legacy conversion.
        if std::fs::symlink_metadata(root.join("project.sqlite")).is_ok() {
            return Err(fail("SOURCE_MIGRATION_REQUIRED"));
        }
        let ProjectInspection::Unmanaged(manifest) = Self::inspect_format(root)? else {
            return Err(fail("SOURCE_ADOPTION_REQUIRED"));
        };
        let parent = Parent::open(root, &manifest.manuscript)?;
        let (bytes, _) = parent
            .read(&parent.name, false)?
            .ok_or(fail("SOURCE_READ_UNAVAILABLE"))?;
        let mut document = source::read_source(&bytes, &[]).map_err(format_error)?;
        if !bytes.is_empty() {
            document = bind_new_identities(&document)?;
        }
        let management = root.join(".scenesparrow");
        db(std::fs::create_dir(&management))?;
        write_new(
            &management.join("managed.json"),
            &db(serde_json::to_vec(
                &serde_json::json!({"version":1,"projectId":manifest.project_id}),
            ))?,
        )?;
        sync_directory(root)?;
        let mut repository = Self::open_with_mode(&management, false)
            .map_err(|_| fail("SOURCE_RECOVERY_REQUIRED"))?;
        repository.creative_root = Some(db(std::fs::canonicalize(root))?);
        // Initialization has an explicit incomplete state: a crash cannot reopen
        // it as a fresh unlocked project. Keep the exact pre-adoption evidence.
        let original_hash = repository.object(&bytes)?;
        let source_hash = repository.object(document.source.as_bytes())?;
        if document.source.as_bytes() != bytes {
            let captured = parent
                .read(&parent.name, false)?
                .ok_or(fail("SOURCE_EXTERNAL_CHANGE"))?;
            if captured.0 != bytes {
                return Err(fail("SOURCE_EXTERNAL_CHANGE"));
            }
            let stage = format!(".scenesparrow-stage-{}", uuid::Uuid::new_v4());
            let staged_identity = parent.stage(&stage, document.source.as_bytes())?;
            parent.exchange(&parent.name, &stage)?;
            let displaced = parent
                .read(&stage, false)?
                .ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
            if displaced != captured {
                repository.preserve_conflict(&displaced.0)?;
                return Err(fail("SOURCE_EXTERNAL_CHANGE"));
            }
            let live = parent
                .read(&parent.name, false)?
                .ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
            if live.0 != document.source.as_bytes() || live.1 != staged_identity {
                repository.preserve_conflict(&live.0)?;
                return Err(fail("SOURCE_EXTERNAL_CHANGE"));
            }
            parent.unlink(&stage)?;
        }
        {
            let mut c = db(repository.connection.lock())?;
            let tx = db(c.transaction())?;
            let title = manifest.name.as_deref().unwrap_or("Untitled project");
            let project = initialize_project(&tx, &uuid::Uuid::new_v4().to_string(), title)
                .map_err(|_| fail("STORAGE_UNAVAILABLE"))?;
            db(tx.execute("UPDATE project SET id=?1", [&manifest.project_id]))?;
            db(tx.execute(
                "UPDATE object_identities SET id=?1 WHERE id=?2",
                params![manifest.project_id, project.id],
            ))?;
            db(tx.execute(
                "INSERT INTO authored_source VALUES(1,?1,?2,?3,0)",
                params![manifest.project_id, manifest.manuscript, source_hash],
            ))?;
            db(tx.execute(
                "INSERT INTO source_pins VALUES('adoption-original',?1)",
                [&original_hash],
            ))?;
            let blocks = source::project(&document).map_err(format_error)?;
            let mut state = repository.load(&tx)?;
            if !bytes.is_empty() {
                state.workspace_stage = ManuscriptStateWorkspaceStage::Draft;
            }
            state.blocks = blocks
                .into_iter()
                .map(|b| Block {
                    id: b.id,
                    revision: 1,
                    kind: b.kind,
                    attrs: b.attrs,
                    runs: b.runs,
                })
                .collect();
            manuscript::normalize(&mut state)?;
            for (position, block) in state.blocks.iter().enumerate() {
                let payload = repository.object(&db(serde_json::to_vec(block))?)?;
                db(tx.execute(
                    "INSERT INTO object_identities VALUES(?1,'block',1,0)",
                    [&block.id],
                ))?;
                db(tx.execute(
                    "INSERT INTO content_revisions VALUES(?1,1,?2)",
                    params![block.id, payload],
                ))?;
                db(tx.execute(
                    "INSERT INTO blocks VALUES(?1,?2,?3,1,?4)",
                    params![block.id, state.manuscript_id, position, payload],
                ))?;
            }
            let snapshot = repository.object(&db(serde_json::to_vec(&state))?)?;
            db(tx.execute(
                "UPDATE manuscripts SET snapshot_hash=?1,workspace_stage=?2",
                params![snapshot, if bytes.is_empty() { "outline" } else { "draft" }],
            ))?;
            db(tx.commit())?;
        }
        let managed = serde_json::json!({"version":1,"projectId":manifest.project_id,"state":"ready","adoptionOriginalHash":original_hash});
        let staged = management.join("managed.next.json");
        write_new(&staged, &db(serde_json::to_vec(&managed))?)?;
        db(std::fs::rename(staged, management.join("managed.json")))?;
        sync_directory(&management)?;
        repository.verify_source_state()?;
        Ok(repository)
    }
    pub fn open_format(root: &Path) -> Result<Self> {
        let manifest = match Self::inspect_format(root)? {
            ProjectInspection::Legacy => {
                return Self::open_existing(root).map_err(|_| fail("STORAGE_UNAVAILABLE"));
            }
            ProjectInspection::Managed(value) => value,
            ProjectInspection::FutureReadOnly { .. } => {
                return Err(fail("SOURCE_FUTURE_READ_ONLY"));
            }
            ProjectInspection::Unmanaged(_) => return Err(fail("SOURCE_ADOPTION_REQUIRED")),
            ProjectInspection::RecoveryRequired => return Err(fail("SOURCE_RECOVERY_REQUIRED")),
        };
        let repository =
            Self::open_managed_existing(root).map_err(|_| fail("SOURCE_RECOVERY_REQUIRED"))?;
        let c = db(repository.connection.lock())?;
        let project = read_project(&c)
            .map_err(|_| fail("STORAGE_UNAVAILABLE"))?
            .ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
        if project.id != manifest.project_id {
            return Err(fail("SOURCE_PROJECT_MISMATCH"));
        }
        drop(c);
        repository.verify_source_state()?;
        Ok(repository)
    }
    pub fn inspect_registered_format(&self) -> Result<ProjectFormatInspection> {
        Self::format_inspection(self.creative_root.as_deref().unwrap_or(&self.directory))
    }
    pub fn format_inspection(root: &Path) -> Result<ProjectFormatInspection> {
        let (status, format_version, project_id) = match Self::inspect_format(root)? {
            ProjectInspection::Legacy => (ProjectFormatInspectionStatus::Legacy, None, None),
            ProjectInspection::Unmanaged(manifest) => (
                ProjectFormatInspectionStatus::Unmanaged,
                Some(1),
                Some(manifest.project_id),
            ),
            ProjectInspection::Managed(manifest) => (
                ProjectFormatInspectionStatus::Managed,
                Some(1),
                Some(manifest.project_id),
            ),
            ProjectInspection::FutureReadOnly { format_version, .. } => (
                ProjectFormatInspectionStatus::FutureReadOnly,
                Some(format_version),
                None,
            ),
            ProjectInspection::RecoveryRequired => {
                (ProjectFormatInspectionStatus::RecoveryRequired, None, None)
            }
        };
        Ok(ProjectFormatInspection {
            status,
            format_version,
            project_id,
        })
    }
    pub fn read_source_snapshot(&self) -> Result<SourceSnapshot> {
        let c = db(self.connection.lock())?;
        self.source_snapshot_locked(&c)
    }
    pub(super) fn source_snapshot_locked(&self, c: &Connection) -> Result<SourceSnapshot> {
        let (project_id, path, accepted_hash, generation) =
            source_row(c)?.ok_or(fail("SOURCE_CAPABILITY_UNSUPPORTED"))?;
        let accepted = self.read_object(&accepted_hash)?;
        let document = source::read_source(&accepted, &[]).map_err(format_error)?;
        let root = self
            .creative_root
            .as_ref()
            .ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
        let live = Parent::open(root, &path).and_then(|parent| parent.read(&parent.name, false));
        let (external_status, external_hash) = match live {
            Ok(Some((bytes, _))) => {
                let digest = hash(&bytes);
                (
                    if digest == accepted_hash {
                        AuthoredSourceSnapshotExternalStatus::Unchanged
                    } else {
                        AuthoredSourceSnapshotExternalStatus::Changed
                    },
                    Some(digest),
                )
            }
            Ok(None) => (AuthoredSourceSnapshotExternalStatus::Missing, None),
            Err(_) => (AuthoredSourceSnapshotExternalStatus::Unavailable, None),
        };
        let semantic_block_ids = source::project(&document)
            .map_err(format_error)?
            .into_iter()
            .map(|block| block.id)
            .collect::<Vec<_>>();
        let semantic_ids = semantic_block_ids.iter().collect::<BTreeSet<_>>();
        let bindings = document
            .blocks
            .into_iter()
            .map(|block| AuthoredSourceBinding {
                semantic_editable: block
                    .id
                    .as_ref()
                    .is_some_and(|id| semantic_ids.contains(id)),
                address: block.address,
                kind: block.kind,
                start_utf8: block.start_utf8 as i64,
                end_utf8: block.end_utf8 as i64,
                list_item_address: block.list_item_address,
                id: block.id,
            })
            .collect();
        Ok(SourceSnapshot {
            project_id,
            working_revision: self.load(c)?.working_revision,
            generation,
            accepted_hash,
            source: document.source,
            semantic_block_ids,
            bindings,
            external_status,
            external_hash,
        })
    }
    pub fn save_source(&self, request: &SourceSaveRequest) -> Result<SourceSaveResponse> {
        let mut c = db(self.connection.lock())?;
        let command = ManuscriptCommand::ApplyDocumentEdit {
            request_id: request.request_id.clone(),
            project_id: request.project_id.clone(),
            expected_working_revision: request.expected_working_revision,
            payload: EditPayload {
                expected_block_revisions: vec![],
                group: request.group.clone(),
                operations: vec![],
            },
        };
        let receipt = self.execute_manuscript_source_locked(&mut c, &command, Some(request))?;
        let snapshot = self.source_snapshot_locked(&c)?;
        Ok(SourceSaveResponse { receipt, snapshot })
    }
    pub(super) fn verify_source_state(&self) -> Result<()> {
        let c = db(self.connection.lock())?;
        if self.creative_root.is_some() && source_row(&c)?.is_none() {
            return Err(fail("SOURCE_RECOVERY_REQUIRED"));
        }
        if let Some((id, path, digest, _)) = source_row(&c)? {
            let root = self
                .creative_root
                .as_ref()
                .ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
            let manifest = Parent::open(root, "project.json")?
                .read("project.json", false)?
                .ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?
                .0;
            let raw: serde_json::Value = db(serde_json::from_slice(&manifest))?;
            if raw["projectId"] != id || raw["manuscript"] != path {
                return Err(fail("SOURCE_PROJECT_MISMATCH"));
            }
            let document =
                source::read_source(&self.read_object(&digest)?, &[]).map_err(format_error)?;
            let projected = source::project(&document).map_err(format_error)?;
            let current = self.load(&c)?;
            if projected != manuscript::BusinessSnapshot::capture(&current).blocks {
                return Err(fail("SOURCE_RECOVERY_REQUIRED"));
            }
        }
        Ok(())
    }
}
fn bind_new_identities(document: &SourceDocument) -> Result<SourceDocument> {
    prepare_source_identities(document).map(|p| p.0)
}
fn prepare_source_identities(
    document: &SourceDocument,
) -> Result<(SourceDocument, Vec<(String, String)>)> {
    let bindings = document
        .blocks
        .iter()
        .filter(|block| block.id.is_none())
        .map(|block| (block.address.clone(), uuid::Uuid::new_v4().to_string()))
        .collect::<Vec<_>>();
    let prepared = source::insert_identities(document, &bindings).map_err(format_error)?;
    Ok((prepared, bindings))
}
fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = db(File::options().write(true).create_new(true).open(path))?;
    db(file.write_all(bytes))?;
    db(file.sync_all())
}
pub(crate) fn source_row(c: &Connection) -> Result<Option<(String, String, String, i64)>> {
    let version: i64 = db(c.pragma_query_value(None, "user_version", |row| row.get(0)))?;
    if version < 11 {
        return Ok(None);
    }
    db(c.query_row("SELECT project_id,relative_path,accepted_hash,generation FROM authored_source WHERE singleton=1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional())
}
impl SqliteProjectRepository {
    pub(crate) fn source_edit_transition(
        &self,
        c: &Connection,
        request: &SourceSaveRequest,
        before: &ManuscriptState,
        identities: &BTreeMap<String, i64>,
    ) -> Result<Transition> {
        if !manuscript::uuid4(&request.group.group_id)
            || !manuscript::uuid4(&request.group.client_session_id)
            || request.source.len() > manuscript::MAX_DOCUMENT_BYTES
        {
            return Err(fail("INVALID_REQUEST"));
        }
        let (_, _, accepted, generation) =
            source_row(c)?.ok_or(fail("SOURCE_CAPABILITY_UNSUPPORTED"))?;
        if request.expected_generation != generation || request.expected_hash != accepted {
            return Err(fail("SOURCE_BASE_MISMATCH"));
        }
        let previous = self.read_object(&accepted)?;
        let mut document =
            source::read_source(request.source.as_bytes(), &[]).map_err(format_error)?;
        // The core assigns new identities and proves every insertion itself.
        if !request.source.is_empty() {
            document = bind_new_identities(&document)?;
        }
        let protected = Self::user_lock_ids(c)?;
        source::read_source(
            document.source.as_bytes(),
            &protected.iter().map(String::as_str).collect::<Vec<_>>(),
        )
        .map_err(format_error)?;
        let mut target = Self::business(c, before)?;
        target.blocks = source::project(&document).map_err(format_error)?;
        target.workspace_stage = if document.source.is_empty()
            && before.workspace_stage == ManuscriptStateWorkspaceStage::Outline
        {
            ManuscriptStateWorkspaceStage::Outline
        } else {
            ManuscriptStateWorkspaceStage::Draft
        };
        let mut known = identities.clone();
        for block in &target.blocks {
            if let Some(object_type) = db(c
                .query_row(
                    "SELECT object_type FROM object_identities WHERE id=?1",
                    [&block.id],
                    |r| r.get::<_, String>(0),
                )
                .optional())?
                && object_type != "block"
            {
                return Err(fail("IDENTITY_INVALID"));
            }
            known.entry(block.id.clone()).or_insert(0);
        }
        let source_hash = self.object(document.source.as_bytes())?;
        target.source_hash = Some(source_hash.clone());
        let raw_changed = previous != document.source.as_bytes();
        let mut t = manuscript::restore(
            before,
            &target,
            &known,
            &BTreeSet::new(),
            self.policy.as_ref(),
        )?;
        t.source_hash = Some(source_hash);
        if !raw_changed {
            t.state = before.clone();
            t.affected.clear();
            return Ok(t);
        }
        let previous_document = source::read_source(&previous, &[]).map_err(format_error)?;
        let before_ids = before
            .blocks
            .iter()
            .map(|block| block.id.clone())
            .collect::<BTreeSet<_>>();
        let after_ids = t
            .state
            .blocks
            .iter()
            .map(|block| block.id.clone())
            .collect::<BTreeSet<_>>();
        let scoped = if before_ids == after_ids {
            source::known_leaf_change_scope(&previous_document, &document, &before_ids)
                .map_err(format_error)?
        } else {
            source::known_root_leaf_structural_scope(&previous_document, &document)
                .map_err(format_error)?
        };
        if before_ids != after_ids && scoped.is_some() {
            self.guard_root_source_structure(c, &before_ids, None)?;
        }
        if let Some(raw_affected) = scoped {
            t.affected.extend(raw_affected);
        } else {
            // An unproved scaffold/unknown edit can affect every protected leaf.
            t.affected.extend(
                before
                    .blocks
                    .iter()
                    .chain(t.state.blocks.iter())
                    .map(|block| block.id.clone()),
            );
            self.guard_source_tasks(c, None)?;
        }
        for block in &mut t.state.blocks {
            if t.affected.contains(&block.id) {
                block.revision = manuscript::next_revision(*known.get(&block.id).unwrap_or(&0))?;
            }
        }
        self.policy.validate(before, &t.state, &t.affected)?;
        Ok(t)
    }
    fn guard_root_source_structure(
        &self,
        c: &Connection,
        before_ids: &BTreeSet<String>,
        allowed_task: Option<&str>,
    ) -> Result<()> {
        if before_ids.is_empty() {
            return self.guard_source_tasks(c, allowed_task);
        }
        let mut query=db(c.prepare("SELECT block_id FROM review_reservations UNION SELECT d.block_id FROM downstream_dependencies d JOIN downstream_inputs i ON i.id=d.consumer_id WHERE i.status='using'"))?;
        let reserved = db(query.query_map([], |row| row.get::<_, String>(0)))?
            .map(db)
            .collect::<Result<BTreeSet<_>>>()?;
        if before_ids.is_subset(&reserved) {
            return self.guard_source_tasks(c, allowed_task);
        }
        Ok(())
    }
    fn guard_source_tasks(&self, c: &Connection, allowed_task: Option<&str>) -> Result<()> {
        let active:bool=db(c.query_row("SELECT EXISTS(SELECT 1 FROM review_reservations) OR EXISTS(SELECT 1 FROM downstream_inputs WHERE status='using') OR EXISTS(SELECT 1 FROM script_ai_tasks WHERE application='pending' AND (?1 IS NULL OR id!=?1))",[allowed_task],|r|r.get(0)))?;
        if active {
            return Err(fail("TASK_USING_CONTENT"));
        }
        Ok(())
    }
    pub(crate) fn prepare_transition_source(
        &self,
        c: &Connection,
        before: &ManuscriptState,
        t: &mut Transition,
        command: &ManuscriptCommand,
    ) -> Result<()> {
        let Some((_, _, accepted, _)) = source_row(c)? else {
            return Ok(());
        };
        let previous =
            source::read_source(&self.read_object(&accepted)?, &[]).map_err(format_error)?;
        if t.source_hash.is_none() {
            let old = manuscript::BusinessSnapshot::capture(before).blocks;
            let new = manuscript::BusinessSnapshot::capture(&t.state).blocks;
            t.source_hash = Some(if old == new {
                accepted.clone()
            } else {
                let bytes = patch_semantics(&previous, &old, &new)?;
                let candidate = source::read_source(&bytes, &[]).map_err(format_error)?;
                let known = old
                    .iter()
                    .map(|block| block.id.as_str())
                    .collect::<BTreeSet<_>>();
                let after = candidate
                    .blocks
                    .iter()
                    .filter_map(|block| block.id.as_ref().map(|id| (id.as_str(), block)))
                    .collect::<BTreeMap<_, _>>();
                for block in previous.blocks.iter().filter(|block| {
                    !previous.source.is_empty()
                        && block.id.as_deref().is_none_or(|id| !known.contains(id))
                }) {
                    let preserved = block
                        .id
                        .as_deref()
                        .and_then(|id| after.get(id))
                        .ok_or(fail("SOURCE_SEMANTIC_UNSUPPORTED"))?;
                    if block.kind != preserved.kind
                        || block.list_item_address.is_some()
                            != preserved.list_item_address.is_some()
                        || block.address.split('/').count() != preserved.address.split('/').count()
                        || previous.source[block.start_utf8..block.end_utf8]
                            != candidate.source[preserved.start_utf8..preserved.end_utf8]
                    {
                        return Err(fail("SOURCE_SEMANTIC_UNSUPPORTED"));
                    }
                }
                self.object(&bytes)?
            });
        }
        let digest = t
            .source_hash
            .as_ref()
            .ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
        let after = source::read_source(&self.read_object(digest)?, &[]).map_err(format_error)?;
        if source::project(&after).map_err(format_error)?
            != manuscript::BusinessSnapshot::capture(&t.state).blocks
        {
            return Err(fail("SOURCE_SEMANTIC_UNSUPPORTED"));
        }
        if digest != &accepted {
            let before_ids = before
                .blocks
                .iter()
                .map(|block| block.id.clone())
                .collect::<BTreeSet<_>>();
            let after_ids = t
                .state
                .blocks
                .iter()
                .map(|block| block.id.clone())
                .collect::<BTreeSet<_>>();
            let proved = if before_ids == after_ids {
                source::known_leaf_change_scope(&previous, &after, &before_ids)
                    .map_err(format_error)?
                    .is_some()
            } else {
                let proved = source::known_root_leaf_structural_scope(&previous, &after)
                    .map_err(format_error)?
                    .is_some();
                if proved {
                    self.guard_root_source_structure(
                        c,
                        &before_ids,
                        match command {
                            ManuscriptCommand::UsePlanningResult { payload, .. } => {
                                Some(payload.task_id.as_str())
                            }
                            _ => None,
                        },
                    )?;
                }
                proved
            };
            if !proved {
                self.guard_source_tasks(
                    c,
                    match command {
                        ManuscriptCommand::UsePlanningResult { payload, .. } => {
                            Some(payload.task_id.as_str())
                        }
                        _ => None,
                    },
                )?;
            }
            // Undo/Redo restores exact raw evidence. Its recorded affected IDs
            // already include the source-only conservative ownership footprint.
            if t.affected.is_empty() {
                t.affected
                    .extend(before.blocks.iter().map(|b| b.id.clone()));
            }
        }
        Ok(())
    }
    pub(crate) fn source_has_unknown(&self, c: &Connection, digest: Option<&str>) -> Result<bool> {
        let Some((_, _, accepted, _)) = source_row(c)? else {
            return Ok(false);
        };
        let doc = source::read_source(&self.read_object(digest.unwrap_or(&accepted))?, &[])
            .map_err(format_error)?;
        let projected = source::project(&doc).map_err(format_error)?;
        let known = projected
            .iter()
            .map(|block| block.id.as_str())
            .collect::<BTreeSet<_>>();
        Ok(doc
            .blocks
            .iter()
            .any(|block| block.id.as_deref().is_none_or(|id| !known.contains(id))))
    }
}
fn escape_text(text: &str) -> String {
    let mut out = String::new();
    for c in text.chars() {
        if "\\`*_{}[]<>()#+-.!|>".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}
fn render_runs(runs: &[TextRun]) -> Result<String> {
    let mut output = String::new();
    for run in runs {
        if run.text.contains('\n') || run.text.contains('\r') {
            return Err(fail("SOURCE_SEMANTIC_UNSUPPORTED"));
        }
        let code = run.marks.iter().any(|m| m.r#type == MarkType::Code);
        let mut text = if code {
            if run.text.contains('`') || run.text.starts_with(' ') || run.text.ends_with(' ') {
                return Err(fail("SOURCE_SEMANTIC_UNSUPPORTED"));
            }
            format!("`{}`", run.text)
        } else {
            escape_text(&run.text)
        };
        for mark in run.marks.iter().rev() {
            match mark.r#type {
                MarkType::Code => {}
                MarkType::Bold => text = format!("**{text}**"),
                MarkType::Italic => text = format!("*{text}*"),
                MarkType::Link => {
                    let href = mark
                        .href
                        .as_deref()
                        .ok_or(fail("SOURCE_SEMANTIC_UNSUPPORTED"))?;
                    if href.contains(['(', ')', ' ', '\n']) {
                        return Err(fail("SOURCE_SEMANTIC_UNSUPPORTED"));
                    }
                    text = format!("[{text}]({href})");
                }
            }
        }
        output.push_str(&text);
    }
    Ok(output)
}
fn render_root(block: &NewBlock) -> Result<String> {
    let text = render_runs(&block.runs)?;
    let prefix = match block.kind {
        BlockKind::Heading => format!("{} ", "#".repeat(block.attrs.level.unwrap_or(1) as usize)),
        BlockKind::Paragraph => String::new(),
        BlockKind::Listitem => return Err(fail("SOURCE_SEMANTIC_UNSUPPORTED")),
    };
    Ok(format!("{prefix}{text}"))
}
fn render_blocks(blocks: &[NewBlock]) -> Result<String> {
    let mut output = String::new();
    let mut previous_list = false;
    for block in blocks {
        let is_list = block.kind == BlockKind::Listitem;
        if !output.is_empty() {
            output.push_str(if is_list && previous_list {
                "\n"
            } else {
                "\n\n"
            });
        }
        let text = render_runs(&block.runs)?;
        if is_list {
            let depth = block.attrs.depth.unwrap_or(0);
            if !(0..=3).contains(&depth) {
                return Err(fail("SOURCE_SEMANTIC_UNSUPPORTED"));
            }
            let prefix = if block.attrs.list_kind == Some(BlockAttrsListKind::Ordered) {
                "1. "
            } else {
                "- "
            };
            // Four-column indentation accepts both ordered and bullet ancestors.
            output.push_str(&"    ".repeat(depth as usize));
            output.push_str(prefix);
            if text.is_empty() {
                output.push_str(&format!("<!-- scenesparrow:empty={} -->", block.id));
            } else {
                output.push_str(&text);
                output.push_str(&format!("<!-- scenesparrow:block={} -->", block.id));
            }
        } else if block.runs.is_empty() && block.kind == BlockKind::Paragraph {
            output.push_str(&format!("<!-- scenesparrow:empty={} -->", block.id));
        } else {
            output.push_str(&format!(
                "<!-- scenesparrow:block={} -->\n\n{}",
                block.id,
                render_root(block)?
            ));
        }
        previous_list = is_list;
    }
    if !output.is_empty() {
        output.push('\n');
    }
    Ok(output)
}
fn semantic_leaf_range(document: &SourceDocument, id: &str) -> Result<(usize, usize)> {
    if let Some(range) = source::root_leaf_range(document, id).map_err(format_error)? {
        return Ok(range);
    }
    let (start, _) = source::list_prefix_range(document, id)
        .map_err(format_error)?
        .ok_or(fail("SOURCE_SEMANTIC_UNSUPPORTED"))?;
    let block = document
        .blocks
        .iter()
        .find(|block| block.id.as_deref() == Some(id))
        .ok_or(fail("IDENTITY_MISSING"))?;
    let mut end = block.end_utf8;
    if document.source[end..].starts_with("\r\n") {
        end += 2;
    } else if document.source[end..].starts_with('\n') {
        end += 1;
    }
    Ok((start, end))
}
fn patch_semantics(
    document: &SourceDocument,
    old: &[NewBlock],
    new: &[NewBlock],
) -> Result<Vec<u8>> {
    // Initial drafts are generated from the representable canonical subset and
    // reparsed below. Populated documents always use bounded native source spans.
    let empty =
        document.source.trim().is_empty() || document.blocks.iter().all(|b| b.kind == "empty");
    if empty {
        return render_blocks(new).map(String::into_bytes);
    }
    let old_ids = old.iter().map(|b| &b.id).collect::<Vec<_>>();
    let new_ids = new.iter().map(|b| &b.id).collect::<Vec<_>>();
    if old_ids != new_ids {
        // Structural root edits use whole owned root leaves, including markers.
        // Preserve every surviving root's raw bytes; unknown leaves stay outside
        // these ranges. The final native projection proves the requested result.
        let mut prefix = 0;
        while prefix < old.len().min(new.len()) && old[prefix] == new[prefix] {
            prefix += 1;
        }
        let mut suffix = 0;
        while suffix
            < old
                .len()
                .saturating_sub(prefix)
                .min(new.len().saturating_sub(prefix))
            && old[old.len() - 1 - suffix] == new[new.len() - 1 - suffix]
        {
            suffix += 1;
        }
        let old_changed = &old[prefix..old.len() - suffix];
        let new_changed = &new[prefix..new.len() - suffix];
        let mut patches = vec![];
        for block in old_changed {
            let (start, end) = semantic_leaf_range(document, &block.id)?;
            patches.push(source::SourcePatch {
                start,
                end,
                replacement: String::new(),
            });
        }
        let insertion = if let Some(first) = patches.first() {
            first.start
        } else if let Some(next) = old.get(prefix) {
            semantic_leaf_range(document, &next.id)?.0
        } else {
            document.source.len()
        };
        let rendered = render_blocks(new_changed)?;
        if !rendered.is_empty() {
            let list_insertion = new_changed
                .iter()
                .all(|block| block.kind == BlockKind::Listitem);
            let mut replacement = String::new();
            if !list_insertion && insertion > 0 && !document.source[..insertion].ends_with("\n\n") {
                replacement.push_str("\n\n");
            }
            replacement.push_str(&rendered);
            if !list_insertion {
                replacement.push_str("\n\n");
            }
            if let Some(first) = patches.first_mut() {
                first.replacement = replacement;
            } else {
                patches.push(source::SourcePatch {
                    start: insertion,
                    end: insertion,
                    replacement,
                });
            }
        }
        return source::apply_patches(document, document.source.as_bytes(), &patches)
            .map_err(format_error);
    }
    let mut patches = vec![];
    for (old, new) in old.iter().zip(new) {
        if old == new {
            continue;
        }
        let block = document
            .blocks
            .iter()
            .find(|b| b.id.as_deref() == Some(&old.id))
            .ok_or(fail("IDENTITY_MISSING"))?;
        if !matches!(block.kind.as_str(), "paragraph" | "heading" | "empty") {
            return Err(fail("SOURCE_SEMANTIC_UNSUPPORTED"));
        }
        if old.kind != new.kind {
            return Err(fail("SOURCE_SEMANTIC_UNSUPPORTED"));
        }
        if old.runs.is_empty() != new.runs.is_empty() && old.kind != BlockKind::Heading {
            let (start, end, replacement) = if block.list_item_address.is_some() {
                let replacement = if new.runs.is_empty() {
                    format!("<!-- scenesparrow:empty={} -->", new.id)
                } else {
                    format!(
                        "{}<!-- scenesparrow:block={} -->",
                        render_runs(&new.runs)?,
                        new.id
                    )
                };
                (block.start_utf8, block.end_utf8, replacement)
            } else {
                let (start, end) = source::root_leaf_range(document, &old.id)
                    .map_err(format_error)?
                    .ok_or(fail("SOURCE_SEMANTIC_UNSUPPORTED"))?;
                let replacement = if new.runs.is_empty() {
                    format!("<!-- scenesparrow:empty={} -->", new.id)
                } else {
                    format!(
                        "<!-- scenesparrow:block={} -->\n\n{}",
                        new.id,
                        render_root(new)?
                    )
                };
                (start, end, replacement)
            };
            patches.push(source::SourcePatch {
                start,
                end,
                replacement,
            });
            continue;
        }
        if old.attrs != new.attrs && block.list_item_address.is_some() {
            let (start, end) = source::list_prefix_range(document, &old.id)
                .map_err(format_error)?
                .ok_or(fail("SOURCE_SEMANTIC_UNSUPPORTED"))?;
            let depth = new.attrs.depth.unwrap_or(0);
            let bullet = if new.attrs.list_kind == Some(BlockAttrsListKind::Ordered) {
                "1. "
            } else {
                "- "
            };
            patches.push(source::SourcePatch {
                start,
                end,
                replacement: format!("{}{bullet}", "    ".repeat(depth as usize)),
            });
        }
        let raw = &document.source[block.start_utf8..block.end_utf8];
        if raw.contains('\n') || raw.contains('\r') {
            return Err(fail("SOURCE_SEMANTIC_UNSUPPORTED"));
        }
        let marker = format!("<!-- scenesparrow:block={} -->", old.id);
        let suffix = raw.find(&marker).map(|offset| &raw[offset..]).unwrap_or("");
        let replacement = if block.list_item_address.is_some() {
            format!("{}{suffix}", render_runs(&new.runs)?)
        } else {
            format!("{}{suffix}", render_root(new)?)
        };
        patches.push(source::SourcePatch {
            start: block.start_utf8,
            end: block.end_utf8,
            replacement,
        });
    }
    source::apply_patches(document, document.source.as_bytes(), &patches).map_err(format_error)
}
impl SqliteProjectRepository {
    pub(crate) fn guard_source_application(&self, c: &Connection) -> Result<()> {
        self.guard_source_recovery()?;
        if let Some((_, path, accepted, _)) = source_row(c)? {
            let parent = Parent::open(
                self.creative_root
                    .as_ref()
                    .ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?,
                &path,
            )?;
            let live = parent.read(&parent.name, false)?;
            if live
                .as_ref()
                .is_none_or(|(bytes, _)| hash(bytes) != accepted)
            {
                return Err(fail("SOURCE_EXTERNAL_CHANGE"));
            }
        }
        Ok(())
    }
    pub(crate) fn guard_source_recovery(&self) -> Result<()> {
        if self.creative_root.is_none() {
            return Ok(());
        }
        match std::fs::symlink_metadata(self.intent_path()) {
            Ok(_) => Err(fail("SOURCE_RECOVERY_REQUIRED")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(fail("STORAGE_UNAVAILABLE")),
        }
    }
    pub(crate) fn capture_source_descriptor(
        c: &Connection,
        root: &Path,
        management: &Path,
    ) -> Result<(String, String)> {
        let manifest_bytes = Parent::open(root, "project.json")?
            .read("project.json", false)?
            .ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?
            .0;
        let marker_bytes = Parent::open(management, "managed.json")?
            .read("managed.json", false)?
            .ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?
            .0;
        let manifest = match scenesparrow_domain::open_project::inspect_project_manifest(db(
            serde_json::from_slice(&manifest_bytes),
        )?)
        .map_err(format_error)?
        {
            scenesparrow_domain::open_project::ManifestInspection::Supported(manifest) => manifest,
            _ => return Err(fail("SOURCE_FUTURE_READ_ONLY")),
        };
        let marker: serde_json::Value = db(serde_json::from_slice(&marker_bytes))?;
        let (id, path, _, _) = source_row(c)?.ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
        if manifest.project_id != id
            || manifest.manuscript != path
            || marker["projectId"] != id
            || marker["state"] != "ready"
        {
            return Err(fail("SOURCE_PROJECT_MISMATCH"));
        }
        Ok((
            db(String::from_utf8(manifest_bytes))?,
            db(String::from_utf8(marker_bytes))?,
        ))
    }
    pub(crate) fn captured_source_markdown(
        &self,
        c: &Connection,
    ) -> Result<Option<serde_json::Value>> {
        source_row(c)?.map(|(_,_,accepted,_)| {
            let raw=self.read_object(&accepted)?;
            let clean=scenesparrow_domain::source::clean_markdown(&raw).map_err(format_error)?;
            Ok(serde_json::json!({"version":2,"sourceHash":accepted,"source":db(String::from_utf8(raw))?,"cleanMarkdown":clean}))
        }).transpose()
    }
    pub(crate) fn source_body_identity(c: &Connection, semantic_hash: String) -> Result<String> {
        Ok(if let Some((_, _, accepted, _)) = source_row(c)? {
            hash(&db(serde_json::to_vec(&(semantic_hash, accepted)))?)
        } else {
            semantic_hash
        })
    }
    pub(crate) fn pin_current_source(c: &Connection, owner: &str) -> Result<()> {
        if let Some((_, _, accepted, _)) = source_row(c)? {
            db(c.execute(
                "INSERT OR IGNORE INTO source_pins VALUES(?1,?2)",
                params![owner, accepted],
            ))?;
        }
        Ok(())
    }
    pub(crate) fn source_retention_roots(&self, c: &Connection) -> Result<BTreeSet<String>> {
        let mut roots = BTreeSet::new();
        let mut query = db(c.prepare(
            if db(c.pragma_query_value::<i64,_>(None,"user_version",|r|r.get(0)))? >= 12 {
                "SELECT accepted_hash FROM authored_source UNION SELECT source_hash FROM source_pins UNION SELECT live_hash FROM source_candidates WHERE live_hash IS NOT NULL UNION SELECT base_hash FROM source_candidates"
            } else {"SELECT accepted_hash FROM authored_source UNION SELECT source_hash FROM source_pins"},
        ))?;
        for row in db(query.query_map([], |r| r.get::<_, String>(0)))? {
            roots.insert(db(row)?);
        }
        if self.creative_root.is_some() {
            let marker: serde_json::Value = db(serde_json::from_slice(&db(std::fs::read(
                self.directory.join("managed.json"),
            ))?))?;
            if let Some(hash) = marker["adoptionOriginalHash"].as_str() {
                roots.insert(hash.into());
            }
        }
        if self.intent_path().exists() {
            let bytes = self
                .read_intent_bytes()?
                .ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
            let intent: Intent = db(serde_json::from_slice(&bytes))?;
            roots.insert(hash(&bytes));
            if let Some(accepted) = intent.accepted {
                roots.insert(accepted.before_hash);
                roots.insert(accepted.after_hash);
            }
            for change in intent.changes {
                roots.extend(change.before_hash);
                roots.extend(change.after_hash);
            }
        }
        Ok(roots)
    }
    fn read_intent_bytes(&self) -> Result<Option<Vec<u8>>> {
        let parent = Parent::open(&self.directory, "source-intent.json")?;
        parent
            .read_limit(&parent.name, false, 16 * 1024 * 1024)
            .map(|p| p.map(|v| v.0))
    }
    fn intent_path(&self) -> PathBuf {
        self.directory.join("source-intent.json")
    }
    pub(crate) fn prepare_source_intent(
        &self,
        c: &Connection,
        request: &str,
        digest: &str,
        t: &Transition,
        resolution: Option<&AuthoredSourceResolveRequest>,
    ) -> Result<Option<Intent>> {
        let Some((project_id, path, accepted, generation)) = source_row(c)? else {
            return Ok(None);
        };
        if self.intent_path().exists() {
            return Err(fail("SOURCE_RECOVERY_REQUIRED"));
        }
        let after = t.source_hash.as_deref().unwrap_or(&accepted);
        if after == accepted && resolution.is_none() {
            return Ok(None);
        }
        self.source_cut("before-stage")?;
        let root = self
            .creative_root
            .as_ref()
            .ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
        let parent = Parent::open(root, &path)?;
        let live = parent.read(&parent.name, false)?;
        let bound = if let Some(request) = resolution {
            let (candidate, identity) = self.validate_source_candidate(c, request)?;
            if !matches_physical(live.as_ref(), &candidate.live_hash, &identity) {
                return Err(fail("SOURCE_CANDIDATE_STALE"));
            }
            Some(BoundResolution {
                candidate_id: candidate.id,
                base_hash: accepted.clone(),
                base_generation: generation,
                live_hash: candidate.live_hash,
                disposition: db(serde_json::to_value(&request.disposition))?
                    .as_str()
                    .ok_or(fail("INVALID_REQUEST"))?
                    .into(),
            })
        } else {
            if live
                .as_ref()
                .is_none_or(|(bytes, _)| hash(bytes) != accepted)
            {
                return Err(fail("SOURCE_EXTERNAL_CHANGE"));
            }
            None
        };
        let physical_before = live
            .as_ref()
            .map(|(bytes, _)| self.object(bytes))
            .transpose()?;
        let before_identity = live.map(|(_, identity)| identity);
        self.read_object(&accepted)?;
        let bytes = self.read_object(after)?;
        let staged_name = format!(".scenesparrow-stage-{}", uuid::Uuid::new_v4());
        let after_identity = parent.stage(&staged_name, &bytes)?;
        self.source_cut("after-stage")?;
        let intent = Intent {
            version: 2,
            graph: None,
            accepted: Some(AcceptedChange {
                before_hash: accepted.clone(),
                after_hash: after.into(),
            }),
            resolution: bound,
            request_id: request.into(),
            digest: digest.into(),
            project_id,
            expected_generation: generation,
            changes: vec![FileChange {
                relative_path: path,
                before_hash: physical_before,
                after_hash: Some(after.into()),
                before_identity,
                after_identity: Some(after_identity),
                staged_name,
            }],
        };
        let bytes = db(serde_json::to_vec(&intent))?;
        self.object(&bytes)?;
        self.source_cut("before-intent-flush")?;
        write_new(&self.intent_path(), &bytes)?;
        sync_directory(&self.directory)?;
        self.source_cut("after-intent")?;
        Ok(Some(intent))
    }
    pub(crate) fn promote_source_intent(&self, intent: &Intent) -> Result<()> {
        if intent.version == 3 {
            return self.promote_graph_intent(intent);
        }
        let root = self
            .creative_root
            .as_ref()
            .ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
        for change in &intent.changes {
            let parent = Parent::open(root, &change.relative_path)?;
            let current = parent.read(&parent.name, false)?;
            if !matches_physical(
                current.as_ref(),
                &change.before_hash,
                &change.before_identity,
            ) {
                if let Some(current) = current {
                    self.preserve_conflict(&current.0)?;
                }
                return Err(fail("SOURCE_EXTERNAL_CHANGE"));
            }
            self.source_cut("before-promotion")?;
            if change.before_hash.is_none() {
                parent.rename_no_replace(&change.staged_name, &parent.name)?;
                self.source_cut("after-promotion")?;
            } else {
                // Exchange captures any replacement after the read as evidence.
                parent.exchange(&parent.name, &change.staged_name)?;
                self.source_cut("after-promotion")?;
                let displaced = parent
                    .read(&change.staged_name, false)?
                    .ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
                if !matches_version(&displaced, &change.before_hash, &change.before_identity) {
                    self.preserve_conflict(&displaced.0)?;
                    return Err(fail("SOURCE_EXTERNAL_CHANGE"));
                }
            }
            let current = parent
                .read(&parent.name, false)?
                .ok_or(fail("SOURCE_EXTERNAL_CHANGE"))?;
            if !matches_version(&current, &change.after_hash, &change.after_identity) {
                self.preserve_conflict(&current.0)?;
                return Err(fail("SOURCE_EXTERNAL_CHANGE"));
            }
        }
        Ok(())
    }
    pub(crate) fn commit_source_intent(
        &self,
        c: &Connection,
        intent: Option<&Intent>,
        command: &ManuscriptCommand,
    ) -> Result<()> {
        if let Some(intent) = intent {
            if intent.version == 3 {
                return self.commit_graph_intent(c, intent);
            }
            let change = intent
                .changes
                .first()
                .ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
            let accepted_before = intent
                .accepted
                .as_ref()
                .map(|a| &a.before_hash)
                .or(change.before_hash.as_ref());
            let updated=db(c.execute("UPDATE authored_source SET accepted_hash=?1,generation=generation+1 WHERE singleton=1 AND generation=?2 AND accepted_hash=?3",params![intent.accepted.as_ref().map(|a| &a.after_hash).or(change.after_hash.as_ref()),intent.expected_generation,accepted_before]))?;
            if updated != 1 {
                return Err(fail("SOURCE_BASE_MISMATCH"));
            }
            if let Some(bound) = &intent.resolution {
                let updated = db(c.execute("UPDATE source_candidates SET disposition=?2 WHERE id=?1 AND disposition='pending'",params![bound.candidate_id,bound.disposition]))?;
                if updated != 1 {
                    return Err(fail("SOURCE_CANDIDATE_STALE"));
                }
            }
            db(c.execute(
                "INSERT INTO source_operations VALUES(?1,?2,?3,?4)",
                params![
                    intent.request_id,
                    intent.digest,
                    intent.expected_generation + 1,
                    hash(&db(serde_json::to_vec(intent))?)
                ],
            ))?;
        }
        if let ManuscriptCommand::StartReviewTask { request_id, .. } = command {
            Self::pin_current_source(c, request_id)?;
        }
        Ok(())
    }
    pub(crate) fn finish_source_intent(&self, intent: Option<&Intent>) -> Result<()> {
        let Some(intent) = intent else {
            return Ok(());
        };
        self.source_cut("after-sql")?;
        self.verify_intent_live(intent, true)?;
        self.source_cut("before-cleanup")?;
        self.cleanup_intent(intent)?;
        self.source_cut("after-cleanup")
    }
    fn verify_intent_live(&self, intent: &Intent, committed: bool) -> Result<()> {
        if intent.version == 3 {
            return self.verify_graph_intent_live(intent, committed);
        }
        let root = self
            .creative_root
            .as_ref()
            .ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
        for change in &intent.changes {
            let parent = Parent::open(root, &change.relative_path)?;
            let live = parent.read(&parent.name, false)?;
            let (digest, identity) = if committed {
                (&change.after_hash, &change.after_identity)
            } else {
                (&change.before_hash, &change.before_identity)
            };
            if !matches_physical(live.as_ref(), digest, identity) {
                if let Some(live) = live {
                    self.preserve_conflict(&live.0)?;
                }
                return Err(fail("SOURCE_EXTERNAL_CHANGE"));
            }
        }
        Ok(())
    }
    fn cleanup_intent(&self, intent: &Intent) -> Result<()> {
        if intent.version == 3 {
            return self.cleanup_graph_intent(intent);
        }
        let root = self
            .creative_root
            .as_ref()
            .ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
        for change in &intent.changes {
            let parent = Parent::open(root, &change.relative_path)?;
            if let Some(staged) = parent.read(&change.staged_name, false)? {
                if !matches_version(&staged, &change.before_hash, &change.before_identity)
                    && !matches_version(&staged, &change.after_hash, &change.after_identity)
                {
                    self.preserve_conflict(&staged.0)?;
                    return Err(fail("SOURCE_EXTERNAL_CHANGE"));
                }
                parent.unlink(&change.staged_name)?;
            }
        }
        db(std::fs::remove_file(self.intent_path()))?;
        sync_directory(&self.directory)
    }
    fn preserve_conflict(&self, bytes: &[u8]) -> Result<()> {
        // Conflict evidence is management-owned, outside cache and collector.
        let path = self.directory.join("conflicts");
        if !path.exists() {
            db(std::fs::create_dir(&path))?;
        }
        plain_directory(&path)?;
        let artifact = path.join(hash(bytes));
        if !artifact.exists() {
            write_new(&artifact, bytes)?;
            sync_directory(&path)?;
            sync_directory(&self.directory)?;
        }
        Ok(())
    }
    pub(crate) fn recover_source_intents(&self) -> Result<()> {
        let c = db(self.connection.lock())?;
        self.recover_source_intents_locked(&c)
    }
    fn recover_source_intents_locked(&self, c: &Connection) -> Result<()> {
        if !self.intent_path().exists() {
            return Ok(());
        }
        let bytes = self
            .read_intent_bytes()?
            .ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
        let intent: Intent = db(serde_json::from_slice(&bytes))?;
        if intent.version == 3 {
            return self.recover_graph_intent(c, &intent, &bytes);
        }
        if !matches!(intent.version, 1 | 2)
            || intent.changes.is_empty()
            || (intent.version == 1 && (intent.accepted.is_some() || intent.resolution.is_some()))
            || (intent.version == 2 && intent.accepted.is_none())
        {
            return Err(fail("SOURCE_RECOVERY_REQUIRED"));
        }
        let committed = self.validate_source_intent_metadata(c, &intent, &bytes)?;
        if self.finish_preserved_source_intent(c, &intent, &bytes)? {
            return Ok(());
        }
        let root = self
            .creative_root
            .as_ref()
            .ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
        for change in &intent.changes {
            // Validate every immutable generation before any live recovery.
            for digest in [&change.before_hash, &change.after_hash]
                .into_iter()
                .flatten()
            {
                self.read_object(digest)?;
            }
            let parent = Parent::open(root, &change.relative_path)?;
            let live = parent.read(&parent.name, false)?;
            let before =
                matches_physical(live.as_ref(), &change.before_hash, &change.before_identity);
            let after = matches_physical(live.as_ref(), &change.after_hash, &change.after_identity);
            if !before && !after {
                if let Some(live) = live {
                    self.preserve_conflict(&live.0)?;
                }
                return Err(fail("SOURCE_EXTERNAL_CHANGE"));
            }
            if committed && !after || !committed && !before {
                if change.before_hash.is_none() && !committed {
                    // Move known after bytes aside without unlinking a path that an
                    // external editor may replace between validation and mutation.
                    parent.rename_no_replace(&parent.name, &change.staged_name)?;
                    let moved = parent
                        .read(&change.staged_name, false)?
                        .ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
                    if !matches_version(&moved, &change.after_hash, &change.after_identity) {
                        self.preserve_conflict(&moved.0)?;
                        let _ = parent.rename_no_replace(&change.staged_name, &parent.name);
                        return Err(fail("SOURCE_EXTERNAL_CHANGE"));
                    }
                } else {
                    let staged = parent
                        .read(&change.staged_name, false)?
                        .ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
                    let valid = if committed {
                        matches_version(&staged, &change.after_hash, &change.after_identity)
                    } else {
                        matches_version(&staged, &change.before_hash, &change.before_identity)
                    };
                    if !valid {
                        self.preserve_conflict(&staged.0)?;
                        return Err(fail("SOURCE_EXTERNAL_CHANGE"));
                    }
                    if change.before_hash.is_none() {
                        parent.rename_no_replace(&change.staged_name, &parent.name)?;
                    } else {
                        parent.exchange(&parent.name, &change.staged_name)?;
                    }
                }
            }
        }
        self.verify_intent_live(&intent, committed)?;
        self.cleanup_intent(&intent)
    }
    fn validate_source_intent_metadata(
        &self,
        c: &Connection,
        intent: &Intent,
        bytes: &[u8],
    ) -> Result<bool> {
        if !matches!(intent.version, 1 | 2)
            || intent.changes.is_empty()
            || (intent.version == 1 && (intent.accepted.is_some() || intent.resolution.is_some()))
            || (intent.version == 2 && intent.accepted.is_none())
        {
            return Err(fail("SOURCE_RECOVERY_REQUIRED"));
        }
        let project = read_project(c)
            .map_err(|_| fail("SOURCE_RECOVERY_REQUIRED"))?
            .ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
        if project.id != intent.project_id {
            return Err(fail("SOURCE_PROJECT_MISMATCH"));
        }
        let operation: Option<(String, i64, String)> = db(c
            .query_row(
                "SELECT digest,generation,intent_hash FROM source_operations WHERE request_id=?1",
                [&intent.request_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional())?;
        let committed = if let Some((digest, generation, intent_hash)) = operation {
            if digest != intent.digest
                || generation != intent.expected_generation + 1
                || intent_hash != hash(bytes)
            {
                return Err(fail("SOURCE_RECOVERY_REQUIRED"));
            }
            let receipt =
                Self::outcome(c, &intent.request_id)?.ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
            if receipt.0 != digest {
                return Err(fail("SOURCE_RECOVERY_REQUIRED"));
            }
            true
        } else {
            false
        };
        let (source_project, source_path, accepted, generation) =
            source_row(c)?.ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
        if source_project != intent.project_id
            || generation != intent.expected_generation + if committed { 1 } else { 0 }
            || intent.changes.len() != 1
            || !manuscript::uuid4(&intent.request_id)
        {
            return Err(fail("SOURCE_RECOVERY_REQUIRED"));
        }
        for change in &intent.changes {
            let expected = if let Some(accepted) = &intent.accepted {
                Some(if committed {
                    accepted.after_hash.as_str()
                } else {
                    accepted.before_hash.as_str()
                })
            } else if committed {
                change.after_hash.as_deref()
            } else {
                change.before_hash.as_deref()
            };
            if change.relative_path != source_path
                || expected != Some(accepted.as_str())
                || !change
                    .staged_name
                    .strip_prefix(".scenesparrow-stage-")
                    .is_some_and(manuscript::uuid4)
            {
                return Err(fail("SOURCE_RECOVERY_REQUIRED"));
            }
        }
        if let Some(accepted) = &intent.accepted {
            self.read_object(&accepted.before_hash)?;
            self.read_object(&accepted.after_hash)?;
            let change = &intent.changes[0];
            if change.after_hash.as_ref() != Some(&accepted.after_hash) {
                return Err(fail("SOURCE_RECOVERY_REQUIRED"));
            }
            if let Some(bound) = &intent.resolution {
                let (candidate, identity) = self.source_candidate_locked(c, &bound.candidate_id)?;
                let disposition = db(serde_json::to_value(candidate.disposition))?;
                if candidate.project_id != intent.project_id
                    || candidate.base_hash != bound.base_hash
                    || candidate.base_generation != bound.base_generation
                    || candidate.live_hash != bound.live_hash
                    || bound.base_hash != accepted.before_hash
                    || bound.base_generation != intent.expected_generation
                    || change.before_hash != bound.live_hash
                    || change.before_identity != identity
                    || disposition.as_str()
                        != Some(if committed {
                            bound.disposition.as_str()
                        } else {
                            "pending"
                        })
                {
                    return Err(fail("SOURCE_RECOVERY_REQUIRED"));
                }
            } else if change.before_hash.as_ref() != Some(&accepted.before_hash) {
                return Err(fail("SOURCE_RECOVERY_REQUIRED"));
            }
        }
        Ok(committed)
    }
    pub(crate) fn source_cut(&self, point: &str) -> Result<()> {
        #[cfg(test)]
        {
            let mut action = db(self.source_action.lock())?;
            if action.as_ref().is_some_and(|(at, _)| at == point) {
                let (_, action) = action.take().expect("checked action");
                action();
            }
            let mut fault = db(self.source_fault.lock())?;
            if fault.as_deref() == Some(point) {
                *fault = None;
                return Err(fail("STORAGE_UNAVAILABLE"));
            }
        }
        let _ = point;
        Ok(())
    }
}
fn matches_version(
    file: &(Vec<u8>, Identity),
    digest: &Option<String>,
    identity: &Option<Identity>,
) -> bool {
    digest.as_ref().is_some_and(|h| hash(&file.0) == *h) && identity.as_ref() == Some(&file.1)
}

pub(crate) fn application_source_conflict(code: &str) -> bool {
    matches!(
        code,
        "SOURCE_RECOVERY_REQUIRED"
            | "SOURCE_EXTERNAL_CHANGE"
            | "SOURCE_CANDIDATE_STALE"
            | "SOURCE_RECOVERY_STALE"
            | "SOURCE_PATH_UNSAFE"
            | "SOURCE_READ_UNAVAILABLE"
            | "SOURCE_CAPABILITY_UNSUPPORTED"
    )
}
fn matches_physical(
    file: Option<&(Vec<u8>, Identity)>,
    digest: &Option<String>,
    identity: &Option<Identity>,
) -> bool {
    match file {
        Some(file) => matches_version(file, digest, identity),
        None => digest.is_none() && identity.is_none(),
    }
}

#[cfg(test)]
mod tests;
