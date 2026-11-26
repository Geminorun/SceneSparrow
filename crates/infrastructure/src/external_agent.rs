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
