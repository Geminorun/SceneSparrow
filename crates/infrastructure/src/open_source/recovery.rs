//! Explicit recovery decisions preserve unseen external bytes without force-write.
use super::*;
fn fingerprint(live: Option<&(Vec<u8>, Identity)>) -> Result<String> {
    let physical = live.map(|(bytes, id)| (hash(bytes), id));
    // Same tuple shape as status: absence is distinct from an empty-file hash.
    let value = (
        physical.as_ref().map(|p| &p.0),
        physical.as_ref().map(|p| p.1),
    );
    Ok(hash(&db(serde_json::to_vec(&value))?))
}
impl SqliteProjectRepository {
    pub fn recover_source(&self, r: &AuthoredSourceRecoverRequest) -> Result<AuthoredSourceStatus> {
        let mut c = db(self.connection.lock())?;
        let (project_id, _, _, _) = source_row(&c)?.ok_or(fail("SOURCE_CAPABILITY_UNSUPPORTED"))?;
        if project_id != r.project_id {
            return Err(fail("SOURCE_PROJECT_MISMATCH"));
        }
        let recovery_digest = hash(&db(serde_json::to_vec(r))?);
        let previous:Option<String>=db(c.query_row("SELECT recovery_digest FROM source_recovery_decisions WHERE intent_hash=?1 AND request_id=?2",params![r.intent_hash,r.request_id],|row|row.get(0)).optional())?;
        if let Some(previous) = previous {
            if previous != recovery_digest {
                return Err(fail("SOURCE_RECOVERY_STALE"));
            }
            // A replay of an older recovery must never settle a newer pending
            // operation merely because it currently owns the same journal path.
            let pending = Parent::open(&self.directory, "source-intent.json")?;
            if let Some((bytes, _)) = pending.read(&pending.name, false)?
                && hash(&bytes) == r.intent_hash
            {
                self.recover_source_intents_locked(&c)?;
            }
            return self.source_status_locked(&c);
        }
        let parent = Parent::open(&self.directory, "source-intent.json")?;
        let bytes = parent
            .read(&parent.name, false)?
            .ok_or(fail("SOURCE_RECOVERY_STALE"))?
            .0;
        let intent: Intent = db(serde_json::from_slice(&bytes))?;
        if hash(&bytes) != r.intent_hash || intent.request_id != r.request_id {
            return Err(fail("SOURCE_RECOVERY_STALE"));
        }
        if r.disposition == Some(AuthoredSourceRecoverRequestDisposition::PreserveExternal) {
            self.preserve_external_recovery(&mut c, r, &intent, &bytes, &recovery_digest)?;
        } else {
            if r.observation_fingerprint.is_some() {
                return Err(fail("INVALID_REQUEST"));
            }
            self.recover_source_intents_locked(&c)?;
        }
        self.source_status_locked(&c)
    }
    fn preserve_external_recovery(
        &self,
        c: &mut Connection,
        r: &AuthoredSourceRecoverRequest,
        intent: &Intent,
        bytes: &[u8],
        recovery_digest: &str,
    ) -> Result<()> {
        let committed = self.validate_source_intent_metadata(c, intent, bytes)?;
        let (project_id, path, accepted, generation) =
            source_row(c)?.ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
        let parent = Parent::open(
            self.creative_root
                .as_ref()
                .ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?,
            &path,
        )?;
        let live = parent.read(&parent.name, false)?;
        let observed = fingerprint(live.as_ref())?;
        if r.observation_fingerprint.as_deref() != Some(&observed) {
            return Err(fail("SOURCE_RECOVERY_STALE"));
        }
        let mut pins = BTreeSet::new();
        let mut evidence = known_recovery_versions(intent);
        pins.insert(self.object(bytes)?);
        for change in &intent.changes {
            pins.extend(change.before_hash.clone());
            pins.extend(change.after_hash.clone());
            if let Some((staged, _)) = parent.read(&change.staged_name, false)? {
                self.preserve_conflict(&staged)?;
                let hash = self.object(&staged)?;
                evidence
                    .entry(hash.clone())
                    .or_default()
                    .insert("staged".into());
                pins.insert(hash);
            }
        }
        if let Some((live, _)) = &live {
            self.preserve_conflict(live)?;
            let hash = self.object(live)?;
            evidence
                .entry(hash.clone())
                .or_default()
                .insert("live".into());
            pins.insert(hash);
        }
        pins.extend(evidence.keys().cloned());
        let candidate = self.persist_source_candidate(
            c,
            &project_id,
            &accepted,
            generation,
            live.as_ref().map(|p| p.0.as_slice()),
            live.as_ref().map(|p| &p.1),
        )?;
        self.source_cut("before-recovery-decision")?;
        if fingerprint(parent.read(&parent.name, false)?.as_ref())? != observed {
            return Err(fail("SOURCE_RECOVERY_STALE"));
        }
        let tx = db(c.transaction())?;
        // This SQL decision is the durable fork from automatic known-version
        // recovery. It is recorded before removing the pending intent fence.
        if !committed {
            if let Some((digest, outcome)) = Self::outcome(&tx, &intent.request_id)? {
                if digest != intent.digest
                    || serde_json::from_str::<serde_json::Value>(&outcome)
                        .ok()
                        .and_then(|v| v.get("error").cloned())
                        .is_none()
                {
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
        db(tx.execute(
            "INSERT INTO source_recovery_decisions VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![
                r.intent_hash,
                intent.request_id,
                intent.digest,
                recovery_digest,
                project_id,
                accepted,
                generation,
                committed,
                observed
            ],
        ))?;
        for (hash, roles) in evidence {
            for role in roles {
                db(tx.execute(
                    "INSERT INTO source_recovery_evidence VALUES(?1,?2,?3)",
                    params![r.intent_hash, hash, role],
                ))?;
            }
        }
        db(tx.execute(
            "UPDATE source_candidates SET explicitly_retained=1 WHERE id=?1",
            [&candidate.0],
        ))?;
        for pin in pins {
            db(tx.execute(
                "INSERT OR IGNORE INTO source_pins VALUES(?1,?2)",
                params![format!("recovery:{}:{pin}", r.intent_hash), pin],
            ))?;
        }
        db(tx.commit())?;
        self.source_cut("after-recovery-decision")?;
        self.finish_preserved_source_intent(c, intent, bytes)?;
        self.source_cut("after-recovery-cleanup")
    }
    pub(super) fn finish_preserved_source_intent(
        &self,
        c: &Connection,
        intent: &Intent,
        bytes: &[u8],
    ) -> Result<bool> {
        let schema: i64 = db(c.pragma_query_value(None, "user_version", |r| r.get(0)))?;
        if schema < 12 {
            return Ok(false);
        }
        let decision:Option<(String,String,String,String,i64)>=db(c.query_row("SELECT request_id,digest,project_id,accepted_hash,generation FROM source_recovery_decisions WHERE intent_hash=?1",[hash(bytes)],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?))).optional())?;
        let Some((request, digest, project, accepted, generation)) = decision else {
            return Ok(false);
        };
        let current = source_row(c)?.ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
        if request != intent.request_id
            || digest != intent.digest
            || project != intent.project_id
            || current.0 != project
            || current.2 != accepted
            || current.3 != generation
        {
            return Err(fail("SOURCE_RECOVERY_REQUIRED"));
        }
        let receipt = Self::outcome(c, &request)?.ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
        if receipt.0 != digest {
            return Err(fail("SOURCE_RECOVERY_REQUIRED"));
        }
        // Keep staged/displaced artifacts intact. Unknown bytes were retained as
        // conflict evidence; no physical creative-file mutation is authorized.
        db(std::fs::remove_file(self.intent_path()))?;
        sync_directory(&self.directory)?;
        Ok(true)
    }
}

