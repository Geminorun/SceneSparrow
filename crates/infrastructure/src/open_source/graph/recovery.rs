use super::journal::physical_known;
use super::*;
#[derive(Debug, Clone, serde::Serialize)]
pub struct GraphRecoveryMember {
    pub path: String,
    pub role: String,
    pub hash: String,
    pub size: u64,
}
impl SqliteProjectRepository {
    fn validate_graph_intent_metadata(
        &self,
        c: &Connection,
        intent: &Intent,
        bytes: &[u8],
    ) -> Result<bool> {
        let graph = intent
            .graph
            .as_ref()
            .ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
        if graph.generation < 0
            || graph.generation >= manuscript::MAX_REVISION
            || intent.expected_generation < 0
            || intent.expected_generation >= manuscript::MAX_REVISION
        {
            return Err(fail("SOURCE_RECOVERY_REQUIRED"));
        }
        if intent.version != 3 || intent.changes.is_empty() || intent.accepted.is_none() {
            return Err(fail("SOURCE_RECOVERY_REQUIRED"));
        }
        let before = self.read_file_graph(&graph.before_hash)?;
        let after = self.read_file_graph(&graph.after_hash)?;
        let physical = if let Some(observation) = &graph.observation {
            if observation.base_hash != graph.before_hash
                || observation.generation != graph.generation
            {
                return Err(fail("SOURCE_RECOVERY_REQUIRED"));
            }
            self.read_file_graph(&observation.graph_hash)?
        } else {
            before.clone()
        };

        self.validate_graph(c, &before)?;
        self.validate_graph(c, &after)?;
        if let Some(scope) = &graph.checked_paths {
            let mut expected = self
                .scoped_graph_paths(c, &before, &after)?
                .ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
            if intent.resolution.is_some() {
                expected.push(source_row(c)?.ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?.1);
                expected.sort();
                expected.dedup();
            }
            if scope.is_empty()
                || scope != &expected
                || physical.files.iter().any(|f| !scope.contains(&f.path))
            {
                return Err(fail("SOURCE_RECOVERY_REQUIRED"));
            }
            if intent
                .changes
                .iter()
                .map(|c| c.relative_path.clone())
                .collect::<Vec<_>>()
                != *scope
            {
                return Err(fail("SOURCE_RECOVERY_REQUIRED"));
            }
        }

        for member in before
            .files
            .iter()
            .chain(&after.files)
            .chain(&physical.files)
        {
            if graph
                .checked_paths
                .as_ref()
                .is_some_and(|paths| !paths.contains(&member.path))
            {
                continue;
            }
            if self.verify_object_stream(&member.hash)? != member.size {
                return Err(fail("GRAPH_INVALID"));
            }
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
                || Self::outcome(c, &intent.request_id)?
                    .is_none_or(|p| p.0 != digest || Self::decode(&p.1).is_err())
            {
                return Err(fail("SOURCE_RECOVERY_REQUIRED"));
            }
            true
        } else {
            false
        };
        let row = graph_row(c)?.ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
        let (id, path, source, generation) =
            source_row(c)?.ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
        let accepted = intent
            .accepted
            .as_ref()
            .ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
        let expected = if committed {
            &graph.after_hash
        } else {
            &graph.before_hash
        };
        let expected_source = if committed {
            &accepted.after_hash
        } else {
            &accepted.before_hash
        };
        if id != intent.project_id
            || row.0 != *expected
            || row.1 != graph.generation + i64::from(committed)
            || generation != intent.expected_generation + i64::from(committed)
            || source != *expected_source
            || before.file(&path)?.hash != accepted.before_hash
            || after.file(&path)?.hash != accepted.after_hash
        {
            return Err(fail("SOURCE_RECOVERY_REQUIRED"));
        }
        if committed && self.load(c)?.working_revision != graph.expected_revision {
            return Err(fail("SOURCE_RECOVERY_REQUIRED"));
        }
        let old = physical.index();
        let new = after.index();
        let accepted_before = before.index();
        let mut paths = BTreeSet::new();
        for change in &intent.changes {
            if !paths.insert(change.relative_path.as_str())
                || !change
                    .staged_name
                    .strip_prefix(".scenesparrow-stage-")
                    .is_some_and(manuscript::uuid4)
            {
                return Err(fail("SOURCE_RECOVERY_REQUIRED"));
            }
            if change.before_hash.is_some() != change.before_identity.is_some()
                || change.after_hash.is_some() != change.after_identity.is_some()
            {
                return Err(fail("SOURCE_RECOVERY_REQUIRED"));
            }
            let old_hash = old
                .get(change.relative_path.as_str())
                .map(|f| f.hash.as_str());
            let new_hash = new
                .get(change.relative_path.as_str())
                .map(|f| f.hash.as_str());
            let physical = if change.relative_path == path {
                intent
                    .resolution
                    .as_ref()
                    .map(|r| r.live_hash.as_deref())
                    .unwrap_or(old_hash)
            } else {
                old_hash
            };
            if change.before_hash.as_deref() != physical || change.after_hash.as_deref() != new_hash
            {
                return Err(fail("SOURCE_RECOVERY_REQUIRED"));
            }
        }
        for path in old.keys().chain(new.keys()).chain(accepted_before.keys()) {
            let physical_checked = graph
                .checked_paths
                .as_ref()
                .is_none_or(|scope| scope.iter().any(|p| p == *path));
            if ((physical_checked && old.get(path) != new.get(path))
                || accepted_before.get(path) != new.get(path))
                && !paths.contains(path)
            {
                return Err(fail("SOURCE_RECOVERY_REQUIRED"));
            }
        }
        if let Some(bound) = &intent.resolution {
            let (candidate, identity) = self.source_candidate_locked(c, &bound.candidate_id)?;
            let disposition = db(serde_json::to_value(candidate.disposition))?;
            let change = intent
                .changes
                .iter()
                .find(|c| c.relative_path == path)
                .ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
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
        }
        Ok(committed)
    }
    pub(crate) fn recover_graph_intent(
        &self,
        c: &Connection,
        intent: &Intent,
        bytes: &[u8],
    ) -> Result<()> {
        let committed = self.validate_graph_intent_metadata(c, intent, bytes)?;
        if self.finish_preserved_graph_intent(c, intent, bytes)? {
            return Ok(());
        }
        self.validate_graph_physical_states(intent)?;
        let root = self
            .creative_root
            .as_ref()
            .ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
        // Prove every required member exists before touching the first file.
        for change in &intent.changes {
            let parent = Parent::open(root, &change.relative_path)?;
            let live = parent.streamed(&parent.name, GraphBudgets::default().per_file)?;
            if physical_known(live.as_ref(), change, committed) {
                continue;
            }
            let stage = parent.streamed(&change.staged_name, GraphBudgets::default().per_file)?;
            let desired = if committed {
                &change.after_hash
            } else {
                &change.before_hash
            };
            if desired.is_some() && !physical_known(stage.as_ref(), change, committed) {
                return Err(fail("SOURCE_RECOVERY_REQUIRED"));
            }
            if desired.is_none() && stage.is_some() {
                return Err(fail("SOURCE_RECOVERY_REQUIRED"));
            }
        }
        for change in &intent.changes {
            let parent = Parent::open(root, &change.relative_path)?;
            let live = parent.streamed(&parent.name, GraphBudgets::default().per_file)?;
            if physical_known(live.as_ref(), change, committed) {
                continue;
            }
            let desired = if committed {
                &change.after_hash
            } else {
                &change.before_hash
            };
            if desired.is_none() {
                parent.rename_no_replace(&parent.name, &change.staged_name)?;
            } else if live.is_none() {
                parent.rename_no_replace(&change.staged_name, &parent.name)?;
            } else {
                parent.exchange(&parent.name, &change.staged_name)?;
            }
            // Exchange may capture an editor race; preserve and fence before proceeding.
            self.validate_graph_physical_states(intent)?;
        }
        self.verify_graph_intent_live(intent, committed)?;
        self.cleanup_graph_intent(intent)
    }
    /// Captures all path identities, including absence, for a fresh explicit decision.
    pub fn graph_recovery_fingerprint(&self, intent_hash: &str) -> Result<String> {
        let _c = db(self.connection.lock())?;
        let bytes = self
            .read_intent_bytes()?
            .ok_or(fail("SOURCE_RECOVERY_STALE"))?;
        if hash(&bytes) != intent_hash {
            return Err(fail("SOURCE_RECOVERY_STALE"));
        }
        let intent: Intent = db(serde_json::from_slice(&bytes))?;
        self.graph_intent_fingerprint(&intent)
    }
    fn graph_intent_fingerprint(&self, intent: &Intent) -> Result<String> {
        let root = self
            .creative_root
            .as_ref()
            .ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
        let scope = intent
            .graph
            .as_ref()
            .ok_or(fail("GRAPH_INVALID"))?
            .checked_paths
            .as_ref();
        let (live, identities) = if let Some(paths) = scope {
            self.scan_graph_paths(root, &intent.project_id, paths)?
        } else {
            self.scan_graph_locked(
                root,
                false,
                GraphBudgets::default(),
                Some(&intent.project_id),
            )?
        };
        let mut observed = vec![];
        for change in &intent.changes {
            let parent = Parent::open(root, &change.relative_path)?;
            observed.push((
                &change.relative_path,
                parent.streamed(&parent.name, GraphBudgets::default().per_file)?,
                parent.streamed(&change.staged_name, GraphBudgets::default().per_file)?,
            ));
        }
        Ok(hash(&db(serde_json::to_vec(&(
            live, identities, observed,
        )))?))
    }
    pub(crate) fn preserve_graph_recovery(
        &self,
        c: &mut Connection,
        r: &AuthoredSourceRecoverRequest,
        intent: &Intent,
        bytes: &[u8],
        digest: &str,
    ) -> Result<()> {
        let committed = self.validate_graph_intent_metadata(c, intent, bytes)?;
        let observed = self.graph_intent_fingerprint(intent)?;
        if r.observation_fingerprint.as_deref() != Some(&observed) {
            return Err(fail("SOURCE_RECOVERY_STALE"));
        }
        let root = self
            .creative_root
            .as_ref()
            .ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
        let graph = intent.graph.as_ref().ok_or(fail("GRAPH_INVALID"))?;
        let mut evidence = vec![];
        for (role, hash) in [
            ("acceptedBefore", &graph.before_hash),
            ("acceptedAfter", &graph.after_hash),
        ] {
            for file in self.read_file_graph(hash)?.files.into_iter().filter(|f| {
                graph
                    .checked_paths
                    .as_ref()
                    .is_none_or(|scope| scope.contains(&f.path))
            }) {
                evidence.push(GraphRecoveryMember {
                    path: file.path,
                    role: role.into(),
                    hash: file.hash,
                    size: file.size,
                });
            }
        }
        let (live, _) = if let Some(paths) = &graph.checked_paths {
            self.scan_graph_paths(root, &intent.project_id, paths)?
        } else {
            self.scan_graph_locked(
                root,
                false,
                GraphBudgets::default(),
                Some(&intent.project_id),
            )?
        };
        for file in live.files {
            evidence.push(GraphRecoveryMember {
                path: file.path,
                role: "live".into(),
                hash: file.hash,
                size: file.size,
            });
        }
        if let Some(observation) = &graph.observation {
            for file in self.read_file_graph(&observation.graph_hash)?.files {
                evidence.push(GraphRecoveryMember {
                    path: file.path,
                    role: "physicalBefore".into(),
                    hash: file.hash,
                    size: file.size,
                });
            }
        }
        for change in &intent.changes {
            for (role, hash) in [
                ("physicalBefore", &change.before_hash),
                ("physicalAfter", &change.after_hash),
            ] {
                if let Some(hash) = hash {
                    evidence.push(GraphRecoveryMember {
                        path: change.relative_path.clone(),
                        role: role.into(),
                        hash: hash.clone(),
                        size: self.verify_object_stream(hash)?,
                    });
                }
            }
            let parent = Parent::open(root, &change.relative_path)?;
            for (role, name) in [("live", &parent.name), ("staged", &change.staged_name)] {
                if let Some((mut file, id)) = parent.open_file(name)? {
                    let (hash, size) =
                        self.object_stream(&mut file, GraphBudgets::default().per_file)?;
                    if parent.streamed(name, GraphBudgets::default().per_file)?
                        != Some((hash.clone(), size, id))
                    {
                        return Err(fail("SOURCE_RECOVERY_STALE"));
                    }
                    evidence.push(GraphRecoveryMember {
                        path: change.relative_path.clone(),
                        role: role.into(),
                        hash,
                        size,
                    });
                }
            }
        }
        self.object(bytes)?;
        self.source_cut("before-recovery-decision")?;
        if self.graph_intent_fingerprint(intent)? != observed {
            return Err(fail("SOURCE_RECOVERY_STALE"));
        }
        let row = graph_row(c)?.ok_or(fail("GRAPH_INVALID"))?;
        let tx = db(c.transaction())?;
        if !committed {
            if let Some((saved, outcome)) = Self::outcome(&tx, &intent.request_id)? {
                if saved != intent.digest || Self::decode(&outcome).is_ok() {
                    return Err(fail("SOURCE_RECOVERY_REQUIRED"));
                }
            } else {
                db(tx.execute(
                    "INSERT INTO command_receipts VALUES(?1,?2,?3)",
                    params![
                        intent.request_id,
                        intent.digest,
                        serde_json::json!({"error":"SOURCE_EXTERNAL_CHANGE"}).to_string()
                    ],
                ))?;
            }
        }
        let intent_hash = hash(bytes);
        db(tx.execute(
            "INSERT INTO graph_recovery_decisions VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            params![
                intent_hash,
                intent.request_id,
                intent.digest,
                digest,
                row.0,
                row.1,
                committed,
                observed
            ],
        ))?;
        for member in evidence {
            db(tx.execute(
                "INSERT OR IGNORE INTO graph_recovery_members VALUES(?1,?2,?3,?4,?5)",
                params![
                    intent_hash,
                    member.path,
                    member.role,
                    member.hash,
                    member.size
                ],
            ))?;
        }
        for (suffix, hash) in [("before", &graph.before_hash), ("after", &graph.after_hash)] {
            db(tx.execute(
                "INSERT INTO file_graph_pins(owner_id,graph_hash) VALUES(?1,?2)",
                params![format!("recovery:{intent_hash}:{suffix}"), hash],
            ))?;
        }
        db(tx.execute(
            "INSERT OR IGNORE INTO source_pins VALUES(?1,?2)",
            params![format!("recovery:{intent_hash}:intent"), intent_hash],
        ))?;
        db(tx.commit())?;
        self.source_cut("after-recovery-decision")?;
        self.finish_preserved_graph_intent(c, intent, bytes)?;
        self.source_cut("after-recovery-cleanup")
    }
    fn finish_preserved_graph_intent(
        &self,
        c: &Connection,
        intent: &Intent,
        bytes: &[u8],
    ) -> Result<bool> {
        let decision:Option<(String,String,String,i64)>=db(c.query_row("SELECT request_id,digest,graph_hash,generation FROM graph_recovery_decisions WHERE intent_hash=?1",[hash(bytes)],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional())?;
        let Some((request, digest, hash, generation)) = decision else {
            return Ok(false);
        };
        if request != intent.request_id
            || digest != intent.digest
            || graph_row(c)? != Some((hash, generation))
            || Self::outcome(c, &request)?.is_none_or(|p| p.0 != digest)
        {
            return Err(fail("SOURCE_RECOVERY_REQUIRED"));
        }
        db(std::fs::remove_file(self.intent_path()))?;
        sync_directory(&self.directory)?;
        Ok(true)
    }
    /// B paginates these records and streams by operation/member identity.
    pub fn graph_recovery_members(
        &self,
        intent_hash: &str,
        offset: u32,
        limit: u32,
    ) -> Result<Vec<GraphRecoveryMember>> {
        let c = db(self.connection.lock())?;
        let mut query=db(c.prepare("SELECT relative_path,role,object_hash,byte_size FROM graph_recovery_members WHERE intent_hash=?1 ORDER BY relative_path,role,object_hash LIMIT ?2 OFFSET ?3"))?;
        db(
            query.query_map(params![intent_hash, limit.min(200), offset], |r| {
                Ok(GraphRecoveryMember {
                    path: r.get(0)?,
                    role: r.get(1)?,
                    hash: r.get(2)?,
                    size: r.get(3)?,
                })
            }),
        )?
        .map(db)
        .collect()
    }
    /// Authorizes the full listed member identity, including its retained version.
    pub fn stream_graph_recovery_member(
        &self,
        intent_hash: &str,
        path: &str,
        role: &str,
        expected_hash: &str,
        output: &mut impl std::io::Write,
    ) -> Result<u64> {
        let c = db(self.connection.lock())?;
        let member:Option<(String,u64)>=db(c.query_row("SELECT object_hash,byte_size FROM graph_recovery_members WHERE intent_hash=?1 AND relative_path=?2 AND role=?3 AND object_hash=?4",params![intent_hash,path,role,expected_hash],|r|Ok((r.get(0)?,r.get(1)?))).optional())?;
        let (hash, size) = member.ok_or(fail("OBJECT_NOT_FOUND"))?;
        if self.stream_object_to(&hash, output)? != size {
            return Err(fail("GRAPH_INVALID"));
        }
        Ok(size)
    }
}
