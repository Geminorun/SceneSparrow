use super::*;
impl SqliteProjectRepository {
    pub(crate) fn current_graph_receipt(
        &self,
        c: &Connection,
        request: &str,
    ) -> Result<CommandReceipt> {
        let h = Self::history_metadata(c)?;
        Ok(CommandReceipt {
            request_id: request.into(),
            working_revision: h.working_revision,
            source_revisions: None,
            block_revisions: vec![],
            history_revision: h.history_revision,
            cursor: h.cursor,
            undo_count: h.undo_count,
            redo_count: h.redo_count,
            undo_label: h.undo_label,
            redo_label: h.redo_label,
            event_sequence: db(c.query_row(
                "SELECT COALESCE(MAX(sequence),0) FROM project_events",
                [],
                |r| r.get(0),
            ))?,
            normalized: false,
        })
    }
    fn member_reader_locked(
        &self,
        _c: &Connection,
        hash: &str,
        size: u64,
    ) -> Result<WorkMemberReader> {
        if self.preparation_leases.load(Ordering::SeqCst) >= 5 {
            return Err(fail("QUEUE_FULL"));
        }
        let lease = Lease::acquire(&self.preparation_leases);
        let parent = Parent::open(&self.directory, &format!("objects/{hash}"))?;
        let (file, _) = parent.open_file(hash)?.ok_or(fail("OBJECT_NOT_FOUND"))?;
        parent.verify()?;
        if db(file.metadata())?.len() != size {
            return Err(fail("STORAGE_UNAVAILABLE"));
        }
        Ok(WorkMemberReader {
            file,
            hash: hash.into(),
            size,
            _lease: lease,
        })
    }
    pub fn work_candidate_member(
        &self,
        item: &str,
        candidate: &str,
        member: &str,
        role: &str,
    ) -> Result<WorkMemberReader> {
        let c = db(self.connection.lock())?;
        let view = self.work_candidate_locked(&c, item, candidate)?;
        let raw: String = db(c.query_row(
            "SELECT changes_json FROM work_candidates WHERE id=?1 AND item_id=?2",
            params![candidate, item],
            |r| r.get(0),
        ))?;
        let changes: Vec<WorkChangeView> = parse(&raw)?;
        let change = changes
            .iter()
            .find(|x| x.member_id == member)
            .ok_or(fail("OBJECT_NOT_FOUND"))?;
        let (hash, size) = match role {
            "before" => (change.before_hash.as_ref(), change.before_size),
            "after" => (change.after_hash.as_ref(), change.after_size),
            _ => return Err(fail("OBJECT_NOT_FOUND")),
        };
        let hash = hash.ok_or(fail("OBJECT_NOT_FOUND"))?;
        let graph = if role == "before" {
            self.read_file_graph(&self.work_item_locked(&c, item)?.base_graph_hash)?
        } else {
            self.read_file_graph(&view.prepared_graph_hash)?
        };
        let file = graph.file(&change.path)?;
        if file.hash != *hash || file.size != size as u64 {
            return Err(fail("OBJECT_NOT_FOUND"));
        }
        self.member_reader_locked(&c, hash, size as u64)
    }
    pub fn graph_recoveries_page(&self, cursor: Option<&str>) -> Result<GraphRecoveryPage> {
        let c = db(self.connection.lock())?;
        let mut q=db(c.prepare("SELECT intent_hash,COUNT(*) FROM graph_recovery_members GROUP BY intent_hash ORDER BY intent_hash"))?;
        let records = db(q.query_map([], |r| {
            Ok(GraphRecoveryView {
                intent_hash: r.get(0)?,
                member_count: r.get(1)?,
            })
        }))?
        .map(db)
        .collect::<Result<Vec<_>>>()?;
        let p = read_project(&c)
            .map_err(|_| fail("STORAGE_UNAVAILABLE"))?
            .ok_or(fail("PROJECT_NOT_FOUND"))?;
        let (records, continuation) = page(records, cursor, &format!("recoveries:{}", p.id))?;
        Ok(GraphRecoveryPage {
            records,
            continuation,
        })
    }
    pub fn graph_recovery_members_page(
        &self,
        intent: &str,
        cursor: Option<&str>,
    ) -> Result<GraphRecoveryMemberPage> {
        let c = db(self.connection.lock())?;
        let mut q=db(c.prepare("SELECT relative_path,role,object_hash,byte_size FROM graph_recovery_members WHERE intent_hash=?1 ORDER BY relative_path,role,object_hash"))?;
        let mut records = vec![];
        for row in db(q.query_map([intent], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
            ))
        }))? {
            let (path, role, hash, size) = db(row)?;
            records.push(GraphRecoveryMemberView {
                member_id: digest(&(intent, &path, &role, &hash))?,
                path,
                role,
                hash,
                size,
            });
        }
        let (records, continuation) = page(records, cursor, &format!("recovery:{intent}"))?;
        Ok(GraphRecoveryMemberPage {
            records,
            continuation,
        })
    }
    pub fn graph_recovery_member_reader(
        &self,
        intent: &str,
        member: &str,
    ) -> Result<WorkMemberReader> {
        let c = db(self.connection.lock())?;
        let mut q=db(c.prepare("SELECT relative_path,role,object_hash,byte_size FROM graph_recovery_members WHERE intent_hash=?1"))?;
        for row in db(q.query_map([intent], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
            ))
        }))? {
            let (path, role, hash, size) = db(row)?;
            if digest(&(intent, &path, &role, &hash))? == member {
                return self.member_reader_locked(&c, &hash, size as u64);
            }
        }
        Err(fail("OBJECT_NOT_FOUND"))
    }
}

