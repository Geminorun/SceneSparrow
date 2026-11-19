//! Pure authored-file validation. Physical links and atomic access belong to storage.
use crate::contracts::OpenProjectManifest;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use unicode_normalization::UnicodeNormalization;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{code}: {field}")]
pub struct FormatError {
    pub code: &'static str,
    pub field: String,
}
fn error(code: &'static str, field: &str) -> FormatError {
    FormatError {
        code,
        field: field.into(),
    }
}
type Result<T> = std::result::Result<T, FormatError>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManifestInspection {
    Supported(OpenProjectManifest),
    FutureReadOnly { format_version: i64, raw: Value },
}
fn portable_key(path: &str) -> String {
    path.nfc()
        .collect::<String>()
        .to_uppercase()
        .to_lowercase()
        .nfc()
        .collect()
}
/// Physical root entries must not alias an app-owned or Git namespace under
/// the same Unicode caseless key used by portable path validation. Canonical
/// spellings stay valid; callers pass one complete directory-entry name.
pub fn is_protected_root_alias(segment: &str) -> bool {
    let key = portable_key(segment);
    [".scenesparrow", "project.json", ".git"]
        .iter()
        .any(|reserved| key == *reserved && segment != *reserved)
}
pub fn validate_portable_paths(paths: &[&str]) -> Result<()> {
    let mut entries = BTreeMap::new();
    let mut files = BTreeSet::new();
    for path in paths {
        if path.is_empty()
            || path
                .chars()
                .any(|c| c.is_control() || "\\<>:\"|?*".contains(c))
        {
            return Err(error("PATH_INVALID", path));
        }
        let mut prefix = String::new();
        for segment in path.split('/') {
            let stem = portable_key(segment.split('.').next().unwrap_or(""));
            let numbered = ["com", "lpt"].iter().any(|p| {
                stem.strip_prefix(p).is_some_and(|s| {
                    matches!(
                        s,
                        "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                    )
                })
            });
            if segment.is_empty()
                || matches!(segment, "." | "..")
                || segment.ends_with(['.', ' '])
                || matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
                || numbered
            {
                return Err(error("PATH_INVALID", path));
            }
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(segment);
            let key = portable_key(&prefix);
            if entries
                .get(&key)
                .is_some_and(|previous| previous != &prefix)
            {
                return Err(error("PATH_COLLISION", path));
            }
            entries.insert(key, prefix.clone());
        }
        if !files.insert(portable_key(path)) {
            return Err(error("PATH_COLLISION", "paths"));
        }
    }
    for path in paths {
        let segments: Vec<_> = path.split('/').collect();
        for i in 1..segments.len() {
            if files.contains(&portable_key(&segments[..i].join("/"))) {
                return Err(error("PATH_COLLISION", path));
            }
        }
    }
    Ok(())
}
fn extensions(value: &Value, field: &str) -> Result<()> {
    let invalid = || error("EXTENSIONS_INVALID", field);
    let object = value.as_object().ok_or_else(invalid)?;
    if object.len() > 64
        || object.keys().any(|key| {
            let Some((namespace, name)) = key.split_once(':') else {
                return true;
            };
            namespace.is_empty()
                || !namespace.as_bytes()[0].is_ascii_lowercase()
                || !namespace
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b".-".contains(&c))
                || name.is_empty()
                || !name.as_bytes()[0].is_ascii_alphanumeric()
                || !name
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
        })
    {
        return Err(invalid());
    }
    fn depth(value: &Value, level: usize) -> bool {
        level <= 16
            && match value {
                Value::Array(items) => items.iter().all(|v| depth(v, level + 1)),
                Value::Object(items) => items.values().all(|v| depth(v, level + 1)),
                _ => true,
            }
    }
    if !depth(value, 0) || serde_json::to_vec(value).map_err(|_| invalid())?.len() > 65536 {
        return Err(invalid());
    }
    Ok(())
}
fn shape(value: &Value, schema: &Value, definitions: &Value, field: &str) -> Result<()> {
    let invalid = || error("FORMAT_INVALID", field);
    if let Some(reference) = schema["$ref"].as_str() {
        let name = reference.rsplit('/').next().ok_or_else(invalid)?;
        return match name {
            "FileJsonValue" => Ok(()),
            "FileExtensions" => extensions(value, field),
            _ => shape(value, &definitions[name], definitions, field),
        };
    }
    if schema["enum"]
        .as_array()
        .is_some_and(|v| !v.contains(value))
    {
        return Err(invalid());
    }
    match schema["type"].as_str() {
        Some("object") => {
            let object = value.as_object().ok_or_else(invalid)?;
            if let Some(required) = schema["required"].as_array() {
                for key in required {
                    if !object.contains_key(key.as_str().unwrap_or("")) {
                        return Err(invalid());
                    }
                }
            }
            let properties = schema["properties"].as_object().ok_or_else(invalid)?;
            for (key, child) in object {
                let property = properties.get(key).ok_or_else(invalid)?;
                shape(child, property, definitions, &format!("{field}.{key}"))?;
            }
        }
        Some("array") => {
            for (index, child) in value.as_array().ok_or_else(invalid)?.iter().enumerate() {
                shape(
                    child,
                    &schema["items"],
                    definitions,
                    &format!("{field}.{index}"),
                )?;
            }
        }
        Some("string") if value.is_string() => (),
        Some("integer") => {
            let number = value.as_i64().ok_or_else(invalid)?;
            if number.unsigned_abs() > 9_007_199_254_740_991
                || schema["minimum"].as_i64().is_some_and(|n| number < n)
                || schema["maximum"].as_i64().is_some_and(|n| number > n)
            {
                return Err(invalid());
            }
        }
        _ => return Err(invalid()),
    }
    Ok(())
}
fn definitions() -> Value {
    serde_json::from_str::<Value>(include_str!(
        "../../../packages/contracts/schema/open-project.schema.json"
    ))
    .expect("compiled schema")["definitions"]
        .clone()
}
fn role_path(path: &str, role: &str) -> Result<()> {
    let lower = path.to_lowercase();
    let extensions: &[&str] = match role {
        "manuscript" => &[".md"],
        "audio" => &[".json"],
        "media" => &[".wav", ".flac"],
        _ => &[".ts", ".tsx", ".js", ".jsx"],
    };
    if path
        .split('/')
        .any(|segment| matches!(portable_key(segment).as_str(), ".scenesparrow" | ".git"))
        || !extensions
            .iter()
            .any(|extension| lower.ends_with(extension))
    {
        return Err(error("PATH_INVALID", role));
    }
    Ok(())
}
pub fn inspect_project_manifest(value: Value) -> Result<ManifestInspection> {
    let version = value["formatVersion"]
        .as_i64()
        .filter(|v| *v >= 1 && *v <= 9_007_199_254_740_991)
        .ok_or_else(|| error("FORMAT_INVALID", "formatVersion"))?;
    if value["format"] != "scenesparrow" {
        return Err(error("FORMAT_INVALID", "formatVersion"));
    }
    if version > 1 {
        return Ok(ManifestInspection::FutureReadOnly {
            format_version: version,
            raw: value,
        });
    }
    let defs = definitions();
    shape(&value, &defs["OpenProjectManifest"], &defs, "manifest")?;
    let manifest: OpenProjectManifest =
        serde_json::from_value(value).map_err(|_| error("FORMAT_INVALID", "manifest"))?;
    if !crate::manuscript::uuid4(&manifest.project_id) {
        return Err(error("IDENTITY_INVALID", "projectId"));
    }
    if manifest.name.as_ref().is_some_and(|name| {
        name.trim().is_empty() || name.chars().count() > 120 || name.chars().any(char::is_control)
    }) {
        return Err(error("FORMAT_INVALID", "name"));
    }
    if manifest
        .video
        .as_ref()
        .is_some_and(|v| v.composition_id.trim().is_empty())
    {
        return Err(error("FORMAT_INVALID", "compositionId"));
    }
    role_path(&manifest.manuscript, "manuscript")?;
    if let Some(audio) = &manifest.audio {
        role_path(&audio.plan, "audio")?;
    }
    if let Some(video) = &manifest.video {
        role_path(&video.entry, "video")?;
    }
    let mut paths = vec!["project.json", &manifest.manuscript];
    if let Some(audio) = &manifest.audio {
        paths.push(&audio.plan);
    }
    if let Some(video) = &manifest.video {
        paths.push(&video.entry);
    }
    validate_portable_paths(&paths)?;
    Ok(ManifestInspection::Supported(manifest))
}
pub fn validate_media_declaration(value: &Value, audio: bool) -> Result<()> {
    let defs = definitions();
    shape(
        value,
        &defs[if audio {
            "AudioPlanDeclaration"
        } else {
            "VideoProjectDeclaration"
        }],
        &defs,
        if audio { "audio" } else { "video" },
    )?;
    if audio {
        let mut ids = BTreeSet::new();
        let media: BTreeSet<_> = value["segments"]
            .as_array()
            .expect("validated array")
            .iter()
            .map(|segment| segment["media"].as_str().expect("validated path"))
            .collect();
        validate_portable_paths(&media.into_iter().collect::<Vec<_>>())?;
        for segment in value["segments"].as_array().expect("validated array") {
            let id = segment["id"].as_str().expect("validated id");
            if !crate::manuscript::uuid4(id)
                || !crate::manuscript::uuid4(segment["sourceBlockId"].as_str().unwrap_or(""))
                || !ids.insert(id)
            {
                return Err(error("IDENTITY_INVALID", "segment.id"));
            }
            role_path(segment["media"].as_str().expect("validated path"), "media")?;
            validate_portable_paths(&[segment["media"].as_str().expect("validated path")])?;
            if segment["trimEndSample"].as_i64() <= segment["trimStartSample"].as_i64() {
                return Err(error("FORMAT_INVALID", "trimEndSample"));
            }
        }
    } else {
        role_path(value["entry"].as_str().expect("validated path"), "video")?;
        validate_portable_paths(&[value["entry"].as_str().expect("validated path")])?;
        if value["compositionId"]
            .as_str()
            .unwrap_or("")
            .trim()
            .is_empty()
        {
            return Err(error("FORMAT_INVALID", "compositionId"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn protected_root_aliases_reuse_unicode_portable_keys() {
        for alias in [
            ".ſcenesparrow",
            ".gıt",
            "project.jſon",
            ".SCENESPARROW",
            ".GIT",
            "PROJECT.JSON",
        ] {
            assert!(is_protected_root_alias(alias), "{alias}");
        }
        for ordinary in [
            ".scenesparrow",
            "project.json",
            ".git",
            ".scenesparrow-old",
            ".gitignore",
            "project.json.bak",
            ".ſcenesparrow-more",
            ".gıtx",
            "project.jſon.bak",
            "folder/.ſcenesparrow",
        ] {
            assert!(!is_protected_root_alias(ordinary), "{ordinary}");
        }
    }
    #[test]
    fn shared_node_rust_agreement_fixtures() {
        let fixtures: Vec<Value> = serde_json::from_str(include_str!(
            "../../../tests/fixtures/open-project/validation.json"
        ))
        .unwrap();
        for fixture in &fixtures {
            let value = &fixture["value"];
            let result: std::result::Result<&str, FormatError> =
                match fixture["kind"].as_str().unwrap() {
                    "manifest" => inspect_project_manifest(value.clone()).map(|v| match v {
                        ManifestInspection::Supported(_) => "supported",
                        ManifestInspection::FutureReadOnly { .. } => "future-read-only",
                    }),
                    "paths" => validate_portable_paths(
                        &value
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|v| v.as_str().unwrap())
                            .collect::<Vec<_>>(),
                    )
                    .map(|_| "valid"),
                    kind => validate_media_declaration(value, kind == "audio").map(|_| "valid"),
                };
            let actual = result.unwrap_or_else(|error| error.code);
            assert_eq!(
                actual,
                fixture["result"].as_str().unwrap(),
                "{}",
                fixture["name"]
            );
        }
        println!("{} shared Node/Rust cases", fixtures.len());
    }
    #[test]
    fn generated_types_preserve_extensions_and_keep_live_dtos_closed() {
        let raw = serde_json::json!({ "format": "scenesparrow", "formatVersion": 1, "projectId": "11111111-1111-4111-8111-111111111111", "manuscript": "manuscript.md", "extensions": { "org.example:payload": { "unknown": [null, true, 1.25, "雀"] } } });
        let ManifestInspection::Supported(manifest) =
            inspect_project_manifest(raw.clone()).unwrap()
        else {
            panic!()
        };
        assert_eq!(serde_json::to_value(manifest).unwrap(), raw);
        assert!(
            serde_json::from_value::<crate::contracts::TextRun>(
                serde_json::json!({ "text": "text", "marks": [], "unknown": 1 })
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<crate::contracts::ProjectAudioDeclaration>(
                serde_json::json!({ "plan": "audio/plan.json", "unknown": 1 })
            )
            .is_err()
        );
    }
    #[test]
    fn extensions_are_bounded() {
        assert!(
            extensions(
                &serde_json::json!({"org.example:large": "雀".repeat(22000)}),
                "extensions"
            )
            .is_err()
        );
        let keys: serde_json::Map<String, Value> = (0..65)
            .map(|i| (format!("org.example:key{i}"), Value::Null))
            .collect();
        assert!(extensions(&Value::Object(keys), "extensions").is_err());
        let mut deep = Value::Null;
        for _ in 0..17 {
            deep = Value::Array(vec![deep]);
        }
        assert!(extensions(&serde_json::json!({"org.example:deep": deep}), "extensions").is_err());
    }
}
