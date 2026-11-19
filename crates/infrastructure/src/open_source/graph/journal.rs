use super::*;
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct GraphIntent {
    pub before_hash: String,
    pub after_hash: String,
    pub generation: i64,
    pub expected_revision: i64,
    pub rename: Option<(String, String)>,
    pub observation: Option<GraphObservation>,
    pub checked_paths: Option<Vec<String>>,
}
fn known(
    file: Option<&(String, u64, Identity)>,
    hash: &Option<String>,
    identity: &Option<Identity>,
) -> bool {
    match file {
        Some((h, _, id)) => hash.as_ref() == Some(h) && identity.as_ref() == Some(id),
        None => hash.is_none() && identity.is_none(),
    }
}
pub(super) fn physical_known(
    file: Option<&(String, u64, Identity)>,
    change: &FileChange,
    after: bool,
) -> bool {
    if after {
        known(file, &change.after_hash, &change.after_identity)
    } else {
        known(file, &change.before_hash, &change.before_identity)
    }
}
impl SqliteProjectRepository {
    pub(crate) fn prepare_graph_intent(
        &self,
        c: &Connection,
        request: &str,
        digest: &str,
        t: &Transition,
        update: &GraphUpdate,
        resolution: Option<&AuthoredSourceResolveRequest>,
    ) -> Result<Option<Intent>> {
        if update.before.hash == update.after_hash
            && resolution.is_none()
            && !update.validate_physical
            && update.observation.is_none()
        {
            return Ok(None);
        }
        self.guard_source_recovery()?;
        let (project_id, source, accepted, generation) =
            source_row(c)?.ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
        let root = self
            .creative_root
            .as_ref()
            .ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
        let mut checked_paths = update.checked_paths.clone();
        if resolution.is_some()
            && let Some(paths) = &mut checked_paths
        {
            paths.push(source.clone());
            paths.sort();
            paths.dedup();
        }
        let physical = if let Some(observation) = &update.observation {
            if observation.base_hash != update.before.hash
                || observation.generation != update.before.generation
            {
                return Err(fail("GRAPH_OBSERVATION_STALE"));
            }
            self.revalidate_graph_observation(observation)?
        } else {
            let mut graph = update.before.graph.clone();
            if let Some(paths) = &checked_paths {
                graph.files.retain(|f| paths.contains(&f.path));
            }
            graph
        };
        Self::guard_graph_topology(&physical, &update.after)?;
        if checked_paths.is_none() {
            self.guard_graph_production(c, &physical, &update.after)?;
        }

        let bound = if let Some(request) = resolution {
            let (candidate, _) = self.validate_source_candidate(c, request)?;
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
            None
        };
        manuscript::next_revision(update.before.generation)?;
        manuscript::next_revision(generation)?;
        let observation = if let Some(observation) = &update.observation {
            observation.clone()
        } else {
            let mut expected = physical.clone();
            if let Some(bound) = &bound {
                expected.files.retain(|f| f.path != source);
                if let Some(hash) = &bound.live_hash {
                    expected.files.push(GraphFile {
                        path: source.clone(),
                        hash: hash.clone(),
                        size: self.verify_object_stream(hash)?,
                    });
                    expected.files.sort_by(|a, b| a.path.cmp(&b.path));
                }
            }
            let (actual, identities) = if let Some(paths) = &checked_paths {
                self.scan_graph_paths(root, &physical.project_id, paths)?
            } else {
                self.scan_graph_locked(
                    root,
                    false,
                    GraphBudgets::default(),
                    Some(&physical.project_id),
                )?
            };
            if actual != expected {
                return Err(fail("SOURCE_EXTERNAL_CHANGE"));
            }
            GraphObservation {
                base_hash: update.before.hash.clone(),
                generation: update.before.generation,
                graph_hash: self.object(&db(serde_json::to_vec(&actual))?)?,
                identities,
            }
        };
        // Revalidate the complete accepted base. Observation never becomes authority.
        for file in &physical.files {
            let parent = Parent::open(root, &file.path)?;
            let actual = parent.streamed(&parent.name, GraphBudgets::default().per_file)?;
            let expected = if file.path == source {
                bound
                    .as_ref()
                    .map(|b| b.live_hash.as_deref())
                    .unwrap_or(Some(file.hash.as_str()))
            } else {
                Some(file.hash.as_str())
            };
            if actual.as_ref().map(|p| p.0.as_str()) != expected {
                return Err(fail("SOURCE_EXTERNAL_CHANGE"));
            }
        }
        // Verify every after member before writing any durable intention.
        for file in update.after.files.iter().filter(|f| {
            checked_paths
                .as_ref()
                .is_none_or(|paths| paths.contains(&f.path))
        }) {
            if self.verify_object_stream(&file.hash)? != file.size {
                return Err(fail("GRAPH_INVALID"));
            }
        }
        if update.before.hash == update.after_hash
            && resolution.is_none()
            && physical.files
                == update
                    .after
                    .files
                    .iter()
                    .filter(|f| checked_paths.as_ref().is_none_or(|p| p.contains(&f.path)))
                    .cloned()
                    .collect::<Vec<_>>()
        {
            return Ok(None);
        }
        let paths = physical
            .files
            .iter()
            .chain(&update.after.files)
            .chain(&update.before.graph.files)
            .map(|f| f.path.clone())
            .collect::<BTreeSet<_>>();
        let old = physical.index();
        let new = update.after.index();
        let accepted_before = update.before.graph.index();
        let mut changes = vec![];
        for path in paths
            .into_iter()
            .filter(|p| checked_paths.as_ref().is_none_or(|scope| scope.contains(p)))
        {
            let before = old.get(path.as_str()).copied();
            let after = new.get(path.as_str()).copied();
            if before == after
                && !(path == source && resolution.is_some())
                && accepted_before.get(path.as_str()).copied() == after
            {
                continue;
            }
            self.source_cut("before-stage")?;
            let parent = Parent::open_creating(root, &path)?;
            let live = parent.streamed(&parent.name, GraphBudgets::default().per_file)?;
            let expected = if path == source {
                bound
                    .as_ref()
                    .map(|b| b.live_hash.as_deref())
                    .unwrap_or(before.map(|f| f.hash.as_str()))
            } else {
                before.map(|f| f.hash.as_str())
            };
            if live.as_ref().map(|p| p.0.as_str()) != expected {
                return Err(fail("SOURCE_EXTERNAL_CHANGE"));
            }
            let (before_hash, before_identity) = live
                .as_ref()
                .map(|p| (Some(p.0.clone()), Some(p.2.clone())))
                .unwrap_or((None, None));
            if let Some(hash) = &before_hash
                && self.verify_object_stream(hash).is_err()
            {
                let (mut input, _) = parent
                    .open_file(&parent.name)?
                    .ok_or(fail("SOURCE_EXTERNAL_CHANGE"))?;
                let captured = self.object_stream(&mut input, GraphBudgets::default().per_file)?;
                if captured.0 != *hash {
                    return Err(fail("SOURCE_EXTERNAL_CHANGE"));
                }
            }
            let staged_name = format!(".scenesparrow-stage-{}", uuid::Uuid::new_v4());
            let after_identity = after
                .map(|file| parent.stage_object(&staged_name, self, &file.hash))
                .transpose()?;
            self.source_cut("after-stage")?;
            changes.push(FileChange {
                relative_path: path,
                before_hash,
                after_hash: after.map(|f| f.hash.clone()),
                before_identity,
                after_identity,
                staged_name,
            });
        }
        if changes.is_empty() {
            return Err(fail("GRAPH_INVALID"));
        }
        let intent = Intent {
            version: 3,
            request_id: request.into(),
            digest: digest.into(),
            project_id,
            expected_generation: generation,
            changes,
            accepted: Some(AcceptedChange {
                before_hash: accepted,
                after_hash: t
                    .source_hash
                    .clone()
                    .ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?,
            }),
            resolution: bound,
            graph: Some(GraphIntent {
                before_hash: update.before.hash.clone(),
                after_hash: update.after_hash.clone(),
                generation: update.before.generation,
                expected_revision: t.state.working_revision,
                rename: update.rename.clone(),
                observation: Some(observation),
                checked_paths,
            }),
        };
        let bytes = db(serde_json::to_vec(&intent))?;
        if bytes.len() > 16 * 1024 * 1024 {
            return Err(fail("GRAPH_BUDGET_EXCEEDED"));
        }
        self.object(&bytes)?;
        self.source_cut("before-intent-flush")?;
        write_new(&self.intent_path(), &bytes)?;
        sync_directory(&self.directory)?;
        self.source_cut("after-intent")?;
        Ok(Some(intent))
    }
    pub(crate) fn promote_graph_intent(&self, intent: &Intent) -> Result<()> {
        let root = self
            .creative_root
            .as_ref()
            .ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
        if let Some(observation) = intent.graph.as_ref().and_then(|g| g.observation.as_ref()) {
            self.revalidate_intent_observation(intent, observation)?;
        }
        for (index, change) in intent.changes.iter().enumerate() {
            let parent = Parent::open(root, &change.relative_path)?;
            let live = parent.streamed(&parent.name, GraphBudgets::default().per_file)?;
            let stage = parent.streamed(&change.staged_name, GraphBudgets::default().per_file)?;
            if !physical_known(live.as_ref(), change, false)
                || !physical_known(stage.as_ref(), change, true)
            {
                return Err(fail("SOURCE_EXTERNAL_CHANGE"));
            }
            self.source_cut(&format!("before-promotion-{index}"))?;
            self.source_cut("before-promotion")?;
            match (&change.before_hash, &change.after_hash) {
                (None, Some(_)) => parent.rename_no_replace(&change.staged_name, &parent.name)?,
                (Some(_), None) => parent.rename_no_replace(&parent.name, &change.staged_name)?,
                (Some(_), Some(_)) => parent.exchange(&parent.name, &change.staged_name)?,
                (None, None) => {}
            }
            self.source_cut("after-promotion")?;
            self.source_cut(&format!("after-promotion-{index}"))?;
            let live = parent.streamed(&parent.name, GraphBudgets::default().per_file)?;
            let displaced =
                parent.streamed(&change.staged_name, GraphBudgets::default().per_file)?;
            if !physical_known(live.as_ref(), change, true)
                || !physical_known(displaced.as_ref(), change, false)
            {
                return Err(fail("SOURCE_EXTERNAL_CHANGE"));
            }
        }
        self.verify_graph_intent_live(intent, true)
    }

