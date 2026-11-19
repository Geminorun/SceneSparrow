use super::{Result, db};
use crate::SqliteProjectRepository;
use rusqlite::Connection;
use std::{
    collections::{BTreeMap, BTreeSet},
    time::Duration,
};

impl SqliteProjectRepository {
    /// A retention-root handoff for the upcoming collector. Capturing this list
    /// alone is not permission to collect: capture and reclaim must share the
    /// writer coordinator with object preparation. Migration backups own separate
    /// pinned object copies and must be retained as complete directories.
    pub fn retained_object_roots(&self) -> Result<BTreeSet<String>> {
        let c = db(self.connection.lock())?;
        self.retention_roots(&c)
    }
    pub(crate) fn retention_roots(&self, c: &Connection) -> Result<BTreeSet<String>> {
        let mut roots = BTreeSet::new();
        let version: i64 = db(c.pragma_query_value(None, "user_version", |r| r.get(0)))?;
        if version < 2 {
            return Ok(roots);
        }
        if version >= 11 {
            roots.extend(self.source_retention_roots(c)?);
        }
        if version >= 13 {
            roots.extend(self.graph_retention_roots(c)?);
        }
        let current_roots = if version >= 3 {
            "SELECT snapshot_hash FROM manuscripts WHERE snapshot_hash IS NOT NULL UNION SELECT payload_hash FROM blocks UNION SELECT before_hash FROM history_entries UNION SELECT after_hash FROM history_entries"
        } else {
            "SELECT snapshot_hash FROM manuscripts WHERE snapshot_hash IS NOT NULL UNION SELECT payload_hash FROM blocks"
        };
        let mut stmt = db(c.prepare(current_roots))?;
        for row in db(stmt.query_map([], |r| r.get::<_, String>(0)))? {
            roots.insert(db(row)?);
        }
        if version >= 6 {
            let mut planning_roots=db(c.prepare("SELECT content_hash FROM draft_generation_manifests UNION SELECT result_hash FROM draft_generation_manifests"))?;
            for row in db(planning_roots.query_map([], |r| r.get::<_, String>(0)))? {
                roots.insert(db(row)?);
            }
        }
        if version >= 7 {
            let mut review_roots = db(c.prepare(if version>=8 {"SELECT context_hash FROM review_tasks WHERE context_hash!='' UNION SELECT b.context_hash FROM review_candidate_bindings b JOIN review_candidates c ON c.id=b.candidate_id WHERE c.payload_hash IS NOT NULL UNION SELECT payload_hash FROM review_candidates WHERE payload_hash IS NOT NULL UNION SELECT payload_hash FROM review_comparisons WHERE payload_hash IS NOT NULL"}else{"SELECT context_hash FROM review_tasks WHERE context_hash!='' UNION SELECT payload_hash FROM review_candidates WHERE payload_hash IS NOT NULL UNION SELECT payload_hash FROM review_comparisons WHERE payload_hash IS NOT NULL"}))?;
            for row in db(review_roots.query_map([], |r| r.get::<_, String>(0)))? {
                roots.insert(db(row)?);
            }
        }
        if version >= 8 {
            let mut approval = db(c.prepare("SELECT manifest_hash FROM approved_manifests UNION SELECT manifest_hash FROM downstream_inputs UNION SELECT content_hash FROM downstream_dependencies UNION SELECT content_hash FROM user_locks"))?;
            for row in db(approval.query_map([], |r| r.get::<_, String>(0)))? {
                roots.insert(db(row)?);
            }
            let mut manifests = db(c.prepare("SELECT manifest_hash FROM approved_manifests"))?;
            for row in db(manifests.query_map([], |r| r.get::<_, String>(0)))? {
                let manifest: crate::finalization::ApprovedManifest =
                    db(serde_json::from_slice(&self.read_object(&db(row)?)?))?;
                roots.extend(manifest.source_hash);
                roots.extend(manifest.blocks.into_iter().map(|l| l.content_hash));
            }
        }
        if version >= 5 {
            let mut ai = db(c.prepare("SELECT object_hash FROM ai_artifacts UNION SELECT object_hash FROM ai_input_snapshots WHERE payload_retained=1"))?;
            for row in db(ai.query_map([], |r| r.get::<_, String>(0)))? {
                roots.insert(db(row)?);
            }
        }
        if version >= 7 {
            for thread in Self::review_threads(c)? {
                for range in thread.anchor.ranges {
                    if let Some(h) = range.quote_hash {
                        roots.insert(h);
                    }
                }
            }
        }
        let mut source_versions: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        let mut block_ids = BTreeSet::new();
        if version >= 3 {
            let mut histories = db(c.prepare(
            "SELECT before_hash FROM history_entries UNION SELECT after_hash FROM history_entries",
        ))?;
            for row in db(histories.query_map([], |r| r.get::<_, String>(0)))? {
                let root = self.read_business(&db(row)?)?;
                roots.extend(root.source_hash);
                for thread in &root.reviews {
                    for range in &thread.anchor.ranges {
                        if let Some(h) = &range.quote_hash {
                            roots.insert(h.clone());
                        }
                    }
                }
                for source in root.sources {
                    if let Some(h) = source.object_hash {
                        source_versions
                            .entry(source.id)
                            .or_default()
                            .insert(h.clone());
                        roots.insert(h);
                    }
                }
                for block in root.blocks {
                    block_ids.insert(block.id);
                }
            }
        }
        if version >= 4 {
            for source in Self::source_members(c)? {
                if let Some(h) = source.object_hash {
                    source_versions
                        .entry(source.id)
                        .or_default()
                        .insert(h.clone());
                    roots.insert(h);
                }
            }
        }
        let mut current = db(c.prepare("SELECT id FROM blocks"))?;
        for row in db(current.query_map([], |r| r.get::<_, String>(0)))? {
            block_ids.insert(db(row)?);
        }
        if version >= 4 {
            let mut stmt=db(c.prepare(if version>=9 {"SELECT object_hash FROM intakes WHERE status='complete' UNION SELECT p.object_hash FROM external_object_pins p WHERE NOT EXISTS(SELECT 1 FROM copy_preparations x WHERE p.owner_id='copy:'||x.id AND x.expires_at<CAST(unixepoch('subsec')*1000 AS INTEGER)) AND NOT EXISTS(SELECT 1 FROM export_jobs x WHERE p.owner_id='export:'||x.id AND x.status IN ('failed','interrupted') AND x.retain_until<CAST(unixepoch('subsec')*1000 AS INTEGER))"}else{"SELECT object_hash FROM intakes WHERE status='complete' UNION SELECT object_hash FROM external_object_pins"}))?;
            for row in db(stmt.query_map([], |r| r.get::<_, String>(0)))? {
                roots.insert(db(row)?);
            }
            let mut stmt = db(c.prepare(
                "SELECT input_hash,result_hash,source_id,status,purpose FROM document_attempts",
            ))?;
            for row in db(stmt.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ))
            }))? {
                let (input, result, source, status, purpose) = db(row)?;
                if matches!(status.as_str(), "queued" | "running")
                    || (purpose == "import" && status == "ready")
                    // A refreshed source keeps its ID, not all previous byte snapshots.
                    || source.as_ref().is_some_and(|s| {
                        source_versions
                            .get(s)
                            .is_some_and(|hashes| hashes.contains(&input))
                    })
                {
                    roots.insert(input);
                    if let Some(h) = result {
                        roots.insert(h);
                    }
                }
            }
            let mut stmt =
                db(c.prepare("SELECT block_id,input_hash,result_hash FROM import_provenance"))?;
            for row in db(stmt.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            }))? {
                let (id, input, result) = db(row)?;
                if block_ids.contains(&id) {
                    roots.insert(input);
                    roots.insert(result);
                }
            }
        }
        Ok(roots)
    }
    pub fn collect_objects(&self, grace: Duration) -> Result<usize> {
        // Capture, reconciliation, row pruning and deletion share the exact writer
        // coordinator used by promotion and command commit. Backups are not traversed.
        let mut c = db(self.connection.lock())?;
        self.verify_file_graph_history(&c)?;
        let roots = self.retention_roots(&c)?;
        for h in &roots {
            self.verify_object_stream(h)?;
        }
        let mut candidates = vec![];
        for entry in db(std::fs::read_dir(self.directory.join("objects")))? {
            let entry = db(entry)?;
            let h = entry.file_name().to_string_lossy().into_owned();
            if !roots.contains(&h)
                && db(entry.file_type())?.is_file()
                && db(entry.metadata())?
                    .modified()
                    .ok()
                    .and_then(|t| t.elapsed().ok())
                    .is_some_and(|age| age >= grace)
            {
                candidates.push((h, entry.path()));
            }
        }
        let tx = db(c.transaction())?;
        for (h, _) in &candidates {
            db(tx.execute("DELETE FROM content_revisions WHERE payload_hash=?1", [h]))?;
            db(tx.execute(
                "DELETE FROM import_provenance WHERE input_hash=?1 OR result_hash=?1",
                [h],
            ))?;
            db(tx.execute("DELETE FROM document_attempts WHERE status NOT IN ('queued','running') AND (input_hash=?1 OR result_hash=?1)",[h]))?;
        }
        db(tx.commit())?;
        // A failure after metadata pruning leaves harmless orphan bytes. Never unlink
        // first: rollback must not restore a committed row pointing to deleted bytes.
        let mut removed = 0;
        for (_, path) in candidates {
            db(std::fs::remove_file(path))?;
            removed += 1;
        }
        Ok(removed)
    }
}
