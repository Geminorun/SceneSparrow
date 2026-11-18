//! Read-only compatibility for retired output budgets in persisted v1 records.
//! Live protocol DTOs remain closed; no legacy fields enter new configurations.
use super::*;
use serde_json::Value;

fn parameters(value: &mut Value) {
    if let Some(object) = value.as_object_mut() {
        object.remove("maxOutputTokens");
    }
}
fn model(value: &mut Value) {
    if let Some(object) = value.as_object_mut() {
        object.remove("tokenField");
        if let Some(defaults) = object.get_mut("defaultParameters") {
            parameters(defaults);
        }
    }
}
pub(super) fn read_settings(bytes: &[u8]) -> Result<AiSettings> {
    let mut value: Value = safe(serde_json::from_slice(bytes))?;
    if let Some(models) = value.get_mut("models").and_then(Value::as_array_mut) {
        for entry in models {
            model(entry);
        }
    }
    if let Some(bindings) = value.get_mut("bindings").and_then(Value::as_array_mut) {
        for binding in bindings {
            if let Some(defaults) = binding.get_mut("parameters") {
                parameters(defaults);
            }
        }
    }
    safe(serde_json::from_value(value))
}
pub(super) fn has_retired_configuration(value: &Value) -> bool {
    value.get("model").is_some_and(|entry| {
        entry.get("tokenField").is_some()
            || entry
                .get("defaultParameters")
                .is_some_and(|p| p.get("maxOutputTokens").is_some())
    }) || value
        .get("parameters")
        .is_some_and(|p| p.get("maxOutputTokens").is_some())
}
pub(super) fn read_configuration(json: &str) -> Result<AiResolvedConfig> {
    let mut value: Value = safe(serde_json::from_str(json))?;
    if let Some(entry) = value.get_mut("model") {
        model(entry);
    }
    if let Some(defaults) = value.get_mut("parameters") {
        parameters(defaults);
    }
    // Preserve the stored fingerprint, never recompute historical task identity.
    safe(serde_json::from_value(value))
}