    pub(crate) fn commit_graph_intent(&self, c: &Connection, intent: &Intent) -> Result<()> {
        let graph = intent.graph.as_ref().ok_or(fail("GRAPH_INVALID"))?;
        let before = self.read_file_graph(&graph.before_hash)?;
        let after = self.read_file_graph(&graph.after_hash)?;
        self.guard_graph_production(c, &before, &after)?;
        self.verify_graph_intent_identities(intent)?;
        let count=db(c.execute("UPDATE accepted_file_graph SET graph_hash=?1,generation=generation+1 WHERE singleton=1 AND graph_hash=?2 AND generation=?3",params![graph.after_hash,graph.before_hash,graph.generation]))?;
        if count != 1 {
            return Err(fail("GRAPH_BASE_MISMATCH"));
        }
        let accepted = intent.accepted.as_ref().ok_or(fail("GRAPH_INVALID"))?;
        let count=db(c.execute("UPDATE authored_source SET accepted_hash=?1,generation=generation+1 WHERE singleton=1 AND accepted_hash=?2 AND generation=?3",params![accepted.after_hash,accepted.before_hash,intent.expected_generation]))?;
        if count != 1 {
            return Err(fail("SOURCE_BASE_MISMATCH"));
        }
        let manifest = self.validate_graph(c, &after)?;
        db(c.execute(
            "UPDATE project SET title=?1 WHERE singleton=1",
            [manifest.name.as_deref().unwrap_or("Untitled project")],
        ))?;
        let old_manifest = self.validate_graph(c, &before)?;
        if graph.rename.is_none() && old_manifest.name != manifest.name {
            db(c.execute("INSERT INTO project_rename_receipts(request_id,project_id,previous_title,title) VALUES(?1,?2,?3,?4)",params![format!("graph-name:{}",intent.request_id),intent.project_id,old_manifest.name.as_deref().unwrap_or("Untitled project"),manifest.name.as_deref().unwrap_or("Untitled project")]))?;
        }
        if let Some((previous, title)) = &graph.rename {
            db(c.execute("INSERT INTO project_rename_receipts(request_id,project_id,previous_title,title) VALUES(?1,?2,?3,?4)",params![intent.request_id,intent.project_id,previous,title]))?;
        }
        if let Some(bound) = &intent.resolution
            && db(c.execute(
                "UPDATE source_candidates SET disposition=?2 WHERE id=?1 AND disposition='pending'",
                params![bound.candidate_id, bound.disposition],
            ))? != 1
        {
            return Err(fail("SOURCE_CANDIDATE_STALE"));
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
        Ok(())
    }
    pub(crate) fn verify_graph_intent_live(&self, intent: &Intent, committed: bool) -> Result<()> {
        let root = self
            .creative_root
            .as_ref()
            .ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
        let graph = intent.graph.as_ref().ok_or(fail("GRAPH_INVALID"))?;
        let expected_hash = if committed {
            &graph.after_hash
        } else {
            &graph
                .observation
                .as_ref()
                .ok_or(fail("GRAPH_INVALID"))?
                .graph_hash
        };
        let mut expected = self.read_file_graph(expected_hash)?;
        if let Some(paths) = &graph.checked_paths {
            expected.files.retain(|f| paths.contains(&f.path));
        }
        let (actual, identities) = if let Some(paths) = &graph.checked_paths {
            self.scan_graph_paths(root, &expected.project_id, paths)?
        } else {
            self.scan_graph_locked(
                root,
                false,
                GraphBudgets::default(),
                Some(&expected.project_id),
            )?
        };
        if actual != expected {
            return Err(fail("SOURCE_EXTERNAL_CHANGE"));
        }
        let mut expected_ids = graph
            .observation
            .as_ref()
            .ok_or(fail("GRAPH_INVALID"))?
            .identities
            .clone();
        for change in &intent.changes {
            expected_ids.remove(&change.relative_path);
            if let Some(id) = if committed {
                &change.after_identity
            } else {
                &change.before_identity
            } {
                expected_ids.insert(change.relative_path.clone(), id.clone());
            }
        }
        if identities != expected_ids {
            return Err(fail("SOURCE_EXTERNAL_CHANGE"));
        }
        for change in &intent.changes {
            let parent = Parent::open(root, &change.relative_path)?;
            if !physical_known(
                parent
                    .streamed(&parent.name, GraphBudgets::default().per_file)?
                    .as_ref(),
                change,
                committed,
            ) {
                return Err(fail("SOURCE_EXTERNAL_CHANGE"));
            }
        }
        Ok(())
    }
    fn verify_graph_intent_identities(&self, intent: &Intent) -> Result<()> {
        let root = self
            .creative_root
            .as_ref()
            .ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
        for change in &intent.changes {
            let parent = Parent::open(root, &change.relative_path)?;
            let file = parent.open_file(&parent.name)?;
            if file.as_ref().map(|p| &p.1) != change.after_identity.as_ref() {
                return Err(fail("SOURCE_EXTERNAL_CHANGE"));
            }
            parent.verify()?;
        }
        Ok(())
    }
    pub(crate) fn cleanup_graph_intent(&self, intent: &Intent) -> Result<()> {
        self.validate_graph_physical_states(intent)?;
        let root = self
            .creative_root
            .as_ref()
            .ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
        for (index, change) in intent.changes.iter().enumerate() {
            let parent = Parent::open(root, &change.relative_path)?;
            if let Some(stage) =
                parent.streamed(&change.staged_name, GraphBudgets::default().per_file)?
            {
                if !physical_known(Some(&stage), change, false)
                    && !physical_known(Some(&stage), change, true)
                {
                    return Err(fail("SOURCE_EXTERNAL_CHANGE"));
                }
                parent.unlink(&change.staged_name)?;
            }
            self.source_cut(&format!("after-cleanup-{index}"))?;
        }
        db(std::fs::remove_file(self.intent_path()))?;
        sync_directory(&self.directory)
    }
    /// Validate all states before any recovery/cleanup mutation. A third-party
    /// version anywhere fences the entire operation and every sibling artifact.
    pub(super) fn validate_graph_physical_states(&self, intent: &Intent) -> Result<()> {
        let root = self
            .creative_root
            .as_ref()
            .ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
        let graph = intent.graph.as_ref().ok_or(fail("GRAPH_INVALID"))?;
        let observed = graph.observation.as_ref().ok_or(fail("GRAPH_INVALID"))?;
        let baseline = self.read_file_graph(&observed.graph_hash)?;
        let (actual, identities) = if let Some(paths) = &graph.checked_paths {
            self.scan_graph_paths(root, &baseline.project_id, paths)?
        } else {
            self.scan_graph_locked(
                root,
                false,
                GraphBudgets::default(),
                Some(&baseline.project_id),
            )?
        };
        let changed = intent
            .changes
            .iter()
            .map(|c| (c.relative_path.as_str(), c))
            .collect::<BTreeMap<_, _>>();
        let old = baseline.index();
        let live = actual.index();
        for path in old.keys().chain(live.keys()) {
            if let Some(change) = changed.get(path) {
                let file = live
                    .get(path)
                    .map(|f| (f.hash.clone(), f.size, identities[*path].clone()));
                if !physical_known(file.as_ref(), change, false)
                    && !physical_known(file.as_ref(), change, true)
                {
                    return Err(fail("SOURCE_EXTERNAL_CHANGE"));
                }
            } else if old.get(path) != live.get(path)
                || observed.identities.get(*path) != identities.get(*path)
            {
                return Err(fail("SOURCE_EXTERNAL_CHANGE"));
            }
        }
        for change in &intent.changes {
            let parent = Parent::open(root, &change.relative_path)?;
            for name in [&parent.name, &change.staged_name] {
                let file = parent.streamed(name, GraphBudgets::default().per_file)?;
                if file.is_some()
                    && !physical_known(file.as_ref(), change, false)
                    && !physical_known(file.as_ref(), change, true)
                {
                    return Err(fail("SOURCE_EXTERNAL_CHANGE"));
                }
            }
        }
        Ok(())
    }
}

impl SqliteProjectRepository {
    pub(super) fn scan_graph_paths(
        &self,
        root: &Path,
        project: &str,
        paths: &[String],
    ) -> Result<(FileGraph, BTreeMap<String, Identity>)> {
        let mut graph = FileGraph {
            version: 1,
            project_id: project.into(),
            files: vec![],
        };
        let mut identities = BTreeMap::new();
        for path in paths {
            let parent = Parent::open(root, path)?;
            if let Some((hash, size, id)) =
                parent.streamed(&parent.name, manuscript::MAX_DOCUMENT_BYTES as u64)?
            {
                if self.directory.join("objects").join(&hash).exists() {
                    if self.verify_object_stream(&hash)? != size {
                        return Err(fail("GRAPH_INVALID"));
                    }
                } else {
                    let (mut file, opened) = parent
                        .open_file(&parent.name)?
                        .ok_or(fail("SOURCE_EXTERNAL_CHANGE"))?;
                    if opened != id
                        || self.object_stream(&mut file, manuscript::MAX_DOCUMENT_BYTES as u64)?
                            != (hash.clone(), size)
                    {
                        return Err(fail("SOURCE_EXTERNAL_CHANGE"));
                    }
                }
                if parent.streamed(&parent.name, manuscript::MAX_DOCUMENT_BYTES as u64)?
                    != Some((hash.clone(), size, id.clone()))
                {
                    return Err(fail("SOURCE_EXTERNAL_CHANGE"));
                }
                identities.insert(path.clone(), id);
                graph.files.push(GraphFile {
                    path: path.clone(),
                    hash,
                    size,
                });
            }
        }
        Ok((graph, identities))
    }
    fn revalidate_intent_observation(
        &self,
        intent: &Intent,
        observation: &GraphObservation,
    ) -> Result<()> {
        let graph = intent.graph.as_ref().ok_or(fail("GRAPH_INVALID"))?;
        if let Some(paths) = &graph.checked_paths {
            let root = self
                .creative_root
                .as_ref()
                .ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
            let (actual, identities) = self.scan_graph_paths(root, &intent.project_id, paths)?;
            if actual != self.read_file_graph(&observation.graph_hash)?
                || identities != observation.identities
            {
                return Err(fail("SOURCE_EXTERNAL_CHANGE"));
            }
        } else {
            self.revalidate_graph_observation(observation)?;
        }
        Ok(())
    }
}
