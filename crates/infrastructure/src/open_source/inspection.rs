//! Registered-file observations are evidence only. Events never mutate prose.
use super::*;
use std::time::{Duration, Instant};
const QUIET: Duration = Duration::from_millis(300);
#[derive(Default)]
pub(crate) struct Observation {
    fingerprint: Option<(Option<String>, Option<Identity>)>,
    since: Option<Instant>,
    last_scan: Option<Instant>,
    status: Option<AuthoredSourceStatus>,
    pub(super) watcher: Option<File>,
    pub(super) watch_attempted: bool,
}
impl Observation {
    fn watch(&mut self, root: &Path, path: &str) {
        if self.watch_attempted {
            return;
        }
        self.watch_attempted = true;
        #[cfg(target_os = "linux")]
        {
            use std::os::{
                fd::{AsRawFd, FromRawFd},
                unix::ffi::OsStrExt,
            };
            // Internal registered paths only. Event payloads never select I/O paths.
            let fd = unsafe { libc::inotify_init1(libc::IN_NONBLOCK | libc::IN_CLOEXEC) };
            if fd < 0 {
                return;
            }
            let file = unsafe { File::from_raw_fd(fd) };
            let directory = root.join(path).parent().unwrap_or(root).to_path_buf();
            let Ok(name) = std::ffi::CString::new(directory.as_os_str().as_bytes()) else {
                return;
            };
            let mask = libc::IN_CLOSE_WRITE
                | libc::IN_MOVED_TO
                | libc::IN_MOVED_FROM
                | libc::IN_CREATE
                | libc::IN_DELETE
                | libc::IN_MODIFY
                | libc::IN_DELETE_SELF
                | libc::IN_MOVE_SELF;
            if unsafe { libc::inotify_add_watch(file.as_raw_fd(), name.as_ptr(), mask) } >= 0 {
                self.watcher = Some(file);
            }
        }
        let _ = (root, path);
    }
    fn events(&mut self) -> bool {
        use std::io::Read;
        let Some(file) = self.watcher.as_mut() else {
            return false;
        };
        let mut bytes = [0u8; 8192];
        let mut changed = false;
        // Bound event draining even under continuous external writes.
        for _ in 0..8 {
            match file.read(&mut bytes) {
                Ok(n) if n > 0 => changed = true,
                _ => break,
            }
        }
        changed
    }
}
impl SqliteProjectRepository {
    pub(crate) fn stop_source_watcher(&self) -> Result<()> {
        let mut observation = db(self.source_observation.lock())?;
        observation.watcher = None;
        observation.watch_attempted = false;
        Ok(())
    }
    fn pending_source_intent(&self) -> Result<Option<AuthoredSourcePendingIntent>> {
        if !self.intent_path().exists() {
            return Ok(None);
        }
        let parent = Parent::open(&self.directory, "source-intent.json")?;
        let bytes = parent
            .read(&parent.name, false)?
            .ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?
            .0;
        let intent: Intent = db(serde_json::from_slice(&bytes))?;
        Ok(Some(AuthoredSourcePendingIntent {
            intent_hash: hash(&bytes),
            request_id: intent.request_id,
            version: intent.version.into(),
        }))
    }
    pub fn source_status(&self) -> Result<AuthoredSourceStatus> {
        let c = db(self.connection.lock())?;
        self.source_status_locked(&c)
    }
    pub(super) fn source_status_locked(&self, c: &Connection) -> Result<AuthoredSourceStatus> {
        let (project_id, _, accepted_hash, generation) =
            source_row(c)?.ok_or(fail("SOURCE_CAPABILITY_UNSUPPORTED"))?;
        let observation = db(self.source_observation.lock())?;
        let mut status = observation
            .status
            .clone()
            .filter(|s| s.generation == generation && s.accepted_hash == accepted_hash)
            .unwrap_or(AuthoredSourceStatus {
                project_id,
                generation,
                accepted_hash,
                external_status: AuthoredSourceStatusExternalStatus::Unstable,
                external_hash: None,
                candidate_id: None,
                pending_intent: None,
                observation_fingerprint: None,
                watch_mode: AuthoredSourceStatusWatchMode::Polling,
            });
        status.pending_intent = self.pending_source_intent()?;
        status.watch_mode = if self.is_quiescing() {
            AuthoredSourceStatusWatchMode::Stopped
        } else if observation.watcher.is_some() {
            AuthoredSourceStatusWatchMode::Native
        } else {
            AuthoredSourceStatusWatchMode::Polling
        };
        Ok(status)
    }
    /// Bounded same-process rescan for reopen, focus, or explicit user retry.
    pub fn rescan_source(&self) -> Result<AuthoredSourceStatus> {
        self.inspect_source_changes(true)?;
        std::thread::sleep(QUIET + Duration::from_millis(10));
        self.inspect_source_changes(true)?;
        self.source_status()
    }
    /// Service lifecycle tick; native events are hints, with a 2s missed-event repair.
    pub fn inspect_source_changes(&self, force: bool) -> Result<()> {
        if self.creative_root.is_none() || self.is_quiescing() {
            return Ok(());
        }
        let c = db(self.connection.lock())?;
        let (project_id, path, accepted_hash, generation) =
            source_row(&c)?.ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
        let root = self
            .creative_root
            .as_ref()
            .ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?;
        let mut observation = db(self.source_observation.lock())?;
        if self.is_quiescing() {
            return Ok(());
        }
        observation.watch(root, &path);
        let events = observation.events();
        let settling = observation.status.as_ref().is_some_and(|s| {
            s.external_status == AuthoredSourceStatusExternalStatus::Unstable
                || s.external_status == AuthoredSourceStatusExternalStatus::Missing
                    && s.candidate_id.is_none()
        });
        if !force
            && !events
            && !settling
            && observation
                .last_scan
                .is_some_and(|t| t.elapsed() < Duration::from_secs(2))
        {
            return Ok(());
        }
        observation.last_scan = Some(Instant::now());
        if events {
            observation.since = Some(Instant::now());
        }
        let live = Parent::open(root, &path).and_then(|parent| parent.read(&parent.name, false));
        let mut status = AuthoredSourceStatus {
            project_id: project_id.clone(),
            generation,
            accepted_hash: accepted_hash.clone(),
            external_status: AuthoredSourceStatusExternalStatus::Unavailable,
            external_hash: None,
            candidate_id: None,
            pending_intent: None,
            observation_fingerprint: None,
            watch_mode: if observation.watcher.is_some() {
                AuthoredSourceStatusWatchMode::Native
            } else {
                AuthoredSourceStatusWatchMode::Polling
            },
        };
        match live {
            Ok(Some((bytes, identity))) => {
                let live_hash = hash(&bytes);
                status.external_hash = Some(live_hash.clone());
                let fingerprint = (Some(live_hash.clone()), Some(identity.clone()));
                if observation.fingerprint.as_ref() != Some(&fingerprint) {
                    observation.fingerprint = Some(fingerprint);
                    observation.since = Some(Instant::now());
                }
                if live_hash == accepted_hash {
                    status.external_status = AuthoredSourceStatusExternalStatus::Unchanged;
                } else if observation.since.is_some_and(|t| t.elapsed() >= QUIET) {
                    let candidate = self.persist_source_candidate(
                        &c,
                        &project_id,
                        &accepted_hash,
                        generation,
                        Some(&bytes),
                        Some(&identity),
                    )?;
                    status.external_status = if candidate.1.is_some() {
                        AuthoredSourceStatusExternalStatus::Invalid
                    } else {
                        AuthoredSourceStatusExternalStatus::Changed
                    };
                    status.candidate_id = Some(candidate.0);
                } else {
                    status.external_status = AuthoredSourceStatusExternalStatus::Unstable;
                }
            }
            Ok(None) => {
                status.external_status = AuthoredSourceStatusExternalStatus::Missing;
                let fingerprint = (None, None);
                if observation.fingerprint.as_ref() != Some(&fingerprint) {
                    observation.fingerprint = Some(fingerprint);
                    observation.since = Some(Instant::now());
                }
                if observation.since.is_some_and(|t| t.elapsed() >= QUIET) {
                    status.candidate_id = Some(
                        self.persist_source_candidate(
                            &c,
                            &project_id,
                            &accepted_hash,
                            generation,
                            None,
                            None,
                        )?
                        .0,
                    );
                }
            }
            Err(_) => {
                observation.fingerprint = None;
                observation.since = None;
            }
        }
        status.observation_fingerprint = observation
            .fingerprint
            .as_ref()
            .map(|f| hash(&serde_json::to_vec(f).expect("physical fingerprint")));
        self.observe_source_candidate(&c, status.candidate_id.as_deref())?;
        self.prune_source_candidates_locked(&c)?;
        observation.status = Some(status);
        Ok(())
    }
    pub(super) fn persist_source_candidate(
        &self,
        c: &Connection,
        project_id: &str,
        accepted_hash: &str,
        generation: i64,
        bytes: Option<&[u8]>,
        identity: Option<&Identity>,
    ) -> Result<(String, Option<String>)> {
        let physical_identity = db(serde_json::to_string(&identity))?;
        let live_hash = bytes.map(hash);
        let existing:Option<(String,Option<String>)>=db(c.query_row("SELECT id,validation_error FROM source_candidates WHERE project_id=?1 AND base_hash=?2 AND base_generation=?3 AND live_hash IS ?4 AND physical_identity=?5",params![project_id,accepted_hash,generation,live_hash,physical_identity],|r|Ok((r.get(0)?,r.get(1)?))).optional())?;
        if let Some(candidate) = existing {
            self.observe_source_candidate(c, Some(&candidate.0))?;
            return Ok(candidate);
        }
        let (bindings, validation_error) = match bytes {
            Some(bytes) => match source::read_source(bytes, &[]) {
                Ok(document) => (source_bindings(&document)?, None),
                Err(error) => (vec![], Some(error.code.to_string())),
            },
            None => (vec![], Some("SOURCE_REQUIRED_FILE_DELETED".into())),
        };
        if let Some(bytes) = bytes {
            self.object(bytes)?;
        }
        let candidate = AuthoredSourceCandidate {
            id: uuid::Uuid::new_v4().to_string(),
            project_id: project_id.into(),
            base_hash: accepted_hash.into(),
            base_generation: generation,
            live_hash,
            source: bytes.and_then(|b| String::from_utf8(b.to_vec()).ok()),
            bindings,
            validation_error,
            disposition: AuthoredSourceCandidateDisposition::Pending,
        };
        db(c.execute("INSERT INTO source_candidates(id,project_id,base_hash,base_generation,live_hash,physical_identity,payload_json,validation_error) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",params![candidate.id,project_id,accepted_hash,generation,candidate.live_hash,physical_identity,db(serde_json::to_string(&candidate))?,candidate.validation_error]))?;
        self.observe_source_candidate(c, Some(&candidate.id))?;
        Ok((candidate.id, candidate.validation_error))
    }
    fn observe_source_candidate(&self, c: &Connection, id: Option<&str>) -> Result<()> {
        let changed=db(c.execute("UPDATE source_candidate_observation SET current_candidate_id=?1,sequence=sequence+1 WHERE singleton=1 AND current_candidate_id IS NOT ?1",[id]))?;
        if changed == 1
            && let Some(id) = id
        {
            db(c.execute("UPDATE source_candidates SET observed_sequence=(SELECT sequence FROM source_candidate_observation WHERE singleton=1) WHERE id=?1",[id]))?;
        }
        Ok(())
    }
    pub fn prune_source_candidates(&self) -> Result<()> {
        let c = db(self.connection.lock())?;
        self.prune_source_candidates_locked(&c)
    }
    fn prune_source_candidates_locked(&self, c: &Connection) -> Result<()> {
        let version: i64 = db(c.pragma_query_value(None, "user_version", |r| r.get(0)))?;
        if version < 12 {
            return Ok(());
        }
        let pending = if self.intent_path().exists() {
            let parent = Parent::open(&self.directory, "source-intent.json")?;
            let bytes = parent
                .read(&parent.name, false)?
                .ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?
                .0;
            let intent: Intent = db(serde_json::from_slice(&bytes))?;
            intent.resolution.map(|r| r.candidate_id)
        } else {
            None
        };
        // The current observation and journal binding are outside the five-record
        // comparison window. Explicit recovery evidence never enters this window.
        db(c.execute("WITH protected AS (SELECT current_candidate_id AS id FROM source_candidate_observation WHERE current_candidate_id IS NOT NULL UNION SELECT ?1 WHERE ?1 IS NOT NULL), recent AS (SELECT id FROM source_candidates WHERE explicitly_retained=0 AND id NOT IN (SELECT id FROM protected) ORDER BY observed_sequence DESC,rowid DESC LIMIT 5) DELETE FROM source_candidates WHERE explicitly_retained=0 AND id NOT IN (SELECT id FROM protected) AND id NOT IN (SELECT id FROM recent)",[pending]))?;
        Ok(())
    }
    pub fn source_candidate(&self, id: &str) -> Result<AuthoredSourceCandidate> {
        if !manuscript::uuid4(id) {
            return Err(fail("INVALID_REQUEST"));
        }
        let c = db(self.connection.lock())?;
        self.source_candidate_locked(&c, id)
            .map(|(candidate, _)| candidate)
    }
    pub(super) fn source_candidate_locked(
        &self,
        c: &Connection,
        id: &str,
    ) -> Result<(AuthoredSourceCandidate, Option<Identity>)> {
        let (payload,identity,disposition):(String,String,String)=db(c.query_row("SELECT payload_json,physical_identity,disposition FROM source_candidates WHERE id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional())?.ok_or(fail("SOURCE_CANDIDATE_STALE"))?;
        let mut candidate: AuthoredSourceCandidate = db(serde_json::from_str(&payload))?;
        candidate.disposition = db(serde_json::from_value(serde_json::Value::String(
            disposition,
        )))?;
        if let Some(hash) = &candidate.live_hash {
            self.read_object(hash)?;
        }
        Ok((candidate, db(serde_json::from_str(&identity))?))
    }
}
fn source_bindings(document: &SourceDocument) -> Result<Vec<AuthoredSourceBinding>> {
    let semantic = source::project(document)
        .map_err(format_error)?
        .into_iter()
        .map(|b| b.id)
        .collect::<BTreeSet<_>>();
    Ok(document
        .blocks
        .iter()
        .map(|b| AuthoredSourceBinding {
            address: b.address.clone(),
            kind: b.kind.clone(),
            start_utf8: b.start_utf8 as i64,
            end_utf8: b.end_utf8 as i64,
            list_item_address: b.list_item_address.clone(),
            id: b.id.clone(),
            semantic_editable: b.id.as_ref().is_some_and(|id| semantic.contains(id)),
        })
        .collect())
}
