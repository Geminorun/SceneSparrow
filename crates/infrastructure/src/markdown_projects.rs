//! The opt-in Web validation store has no SQLite repository or background jobs.
use atomic_write_file::AtomicWriteFile;
use scenesparrow_domain::{contracts::MarkdownProject, manuscript::MAX_TEXT_BYTES};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
use uuid::Uuid;

type Result<T> = std::result::Result<T, &'static str>;
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    format: String,
    format_version: u32,
    project_id: String,
    manuscript: String,
}
pub struct MarkdownProjects {
    root: PathBuf,
    writer: Mutex<()>,
    #[cfg(test)]
    fail_before_commit: std::sync::atomic::AtomicBool,
}
fn io<T>(result: std::io::Result<T>) -> Result<T> {
    result.map_err(|_| "MARKDOWN_STORAGE_UNAVAILABLE")
}
// shortcut: named-file checks assume a trusted local volume; use OS handles if hostile local writers enter scope.
fn regular(path: &Path, directory: bool) -> Result<()> {
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
fn read(path: &Path, limit: usize) -> Result<Vec<u8>> {
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
    fn read_inner(&self, id: &str) -> Result<MarkdownProject> {
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

    pub fn save(&self, id: &str, revision: &str, text: String) -> Result<MarkdownProject> {
        validate(&text)?;
        let _guard = self
            .writer
            .lock()
            .map_err(|_| "MARKDOWN_STORAGE_UNAVAILABLE")?;
        if self.read_inner(id)?.revision != revision {
            return Err("MARKDOWN_CONFLICT");
        }
        let path = self.directory(id)?.join("manuscript.md");
        regular(&path, false)?;
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
        Ok(snapshot(id, text))
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
