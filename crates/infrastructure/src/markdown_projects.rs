//! File-backed Web project storage.
use atomic_write_file::AtomicWriteFile;
use scenesparrow_domain::{
    contracts::{
        MarkdownDocument, MarkdownDocumentKind, MarkdownExchangeDocument, MarkdownExchangeReview,
        MarkdownProject,
    },
    manuscript::MAX_TEXT_BYTES,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::{
    fs,
    io::{Cursor, Read},
    path::{Path, PathBuf},
    sync::Mutex,
};
use uuid::Uuid;
pub(super) fn digest(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

pub(super) type Result<T> = std::result::Result<T, &'static str>;
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    format: String,
    format_version: u32,
    project_id: String,
    manuscript: String,
}
pub const MAX_OUTLINE_BYTES: usize = 256 * 1024;
pub const MAX_EXCHANGE_BYTES: usize =
    MAX_TEXT_BYTES + MAX_OUTLINE_BYTES + 2 * super::markdown_annotations::SIDECAR_LIMIT + 64 * 1024;
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Exchange {
    base_revision: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "outline_base"
    )]
    outline_base_revision: Option<Option<String>>,
}
// Preserve the distinction between an older package and an explicitly absent outline.
fn outline_base<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(deserializer).map(Some)
}
pub struct MarkdownProjects {
    root: PathBuf,
    pub(super) writer: Mutex<()>,
    #[cfg(test)]
    fail_before_commit: std::sync::atomic::AtomicBool,
}
pub(super) fn io<T>(result: std::io::Result<T>) -> Result<T> {
    result.map_err(|_| "MARKDOWN_STORAGE_UNAVAILABLE")
}
// shortcut: named-file checks assume a trusted local volume; use OS handles if hostile local writers enter scope.
pub(super) fn regular(path: &Path, directory: bool) -> Result<()> {
    let meta = io(fs::symlink_metadata(path))?;
    if meta.file_type().is_symlink()
        || (if directory {
            !meta.is_dir()
        } else {
            !meta.is_file()
        })
    {
        return Err("MARKDOWN_PROJECT_INVALID");
    }
    Ok(())
}
pub(super) fn read(path: &Path, limit: usize) -> Result<Vec<u8>> {
    regular(path, false)?;
    let file = io(fs::File::open(path))?;
    let mut bytes = Vec::new();
    io(file.take((limit + 1) as u64).read_to_end(&mut bytes))?;
    if bytes.len() > limit {
        return Err("MARKDOWN_TEXT_INVALID");
    }
    Ok(bytes)
}
fn validate(text: &str) -> Result<()> {
    if text.len() > MAX_TEXT_BYTES {
        return Err("MARKDOWN_TEXT_INVALID");
    }
    Ok(())
}
fn snapshot(id: &str, text: String) -> MarkdownProject {
    MarkdownProject {
        project_id: id.to_owned(),
        revision: format!("{:x}", Sha256::digest(text.as_bytes())),
        text,
    }
}
impl MarkdownProjects {
    pub fn open(root: &Path) -> Result<Self> {
        io(fs::create_dir_all(root))?;
        regular(root, true)?;
        if fs::symlink_metadata(root.join("project.sqlite")).is_ok() {
            return Err("MARKDOWN_PROJECT_INVALID");
        }
        Ok(Self {
            root: io(root.canonicalize())?,
            writer: Mutex::new(()),
            #[cfg(test)]
            fail_before_commit: std::sync::atomic::AtomicBool::new(false),
        })
    }
    fn directory(&self, id: &str) -> Result<PathBuf> {
        if Uuid::parse_str(id).ok().map(|v| v.to_string()).as_deref() != Some(id) {
            return Err("MARKDOWN_PROJECT_INVALID");
        }
        regular(&self.root, true)?;
        let dir = self.root.join(id);
        regular(&dir, true)?;
        Ok(dir)
    }
    pub(super) fn validated_directory(&self, id: &str) -> Result<PathBuf> {
        let dir = self.directory(id)?;
        let manifest: Manifest = serde_json::from_slice(&read(&dir.join("project.json"), 1024)?)
            .map_err(|_| "MARKDOWN_PROJECT_INVALID")?;
        if manifest.format != "scenesparrow"
            || manifest.format_version != 1
            || manifest.project_id != id
            || manifest.manuscript != "manuscript.md"
        {
            return Err("MARKDOWN_PROJECT_INVALID");
        }
        Ok(dir)
    }
    fn read_inner(&self, id: &str) -> Result<MarkdownProject> {
        let dir = self.validated_directory(id)?;
        let text = String::from_utf8(read(&dir.join("manuscript.md"), MAX_TEXT_BYTES)?)
            .map_err(|_| "MARKDOWN_TEXT_INVALID")?;
        Ok(snapshot(id, text))
    }
    pub fn read(&self, id: &str) -> Result<MarkdownProject> {
        let _guard = self
            .writer
            .lock()
            .map_err(|_| "MARKDOWN_STORAGE_UNAVAILABLE")?;
        self.read_inner(id)
    }
    pub fn create(&self, text: String) -> Result<MarkdownProject> {
        validate(&text)?;
        let _guard = self
            .writer
            .lock()
            .map_err(|_| "MARKDOWN_STORAGE_UNAVAILABLE")?;
        regular(&self.root, true)?;
        let id = Uuid::new_v4().to_string();
        let dir = self.root.join(&id);
        io(fs::create_dir(&dir))?;
        let manifest = Manifest {
            format: "scenesparrow".into(),
            format_version: 1,
            project_id: id.clone(),
            manuscript: "manuscript.md".into(),
        };
        io(fs::write(dir.join("manuscript.md"), text.as_bytes()))?;
        io(fs::write(
            dir.join("project.json"),
            serde_json::to_vec(&manifest).map_err(|_| "MARKDOWN_PROJECT_INVALID")?,
        ))?;
        self.read_inner(&id)
    }

