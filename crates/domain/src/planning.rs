//! Planning rules and complete output interpretation. Providers never assign identity.
use crate::{
    contracts::*,
    manuscript::{self, ManuscriptError},
};
use std::collections::BTreeSet;
pub type Result<T> = std::result::Result<T, ManuscriptError>;
pub fn ensure(ok: bool, code: &'static str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(ManuscriptError(code, None))
    }
}
fn text(value: &str, max: usize) -> bool {
    value.chars().count() <= max
        && !value
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t')
}
pub fn empty() -> PlanningContent {
    PlanningContent {
        brief: PlanningBrief {
            topic: String::new(),
            language: "en".into(),
            audience: String::new(),
            style: String::new(),
            length_hint: String::new(),
        },
        nodes: vec![],
        instruction: String::new(),
        evidence: vec![],
    }
}
pub fn validate(p: &PlanningContent, ready: bool) -> Result<()> {
    let b = &p.brief;
    ensure(
        b.language
            .parse::<language_tags::LanguageTag>()
            .is_ok_and(|v| v.validate().is_ok())
            && text(&b.topic, 500)
            && (!ready || !b.topic.trim().is_empty())
            && [&b.audience, &b.style, &b.length_hint]
                .iter()
                .all(|v| text(v, 2000)),
        "BRIEF_INVALID",
    )?;
    ensure(
        p.instruction.len() <= 8192 && text(&p.instruction, 8192),
        "BRIEF_INVALID",
    )?;
    ensure(
        p.nodes.len() <= 200 && serde_json::to_vec(&p.nodes).is_ok_and(|v| v.len() <= 262144),
        "OUTLINE_INVALID",
    )?;
    let mut ids = BTreeSet::new();
    let mut previous = -1;
    for n in &p.nodes {
        ensure(
            manuscript::uuid4(&n.id)
                && ids.insert(&n.id)
                && (0..=3).contains(&n.depth)
                && n.depth <= previous + 1
                && !n.title.trim().is_empty()
                && text(&n.title, 300)
                && n.key_points.len() <= 20
                && n.key_points.iter().all(|v| text(v, 1000)),
            "OUTLINE_INVALID",
        )?;
        previous = n.depth;
    }
    ensure(
        p.evidence.len() <= 100
            && p.evidence
                .iter()
                .map(|e| &e.source_id)
                .collect::<BTreeSet<_>>()
                .len()
                <= 50,
        "EVIDENCE_CHOICE_REQUIRED",
    )?;
    let mut choices = BTreeSet::new();
    for e in &p.evidence {
        ensure(
            manuscript::uuid4(&e.source_id)
                && e.start >= 0
                && e.end >= e.start
                && choices.insert(serde_json::to_string(e).unwrap_or_default()),
            "EVIDENCE_CHOICE_REQUIRED",
        )?;
    }
    Ok(())
}
/// Content-only snapshots restore identity, but never old dependency tokens.
pub fn content_snapshot(p: &PlanningContent) -> PlanningContent {
    let mut p = p.clone();
    for n in &mut p.nodes {
        n.revision = 0;
    }
    p
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OutlineOutput {
    pub schema_version: i64,
    pub nodes: Vec<ProposedNode>,
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProposedNode {
    #[serde(deserialize_with = "nullable_id")]
    pub existing_id: Option<String>,
    pub depth: i64,
    pub title: String,
    pub key_points: Vec<String>,
}
fn nullable_id<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<String>, D::Error> {
    serde::Deserialize::deserialize(deserializer)
}
pub fn interpret_outline(
    bytes: &[u8],
    before: &PlanningContent,
    adjust: bool,
) -> Result<PlanningContent> {
    let output: OutlineOutput =
        serde_json::from_slice(bytes).map_err(|_| ManuscriptError("INVALID_OUTPUT", None))?;
    ensure(output.schema_version == 1, "INVALID_OUTPUT")?;
    ensure(!output.nodes.is_empty(), "OUTLINE_INVALID")?;
    let mut seen = BTreeSet::new();
    let mut result = before.clone();
    result.nodes = vec![];
    for n in output.nodes {
        let id = if let Some(id) = n.existing_id {
            ensure(
                adjust && before.nodes.iter().any(|v| v.id == id) && seen.insert(id.clone()),
                "OUTLINE_INVALID",
            )?;
            id
        } else {
            uuid::Uuid::new_v4().to_string()
        };
        result.nodes.push(OutlineNode {
            id,
            revision: 0,
            depth: n.depth,
            title: n.title,
            key_points: n.key_points,
        });
    }
    validate(&result, true)?;
    Ok(result)
}
#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DraftOutput {
    pub schema_version: i64,
    pub sections: Vec<DraftSection>,
    pub evidence_references: Vec<DraftReference>,
    pub verification_hints: Vec<String>,
    pub planning_notes: Vec<String>,
}
#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DraftSection {
    pub outline_node_id: String,
    pub blocks: Vec<DraftBlock>,
}
#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DraftBlock {
    pub kind: BlockKind,
    pub attrs: BlockAttrs,
    pub runs: Vec<TextRun>,
}
#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DraftReference {
    pub evidence_id: String,
    pub outline_node_id: String,
}
pub fn interpret_draft(
    bytes: &[u8],
    plan: &PlanningContent,
    evidence: &[PlanningEvidence],
) -> Result<Vec<Block>> {
    let output: DraftOutput =
        serde_json::from_slice(bytes).map_err(|_| ManuscriptError("INVALID_OUTPUT", None))?;
    ensure(output.schema_version == 1, "INVALID_OUTPUT")?;
    ensure(
        output.sections.len() == plan.nodes.len() && !plan.nodes.is_empty(),
        "DRAFT_STRUCTURE_INVALID",
    )?;
    ensure(
        output.evidence_references.len() <= 100
            && output.verification_hints.len() <= 100
            && output.planning_notes.len() <= 20
            && serde_json::to_vec(&(
                &output.evidence_references,
                &output.verification_hints,
                &output.planning_notes,
            ))
            .is_ok_and(|v| v.len() <= 65536),
        "INVALID_OUTPUT",
    )?;
    for r in &output.evidence_references {
        ensure(
            evidence.iter().any(|e| e.id == r.evidence_id)
                && plan.nodes.iter().any(|n| n.id == r.outline_node_id),
            "INVALID_OUTPUT",
        )?;
    }
    let mut blocks = vec![];
    for (i, (section, node)) in output.sections.into_iter().zip(&plan.nodes).enumerate() {
        ensure(
            section.outline_node_id == node.id,
            "DRAFT_STRUCTURE_INVALID",
        )?;
        let leaf = plan.nodes.get(i + 1).is_none_or(|n| n.depth <= node.depth);
        ensure(
            !leaf
                || section
                    .blocks
                    .iter()
                    .any(|b| b.runs.iter().any(|r| !r.text.trim().is_empty())),
            "DRAFT_STRUCTURE_INVALID",
        )?;
        blocks.push(Block {
            id: uuid::Uuid::new_v4().to_string(),
            revision: 1,
            kind: BlockKind::Heading,
            attrs: BlockAttrs {
                level: Some(node.depth + 1),
                depth: None,
                list_kind: None,
            },
            runs: vec![TextRun {
                text: node.title.clone(),
                marks: vec![],
            }],
        });
        for b in section.blocks {
            ensure(b.kind != BlockKind::Heading, "DRAFT_STRUCTURE_INVALID")?;
            blocks.push(Block {
                id: uuid::Uuid::new_v4().to_string(),
                revision: 1,
                kind: b.kind,
                attrs: b.attrs,
                runs: b.runs,
            });
        }
    }
    Ok(blocks)
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn outline_output_requires_version_nullable_ids_current_mapping_and_valid_preorder() {
        let mut plan = empty();
        plan.brief.topic = "Topic".into();
        let id = uuid::Uuid::new_v4().to_string();
        plan.nodes.push(OutlineNode {
            id: id.clone(),
            revision: 1,
            depth: 0,
            title: "Current".into(),
            key_points: vec![],
        });
        let node = json!({"existingId":id,"depth":0,"title":"Updated","keyPoints":[]});
        let valid = json!({"schemaVersion":1,"nodes":[node.clone()]});
        assert!(interpret_outline(&serde_json::to_vec(&valid).unwrap(), &plan, true).is_ok());
        for output in [
            json!({"nodes":[node.clone()]}),
            json!({"schemaVersion":2,"nodes":[node.clone()]}),
            json!({"schemaVersion":1,"nodes":[node.clone(),node.clone()]}),
            json!({"schemaVersion":1,"nodes":[{"existingId":null,"depth":2,"title":"Skip depth","keyPoints":[]}]}),
            json!({"schemaVersion":1,"nodes":[{"depth":0,"title":"Missing explicit identity","keyPoints":[]}]}),
            json!({"schemaVersion":1,"nodes":[{"existingId":uuid::Uuid::new_v4().to_string(),"depth":0,"title":"Foreign","keyPoints":[]}]}),
        ] {
            assert!(interpret_outline(&serde_json::to_vec(&output).unwrap(), &plan, true).is_err());
        }
        assert!(interpret_outline(&serde_json::to_vec(&valid).unwrap(), &plan, false).is_err());
    }
    #[test]
    fn bcp47_and_outline_resource_limits_are_domain_owned() {
        let mut p = empty();
        p.brief.topic = "中文 🐦".into();
        for language in ["zh-Hans-CN", "en-US", "x-private"] {
            p.brief.language = language.into();
            validate(&p, true).unwrap();
        }
        for language in ["", "en-abcdefghi", "en--US", "123-US"] {
            p.brief.language = language.into();
            assert_eq!(validate(&p, true).unwrap_err().0, "BRIEF_INVALID");
        }
        p.brief.language = "en".into();
        p.brief.topic = "🐦".repeat(501);
        assert_eq!(validate(&p, true).unwrap_err().0, "BRIEF_INVALID");
    }
}
