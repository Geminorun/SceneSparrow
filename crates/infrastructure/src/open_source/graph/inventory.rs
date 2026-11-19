use super::*;
#[derive(Debug, Clone, Copy)]
pub struct GraphBudgets {
    pub files: usize,
    pub per_file: u64,
    pub aggregate: u64,
}
impl Default for GraphBudgets {
    fn default() -> Self {
        Self {
            files: 20_000,
            per_file: 4 * 1024 * 1024 * 1024,
            aggregate: 16 * 1024 * 1024 * 1024,
        }
    }
}
fn credential(key: &str) -> bool {
    matches!(
        key,
        ".ssh"
            | ".aws"
            | ".gnupg"
            | ".env"
            | ".npmrc"
            | ".netrc"
            | ".pypirc"
            | "credentials.json"
            | "id_rsa"
            | "id_dsa"
            | "id_ecdsa"
            | "id_ed25519"
    ) || key.starts_with(".env.")
        || [".key", ".pem", ".p12", ".pfx", ".jks", ".keystore"]
            .iter()
            .any(|suffix| key.ends_with(suffix))
}
pub(crate) fn excluded(segment: &str, submitted: bool) -> Result<bool> {
    let key = scenesparrow_domain::open_project::portable_key(segment);
    if matches!(key.as_str(), ".scenesparrow" | ".git") {
        if submitted || segment != key {
            return Err(fail("GRAPH_FORBIDDEN_PATH"));
        }
        return Ok(true);
    }
    if credential(&key) {
        return if submitted {
            Err(fail("GRAPH_FORBIDDEN_PATH"))
        } else {
            Ok(true)
        };
    }
    if key == "project.json" && segment != "project.json" {
        return Err(fail("GRAPH_FORBIDDEN_PATH"));
    }
    Ok(matches!(
        key.as_str(),
        "node_modules" | ".cache" | ".next" | ".turbo" | "dist" | "build" | "output"
    ) || key.starts_with(".scenesparrow-stage-")
        || key.starts_with(".scenesparrow-displaced-")
        || matches!(key.as_str(), ".core.lock" | "source-intent.json")
        || key.ends_with(".pid")
        || key.ends_with(".sock"))
}
pub(super) fn validate_members(graph: &FileGraph, budgets: GraphBudgets) -> Result<()> {
    if db(serde_json::to_vec(graph))?.len() > 16 * 1024 * 1024 {
        return Err(fail("GRAPH_BUDGET_EXCEEDED"));
    }
    if graph.files.len() > budgets.files {
        return Err(fail("GRAPH_BUDGET_EXCEEDED"));
    }
    let mut total = 0u64;
    let mut previous: Option<&str> = None;
    for file in &graph.files {
        if previous.is_some_and(|p| p >= file.path.as_str())
            || file.hash.len() != 64
            || !file
                .hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(fail("GRAPH_INVALID"));
        }
        previous = Some(&file.path);
        for segment in file.path.split('/') {
            if excluded(segment, true)? {
                return Err(fail("GRAPH_FORBIDDEN_PATH"));
            }
        }
        total = total
            .checked_add(file.size)
            .filter(|s| *s <= budgets.aggregate)
            .ok_or(fail("GRAPH_BUDGET_EXCEEDED"))?;
        if file.size > budgets.per_file {
            return Err(fail("GRAPH_BUDGET_EXCEEDED"));
        }
    }
    scenesparrow_domain::open_project::validate_portable_paths(
        &graph
            .files
            .iter()
            .map(|f| f.path.as_str())
            .collect::<Vec<_>>(),
    )
    .map_err(format_error)
}
impl SqliteProjectRepository {
    /// Explicit rescan/candidate intake only, never called by the source poll.
    /// The caller selects the private candidate directory; no renderer path API.
    pub fn inventory_file_graph(
        &self,
        root: &Path,
        submitted: bool,
        budgets: GraphBudgets,
    ) -> Result<(String, FileGraph)> {
        let c = db(self.connection.lock())?;
        self.guard_source_recovery()?;
        let graph = self.inventory_graph_locked(root, submitted, budgets)?;
        self.validate_graph(&c, &graph)?;
        let hash = self.object(&db(serde_json::to_vec(&graph))?)?;
        Ok((hash, graph))
    }
    pub(super) fn inventory_graph_locked(
        &self,
        root: &Path,
        submitted: bool,
        budgets: GraphBudgets,
    ) -> Result<FileGraph> {
        self.scan_graph_locked(root, submitted, budgets, None)
            .map(|p| p.0)
    }
    pub(super) fn scan_graph_locked(
        &self,
        root: &Path,
        submitted: bool,
        budgets: GraphBudgets,
        project_id: Option<&str>,
    ) -> Result<(FileGraph, BTreeMap<String, Identity>)> {
        self.scan_graph_cancellable(root, submitted, budgets, project_id, None)
    }
    pub(super) fn scan_graph_cancellable(
        &self,
        root: &Path,
        submitted: bool,
        budgets: GraphBudgets,
        project_id: Option<&str>,
        request: Option<&str>,
    ) -> Result<(FileGraph, BTreeMap<String, Identity>)> {
        let mut check = || request.map_or(Ok(()), |r| self.work_cancelled(r));
        check()?;
        plain_directory(root)?;
        let project_id = if let Some(project_id) = project_id {
            project_id.to_owned()
        } else {
            let manifest = Parent::open(root, "project.json")?
                .read("project.json", false)?
                .ok_or(fail("GRAPH_REQUIRED_FILE_MISSING"))?
                .0;
            let manifest = match scenesparrow_domain::open_project::inspect_project_manifest(
                serde_json::from_slice(&manifest).map_err(|_| fail("FORMAT_INVALID"))?,
            )
            .map_err(format_error)?
            {
                scenesparrow_domain::open_project::ManifestInspection::Supported(m) => m,
                _ => return Err(fail("SOURCE_FUTURE_READ_ONLY")),
            };
            manifest.project_id
        };
        let mut graph = FileGraph {
            version: 1,
            project_id,
            files: vec![],
        };
        let mut identities = BTreeMap::new();
        let mut pending = vec![String::new()];
        let mut total = 0u64;
        let mut directories = 0usize;
        while let Some(prefix) = pending.pop() {
            directories = directories
                .checked_add(1)
                .filter(|n| *n <= budgets.files.saturating_mul(32).saturating_add(1))
                .ok_or(fail("GRAPH_BUDGET_EXCEEDED"))?;
            let parent = Parent::open(root, &format!("{prefix}__inventory__"))?;
            for name in parent.entries(budgets.files.saturating_mul(32).saturating_add(32))? {
                if excluded(&name, submitted)? {
                    continue;
                }
                let relative = format!("{prefix}{name}");
                scenesparrow_domain::open_project::validate_portable_paths(&[&relative])
                    .map_err(format_error)?;
                let metadata = db(std::fs::symlink_metadata(root.join(&relative)))?;
                if metadata.file_type().is_symlink() {
                    return Err(fail("SOURCE_PATH_UNSAFE"));
                }
                if metadata.is_dir() {
                    pending.push(format!("{relative}/"));
                    continue;
                }
                if !metadata.is_file() {
                    return Err(fail("SOURCE_PATH_UNSAFE"));
                }
                if graph.files.len() >= budgets.files || metadata.len() > budgets.per_file {
                    return Err(fail("GRAPH_BUDGET_EXCEEDED"));
                }
                let limit = budgets
                    .per_file
                    .min(budgets.aggregate.saturating_sub(total));
                let (hash, size, id) = parent
                    .streamed_checked(&name, limit, &mut check)?
                    .ok_or(fail("SOURCE_EXTERNAL_CHANGE"))?;
                if self.directory.join("objects").join(&hash).exists() {
                    struct CheckedSink<'a>(&'a mut dyn FnMut() -> Result<()>);
                    impl std::io::Write for CheckedSink<'_> {
                        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                            (self.0)().map_err(|_| std::io::Error::other("work cancelled"))?;
                            Ok(bytes.len())
                        }
                        fn flush(&mut self) -> std::io::Result<()> {
                            Ok(())
                        }
                    }
                    let verified = self.stream_object_to(&hash, &mut CheckedSink(&mut check));
                    check()?;
                    if verified? != size {
                        return Err(fail("GRAPH_INVALID"));
                    }
                } else {
                    let (mut input, opened) = parent
                        .open_file(&name)?
                        .ok_or(fail("SOURCE_EXTERNAL_CHANGE"))?;
                    struct CheckedRead<'a> {
                        file: &'a mut File,
                        check: &'a mut dyn FnMut() -> Result<()>,
                    }
                    impl std::io::Read for CheckedRead<'_> {
                        fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
                            (self.check)().map_err(|_| std::io::Error::other("work cancelled"))?;
                            std::io::Read::read(self.file, bytes)
                        }
                    }
                    let published = self.object_stream(
                        &mut CheckedRead {
                            file: &mut input,
                            check: &mut check,
                        },
                        limit,
                    );
                    check()?;
                    if opened != id || published? != (hash.clone(), size) {
                        return Err(fail("SOURCE_EXTERNAL_CHANGE"));
                    }
                }
                if parent.streamed_checked(&name, limit, &mut check)?
                    != Some((hash.clone(), size, id.clone()))
                {
                    return Err(fail("SOURCE_EXTERNAL_CHANGE"));
                }
                total = total
                    .checked_add(size)
                    .filter(|s| *s <= budgets.aggregate)
                    .ok_or(fail("GRAPH_BUDGET_EXCEEDED"))?;
                identities.insert(relative.clone(), id);
                graph.files.push(GraphFile {
                    path: relative,
                    hash,
                    size,
                });
            }
            parent.verify()?;
        }
        graph.files.sort_by(|a, b| a.path.cmp(&b.path));
        validate_members(&graph, budgets)?;
        Ok((graph, identities))
    }
}
