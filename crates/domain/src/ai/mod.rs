//! Shared AI values and validation. Consumers own prompts and applicability.
use crate::contracts::*;
use std::collections::BTreeSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct AiError(pub &'static str);
pub type Result<T> = std::result::Result<T, AiError>;
pub fn ensure(ok: bool, code: &'static str) -> Result<()> {
    if ok { Ok(()) } else { Err(AiError(code)) }
}
pub fn valid_id(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok_and(|u| u.get_version_num() == 4 && u.to_string() == id)
}
pub fn word<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}
pub fn default_settings() -> AiSettings {
    AiSettings {
        schema_version: 1,
        revision: 0,
        providers: vec![],
        models: vec![],
        bindings: vec![],
        retired_profile_ids: vec![],
        policy: AiPolicy {
            overall_ms: 180000,
            idle_ms: 60000,
            max_output_bytes: 8388608,
        },
    }
}
pub fn validate_root(value: &str) -> Result<()> {
    let u = url::Url::parse(value).map_err(|_| AiError("INVALID_URL"))?;
    ensure(
        value.len() <= 8192
            && !value.chars().any(char::is_control)
            && ["http", "https"].contains(&u.scheme())
            && u.host_str().is_some()
            && u.username().is_empty()
            && u.password().is_none()
            && u.query().is_none()
            && u.fragment().is_none(),
        "INVALID_URL",
    )
}
pub fn validate_settings(s: &AiSettings) -> Result<()> {
    ensure(
        s.schema_version == 1
            && (0..i64::MAX).contains(&s.revision)
            && s.providers.len() <= 64
            && s.models.len() <= 1024
            && s.bindings.len() <= 3,
        "INVALID_SETTINGS",
    )?;
    ensure(
        (100..=180000).contains(&s.policy.overall_ms)
            && (100..=60000).contains(&s.policy.idle_ms)
            && (1..=8388608).contains(&s.policy.max_output_bytes),
        "INVALID_SETTINGS",
    )?;
    let mut ids = BTreeSet::new();
    for p in &s.providers {
        ensure(
            valid_id(&p.id)
                && !s.retired_profile_ids.contains(&p.id)
                && ids.insert(&p.id)
                && !p.label.trim().is_empty()
                && p.label.len() <= 120
                && p.revision > 0
                && p.credential_revision.as_ref().is_none_or(|id| valid_id(id)),
            "INVALID_SETTINGS",
        )?;
        ensure(
            word(&p.adapter) == "openai_compatible"
                && (word(&p.auth_mode) != "none" || p.credential_revision.is_none()),
            "INVALID_SETTINGS",
        )?;
        validate_root(&p.base_url)?;
    }
    ensure(
        s.retired_profile_ids.iter().all(|id| valid_id(id)),
        "INVALID_SETTINGS",
    )?;
    let mut models = BTreeSet::new();
    for m in &s.models {
        ensure(
            ids.contains(&m.provider_id)
                && models.insert((&m.provider_id, &m.id))
                && !m.id.trim().is_empty()
                && m.id.len() <= 256
                && !m.id.chars().any(char::is_control)
                && m.label.len() <= 120
                && m.context_tokens.is_none_or(|v| (1..=10000000).contains(&v))
                && m.output_tokens.is_none_or(|v| (1..=1000000).contains(&v)),
            "INVALID_SETTINGS",
        )?;
        for evidence in [
            &m.capabilities.images,
            &m.capabilities.streaming,
            &m.capabilities.native_json,
        ] {
            ensure(
                evidence.scope.len() <= 256
                    && evidence.observed_at.as_ref().is_none_or(|v| v.len() <= 64),
                "INVALID_SETTINGS",
            )?;
        }
    }
    let mut categories = BTreeSet::new();
    for b in &s.bindings {
        ensure(
            categories.insert(word(&b.category))
                && models.contains(&(&b.provider_id, &b.model_id))
                && b.revision > 0,
            "INVALID_SETTINGS",
        )?;
        ensure(
            (16..=1000000).contains(&b.parameters.max_output_tokens)
                && b.parameters
                    .temperature_milli
                    .is_none_or(|v| (0..=2000).contains(&v)),
            "INVALID_SETTINGS",
        )?;
        let m = s
            .models
            .iter()
            .find(|m| m.id == b.model_id && m.provider_id == b.provider_id)
            .ok_or(AiError("INVALID_SETTINGS"))?;
        ensure(
            m.output_tokens
                .is_none_or(|v| b.parameters.max_output_tokens <= v),
            "INVALID_SETTINGS",
        )?;
    }
    Ok(())
}
pub fn validate_input(input: &AiInput, config: &AiResolvedConfig) -> Result<()> {
    ensure(input.protocol_version == 1, "PROTOCOL_MISMATCH")?;
    ensure(
        word(&config.category) == "text" && word(&config.capability) == "text.generate",
        "CAPABILITY_UNSUPPORTED",
    )?;
    ensure(
        input.messages.len() <= 128 && !input.messages.is_empty(),
        "INPUT_TOO_LARGE",
    )?;
    let mut total = 0;
    let mut images = 0;
    let mut image_bytes = 0;
    let mut ids = BTreeSet::new();
    ensure(input.input_artifacts.len() <= 9, "INPUT_TOO_LARGE")?;
    for artifact in &input.input_artifacts {
        ensure(
            valid_id(&artifact.id)
                && ids.insert(&artifact.id)
                && artifact.hash.len() == 64
                && artifact
                    .hash
                    .bytes()
                    .all(|v| v.is_ascii_hexdigit() && !v.is_ascii_uppercase())
                && artifact.size >= 0,
            "INVALID_INPUT",
        )?;
        if word(&artifact.mime).starts_with("image/") {
            ensure(artifact.size <= 4194304, "INPUT_TOO_LARGE")?;
            image_bytes += artifact.size;
        } else {
            ensure(artifact.size <= 1048576, "INPUT_TOO_LARGE")?;
        }
    }
    for m in &input.messages {
        ensure(m.content.len() <= 256, "INPUT_TOO_LARGE")?;
        for part in &m.content {
            match part {
                AiPart::Text { text } => {
                    total += text.len();
                    ensure(!text.contains('\0'), "INVALID_INPUT")?;
                }
                AiPart::Image { artifact_id } => {
                    images += 1;
                    ensure(
                        input
                            .input_artifacts
                            .iter()
                            .any(|a| a.id == *artifact_id && word(&a.mime).starts_with("image/")),
                        "INVALID_INPUT",
                    )?;
                }
            }
        }
    }
    ensure(
        total <= 1048576 && images <= 8 && image_bytes <= 16777216,
        "INPUT_TOO_LARGE",
    )?;
    if images > 0 {
        ensure(
            word(&config.model.capabilities.images.state) != "unsupported"
                && (word(&config.model.capabilities.images.state) == "supported"
                    || word(&input.image_decision) == "attempt"),
            "CAPABILITY_UNSUPPORTED",
        )?;
    }
    ensure(
        (1..=8388608).contains(&input.output_spec.max_bytes)
            && input.output_spec.max_bytes <= config.policy.max_output_bytes
            && !input.output_spec.schema_id.is_empty()
            && input.output_spec.schema_id.len() <= 256
            && input.output_spec.schema_version > 0,
        "INVALID_INPUT",
    )?;
    if let Some(id) = &input.output_spec.schema_artifact_id {
        ensure(
            word(&input.output_spec.mime) == "application/json"
                && input
                    .input_artifacts
                    .iter()
                    .any(|a| a.id == *id && word(&a.mime) == "application/json"),
            "INVALID_INPUT",
        )?;
    }
    ensure(
        config.model.context_tokens.is_none_or(|v| {
            (total as i64 + 2) / 3 + images * 4096 + config.parameters.max_output_tokens <= v
        }),
        "CONTEXT_LIMIT",
    )
}
pub fn terminal(status: &AiRunStatus) -> bool {
    !["queued", "running", "cancelling"].contains(&word(status).as_str())
}
