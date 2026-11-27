//! The external engine never receives this document port.
use crate::markdown_projects::{MarkdownProjects, digest};
use scenesparrow_application::external_agent::{
    AgentDocuments, CapturedDocument, MAX_OUTPUT_BYTES, Result,
};
use scenesparrow_domain::{contracts::*, manuscript::MAX_TEXT_BYTES};

fn selection(text: &str, selected: &AgentSelection) -> Result<std::ops::Range<usize>> {
    let start = usize::try_from(selected.range.start).map_err(|_| "AGENT_SELECTION_INVALID")?;
    let end = usize::try_from(selected.range.end).map_err(|_| "AGENT_SELECTION_INVALID")?;
    if start >= end
        || selected.quote.len() > MAX_OUTPUT_BYTES
        || text.get(start..end) != Some(selected.quote.as_str())
    {
        return Err("AGENT_SELECTION_INVALID");
    }
    Ok(start..end)
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct BatchReceipt {
    proposal: AgentProposal,
    document: MarkdownDocument,
    settled: bool,
}
fn batch_context(text: &str, annotations: MarkdownAnnotations) -> AgentBatchContext {
    let comments: Vec<_> = annotations
        .comments
        .into_iter()
        .filter(|c| c.status == MarkdownCommentStatus::Open)
        .collect();
    let mut scopes: Vec<AgentEditScope> = vec![];
    let mut unresolved = vec![];
    let mut located: Vec<_> = comments
        .iter()
        .filter_map(|c| match (c.anchor.resolved_start, c.anchor.resolved_end) {
            (Some(start), Some(end)) => Some((start, end, c.id.clone())),
            _ => {
                unresolved.push(AgentUnresolved {
                    comment_ids: vec![c.id.clone()],
                    reason: AgentUnresolvedReason::Detached,
                });
                None
            }
        })
        .collect();
    located.sort_by_key(|(start, end, _)| (*start, *end));
    for (start, end, id) in located {
        if let Some(scope) = scopes.last_mut().filter(|s| start < s.selection.range.end) {
            scope.selection.range.end = scope.selection.range.end.max(end);
            scope.comment_ids.push(id);
        } else {
            scopes.push(AgentEditScope {
                id: format!("scope-{id}"),
                selection: AgentSelection {
                    range: MarkdownRange { start, end },
                    quote: String::new(),
                },
                comment_ids: vec![id],
            });
        }
    }
    scopes.retain_mut(|scope| {
        let range = &scope.selection.range;
        let locked = annotations.locks.iter().flat_map(|l| &l.anchors).any(|a| {
            match (a.resolved_start, a.resolved_end) {
                (Some(start), Some(end)) => range.start < end && range.end > start,
                _ => true,
            }
        });
        if locked {
            unresolved.push(AgentUnresolved {
                comment_ids: scope.comment_ids.clone(),
                reason: AgentUnresolvedReason::Locked,
            });
            false
        } else {
            scope.selection.quote = text[range.start as usize..range.end as usize].into();
            true
        }
    });
    AgentBatchContext {
        comments,
        locks: annotations.locks,
        scopes,
        unresolved,
    }
}
impl MarkdownProjects {
    fn write_conversation_file(
        &self,
        project: &str,
        name: &str,
        value: &impl serde::Serialize,
    ) -> Result<()> {
        use crate::markdown_projects::{io, regular};
        use std::io::Write;
        let _guard = self
            .writer
            .lock()
            .map_err(|_| "MARKDOWN_STORAGE_UNAVAILABLE")?;
        let directory = self.validated_directory(project)?.join("conversations");
        if !directory
            .try_exists()
            .map_err(|_| "MARKDOWN_STORAGE_UNAVAILABLE")?
        {
            io(std::fs::create_dir(&directory))?;
        }
        regular(&directory, true)?;
        let path = directory.join(name);
        if path
            .try_exists()
            .map_err(|_| "MARKDOWN_STORAGE_UNAVAILABLE")?
        {
            regular(&path, false)?;
        }
        let bytes = serde_json::to_vec(value).map_err(|_| "AGENT_STATE_UNAVAILABLE")?;
        if bytes.len() > 4 * 1024 * 1024 {
            return Err("AGENT_SESSION_LIMIT");
        }
        let mut file = io(atomic_write_file::AtomicWriteFile::open(path))?;
        io(file.write_all(&bytes))?;
        io(file.commit())
    }
    fn apply_batch_inner(&self, proposal: &AgentProposal) -> Result<MarkdownDocument> {
        if uuid::Uuid::parse_str(&proposal.id)
            .ok()
            .map(|v| v.to_string())
            .as_deref()
            != Some(&proposal.id)
        {
            return Err("AGENT_PROPOSAL_STALE");
        }
        let context = &proposal.context;
        let batch = proposal.batch.as_ref().ok_or("AGENT_OUTPUT_INVALID")?;
        let captured = context.batch.as_ref().ok_or("AGENT_OUTPUT_INVALID")?;
        let name = format!("agent-apply-{}.json", proposal.id);
        let receipt: Option<BatchReceipt> = self.sidecar(&context.project_id, &name)?;
        if let Some(receipt) = &receipt {
            if receipt.proposal != *proposal {
                return Err("AGENT_PROPOSAL_STALE");
            }
            if receipt.settled {
                return Ok(receipt.document.clone());
            }
        }
        let doc = self.read_document_inner(&context.project_id, context.kind.clone())?;
        let mut comments = vec![];
        let mut edits = vec![];
        let mut seen = std::collections::HashSet::new();
        for change in &batch.changes {
            let scope = captured
                .scopes
                .iter()
                .find(|s| s.id == change.scope_id)
                .ok_or("AGENT_OUTPUT_INVALID")?;
            if !seen.insert(&change.scope_id)
                || change.text.contains('\0')
                || change.text.len() > MAX_OUTPUT_BYTES
                || change.text == scope.selection.quote
            {
                return Err("AGENT_OUTPUT_INVALID");
            }
            for id in &scope.comment_ids {
                comments.push(
                    captured
                        .comments
                        .iter()
                        .find(|c| c.id == *id)
                        .ok_or("AGENT_OUTPUT_INVALID")?
                        .clone(),
                );
            }
            edits.push((scope, change));
        }
        if edits.is_empty() {
            return Err("AGENT_OUTPUT_INVALID");
        }
        edits.sort_by_key(|(s, _)| s.selection.range.start);
        if edits
            .windows(2)
            .any(|w| w[0].0.selection.range.end > w[1].0.selection.range.start)
        {
            return Err("AGENT_OUTPUT_INVALID");
        }
        let mut receipt = match receipt {
            Some(receipt) => receipt,
            None => {
                if doc.revision != context.revision || digest(&doc.text) != context.source_digest {
                    return Err("MARKDOWN_CONFLICT");
                }
                self.check_agent_comments(&context.project_id, &comments, false)?;
                let mut text = doc.text.clone();
                for (scope, change) in edits.iter().rev() {
                    let range = selection(&doc.text, &scope.selection)?;
                    self.agent_locks(&context.project_id, context.kind.clone(), &range)?;
                    text.replace_range(range, &change.text);
                }
                let document = MarkdownDocument {
                    project_id: context.project_id.clone(),
                    kind: context.kind.clone(),
                    revision: Some(digest(&text)),
                    text,
                };
                let receipt = BatchReceipt {
                    proposal: proposal.clone(),
                    document,
                    settled: false,
                };
                // Persist the exact target before the one Markdown write, so an acknowledgement gap is recoverable.
                self.write_sidecar(&context.project_id, &name, &receipt)?;
                receipt
            }
        };
        if doc != receipt.document {
            if doc.revision != context.revision || digest(&doc.text) != context.source_digest {
                return Err("MARKDOWN_CONFLICT");
            }
            self.check_agent_comments(&context.project_id, &comments, false)?;
            for (scope, _) in &edits {
                let range = selection(&doc.text, &scope.selection)?;
                self.agent_locks(&context.project_id, context.kind.clone(), &range)?;
            }
            self.save_document_inner(
                &context.project_id,
                context.kind.clone(),
                context.revision.as_deref(),
                receipt.document.text.clone(),
                None,
            )?;
        }
        self.check_agent_comments(&context.project_id, &comments, true)?;
        receipt.settled = true;
        self.write_sidecar(&context.project_id, &name, &receipt)?;
        Ok(receipt.document)
    }
    fn agent_locks(
        &self,
        project: &str,
        kind: MarkdownDocumentKind,
        range: &std::ops::Range<usize>,
    ) -> Result<()> {
        // Resolve every live lock under the same writer mutex; a detached lock fails closed.
        for lock in self.annotations_inner(project, kind)?.locks {
            for anchor in lock.anchors {
                let start = anchor.resolved_start.ok_or("MARKDOWN_LOCK_CONFLICT")? as usize;
                let end = anchor.resolved_end.ok_or("MARKDOWN_LOCK_CONFLICT")? as usize;
                if range.start < end && range.end > start {
                    return Err("MARKDOWN_LOCKED");
                }
            }
        }
        Ok(())
    }
}
impl AgentDocuments for MarkdownProjects {
    fn authorize(&self, project: &str) -> Result<()> {
        let _guard = self
            .writer
            .lock()
            .map_err(|_| "MARKDOWN_STORAGE_UNAVAILABLE")?;
        self.validated_directory(project).map(|_| ())
    }
    fn conversations(&self, project: &str) -> Result<AgentConversationHistory> {
        use crate::markdown_projects::{io, read, regular};
        let _guard = self
            .writer
            .lock()
            .map_err(|_| "MARKDOWN_STORAGE_UNAVAILABLE")?;
        let directory = self.validated_directory(project)?.join("conversations");
        if !directory
            .try_exists()
            .map_err(|_| "MARKDOWN_STORAGE_UNAVAILABLE")?
        {
            return Ok(AgentConversationHistory {
                current_id: None,
                conversations: vec![],
            });
        }
        regular(&directory, true)?;
        let mut conversations = vec![];
        let mut current_id = None;
        for (count, entry) in io(std::fs::read_dir(&directory))?.enumerate() {
            if count > 256 {
                return Err("AGENT_SESSION_LIMIT");
            }
            let path = io(entry)?.path();
            if path.file_name().and_then(|s| s.to_str()) == Some("current.json") {
                current_id = serde_json::from_slice(&read(&path, 1024)?)
                    .map_err(|_| "AGENT_STATE_UNAVAILABLE")?;
            } else if path
                .file_name()
                .and_then(|s| s.to_str())
                .is_some_and(|name| name.starts_with("summary-") && name.ends_with(".json"))
            {
                if conversations.len() >= 128 {
                    return Err("AGENT_SESSION_LIMIT");
                }
                let view: AgentConversationSummary = serde_json::from_slice(&read(&path, 4096)?)
                    .map_err(|_| "AGENT_STATE_UNAVAILABLE")?;
                if view.project_id != project || uuid::Uuid::parse_str(&view.id).is_err() {
                    return Err("AGENT_STATE_UNAVAILABLE");
                }
                conversations.push(view);
            }
        }
        conversations.sort_by_key(|view| std::cmp::Reverse(view.updated_at));
        Ok(AgentConversationHistory {
            current_id,
            conversations,
        })
    }
    fn load_conversation(&self, project: &str, id: &str) -> Result<AgentSession> {
        use crate::markdown_projects::{read, regular};
        if uuid::Uuid::parse_str(id)
            .ok()
            .map(|v| v.to_string())
            .as_deref()
            != Some(id)
        {
            return Err("AGENT_REQUEST_INVALID");
        }
        let _guard = self
            .writer
            .lock()
            .map_err(|_| "MARKDOWN_STORAGE_UNAVAILABLE")?;
        let directory = self.validated_directory(project)?.join("conversations");
        regular(&directory, true)?;
        let path = directory.join(format!("{id}.json"));
        let view: AgentSession = serde_json::from_slice(&read(&path, 4 * 1024 * 1024)?)
            .map_err(|_| "AGENT_STATE_UNAVAILABLE")?;
        if view.id != id
            || view.project_id != project
            || view.turns.len() > 32
            || view.generations.len() > 32
            || view.turns.iter().any(|t| {
                t.context.project_id != project
                    || t.proposal.as_ref().is_some_and(|p| p.context != t.context)
            })
        {
            return Err("AGENT_STATE_UNAVAILABLE");
        }
        Ok(view)
    }
    fn save_conversation(&self, view: &AgentSession) -> Result<()> {
        if uuid::Uuid::parse_str(&view.id)
            .ok()
            .map(|v| v.to_string())
            .as_deref()
            != Some(&view.id)
        {
            return Err("AGENT_REQUEST_INVALID");
        }
        let exists = {
            let _guard = self
                .writer
                .lock()
                .map_err(|_| "MARKDOWN_STORAGE_UNAVAILABLE")?;
            self.validated_directory(&view.project_id)?
                .join("conversations")
                .join(format!("{}.json", view.id))
                .try_exists()
                .map_err(|_| "MARKDOWN_STORAGE_UNAVAILABLE")?
        };
        if !exists && self.conversations(&view.project_id)?.conversations.len() >= 128 {
            return Err("AGENT_SESSION_LIMIT");
        }
        self.write_conversation_file(&view.project_id, &format!("{}.json", view.id), view)?;
        let summary = AgentConversationSummary {
            id: view.id.clone(),
            project_id: view.project_id.clone(),
            title: view.title.clone(),
            updated_at: view.updated_at,
            engine_id: view.engine_id.clone(),
            model_id: view.model_id.clone(),
        };
        self.write_conversation_file(
            &view.project_id,
            &format!("summary-{}.json", view.id),
            &summary,
        )
    }
    fn select_conversation(&self, project: &str, id: Option<&str>) -> Result<()> {
        self.write_conversation_file(project, "current.json", &id)
    }
    fn capture(&self, project: &str, attachment: &AgentAttachment) -> Result<CapturedDocument> {
        let _guard = self
            .writer
            .lock()
            .map_err(|_| "MARKDOWN_STORAGE_UNAVAILABLE")?;
        let saved = self.read_document_inner(project, attachment.kind.clone())?;
        if attachment.revision != saved.revision {
            return Err("MARKDOWN_CONFLICT");
        }
        let text = match &attachment.buffer {
            Some(buffer)
                if attachment.selection.is_none()
                    && buffer.len() <= MAX_OUTPUT_BYTES
                    && !buffer.contains('\0') =>
            {
                buffer.clone()
            }
            Some(_) => return Err("AGENT_CONTEXT_INVALID"),
            None => saved.text.clone(),
        };
        if text.len() > MAX_TEXT_BYTES
            || text.contains('\0')
            || digest(&text) != attachment.source_digest
        {
            return Err("AGENT_CONTEXT_INVALID");
        }
        if let Some(selected) = &attachment.selection {
            if saved.revision.is_none() {
                return Err("AGENT_SELECTION_INVALID");
            }
            selection(&text, selected)?;
        }
        Ok(CapturedDocument {
            context: AgentContext {
                batch: if attachment.selection.is_none() && text == saved.text {
                    Some(Box::new(batch_context(
                        &text,
                        self.annotations_inner(project, attachment.kind.clone())?,
                    )))
                } else {
                    None
                },
                project_id: project.into(),
                kind: attachment.kind.clone(),
                revision: saved.revision,
                source_digest: digest(&text),
                selection: attachment.selection.clone(),
            },
            text,
        })
    }
    fn recover_apply(&self, proposal: &AgentProposal) -> Result<Option<MarkdownDocument>> {
        if proposal.batch.is_none() {
            return Ok(None);
        }
        let _guard = self
            .writer
            .lock()
            .map_err(|_| "MARKDOWN_STORAGE_UNAVAILABLE")?;
        if uuid::Uuid::parse_str(&proposal.id)
            .ok()
            .map(|v| v.to_string())
            .as_deref()
            != Some(&proposal.id)
        {
            return Err("AGENT_PROPOSAL_STALE");
        }
        let receipt: Option<BatchReceipt> = self.sidecar(
            &proposal.context.project_id,
            &format!("agent-apply-{}.json", proposal.id),
        )?;
        if let Some(receipt) = receipt
            && (receipt.settled
                || self.read_document_inner(
                    &proposal.context.project_id,
                    proposal.context.kind.clone(),
                )? == receipt.document)
        {
            return self.apply_batch_inner(proposal).map(Some);
        }
        Ok(None)
    }
    fn apply(&self, proposal: &AgentProposal) -> Result<MarkdownDocument> {
        let _guard = self
            .writer
            .lock()
            .map_err(|_| "MARKDOWN_STORAGE_UNAVAILABLE")?;
        if proposal.batch.is_some() {
            return self.apply_batch_inner(proposal);
        }
        let context = &proposal.context;
        let doc = self.read_document_inner(&context.project_id, context.kind.clone())?;
        if doc.revision != context.revision || digest(&doc.text) != context.source_digest {
            return Err("MARKDOWN_CONFLICT");
        }
        let range = selection(
            &doc.text,
            context
                .selection
                .as_ref()
                .ok_or("AGENT_SELECTION_INVALID")?,
        )?;
        self.agent_locks(&context.project_id, context.kind.clone(), &range)?;
        if proposal.text.len() > MAX_OUTPUT_BYTES || proposal.text.contains('\0') {
            return Err("AGENT_OUTPUT_INVALID");
        }
        let mut text = doc.text;
        text.replace_range(range, &proposal.text);
        // The established writer rechecks revision, complete-result size and all structural locks.
        self.save_document_inner(
            &context.project_id,
            context.kind.clone(),
            context.revision.as_deref(),
            text,
            None,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ewa_saved_capture_rejects_utf8_splits_and_bounds_unsaved_questions() {
        let root = tempfile::tempdir().unwrap();
        let store = MarkdownProjects::open(root.path()).unwrap();
        let project = store.create("Prefix 中文 suffix".into()).unwrap();
        let start = project.text.find('中').unwrap();
        let mut attachment = AgentAttachment {
            kind: MarkdownDocumentKind::Manuscript,
            revision: Some(project.revision.clone()),
            source_digest: project.revision.clone(),
            selection: Some(AgentSelection {
                range: MarkdownRange {
                    start: (start + 1) as i64,
                    end: (start + 3) as i64,
                },
                quote: "中".into(),
            }),
            buffer: None,
        };
        assert_eq!(
            store.capture(&project.project_id, &attachment).err(),
            Some("AGENT_SELECTION_INVALID")
        );
        attachment.selection.as_mut().unwrap().range.start = start as i64;
        assert_eq!(
            store
                .capture(&project.project_id, &attachment)
                .unwrap()
                .context
                .selection
                .unwrap()
                .quote,
            "中"
        );
        // Locked source stays readable; even an identical replacement must still fail Apply.
        store
            .annotate(
                &project.project_id,
                MarkdownDocumentKind::Manuscript,
                MarkdownAnnotationAction::Lock {
                    revision: project.revision.clone(),
                    ranges: vec![MarkdownRange {
                        start: 0,
                        end: project.text.len() as i64,
                    }],
                },
            )
            .unwrap();
        let locked = store.capture(&project.project_id, &attachment).unwrap();
        assert_eq!(
            store
                .apply(&AgentProposal {
                    batch: None,
                    id: "no-op".into(),
                    context: locked.context,
                    text: "中".into()
                })
                .unwrap_err(),
            "MARKDOWN_LOCKED"
        );
        attachment.buffer = Some(project.text.clone());
        assert_eq!(
            store.capture(&project.project_id, &attachment).err(),
            Some("AGENT_CONTEXT_INVALID")
        );
        attachment.selection = None;
        attachment.buffer = Some("Unsaved question context 中文".into());
        attachment.source_digest = digest(attachment.buffer.as_deref().unwrap());
        let captured = store.capture(&project.project_id, &attachment).unwrap();
        assert_eq!(captured.text, "Unsaved question context 中文");
        assert_eq!(store.read(&project.project_id).unwrap(), project);
        attachment.buffer = Some("x".repeat(MAX_OUTPUT_BYTES + 1));
        attachment.source_digest = digest(attachment.buffer.as_deref().unwrap());
        assert_eq!(
            store.capture(&project.project_id, &attachment).err(),
            Some("AGENT_CONTEXT_INVALID")
        );
    }
    #[test]
    fn ewa_outline_proposals_preserve_surrounding_bytes_and_document_identity() {
        let root = tempfile::tempdir().unwrap();
        let store = MarkdownProjects::open(root.path()).unwrap();
        let project = store.create("Manuscript must stay".into()).unwrap();
        let outline = store
            .save_document(
                &project.project_id,
                MarkdownDocumentKind::Outline,
                None,
                "\u{feff}# Start\r\n\r\n* Target 中文\r\n* Tail\r\n".into(),
            )
            .unwrap();
        let start = outline.text.find("Target 中文").unwrap();
        let attachment = AgentAttachment {
            kind: MarkdownDocumentKind::Outline,
            revision: outline.revision.clone(),
            source_digest: digest(&outline.text),
            selection: Some(AgentSelection {
                range: MarkdownRange {
                    start: start as i64,
                    end: (start + "Target 中文".len()) as i64,
                },
                quote: "Target 中文".into(),
            }),
            buffer: None,
        };
        let captured = store.capture(&project.project_id, &attachment).unwrap();
        let proposal = AgentProposal {
            batch: None,
            id: "fixture-proposal".into(),
            context: captured.context,
            text: "Replacement".into(),
        };
        let changed = store.apply(&proposal).unwrap();
        assert_eq!(
            changed.text,
            "\u{feff}# Start\r\n\r\n* Replacement\r\n* Tail\r\n"
        );
        assert_eq!(store.read(&project.project_id).unwrap(), project);
    }
}

#[cfg(test)]
mod conversation_tests {
    use super::*;
    use scenesparrow_application::external_agent::*;
    use std::sync::{Arc, atomic::AtomicBool};
    struct Fixture;
    impl WritingAgent for Fixture {
        fn check(&self, _: &str, _: &str) -> Result<()> {
            Ok(())
        }
        fn run(
            &self,
            _: AgentInput,
            _: Arc<AtomicBool>,
            _: &mut dyn FnMut(AgentDelta) -> Result<()>,
        ) -> Result<AgentOutput> {
            unreachable!()
        }
    }
    #[test]
    fn awr_ac03_restart_restores_context_dispositions_results_and_interrupted_retry() {
        let root = tempfile::tempdir().unwrap();
        let store = Arc::new(MarkdownProjects::open(root.path()).unwrap());
        let project = store.create("Target 中文".into()).unwrap();
        let sessions = AgentSessions::new(store.clone(), Arc::new(Fixture));
        let owner = sessions
            .create(
                &project.project_id,
                AgentCreateSession {
                    request_id: "create".into(),
                    engine_id: "fixture".into(),
                    model_id: "model".into(),
                },
            )
            .unwrap();
        let request = |id: &str| AgentSendTurn {
            request_id: id.into(),
            instruction: "First instruction 中文".into(),
            attachment: AgentAttachment {
                kind: MarkdownDocumentKind::Manuscript,
                revision: Some(project.revision.clone()),
                source_digest: project.revision.clone(),
                selection: Some(AgentSelection {
                    range: MarkdownRange {
                        start: 0,
                        end: project.text.len() as i64,
                    },
                    quote: project.text.clone(),
                }),
                buffer: None,
            },
        };
        let (first, _) = sessions
            .start(&project.project_id, &owner.id, request("first"))
            .unwrap();
        sessions
            .release_dispatch(&project.project_id, &owner.id, &first.id)
            .unwrap();
        sessions
            .finish(
                &project.project_id,
                &owner.id,
                &first.id,
                Ok(AgentOutput {
                    changes: None,
                    reply: "Saved reply".into(),
                    replacement: Some("Revised 中文".into()),
                }),
            )
            .unwrap();
        let proposal = sessions.read(&project.project_id, &owner.id).unwrap().turns[0]
            .proposal
            .as_ref()
            .unwrap()
            .id
            .clone();
        let result = sessions
            .apply(&project.project_id, &owner.id, &first.id, &proposal)
            .unwrap();
        sessions
            .conversation_action(
                &project.project_id,
                &owner.id,
                AgentConversationAction {
                    action: AgentConversationActionAction::Rename,
                    value: "Renamed conversation".into(),
                },
            )
            .unwrap();
        sessions
            .record_generation(
                &project.project_id,
                &owner.id,
                AgentGeneration {
                    id: "generation".into(),
                    kind: AgentGenerationKind::Outline,
                    instruction: "Outline brief".into(),
                    text: "# Durable outline".into(),
                    status: AgentTurnStatus::Completed,
                    error_code: None,
                    revision: result.revision.clone(),
                    outline_revision: None,
                    created_at: 1,
                },
            )
            .unwrap();
        drop(sessions);
        let restarted = AgentSessions::new(store.clone(), Arc::new(Fixture));
        let restored = restarted.read(&project.project_id, &owner.id).unwrap();
        assert_eq!(restored.title, "Renamed conversation");
        assert_eq!(restored.turns[0].reply, "Saved reply");
        assert_eq!(restored.turns[0].outcome, Some(AgentTurnOutcome::Applied));
        assert_eq!(restored.generations[0].text, "# Durable outline");
        assert_eq!(
            restarted
                .apply(&project.project_id, &owner.id, &first.id, &proposal)
                .unwrap(),
            result
        );
        let summary = restarted.history(&project.project_id).unwrap();
        assert_eq!(summary.current_id.as_deref(), Some(owner.id.as_str()));
        assert_eq!(summary.conversations.len(), 1);
        let saved = store.read(&project.project_id).unwrap();
        let mut follow = request("interrupted");
        follow.attachment.revision = Some(saved.revision.clone());
        follow.attachment.source_digest = saved.revision;
        follow.attachment.selection = None;
        let (pending, dispatch) = restarted
            .start(&project.project_id, &owner.id, follow.clone())
            .unwrap();
        let history = dispatch.unwrap().input.history;
        assert_eq!(history.len(), 2);
        assert!(history.iter().any(|h| h.reply == "Saved reply"));
        drop(restarted);
        let restarted = AgentSessions::new(store.clone(), Arc::new(Fixture));
        let restored = restarted.read(&project.project_id, &owner.id).unwrap();
        assert_eq!(restored.turns[1].id, pending.id);
        assert_eq!(restored.turns[1].status, AgentTurnStatus::Failed);
        assert_eq!(
            restored.turns[1].error_code.as_deref(),
            Some("AGENT_INTERRUPTED")
        );
        follow.request_id = "explicit-retry".into();
        assert!(
            restarted
                .start(&project.project_id, &owner.id, follow)
                .unwrap()
                .1
                .is_some()
        );
        // A proposal discarded before restart cannot acquire a write path afterward.
        let other = sessions_for_discard(store.clone(), &project.project_id);
        let id = other.0;
        let turn = other.1;
        let proposal = other.2;
        let restarted = AgentSessions::new(store.clone(), Arc::new(Fixture));
        assert_eq!(
            restarted
                .apply(&project.project_id, &id, &turn, &proposal)
                .unwrap_err(),
            "AGENT_PROPOSAL_STALE"
        );
    }
    fn sessions_for_discard(
        store: Arc<MarkdownProjects>,
        project: &str,
    ) -> (String, String, String) {
        let sessions = AgentSessions::new(store.clone(), Arc::new(Fixture));
        let saved = store.read(project).unwrap();
        let owner = sessions
            .create(
                project,
                AgentCreateSession {
                    request_id: "discard".into(),
                    engine_id: "fixture".into(),
                    model_id: "model".into(),
                },
            )
            .unwrap();
        let (turn, _) = sessions
            .start(
                project,
                &owner.id,
                AgentSendTurn {
                    request_id: "discard-turn".into(),
                    instruction: "Discard this".into(),
                    attachment: AgentAttachment {
                        kind: MarkdownDocumentKind::Manuscript,
                        revision: Some(saved.revision.clone()),
                        source_digest: saved.revision,
                        selection: Some(AgentSelection {
                            range: MarkdownRange {
                                start: 0,
                                end: saved.text.len() as i64,
                            },
                            quote: saved.text,
                        }),
                        buffer: None,
                    },
                },
            )
            .unwrap();
        sessions
            .release_dispatch(project, &owner.id, &turn.id)
            .unwrap();
        sessions
            .finish(
                project,
                &owner.id,
                &turn.id,
                Ok(AgentOutput {
                    changes: None,
                    reply: "Preview".into(),
                    replacement: Some("Discarded replacement".into()),
                }),
            )
            .unwrap();
        let proposal = sessions.read(project, &owner.id).unwrap().turns[0]
            .proposal
            .as_ref()
            .unwrap()
            .id
            .clone();
        sessions
            .conversation_action(
                project,
                &owner.id,
                AgentConversationAction {
                    action: AgentConversationActionAction::Discard,
                    value: turn.id.clone(),
                },
            )
            .unwrap();
        (owner.id, turn.id, proposal)
    }
}

#[cfg(test)]
mod batch_tests {
    use super::*;
    use scenesparrow_application::external_agent::*;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    struct Fixture;
    impl WritingAgent for Fixture {
        fn check(&self, _: &str, _: &str) -> Result<()> {
            Ok(())
        }
        fn run(
            &self,
            _: AgentInput,
            _: Arc<AtomicBool>,
            _: &mut dyn FnMut(AgentDelta) -> Result<()>,
        ) -> Result<AgentOutput> {
            unreachable!()
        }
    }
    fn range(text: &str, quote: &str) -> MarkdownRange {
        let start = text.find(quote).unwrap();
        MarkdownRange {
            start: start as i64,
            end: (start + quote.len()) as i64,
        }
    }
    fn setup(
        kind: MarkdownDocumentKind,
    ) -> (tempfile::TempDir, Arc<MarkdownProjects>, MarkdownDocument) {
        let root = tempfile::tempdir().unwrap();
        let store = Arc::new(MarkdownProjects::open(root.path()).unwrap());
        let project = store.create("Untouched manuscript".into()).unwrap();
        let doc = store.save_document(&project.project_id, kind.clone(), (kind == MarkdownDocumentKind::Manuscript).then_some(project.revision.as_str()), "\u{feff}# 城市 · City\r\n\r\nFirst 中文\r\n\r\nSecond detail\r\n\r\nLocked ending\r\n".into()).unwrap();
        for quote in ["First 中文", "Second detail", "Locked ending"] {
            store
                .annotate(
                    &doc.project_id,
                    kind.clone(),
                    MarkdownAnnotationAction::Comment {
                        revision: doc.revision.clone().unwrap(),
                        range: range(&doc.text, quote),
                        text: format!("Improve {quote}"),
                    },
                )
                .unwrap();
        }
        store
            .annotate(
                &doc.project_id,
                kind,
                MarkdownAnnotationAction::Lock {
                    revision: doc.revision.clone().unwrap(),
                    ranges: vec![range(&doc.text, "Locked ending")],
                },
            )
            .unwrap();
        (root, store, doc)
    }
    fn start(
        store: Arc<MarkdownProjects>,
        doc: &MarkdownDocument,
        mode: &str,
    ) -> (AgentSessions, AgentSession, AgentTurn) {
        let sessions = AgentSessions::new(store, Arc::new(Fixture));
        let owner = sessions
            .create(
                &doc.project_id,
                AgentCreateSession {
                    request_id: "create".into(),
                    engine_id: "fixture".into(),
                    model_id: "model".into(),
                },
            )
            .unwrap();
        let (turn, dispatch) = sessions
            .start(
                &doc.project_id,
                &owner.id,
                AgentSendTurn {
                    request_id: "send".into(),
                    instruction: "Revise this draft".into(),
                    attachment: AgentAttachment {
                        kind: doc.kind.clone(),
                        revision: doc.revision.clone(),
                        source_digest: digest(&doc.text),
                        selection: None,
                        buffer: None,
                    },
                },
            )
            .unwrap();
        let input = dispatch.unwrap().input;
        assert_eq!(input.text, doc.text);
        let batch = input.context.batch.unwrap();
        assert_eq!(batch.comments.len(), 3);
        assert_eq!(batch.scopes.len(), 2);
        assert_eq!(batch.unresolved[0].reason, AgentUnresolvedReason::Locked);
        sessions
            .release_dispatch(&doc.project_id, &owner.id, &turn.id)
            .unwrap();
        let mut changes: Vec<_> = batch
            .scopes
            .iter()
            .enumerate()
            .map(|(n, s)| AgentBatchChange {
                scope_id: s.id.clone(),
                text: format!("Revised {} 中文", n + 1),
            })
            .collect();
        match mode {
            "question" => changes.clear(),
            "unknown" => changes[0].scope_id = "unknown".into(),
            "clarification" => changes.truncate(1),
            _ => {}
        }
        sessions
            .finish(
                &doc.project_id,
                &owner.id,
                &turn.id,
                Ok(AgentOutput {
                    reply: "Two changes; one locked comment remains.".into(),
                    replacement: None,
                    changes: Some(changes),
                }),
            )
            .unwrap();
        let turn = sessions
            .read(&doc.project_id, &owner.id)
            .unwrap()
            .turns
            .remove(0);
        (sessions, owner, turn)
    }
    #[test]
    fn awr_ac06_questions_unknown_scopes_and_clarification_never_invent_edits() {
        for mode in ["question", "unknown", "clarification"] {
            let (_root, store, doc) = setup(MarkdownDocumentKind::Outline);
            let (_sessions, _owner, turn) = start(store.clone(), &doc, mode);
            match mode {
                "unknown" => {
                    assert_eq!(turn.status, AgentTurnStatus::Failed);
                    assert!(turn.proposal.is_none());
                }
                "question" => {
                    assert_eq!(turn.status, AgentTurnStatus::Completed);
                    assert!(turn.proposal.is_none());
                }
                _ => {
                    let batch = turn.proposal.unwrap().batch.unwrap();
                    assert_eq!(batch.changes.len(), 1);
                    assert_eq!(batch.unresolved.len(), 2);
                    assert!(
                        batch
                            .unresolved
                            .iter()
                            .any(|u| u.reason == AgentUnresolvedReason::Clarification)
                    );
                }
            }
            assert_eq!(
                store
                    .read_document(&doc.project_id, doc.kind.clone())
                    .unwrap(),
                doc
            );
            assert!(
                store
                    .annotations(&doc.project_id, doc.kind)
                    .unwrap()
                    .comments
                    .iter()
                    .all(|c| c.status == MarkdownCommentStatus::Open)
            );
        }
    }
    #[test]
    fn awr_ac06_two_changes_one_locked_in_both_documents_and_durable_dispositions() {
        for kind in [
            MarkdownDocumentKind::Manuscript,
            MarkdownDocumentKind::Outline,
        ] {
            let (_root, store, doc) = setup(kind);
            let (sessions, owner, turn) = start(store.clone(), &doc, "normal");
            let proposal = turn.proposal.unwrap();
            let result = sessions
                .apply(&doc.project_id, &owner.id, &turn.id, &proposal.id)
                .unwrap();
            let expected = doc
                .text
                .replace("First 中文", "Revised 1 中文")
                .replace("Second detail", "Revised 2 中文");
            assert_eq!(
                store
                    .read_document(&doc.project_id, doc.kind.clone())
                    .unwrap()
                    .text,
                expected
            );
            let notes = store
                .annotations(&doc.project_id, doc.kind.clone())
                .unwrap()
                .comments;
            assert_eq!(
                notes
                    .iter()
                    .filter(|c| c.status == MarkdownCommentStatus::Resolved)
                    .count(),
                2
            );
            assert_eq!(
                notes
                    .iter()
                    .find(|c| c.status == MarkdownCommentStatus::Open)
                    .unwrap()
                    .anchor
                    .quote,
                "Locked ending"
            );
            let modified =
                std::fs::metadata(store.validated_directory(&doc.project_id).unwrap().join(
                    if doc.kind == MarkdownDocumentKind::Outline {
                        "outline.md"
                    } else {
                        "manuscript.md"
                    },
                ))
                .unwrap()
                .modified()
                .unwrap();
            assert_eq!(
                sessions
                    .apply(&doc.project_id, &owner.id, &turn.id, &proposal.id)
                    .unwrap(),
                result
            );
            drop(sessions);
            let restarted = AgentSessions::new(store.clone(), Arc::new(Fixture));
            assert_eq!(
                restarted
                    .apply(&doc.project_id, &owner.id, &turn.id, &proposal.id)
                    .unwrap(),
                result
            );
            let restored = restarted.read(&doc.project_id, &owner.id).unwrap();
            assert_eq!(restored.turns[0].outcome, Some(AgentTurnOutcome::Applied));
            assert_eq!(
                std::fs::metadata(store.validated_directory(&doc.project_id).unwrap().join(
                    if doc.kind == MarkdownDocumentKind::Outline {
                        "outline.md"
                    } else {
                        "manuscript.md"
                    }
                ))
                .unwrap()
                .modified()
                .unwrap(),
                modified
            );
            if doc.kind == MarkdownDocumentKind::Outline {
                assert_eq!(
                    store.read(&doc.project_id).unwrap().text,
                    "Untouched manuscript"
                );
            }
            let manuscript = store.read(&doc.project_id).unwrap();
            let outline = store
                .read_document(&doc.project_id, MarkdownDocumentKind::Outline)
                .unwrap();
            let zip = store
                .exchange(
                    &doc.project_id,
                    &manuscript.revision,
                    outline.revision.as_deref(),
                )
                .unwrap();
            assert!(!String::from_utf8_lossy(&zip).contains("agent-apply"));
        }
    }
    #[test]
    fn awr_ac07_changed_text_lock_and_comment_snapshot_keep_preview_and_open_notes() {
        for mutation in ["text", "lock", "comment"] {
            let (_root, store, doc) = setup(MarkdownDocumentKind::Outline);
            let (sessions, owner, turn) = start(store.clone(), &doc, "normal");
            let proposal = turn.proposal.unwrap();
            match mutation {
                "text" => {
                    store
                        .save_document(
                            &doc.project_id,
                            doc.kind.clone(),
                            doc.revision.as_deref(),
                            doc.text.replace("City", "Town"),
                        )
                        .unwrap();
                }
                "lock" => {
                    store
                        .annotate(
                            &doc.project_id,
                            doc.kind.clone(),
                            MarkdownAnnotationAction::Lock {
                                revision: doc.revision.clone().unwrap(),
                                ranges: vec![range(&doc.text, "First 中文")],
                            },
                        )
                        .unwrap();
                }
                _ => {
                    let c = &proposal.context.batch.as_ref().unwrap().comments[0];
                    store
                        .annotate(
                            &doc.project_id,
                            doc.kind.clone(),
                            MarkdownAnnotationAction::Edit {
                                id: c.id.clone(),
                                revision: doc.revision.clone().unwrap(),
                                previous_text: c.text.clone(),
                                text: "New instruction".into(),
                            },
                        )
                        .unwrap();
                }
            }
            assert_eq!(
                sessions
                    .apply(&doc.project_id, &owner.id, &turn.id, &proposal.id)
                    .err(),
                Some(if mutation == "lock" {
                    "MARKDOWN_LOCKED"
                } else {
                    "MARKDOWN_CONFLICT"
                })
            );
            let saved = sessions.read(&doc.project_id, &owner.id).unwrap();
            assert_eq!(saved.turns[0].proposal.as_ref(), Some(&proposal));
            assert!(saved.turns[0].outcome.is_none());
            assert!(
                store
                    .annotations(&doc.project_id, doc.kind.clone())
                    .unwrap()
                    .comments
                    .iter()
                    .all(|c| c.status == MarkdownCommentStatus::Open)
            );
        }
    }
    #[test]
    fn awr_ac07_transient_write_failure_retries_the_same_proposal_after_restart() {
        let (_root, store, doc) = setup(MarkdownDocumentKind::Outline);
        let (sessions, owner, turn) = start(store.clone(), &doc, "normal");
        let proposal = turn.proposal.unwrap();
        store.fail_before_commit.store(true, Ordering::Relaxed);
        assert_eq!(
            sessions
                .apply(&doc.project_id, &owner.id, &turn.id, &proposal.id)
                .err(),
            Some("MARKDOWN_STORAGE_UNAVAILABLE")
        );
        drop(sessions);
        store.fail_before_commit.store(false, Ordering::Relaxed);
        let restarted = AgentSessions::new(store.clone(), Arc::new(Fixture));
        let result = restarted
            .apply(&doc.project_id, &owner.id, &turn.id, &proposal.id)
            .unwrap();
        assert_eq!(
            store
                .read_document(&doc.project_id, doc.kind.clone())
                .unwrap()
                .revision
                .as_deref(),
            Some(result.revision.as_str())
        );
        assert_eq!(
            store
                .annotations(&doc.project_id, doc.kind)
                .unwrap()
                .comments
                .iter()
                .filter(|c| c.status == MarkdownCommentStatus::Resolved)
                .count(),
            2
        );
    }
    #[test]
    fn awr_ac07_write_retry_and_restart_after_markdown_commit_do_not_rewrite_or_resolve_unrelated_notes()
     {
        let (root, store, doc) = setup(MarkdownDocumentKind::Outline);
        let (sessions, owner, turn) = start(store.clone(), &doc, "normal");
        let proposal = turn.proposal.unwrap();
        store.fail_before_commit.store(true, Ordering::Relaxed);
        assert_eq!(
            sessions
                .apply(&doc.project_id, &owner.id, &turn.id, &proposal.id)
                .err(),
            Some("MARKDOWN_STORAGE_UNAVAILABLE")
        );
        assert_eq!(
            store
                .read_document(&doc.project_id, doc.kind.clone())
                .unwrap(),
            doc
        );
        assert!(
            store
                .annotations(&doc.project_id, doc.kind.clone())
                .unwrap()
                .comments
                .iter()
                .all(|c| c.status == MarkdownCommentStatus::Open)
        );
        drop(sessions);
        store.fail_before_commit.store(false, Ordering::Relaxed);
        // Simulate process exit after the committed Markdown save, before comment/turn acknowledgement.
        let receipt: Option<BatchReceipt> = store
            .sidecar(
                &doc.project_id,
                &format!("agent-apply-{}.json", proposal.id),
            )
            .unwrap();
        let receipt = receipt.unwrap();
        store
            .save_document(
                &doc.project_id,
                doc.kind.clone(),
                doc.revision.as_deref(),
                receipt.document.text.clone(),
            )
            .unwrap();
        drop(store);
        let store = Arc::new(MarkdownProjects::open(root.path()).unwrap());
        // A writer fault now proves the receipt recovery never enters the Markdown writer again.
        store.fail_before_commit.store(true, Ordering::Relaxed);
        let restarted = AgentSessions::new(store.clone(), Arc::new(Fixture));
        let result = restarted
            .apply(&doc.project_id, &owner.id, &turn.id, &proposal.id)
            .unwrap();
        assert_eq!(result.revision, receipt.document.revision.unwrap());
        assert_eq!(
            store
                .annotations(&doc.project_id, doc.kind.clone())
                .unwrap()
                .comments
                .iter()
                .filter(|c| c.status == MarkdownCommentStatus::Resolved)
                .count(),
            2
        );
        assert_eq!(store.apply(&proposal).unwrap().text, receipt.document.text);
    }
    #[test]
    fn awr_ac06_overlapping_detached_and_unclear_scopes_and_questions_are_bounded() {
        let (_root, store, doc) = setup(MarkdownDocumentKind::Manuscript);
        store
            .annotate(
                &doc.project_id,
                doc.kind.clone(),
                MarkdownAnnotationAction::Comment {
                    revision: doc.revision.clone().unwrap(),
                    range: range(&doc.text, "中文"),
                    text: "Clarify the same phrase".into(),
                },
            )
            .unwrap();
        let changed = store
            .save_document(
                &doc.project_id,
                doc.kind.clone(),
                doc.revision.as_deref(),
                doc.text.replace("Second detail", "External passage"),
            )
            .unwrap();
        let capture = store
            .capture(
                &doc.project_id,
                &AgentAttachment {
                    kind: doc.kind.clone(),
                    revision: changed.revision.clone(),
                    source_digest: digest(&changed.text),
                    selection: None,
                    buffer: None,
                },
            )
            .unwrap();
        let batch = capture.context.batch.unwrap();
        assert_eq!(batch.scopes.len(), 1);
        assert_eq!(batch.scopes[0].comment_ids.len(), 2);
        assert!(
            batch
                .unresolved
                .iter()
                .any(|u| u.reason == AgentUnresolvedReason::Detached)
        );
        assert_eq!(
            batch_output(r#"{"reply":"Which detail should change?","changes":[]}"#)
                .unwrap()
                .changes
                .unwrap()
                .len(),
            0
        );
        assert!(batch_output(r#"{"reply":"oops","changes":[],"extra":true}"#).is_err());
        let (_root, store, doc) = setup(MarkdownDocumentKind::Outline);
        let (sessions, owner, turn) = start(store.clone(), &doc, "normal");
        sessions
            .conversation_action(
                &doc.project_id,
                &owner.id,
                AgentConversationAction {
                    action: AgentConversationActionAction::Discard,
                    value: turn.id.clone(),
                },
            )
            .unwrap();
        let proposal = turn.proposal.unwrap();
        drop(sessions);
        let restarted = AgentSessions::new(store.clone(), Arc::new(Fixture));
        assert_eq!(
            restarted
                .apply(&doc.project_id, &owner.id, &turn.id, &proposal.id)
                .err(),
            Some("AGENT_PROPOSAL_STALE")
        );
        assert!(
            store
                .annotations(&doc.project_id, doc.kind)
                .unwrap()
                .comments
                .iter()
                .all(|c| c.status == MarkdownCommentStatus::Open)
        );
    }
}