fn known_recovery_versions(intent: &Intent) -> BTreeMap<String, BTreeSet<String>> {
    let mut versions: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for change in &intent.changes {
        if let Some(hash) = &change.before_hash {
            versions
                .entry(hash.clone())
                .or_default()
                .insert("physicalBefore".into());
        }
        if let Some(hash) = &change.after_hash {
            versions
                .entry(hash.clone())
                .or_default()
                .insert("physicalAfter".into());
        }
    }
    if let Some(accepted) = &intent.accepted {
        versions
            .entry(accepted.before_hash.clone())
            .or_default()
            .insert("acceptedBefore".into());
        versions
            .entry(accepted.after_hash.clone())
            .or_default()
            .insert("acceptedAfter".into());
    } else if let Some(change) = intent.changes.first() {
        if let Some(hash) = &change.before_hash {
            versions
                .entry(hash.clone())
                .or_default()
                .insert("acceptedBefore".into());
        }
        if let Some(hash) = &change.after_hash {
            versions
                .entry(hash.clone())
                .or_default()
                .insert("acceptedAfter".into());
        }
    }
    versions
}
fn valid_recovery_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
impl SqliteProjectRepository {
    fn recovery_versions_locked(
        &self,
        c: &Connection,
        intent_hash: &str,
    ) -> Result<(String, BTreeMap<String, BTreeSet<String>>)> {
        if !valid_recovery_hash(intent_hash) {
            return Err(fail("INVALID_REQUEST"));
        }
        let project_id = source_row(c)?
            .ok_or(fail("SOURCE_CAPABILITY_UNSUPPORTED"))?
            .0;
        let decision: Option<String> = db(c
            .query_row(
                "SELECT project_id FROM source_recovery_decisions WHERE intent_hash=?1",
                [intent_hash],
                |r| r.get(0),
            )
            .optional())?;
        if let Some(owner) = decision {
            if owner != project_id {
                return Err(fail("OBJECT_NOT_FOUND"));
            }
            let mut query = db(c.prepare(
                "SELECT source_hash,role FROM source_recovery_evidence WHERE intent_hash=?1",
            ))?;
            let mut versions: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
            for row in db(query.query_map([intent_hash], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            }))? {
                let (hash, role) = db(row)?;
                versions.entry(hash).or_default().insert(role);
            }
            return Ok((project_id, versions));
        }
        let parent = Parent::open(&self.directory, "source-intent.json")?;
        let bytes = parent
            .read(&parent.name, false)?
            .ok_or(fail("OBJECT_NOT_FOUND"))?
            .0;
        if hash(&bytes) != intent_hash {
            return Err(fail("OBJECT_NOT_FOUND"));
        }
        let intent: Intent = db(serde_json::from_slice(&bytes))?;
        if intent.project_id != project_id {
            return Err(fail("OBJECT_NOT_FOUND"));
        }
        Ok((project_id, known_recovery_versions(&intent)))
    }
    pub fn source_recovery_evidence(
        &self,
        intent_hash: &str,
    ) -> Result<AuthoredSourceRecoveryEvidence> {
        let c = db(self.connection.lock())?;
        let (project_id, versions) = self.recovery_versions_locked(&c, intent_hash)?;
        let versions = versions
            .into_iter()
            .map(|(source_hash, roles)| {
                let bytes = self.read_object(&source_hash)?;
                Ok(AuthoredSourceRecoveryVersion {
                    source_hash,
                    roles: roles.into_iter().collect(),
                    size: bytes.len() as i64,
                    utf8: std::str::from_utf8(&bytes).is_ok(),
                })
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(AuthoredSourceRecoveryEvidence {
            project_id,
            intent_hash: intent_hash.into(),
            versions,
        })
    }
    pub fn source_recovery_bytes(
        &self,
        intent_hash: &str,
        source_hash: &str,
    ) -> Result<AuthoredSourceRecoveryBytes> {
        use base64::{Engine, engine::general_purpose::STANDARD};
        if !valid_recovery_hash(source_hash) {
            return Err(fail("INVALID_REQUEST"));
        }
        let c = db(self.connection.lock())?;
        let (project_id, versions) = self.recovery_versions_locked(&c, intent_hash)?;
        if !versions.contains_key(source_hash) {
            return Err(fail("OBJECT_NOT_FOUND"));
        }
        let bytes = self.read_object(source_hash)?;
        Ok(AuthoredSourceRecoveryBytes {
            project_id,
            intent_hash: intent_hash.into(),
            source_hash: source_hash.into(),
            bytes_base64: STANDARD.encode(&bytes),
            source: String::from_utf8(bytes).ok(),
        })
    }
}
