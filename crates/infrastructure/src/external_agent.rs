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
            None => saved.text,
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
                project_id: project.into(),
                kind: attachment.kind.clone(),
                revision: saved.revision,
                source_digest: digest(&text),
                selection: attachment.selection.clone(),
            },
            text,
        })
    }
    fn apply(&self, proposal: &AgentProposal) -> Result<MarkdownDocument> {
        let _guard = self
            .writer
            .lock()
            .map_err(|_| "MARKDOWN_STORAGE_UNAVAILABLE")?;
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
