//! Session-only writing prompts and bounded Markdown validation belong to the manuscript application.
use scenesparrow_domain::{ai::*, contracts::*, manuscript::MAX_TEXT_BYTES};

pub const MAX_OUTPUT_BYTES: usize = 256 * 1024;

pub fn input(action: &MarkdownWritingAction) -> Result<AiInput> {
    ensure(
        (action.kind == MarkdownWritingActionKind::Draft || !action.brief.trim().is_empty())
            && action.brief.len() <= 16 * 1024
            && action.outline.len() <= MAX_OUTPUT_BYTES
            && action.text.len() <= MAX_TEXT_BYTES
            && (action.kind != MarkdownWritingActionKind::Draft
                || !action.outline.trim().is_empty()),
        "MARKDOWN_WRITING_INVALID",
    )?;
    let instruction = match action.kind {
        MarkdownWritingActionKind::Outline => {
            "Prepare an editable outline for the user's writing request, considering the current manuscript. Return only the outline as plain Markdown, without enclosing code fences."
        }
        MarkdownWritingActionKind::Draft => {
            "Write a complete manuscript from the user's edited outline and writing request, considering the current manuscript. Return only the draft as plain Markdown, without enclosing code fences."
        }
    };
    Ok(AiInput {
        protocol_version: 1,
        messages: vec![
            AiMessage {
                role: AiMessageRole::System,
                content: vec![AiPart::Text {
                    text: instruction.into(),
                }],
            },
            AiMessage {
                role: AiMessageRole::User,
                content: vec![AiPart::Text {
                    text: format!(
                        "Writing request:\n{}\n\nEdited outline:\n{}\n\nCurrent manuscript (reference text):\n{}",
                        action.brief, action.outline, action.text
                    ),
                }],
            },
        ],
        input_artifacts: vec![],
        output_spec: AiOutputSpec {
            mime: AiOutputSpecMime::Textplain,
            schema_id: "markdown-writing/1".into(),
            schema_version: 1,
            schema_artifact_id: None,
            max_bytes: MAX_OUTPUT_BYTES as i64,
        },
        image_decision: AiInputImageDecision::None,
    })
}

pub fn validate_output(text: &str) -> Result<()> {
    ensure(
        !text.trim().is_empty() && text.len() <= MAX_OUTPUT_BYTES && !text.contains('\0'),
        "OUTPUT_INVALID",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn drafts_require_an_outline_and_allow_an_empty_brief() {
        let mut action = MarkdownWritingAction {
            action_id: String::new(),
            session_id: String::new(),
            fingerprint: String::new(),
            kind: MarkdownWritingActionKind::Draft,
            brief: "写一个故事".into(),
            outline: String::new(),
            text: String::new(),
            revision: String::new(),
            outline_revision: None,
        };
        assert!(input(&action).is_err());
        action.outline = "# 开场".into();
        action.brief.clear();
        let prepared = input(&action).unwrap();
        assert_eq!(prepared.output_spec.mime, AiOutputSpecMime::Textplain);
        assert!(validate_output("# 草稿\n\n正文").is_ok());
        assert!(validate_output(" \n").is_err());
        assert!(validate_output(&"x".repeat(MAX_OUTPUT_BYTES + 1)).is_err());
    }
}