    pub fn exchange(
        &self,
        id: &str,
        revision: &str,
        outline_revision: Option<&str>,
    ) -> Result<Vec<u8>> {
        let _guard = self
            .writer
            .lock()
            .map_err(|_| "MARKDOWN_STORAGE_UNAVAILABLE")?;
        let saved = self.read_inner(id)?;
        if saved.revision != revision {
            return Err("MARKDOWN_CONFLICT");
        }
        let outline = self.read_document_inner(id, MarkdownDocumentKind::Outline)?;
        if outline.revision.as_deref() != outline_revision {
            return Err("MARKDOWN_CONFLICT");
        }
        let dir = self.directory(id)?;
        let manifest = read(&dir.join("project.json"), 1024)?;
        let metadata = serde_json::to_vec(&Exchange {
            base_revision: saved.revision,
            outline_base_revision: Some(outline.revision.clone()),
        })
        .map_err(|_| "MARKDOWN_EXCHANGE_INVALID")?;
        let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        let mut entries = vec![
            ("exchange.json", metadata),
            ("project/project.json", manifest),
            ("project/manuscript.md", saved.text.into_bytes()),
        ];
        if outline.revision.is_some() {
            entries.push(("project/outline.md", outline.text.into_bytes()));
        }
        for name in ["locks.json", "comments.json"] {
            match fs::symlink_metadata(dir.join(name)) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err("MARKDOWN_STORAGE_UNAVAILABLE"),
                Ok(_) => entries.push((
                    if name == "locks.json" {
                        "project/locks.json"
                    } else {
                        "project/comments.json"
                    },
                    read(&dir.join(name), super::markdown_annotations::SIDECAR_LIMIT)?,
                )),
            }
        }
        for (name, bytes) in entries {
            archive
                .start_file(name, options)
                .map_err(|_| "MARKDOWN_EXCHANGE_INVALID")?;
            archive
                .write_all(&bytes)
                .map_err(|_| "MARKDOWN_EXCHANGE_INVALID")?;
        }
        Ok(archive
            .finish()
            .map_err(|_| "MARKDOWN_EXCHANGE_INVALID")?
            .into_inner())
    }

    pub fn review_exchange(&self, id: &str, bytes: Vec<u8>) -> Result<MarkdownExchangeReview> {
        let invalid = "MARKDOWN_EXCHANGE_INVALID";
        if bytes.len() > MAX_EXCHANGE_BYTES {
            return Err(invalid);
        }
        let mut archive =
            zip::ZipArchive::new(Cursor::new(bytes.as_slice())).map_err(|_| invalid)?;
        // ZipArchive deduplicates central-directory names; verify the raw ZIP32 count too.
        let raw = &bytes;
        let footer = raw
            .len()
            .checked_sub(22 + archive.comment().len())
            .ok_or(invalid)?;
        let end = &raw[footer..];
        let short = |offset| u16::from_le_bytes([end[offset], end[offset + 1]]);
        let long =
            |offset| u32::from_le_bytes(end[offset..offset + 4].try_into().unwrap()) as usize;
        if &end[..4] != b"PK\x05\x06"
            || short(4) != 0
            || short(6) != 0
            || short(8) as usize != archive.len()
            || short(10) as usize != archive.len()
            || long(12).checked_add(long(16)) != Some(footer)
        {
            return Err(invalid);
        }
        if !(3..=7).contains(&archive.len()) {
            return Err(invalid);
        }
        let mut entries = std::collections::HashMap::new();
        let mut directory = false;
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).map_err(|_| invalid)?;
            if entry.name() == "project/" && entry.is_dir() && entry.size() == 0 && !directory {
                let kind = entry.unix_mode().unwrap_or(0) & 0o170000;
                if kind != 0 && kind != 0o040000 {
                    return Err(invalid);
                }
                directory = true;
                continue;
            }
            let limit = match entry.name() {
                "exchange.json" | "project/project.json" => 1024,
                "project/manuscript.md" => MAX_TEXT_BYTES,
                "project/outline.md" => MAX_OUTLINE_BYTES,
                "project/locks.json" | "project/comments.json" => {
                    super::markdown_annotations::SIDECAR_LIMIT
                }
                _ => return Err(invalid),
            };
            let kind = entry.unix_mode().unwrap_or(0) & 0o170000;
            if !entry.is_file() || (kind != 0 && kind != 0o100000) || entry.size() > limit as u64 {
                return Err(invalid);
            }
            let name = entry.name().to_owned();
            let mut decoded = Vec::new();
            entry
                .by_ref()
                .take((limit + 1) as u64)
                .read_to_end(&mut decoded)
                .map_err(|_| invalid)?;
            if decoded.len() > limit || entries.insert(name, decoded).is_some() {
                return Err(invalid);
            }
        }
        let manifest: Manifest =
            serde_json::from_slice(entries.get("project/project.json").ok_or(invalid)?)
                .map_err(|_| invalid)?;
        if manifest.format != "scenesparrow"
            || manifest.format_version != 1
            || manifest.manuscript != "manuscript.md"
        {
            return Err(invalid);
        }
        if manifest.project_id != id {
            return Err("MARKDOWN_EXCHANGE_PROJECT_MISMATCH");
        }
        let exchange: Exchange =
            serde_json::from_slice(entries.get("exchange.json").ok_or(invalid)?)
                .map_err(|_| invalid)?;
        let valid_revision = |revision: &str| {
            revision.len() == 64
                && revision
                    .bytes()
                    .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
        };
        if !valid_revision(&exchange.base_revision)
            || exchange
                .outline_base_revision
                .as_ref()
                .and_then(|v| v.as_deref())
                .is_some_and(|v| !valid_revision(v))
        {
            return Err(invalid);
        }
        if exchange.outline_base_revision.is_none()
            && (entries.len() != 3 || entries.contains_key("project/outline.md"))
        {
            return Err(invalid);
        }
        let mut returned = vec![(
            MarkdownDocumentKind::Manuscript,
            Some(exchange.base_revision),
            entries.remove("project/manuscript.md").ok_or(invalid)?,
        )];
        if let Some(base) = exchange.outline_base_revision {
            if let Some(bytes) = entries.remove("project/outline.md") {
                returned.push((MarkdownDocumentKind::Outline, base, bytes));
            } else if base.is_some() {
                return Err(invalid);
            }
        }
        let _guard = self
            .writer
            .lock()
            .map_err(|_| "MARKDOWN_STORAGE_UNAVAILABLE")?;
        self.validated_directory(id)?;
        let mut documents = vec![];
        for (kind, base_revision, bytes) in returned {
            let text = String::from_utf8(bytes).map_err(|_| invalid)?;
            if base_revision.as_deref() == Some(digest(&text).as_str()) {
                continue;
            }
            let current = self.read_document_inner(id, kind.clone());
            let current_revision = current.as_ref().ok().and_then(|v| v.revision.clone());
            let conflict = current
                .and_then(|current| {
                    if current.revision != base_revision {
                        return Err("MARKDOWN_CONFLICT");
                    }
                    self.protect(id, &current, &text)
                })
                .err()
                .map(str::to_owned);
            documents.push(MarkdownExchangeDocument {
                kind,
                base_revision,
                current_revision,
                text,
                conflict,
            });
        }
        Ok(MarkdownExchangeReview {
            project_id: id.into(),
            documents,
        })
    }

    pub fn read_document(&self, id: &str, kind: MarkdownDocumentKind) -> Result<MarkdownDocument> {
        let _guard = self
            .writer
            .lock()
            .map_err(|_| "MARKDOWN_STORAGE_UNAVAILABLE")?;
        self.read_document_inner(id, kind)
    }
    pub(super) fn read_document_inner(
        &self,
        id: &str,
        kind: MarkdownDocumentKind,
    ) -> Result<MarkdownDocument> {
        let dir = self.validated_directory(id)?;
        let (text, revision) = match kind {
            MarkdownDocumentKind::Manuscript => {
                let text = String::from_utf8(read(&dir.join("manuscript.md"), MAX_TEXT_BYTES)?)
                    .map_err(|_| "MARKDOWN_TEXT_INVALID")?;
                let revision = snapshot(id, text.clone()).revision;
                (text, Some(revision))
            }
            MarkdownDocumentKind::Outline => {
                let path = dir.join("outline.md");
                match fs::symlink_metadata(&path) {
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        (String::new(), None)
                    }
                    Err(_) => return Err("MARKDOWN_STORAGE_UNAVAILABLE"),
                    Ok(_) => {
                        let text = String::from_utf8(read(&path, MAX_OUTLINE_BYTES)?)
                            .map_err(|_| "MARKDOWN_TEXT_INVALID")?;
                        let revision = snapshot(id, text.clone()).revision;
                        (text, Some(revision))
                    }
                }
            }
        };
        Ok(MarkdownDocument {
            project_id: id.into(),
            kind,
            text,
            revision,
        })
    }
    pub fn writing_snapshot(
        &self,
        id: &str,
        revision: &str,
        outline_revision: Option<&str>,
    ) -> Result<Option<MarkdownDocument>> {
        let _guard = self
            .writer
            .lock()
            .map_err(|_| "MARKDOWN_STORAGE_UNAVAILABLE")?;
        if self.read_inner(id)?.revision != revision {
            return Err("MARKDOWN_CONFLICT");
        }
        match outline_revision {
            None => Ok(None),
            Some(revision) => {
                let outline = self.read_document_inner(id, MarkdownDocumentKind::Outline)?;
                if outline.revision.as_deref() != Some(revision) {
                    return Err("MARKDOWN_CONFLICT");
                }
                Ok(Some(outline))
            }
        }
    }
    pub fn save(&self, id: &str, revision: &str, text: String) -> Result<MarkdownProject> {
        self.save_with_outline(id, revision, text, None)
    }
    pub fn save_with_outline(
        &self,
        id: &str,
        revision: &str,
        text: String,
        outline_revision: Option<&str>,
    ) -> Result<MarkdownProject> {
        let saved = self.save_document_guarded(
            id,
            MarkdownDocumentKind::Manuscript,
            Some(revision),
            text,
            outline_revision,
        )?;
        Ok(MarkdownProject {
            project_id: saved.project_id,
            revision: saved.revision.unwrap(),
            text: saved.text,
        })
    }
    pub fn save_document(
        &self,
        id: &str,
        kind: MarkdownDocumentKind,
        revision: Option<&str>,
        text: String,
    ) -> Result<MarkdownDocument> {
        self.save_document_guarded(id, kind, revision, text, None)
    }
    fn save_document_guarded(
        &self,
        id: &str,
        kind: MarkdownDocumentKind,
        revision: Option<&str>,
        text: String,
        outline_revision: Option<&str>,
    ) -> Result<MarkdownDocument> {
        let limit = match kind {
            MarkdownDocumentKind::Manuscript => MAX_TEXT_BYTES,
            MarkdownDocumentKind::Outline => MAX_OUTLINE_BYTES,
        };
        if text.len() > limit {
            return Err("MARKDOWN_TEXT_INVALID");
        }
        let _guard = self
            .writer
            .lock()
            .map_err(|_| "MARKDOWN_STORAGE_UNAVAILABLE")?;
        self.save_document_inner(id, kind, revision, text, outline_revision)
    }
    pub(super) fn save_document_inner(
        &self,
        id: &str,
        kind: MarkdownDocumentKind,
        revision: Option<&str>,
        text: String,
        outline_revision: Option<&str>,
    ) -> Result<MarkdownDocument> {
        let limit = match kind {
            MarkdownDocumentKind::Manuscript => MAX_TEXT_BYTES,
            MarkdownDocumentKind::Outline => MAX_OUTLINE_BYTES,
        };
        if text.len() > limit {
            return Err("MARKDOWN_TEXT_INVALID");
        }
        if let Some(expected) = outline_revision
            && self
                .read_document_inner(id, MarkdownDocumentKind::Outline)?
                .revision
                .as_deref()
                != Some(expected)
        {
            return Err("MARKDOWN_CONFLICT");
        }
        let current = self.read_document_inner(id, kind.clone())?;
        if current.revision.as_deref() != revision {
            return Err("MARKDOWN_CONFLICT");
        }
        self.protect(id, &current, &text)?;
        let name = match kind {
            MarkdownDocumentKind::Manuscript => "manuscript.md",
            MarkdownDocumentKind::Outline => "outline.md",
        };
        let path = self.directory(id)?.join(name);
        if current.revision.is_some() {
            regular(&path, false)?;
        }
        let mut file = io(AtomicWriteFile::open(&path))?;
        io(file.write_all(text.as_bytes()))?;
        #[cfg(test)]
        if self
            .fail_before_commit
            .load(std::sync::atomic::Ordering::Relaxed)
        {
            return Err("MARKDOWN_STORAGE_UNAVAILABLE");
        }
        io(file.commit())?;
        Ok(MarkdownDocument {
            project_id: id.into(),
            kind,
            revision: Some(snapshot(id, text.clone()).revision),
            text,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_bytes_conflict_validation_and_no_database() {
        let root = tempfile::tempdir().unwrap();
        let store = MarkdownProjects::open(root.path()).unwrap();
        fs::write(root.path().join("project.sqlite"), b"legacy sentinel").unwrap();
        assert!(MarkdownProjects::open(root.path()).is_err());
        fs::remove_file(root.path().join("project.sqlite")).unwrap();
        let text = "\u{feff}# 中文\r\nline\rfinal\n";
        let p = store.create(text.into()).unwrap();
        let dir = root.path().join(&p.project_id);
        assert_eq!(
            fs::read(dir.join("manuscript.md")).unwrap(),
            text.as_bytes()
        );
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 2);
        assert_eq!(store.read(&p.project_id).unwrap(), p);
        assert!(store.read("../elsewhere").is_err());
        assert!(store.read(&p.project_id.to_uppercase()).is_err());
        let saved = store
            .save(&p.project_id, &p.revision, "new".into())
            .unwrap();
        assert_eq!(
            store
                .save(&p.project_id, &p.revision, "stale".into())
                .unwrap_err(),
            "MARKDOWN_CONFLICT"
        );
        assert!(
            store
                .save(
                    &p.project_id,
                    &saved.revision,
                    "x".repeat(MAX_TEXT_BYTES + 1)
                )
                .is_err()
        );
        assert_eq!(store.read(&p.project_id).unwrap(), saved);
        store
            .fail_before_commit
            .store(true, std::sync::atomic::Ordering::Relaxed);
        assert!(
            store
                .save(&p.project_id, &saved.revision, "unpublished".into())
                .is_err()
        );
        assert_eq!(store.read(&p.project_id).unwrap(), saved);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 2);
        fs::write(dir.join("project.json"), br#"{"format":"scenesparrow","formatVersion":2,"projectId":"x","manuscript":"../other"}"#).unwrap();
        assert!(store.read(&p.project_id).is_err());
        assert_eq!(fs::read(dir.join("manuscript.md")).unwrap(), b"new");
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
    }
    #[cfg(unix)]
    #[test]
    fn refuses_symlinked_project_and_leaves_and_failed_replacement() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let store = MarkdownProjects::open(root.path()).unwrap();
        let p = store.create("previous".into()).unwrap();
        let dir = root.path().join(&p.project_id);
        let backup = dir.join("original.md");
        fs::rename(dir.join("manuscript.md"), &backup).unwrap();
        symlink(&backup, dir.join("manuscript.md")).unwrap();
        assert!(store.read(&p.project_id).is_err());
        assert!(
            store
                .save(&p.project_id, &p.revision, "bad".into())
                .is_err()
        );
        assert_eq!(fs::read(&backup).unwrap(), b"previous");
        fs::remove_file(dir.join("manuscript.md")).unwrap();
        fs::rename(&backup, dir.join("manuscript.md")).unwrap();
        fs::rename(dir.join("project.json"), dir.join("manifest.backup")).unwrap();
        symlink(dir.join("manifest.backup"), dir.join("project.json")).unwrap();
        assert!(store.read(&p.project_id).is_err());
        fs::remove_file(dir.join("project.json")).unwrap();
        fs::rename(dir.join("manifest.backup"), dir.join("project.json")).unwrap();
        fs::rename(&dir, root.path().join("original")).unwrap();
        symlink(root.path().join("original"), &dir).unwrap();
        assert!(store.read(&p.project_id).is_err());
    }
}
