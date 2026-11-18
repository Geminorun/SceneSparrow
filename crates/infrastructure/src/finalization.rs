//! User approval and future-consumer inputs share the manuscript commit boundary.
use crate::{
    SqliteProjectRepository,
    storage::{Result, db, hash},
};
use rusqlite::{Connection, OptionalExtension, params};
use scenesparrow_domain::{
    contracts::*,
    manuscript::{self, ManuscriptError, Transition},
    planning::ensure,
};
use std::collections::BTreeSet;

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ApprovedManifest {
    pub version: u32,
    pub manuscript_id: String,
    pub blocks: Vec<UserLock>,
}
fn clock_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}
pub(crate) struct PreparedFinalization {
    locks: Vec<UserLock>,
    manifest: Option<String>,
}
impl SqliteProjectRepository {
    pub(crate) fn user_lock_ids(c: &Connection) -> Result<Vec<String>> {
        let mut s = db(c.prepare("SELECT block_id FROM user_locks ORDER BY block_id"))?;
        db(s.query_map([], |r| r.get(0)))?.map(db).collect()
    }
    fn user_locks(c: &Connection) -> Result<Vec<UserLock>> {
        let mut s = db(
            c.prepare("SELECT block_id,revision,content_hash FROM user_locks ORDER BY block_id")
        )?;
        db(s.query_map([], |r| {
            Ok(UserLock {
                block_id: r.get(0)?,
                revision: r.get(1)?,
                content_hash: r.get(2)?,
            })
        }))?
        .map(db)
        .collect()
    }
    pub(crate) fn lock_transition(
        &self,
        c: &Connection,
        command: &ManuscriptCommand,
        before: &ManuscriptState,
    ) -> Result<Transition> {
        let ManuscriptCommand::SetUserLocks { payload, .. } = command else {
            return Err(ManuscriptError("INVALID_REQUEST", None));
        };
        ensure(
            before.workspace_stage == ManuscriptStateWorkspaceStage::Draft,
            "STAGE_CONFLICT",
        )?;
        ensure(
            !payload.all || (payload.locked && payload.block_ids.is_empty()),
            "INVALID_REQUEST",
        )?;
        let mut ids = Self::user_lock_ids(c)?.into_iter().collect::<BTreeSet<_>>();
        let targets = if payload.all {
            before.blocks.iter().map(|b| b.id.clone()).collect()
        } else {
            payload.block_ids.clone()
        };
        ensure(
            targets.len() <= manuscript::MAX_BLOCKS
                && targets.iter().collect::<BTreeSet<_>>().len() == targets.len(),
            "INVALID_REQUEST",
        )?;
        for id in targets {
            ensure(before.blocks.iter().any(|b| b.id == id), "OBJECT_NOT_FOUND")?;
            if payload.locked {
                ids.insert(id);
            } else {
                ids.remove(&id);
            }
        }
        let locks = ids.into_iter().collect::<Vec<_>>();
        let mut state = before.clone();
        if locks != Self::user_lock_ids(c)? {
            state.working_revision = manuscript::next_revision(state.working_revision)?;
        }
        Ok(Transition {
            locks: Some(locks),
            reviews: None,
            state,
            affected: BTreeSet::new(),
            normalized: false,
            sources: None,
            planning: None,
            planning_metadata: None,
        })
    }
    /// SQL-only validation: no repository mutex recursion or immutable IO in a transaction.
    pub(crate) fn guard_finalization(
        c: &Connection,
        before: &ManuscriptState,
        t: &Transition,
    ) -> Result<()> {
        let mut blockers = vec![];
        for id in &t.affected {
            let locked: bool = db(c.query_row(
                "SELECT EXISTS(SELECT 1 FROM user_locks WHERE block_id=?1)",
                [id],
                |r| r.get(0),
            ))?;
            let using:bool=db(c.query_row("SELECT EXISTS(SELECT 1 FROM downstream_dependencies d JOIN downstream_inputs i ON i.id=d.consumer_id WHERE d.block_id=?1 AND i.status='using')",[id],|r|r.get(0)))?;
            if locked {
                blockers.push((id.clone(), "CONTENT_LOCKED"));
            } else if using {
                blockers.push((id.clone(), "TASK_USING_CONTENT"));
            }
        }
        if let Some(ids) = &t.locks {
            let old = Self::user_lock_ids(c)?;
            for id in ids.iter().filter(|id| !old.contains(id)) {
                ensure(
                    before.blocks.iter().any(|b| &b.id == id)
                        || t.state.blocks.iter().any(|b| &b.id == id),
                    "OBJECT_NOT_FOUND",
                )?;
                let pending:bool=db(c.query_row("SELECT EXISTS(SELECT 1 FROM review_claims cl JOIN review_candidates ca ON ca.thread_id=cl.thread_id WHERE cl.block_id=?1 AND ca.status IN ('pending','stale'))",[id],|r|r.get(0)))?;
                let using:bool=db(c.query_row("SELECT EXISTS(SELECT 1 FROM review_reservations WHERE block_id=?1) OR EXISTS(SELECT 1 FROM downstream_dependencies d JOIN downstream_inputs i ON i.id=d.consumer_id WHERE d.block_id=?1 AND i.status='using')",[id],|r|r.get(0)))?;
                if pending {
                    blockers.push((id.clone(), "PENDING_CANDIDATE"));
                } else if using {
                    blockers.push((id.clone(), "TASK_USING_CONTENT"));
                }
            }
        }
        if let Some((_, code)) = blockers.first() {
            return Err(ManuscriptError(
                code,
                Some(HistoryErrorDetails {
                    reason: (*code).into(),
                    affected_ids: blockers.iter().map(|b| b.0.clone()).collect(),
                    candidate_conflicts: None,
                }),
            ));
        }
        Ok(())
    }
    pub(crate) fn prepare_finalization(
        &self,
        c: &Connection,
        t: &Transition,
    ) -> Result<PreparedFinalization> {
        let ids = t.locks.clone().unwrap_or(Self::user_lock_ids(c)?);
        let existing = Self::user_locks(c)?;
        let mut locks = vec![];
        for id in ids {
            if let Some(block) = t.state.blocks.iter().find(|b| b.id == id) {
                locks.push(UserLock {
                    block_id: id,
                    revision: block.revision,
                    content_hash: if let Some(old) = existing
                        .iter()
                        .find(|l| l.block_id == block.id && l.revision == block.revision)
                    {
                        old.content_hash.clone()
                    } else {
                        self.object(&db(serde_json::to_vec(block))?)?
                    },
                });
            }
        }
        let ready = t.state.workspace_stage == ManuscriptStateWorkspaceStage::Draft
            && !t.state.blocks.is_empty()
            && locks.len() == t.state.blocks.len()
            && t.state.blocks.iter().any(|b| {
                b.kind != BlockKind::Heading && b.runs.iter().any(|r| !r.text.trim().is_empty())
            });
        let manifest = if ready {
            let ordered = t
                .state
                .blocks
                .iter()
                .map(|b| {
                    locks
                        .iter()
                        .find(|l| l.block_id == b.id)
                        .cloned()
                        .ok_or(ManuscriptError("STORAGE_UNAVAILABLE", None))
                })
                .collect::<Result<Vec<_>>>()?;
            Some(self.object(&db(serde_json::to_vec(&ApprovedManifest {
                version: 1,
                manuscript_id: t.state.manuscript_id.clone(),
                blocks: ordered,
            }))?)?)
        } else {
            None
        };
        Ok(PreparedFinalization { locks, manifest })
    }
    pub(crate) fn commit_finalization(
        c: &Connection,
        command: &ManuscriptCommand,
        t: &Transition,
        p: &PreparedFinalization,
        history_entry: Option<&str>,
    ) -> Result<()> {
        let previous: Option<String> = db(c.query_row(
            "SELECT baseline_id FROM manuscript_baseline",
            [],
            |r| r.get(0),
        ))?;
        let desired = p
            .locks
            .iter()
            .map(|l| l.block_id.as_str())
            .collect::<BTreeSet<_>>();
        for id in Self::user_lock_ids(c)? {
            if !desired.contains(id.as_str()) {
                db(c.execute("DELETE FROM user_locks WHERE block_id=?1", [id]))?;
            }
        }
        for l in &p.locks {
            db(c.execute(
                "INSERT INTO user_locks VALUES(?1,?2,?3,?4,?5) ON CONFLICT(block_id) DO UPDATE SET revision=excluded.revision,content_hash=excluded.content_hash,action_id=excluded.action_id,created_ms=excluded.created_ms WHERE user_locks.revision!=excluded.revision OR user_locks.content_hash!=excluded.content_hash",
                params![
                    l.block_id,
                    l.revision,
                    l.content_hash,
                    manuscript::envelope(command).0,clock_ms()
                ],
            ))?;
        }
        let baseline = if let Some(h) = &p.manifest {
            db(c.execute(
                "INSERT OR IGNORE INTO approved_manifests(id,manifest_hash) VALUES(?1,?2)",
                params![uuid::Uuid::new_v4().to_string(), h],
            ))?;
            Some(db(c.query_row(
                "SELECT id,sequence FROM approved_manifests WHERE manifest_hash=?1",
                [h],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
            ))?)
        } else {
            None
        };
        db(c.execute(
            "UPDATE manuscript_baseline SET baseline_id=?1",
            [baseline.as_ref().map(|b| &b.0)],
        ))?;
        db(c.execute(
            "UPDATE project SET approved_baseline=?1",
            [baseline.as_ref().map(|b| b.1)],
        ))?;
        if let Some(entry) = history_entry {
            for id in previous.iter().chain(baseline.as_ref().map(|b| &b.0)) {
                db(c.execute(
                    "INSERT OR IGNORE INTO approved_manifest_history VALUES(?1,?2)",
                    params![entry, id],
                ))?;
            }
        }
        if previous.as_ref() != baseline.as_ref().map(|b| &b.0) {
            db(c.execute("INSERT INTO project_events(request_id,event_type,payload_json) VALUES(?1,'manuscript.readinessChanged',?2)",params![manuscript::envelope(command).0,serde_json::json!({"finalized":baseline.is_some(),"baselineId":baseline.as_ref().map(|b|&b.0)}).to_string()]))?;
        }
        // Compare exact dependency tokens/order rather than the review-inclusive working sequence.
        db(c.execute("UPDATE downstream_inputs SET outdated=1 WHERE outdated=0 AND EXISTS(SELECT 1 FROM downstream_dependencies d LEFT JOIN blocks b ON b.id=d.block_id WHERE d.consumer_id=downstream_inputs.id AND (b.id IS NULL OR b.revision!=d.revision OR b.payload_hash!=d.content_hash OR (SELECT COUNT(*) FROM blocks x JOIN downstream_dependencies y ON y.block_id=x.id AND y.consumer_id=d.consumer_id WHERE x.position<b.position)!=(SELECT COUNT(*) FROM downstream_dependencies x WHERE x.consumer_id=d.consumer_id AND x.position<d.position)))",[]))?;
        if t.locks.is_some() {
            db(c.execute("INSERT INTO project_events(request_id,event_type,payload_json) VALUES(?1,'locks.changed','{}')",[manuscript::envelope(command).0]))?;
        }
        Ok(())
    }
    pub fn read_finalization(&self) -> Result<FinalizationState> {
        let c = db(self.connection.lock())?;
        Self::expire_downstream_at(&c, clock_ms())?;
        let baseline=db(c.query_row("SELECT m.id,m.sequence,m.manifest_hash FROM manuscript_baseline b JOIN approved_manifests m ON m.id=b.baseline_id",[],|r|Ok(ApprovedBaseline {id:r.get(0)?,sequence:r.get(1)?,manifest_hash:r.get(2)?})).optional())?;
        let mut stmt=db(c.prepare("SELECT block_id FROM review_reservations UNION SELECT d.block_id FROM downstream_dependencies d JOIN downstream_inputs i ON i.id=d.consumer_id WHERE i.status='using'"))?;
        let reserved_block_ids = db(stmt.query_map([], |r| r.get(0)))?
            .map(db)
            .collect::<Result<Vec<_>>>()?;
        Ok(FinalizationState {
            working_revision: db(c.query_row(
                "SELECT working_revision FROM manuscripts",
                [],
                |r| r.get(0),
            ))?,
            locks: Self::user_locks(&c)?,
            reserved_block_ids,
            finalized: baseline.is_some(),
            baseline,
        })
    }
    /// Controlled local future-consumer fixture; no provider or media execution.
    pub fn start_downstream_fixture(&self, id: &str, block_ids: &[String]) -> Result<String> {
        ensure(
            manuscript::uuid4(id)
                && !block_ids.is_empty()
                && block_ids.len() <= 100
                && block_ids.iter().collect::<BTreeSet<_>>().len() == block_ids.len(),
            "INVALID_REQUEST",
        )?;
        let mut c = db(self.connection.lock())?;
        if let Some((fence, scope)) = db(c
            .query_row(
                "SELECT fence,scope_json FROM downstream_inputs WHERE id=?1",
                [id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .optional())?
        {
            ensure(
                scope == db(serde_json::to_string(block_ids))?,
                "REQUEST_ID_CONFLICT",
            )?;
            return Ok(fence);
        }
        let baseline: String = db(c
            .query_row(
                "SELECT baseline_id FROM manuscript_baseline WHERE baseline_id IS NOT NULL",
                [],
                |r| r.get(0),
            )
            .optional())?
        .ok_or(ManuscriptError("CONTENT_LOCKED", None))?;
        let mut deps = vec![];
        for id in block_ids {
            deps.push(db(c.query_row("SELECT b.id,b.position,b.revision,b.payload_hash FROM blocks b JOIN user_locks l ON l.block_id=b.id AND l.revision=b.revision AND l.content_hash=b.payload_hash WHERE b.id=?1",[id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,i64>(2)?,r.get::<_,String>(3)?))).optional())?.ok_or(ManuscriptError("CONTENT_LOCKED",None))?);
        }
        let h = self.object(&db(serde_json::to_vec(&deps))?)?;
        let fence = uuid::Uuid::new_v4().to_string();
        let tx = db(c.transaction())?;
        db(tx.execute("INSERT INTO downstream_inputs(id,baseline_id,manifest_hash,status,fence,expires_ms,scope_json) VALUES(?1,?2,?3,'using',?4,?5,?6)",params![id,baseline,h,fence,clock_ms()+60_000,db(serde_json::to_string(block_ids))?]))?;
        for (block, position, revision, hash) in deps {
            db(tx.execute(
                "INSERT INTO downstream_dependencies VALUES(?1,?2,?3,?4,?5)",
                params![id, block, position, revision, hash],
            ))?;
        }
        db(tx.commit())?;
        Ok(fence)
    }
    pub fn finish_downstream_fixture(&self, id: &str, fence: &str, cancel: bool) -> Result<bool> {
        let c = db(self.connection.lock())?;
        Ok(db(c.execute("UPDATE downstream_inputs SET status=?3 WHERE id=?1 AND fence=?2 AND status='using' AND expires_ms>?4",params![id,fence,if cancel {"cancelled"} else {"complete"},clock_ms()]))?==1)
    }
    pub fn expire_downstream_fixtures(&self, now_ms: i64) -> Result<()> {
        let c = db(self.connection.lock())?;
        Self::expire_downstream_at(&c, now_ms)
    }
    pub fn downstream_fixture_outdated(&self, id: &str) -> Result<bool> {
        let c = db(self.connection.lock())?;
        db(c.query_row(
            "SELECT outdated FROM downstream_inputs WHERE id=?1",
            [id],
            |r| r.get(0),
        ))
    }
}

impl SqliteProjectRepository {
    pub(crate) fn prune_finalization(c: &Connection) -> Result<()> {
        db(c.execute("DELETE FROM approved_manifest_history WHERE history_entry_id NOT IN (SELECT entry_id FROM history_entry_identities)",[]))?;
        db(c.execute("DELETE FROM review_history_evidence WHERE history_entry_id NOT IN (SELECT entry_id FROM history_entry_identities)",[]))?;
        db(c.execute("DELETE FROM approved_manifests WHERE id NOT IN (SELECT baseline_id FROM manuscript_baseline WHERE baseline_id IS NOT NULL UNION SELECT baseline_id FROM downstream_inputs UNION SELECT baseline_id FROM approved_manifest_history)",[]))?;
        Ok(())
    }
    pub(crate) fn verify_finalization(
        &self,
        c: &Connection,
        state: &ManuscriptState,
    ) -> Result<()> {
        let locks = Self::user_locks(c)?;
        for lock in &locks {
            let block = state
                .blocks
                .iter()
                .find(|b| b.id == lock.block_id)
                .ok_or(ManuscriptError("STORAGE_UNAVAILABLE", None))?;
            ensure(
                lock.revision == block.revision
                    && hash(&db(serde_json::to_vec(block))?) == lock.content_hash,
                "STORAGE_UNAVAILABLE",
            )?;
        }
        let expected_ready = state.workspace_stage == ManuscriptStateWorkspaceStage::Draft
            && locks.len() == state.blocks.len()
            && state.blocks.iter().any(|b| {
                b.kind != BlockKind::Heading && b.runs.iter().any(|r| !r.text.trim().is_empty())
            });
        let baseline:Option<(String,i64,String)>=db(c.query_row("SELECT m.id,m.sequence,m.manifest_hash FROM manuscript_baseline b JOIN approved_manifests m ON m.id=b.baseline_id",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional())?;
        let project: Option<i64> =
            db(c.query_row("SELECT approved_baseline FROM project", [], |r| r.get(0)))?;
        let pointer: Option<String> = db(c.query_row(
            "SELECT baseline_id FROM manuscript_baseline",
            [],
            |r| r.get(0),
        ))?;
        ensure(
            project == baseline.as_ref().map(|b| b.1)
                && pointer.as_ref() == baseline.as_ref().map(|b| &b.0)
                && expected_ready == baseline.is_some(),
            "STORAGE_UNAVAILABLE",
        )?;
        let mut q = db(c.prepare("SELECT id,manifest_hash FROM approved_manifests"))?;
        for row in db(q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))))? {
            let (id, h) = db(row)?;
            let manifest: ApprovedManifest = db(serde_json::from_slice(&self.read_object(&h)?))?;
            ensure(
                manifest.version == 1
                    && manifest.manuscript_id == state.manuscript_id
                    && manifest
                        .blocks
                        .iter()
                        .map(|b| &b.block_id)
                        .collect::<BTreeSet<_>>()
                        .len()
                        == manifest.blocks.len(),
                "STORAGE_UNAVAILABLE",
            )?;
            for lock in &manifest.blocks {
                let block: Block = db(serde_json::from_slice(
                    &self.read_object(&lock.content_hash)?,
                ))?;
                ensure(
                    block.id == lock.block_id && block.revision == lock.revision,
                    "STORAGE_UNAVAILABLE",
                )?;
            }
            if pointer.as_ref() == Some(&id) {
                let ordered = state
                    .blocks
                    .iter()
                    .map(|b| locks.iter().find(|l| l.block_id == b.id).cloned())
                    .collect::<Option<Vec<_>>>()
                    .ok_or(ManuscriptError("STORAGE_UNAVAILABLE", None))?;
                ensure(manifest.blocks == ordered, "STORAGE_UNAVAILABLE")?;
            }
        }
        Ok(())
    }
}

impl SqliteProjectRepository {
    pub(crate) fn expire_downstream_now(c: &Connection) -> Result<()> {
        Self::expire_downstream_at(c, clock_ms())
    }
    fn expire_downstream_at(c: &Connection, now_ms: i64) -> Result<()> {
        db(c.execute("UPDATE downstream_inputs SET status='cancelled' WHERE status='using' AND expires_ms<=?1",[now_ms]))?;
        Ok(())
    }
}
