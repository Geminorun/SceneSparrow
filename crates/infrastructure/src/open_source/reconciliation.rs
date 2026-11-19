//! Explicit source resolutions share the manuscript policy/history/receipt writer.
use super::*;
impl SqliteProjectRepository {
    pub fn resolve_source(
        &self,
        request: &AuthoredSourceResolveRequest,
    ) -> Result<SourceSaveResponse> {
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
        let receipt =
            self.execute_manuscript_source_action_locked(&mut c, &command, None, Some(request))?;
        Ok(SourceSaveResponse {
            receipt,
            snapshot: self.source_snapshot_locked(&c)?,
        })
    }
    pub(crate) fn resolution_source_request(
        &self,
        c: &Connection,
        r: &AuthoredSourceResolveRequest,
    ) -> Result<SourceSaveRequest> {
        let (candidate, _) = self.validate_source_candidate(c, r)?;
        let source = match r.disposition {
            AuthoredSourceResolveRequestDisposition::Accept => {
                if r.source.is_some() {
                    return Err(fail("INVALID_REQUEST"));
                }
                if candidate.live_hash.is_none() {
                    return Err(fail("SOURCE_REQUIRED_FILE_DELETED"));
                }
                if candidate.validation_error.is_some() {
                    return Err(fail("SOURCE_CANDIDATE_INVALID"));
                }
                candidate.source.ok_or(fail("SOURCE_CANDIDATE_INVALID"))?
            }
            AuthoredSourceResolveRequestDisposition::Discard => {
                if r.source.is_some() {
                    return Err(fail("INVALID_REQUEST"));
                }
                db(String::from_utf8(self.read_object(&r.expected_hash)?))?
            }
            AuthoredSourceResolveRequestDisposition::Proposal => {
                r.source.clone().ok_or(fail("INVALID_REQUEST"))?
            }
        };
        if r.group.kind != EditGroupKind::Discrete {
            return Err(fail("INVALID_REQUEST"));
        }
        Ok(SourceSaveRequest {
            request_id: r.request_id.clone(),
            project_id: r.project_id.clone(),
            expected_working_revision: r.expected_working_revision,
            expected_generation: r.expected_generation,
            expected_hash: r.expected_hash.clone(),
            source,
            group: r.group.clone(),
        })
    }
    pub(super) fn validate_source_candidate(
        &self,
        c: &Connection,
        r: &AuthoredSourceResolveRequest,
    ) -> Result<(AuthoredSourceCandidate, Option<Identity>)> {
        if !manuscript::uuid4(&r.candidate_id) {
            return Err(fail("INVALID_REQUEST"));
        }
        let (project_id, path, accepted, generation) =
            source_row(c)?.ok_or(fail("SOURCE_CAPABILITY_UNSUPPORTED"))?;
        let (candidate, identity) = self.source_candidate_locked(c, &r.candidate_id)?;
        if candidate.project_id != project_id
            || r.project_id != project_id
            || candidate.base_hash != accepted
            || candidate.base_generation != generation
            || r.expected_generation != generation
            || r.expected_hash != accepted
            || r.candidate_hash != candidate.live_hash
            || candidate.disposition != AuthoredSourceCandidateDisposition::Pending
        {
            return Err(fail("SOURCE_CANDIDATE_STALE"));
        }
        let parent = Parent::open(
            self.creative_root
                .as_ref()
                .ok_or(fail("SOURCE_RECOVERY_REQUIRED"))?,
            &path,
        )?;
        let live = parent.read(&parent.name, false)?;
        if !matches_physical(live.as_ref(), &candidate.live_hash, &identity) {
            return Err(fail("SOURCE_CANDIDATE_STALE"));
        }
        Ok((candidate, identity))
    }
}
