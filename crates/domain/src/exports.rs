use crate::contracts::*;
/// Stable ordered body tokens exclude project-only review and approval sequences.
pub fn body_token(state: &ManuscriptState) -> String {
    format!(
        "canonical-1|{}|{}|{}",
        state.manuscript_id,
        state.schema_version,
        state
            .blocks
            .iter()
            .map(|b| format!("{}:{}", b.id, b.revision))
            .collect::<Vec<_>>()
            .join("|")
    )
}
pub fn plain(blocks: &[Block]) -> String {
    let mut result = Vec::new();
    let mut counts: Vec<(Option<BlockAttrsListKind>, usize)> = vec![];
    for b in blocks {
        let mut text = String::new();
        let mut label = String::new();
        let mut link: Option<&str> = None;
        let flush = |text: &mut String, label: &mut String, link: Option<&str>| {
            text.push_str(label);
            if let Some(href) = link
                && href != label
            {
                text.push_str(" (");
                text.push_str(href);
                text.push(')');
            }
            label.clear();
        };
        for r in &b.runs {
            let next = r
                .marks
                .iter()
                .find(|m| m.r#type == MarkType::Link)
                .and_then(|m| m.href.as_deref());
            if next != link {
                flush(&mut text, &mut label, link);
                link = next;
            }
            label.push_str(&r.text.replace("\r\n", "\n").replace('\r', "\n"));
        }
        flush(&mut text, &mut label, link);
        if b.kind == BlockKind::Listitem {
            let depth = b.attrs.depth.unwrap_or(0) as usize;
            counts.truncate(depth + 1);
            while counts.len() <= depth {
                counts.push((None, 0));
            }
            let kind = b.attrs.list_kind.clone();
            let entry = &mut counts[depth];
            if entry.0 != kind {
                *entry = (kind.clone(), 0);
            }
            entry.1 += 1;
            let prefix = if kind == Some(BlockAttrsListKind::Ordered) {
                format!("{}.", entry.1)
            } else {
                "-".into()
            };
            text = format!("{}{} {}", "  ".repeat(depth), prefix, text);
        } else {
            counts.clear();
        }
        result.push(text);
    }
    let joined = result.join("\n\n");
    format!("{}\n", joined.trim_end_matches('\n'))
}