impl SqliteProjectRepository {
    /// Explicit recovery inspection is separate from cheap source polling. The
    /// captured intent/root and collector lease protect the outside-writer scan.
    pub fn inspect_graph_recovery(&self, intent_hash: &str) -> Result<GraphRecoveryInspection> {
        let (intent, root, project, lease, slot, worker) = {
            let c = db(self.connection.lock())?;
            if self.is_quiescing() {
                return Err(fail("WORK_CANCELLED"));
            }
            if self
                .preparation_worker
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_err()
            {
                return Err(fail("QUEUE_FULL"));
            }
            struct Slot<'a>(&'a std::sync::atomic::AtomicBool);
            impl Drop for Slot<'_> {
                fn drop(&mut self) {
                    self.0.store(false, Ordering::SeqCst);
                }
            }
            let slot = Slot(&self.preparation_worker);
            if self.preparation_leases.load(Ordering::SeqCst) >= 5 {
                return Err(fail("QUEUE_FULL"));
            }
            let lease = Lease::acquire(&self.preparation_leases);
            let worker = self.worker_guard();
            let bytes = self
                .read_intent_bytes()?
                .ok_or(fail("SOURCE_RECOVERY_STALE"))?;
            if hash(&bytes) != intent_hash {
                return Err(fail("SOURCE_RECOVERY_STALE"));
            }
            let intent: Intent = db(serde_json::from_slice(&bytes))?;
            let project = read_project(&c)
                .map_err(|_| fail("STORAGE_UNAVAILABLE"))?
                .ok_or(fail("PROJECT_NOT_FOUND"))?
                .id;
            if intent.version != 3 || intent.graph.is_none() || intent.project_id != project {
                return Err(fail("SOURCE_RECOVERY_STALE"));
            }
            let root = Parent::open(
                self.creative_root
                    .as_ref()
                    .ok_or(fail("SOURCE_CAPABILITY_UNSUPPORTED"))?,
                "project.json",
            )?;
            (intent, root, project, lease, slot, worker)
        };
        self.source_cut("work-recovery-inspection-held")?;
        let observation_fingerprint = self.graph_intent_fingerprint(&intent)?;
        let c = db(self.connection.lock())?;
        root.verify()?;
        if self.is_quiescing()
            || read_project(&c)
                .map_err(|_| fail("STORAGE_UNAVAILABLE"))?
                .is_none_or(|current| current.id != project)
            || self
                .read_intent_bytes()?
                .is_none_or(|bytes| hash(&bytes) != intent_hash)
        {
            return Err(fail("SOURCE_RECOVERY_STALE"));
        }
        drop(c);
        drop(worker);
        drop(slot);
        drop(lease);
        Ok(GraphRecoveryInspection {
            intent_hash: intent_hash.into(),
            observation_fingerprint,
        })
    }
}
