pub mod diagnostics;
use std::{
    fs::File,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

use rusqlite::{Connection, OptionalExtension, params};
use scenesparrow_application::{Error, ProjectRepository};
use scenesparrow_domain::Project;

struct ProjectOwner(File);

impl ProjectOwner {
    fn acquire(file: File) -> Result<Self, Error> {
        storage(file.try_lock())?;
        Ok(Self(file))
    }
}

impl Drop for ProjectOwner {
    fn drop(&mut self) {
        // A forked utility can retain this file description until exec. Closing
        // our descriptor alone would leave the project locked in that interval.
        let _ = self.0.unlock();
    }
}

pub struct SqliteProjectRepository {
    #[cfg(test)]
    source_fault: Mutex<Option<String>>,
    #[cfg(test)]
    source_action: Mutex<Option<(String, open_source::TestAction)>>,
    #[cfg(test)]
    business_read_count: std::sync::atomic::AtomicUsize,
    #[cfg(test)]
    fail_export_directory_sync: std::sync::atomic::AtomicBool,
    source_observation: Mutex<open_source::Observation>,
    connection: Mutex<Connection>,
    quiescing: std::sync::atomic::AtomicBool,
    workers: std::sync::atomic::AtomicUsize,
    directory: std::path::PathBuf,
    creative_root: Option<std::path::PathBuf>,
    policy: Arc<dyn scenesparrow_domain::manuscript::MutationPolicy>,
    ai_consumers: Mutex<
        std::collections::BTreeMap<
            String,
            Arc<dyn scenesparrow_application::ai::ConsumerCoordinator>,
        >,
    >,
    // Drop the connection and consumers before releasing single-owner exclusion.
    _owner: Option<ProjectOwner>,
}

#[cfg_attr(test, track_caller)]
fn storage<T>(result: Result<T, impl std::fmt::Debug>) -> Result<T, Error> {
    #[cfg(test)]
    let caller = std::panic::Location::caller();
    result.map_err(|_| {
        #[cfg(test)]
        eprintln!("storage failure at {caller}");
        diagnostics::emit(diagnostics::Event::StorageFailed);
        Error::Storage
    })
}

fn read_project(connection: &Connection) -> Result<Option<Project>, Error> {
    storage(
        connection
            .query_row(
                "SELECT id, title, working_revision, approved_baseline FROM project WHERE singleton = 1",
                [],
                |row| Ok(Project {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    working_revision: row.get(2)?,
                    approved_baseline: row.get(3)?,
                }),
            )
            .optional(),
    )
}

impl SqliteProjectRepository {
    pub fn open(directory: &Path) -> Result<Self, Error> {
        if directory.join("project.json").exists() || directory.join(".scenesparrow").exists() {
            return Self::open_format(directory).map_err(|_| Error::Storage);
        }
        Self::open_with_mode(directory, false)
    }

    /// Reopening must never replace a database removed after desktop preflight.
    pub fn open_existing(directory: &Path) -> Result<Self, Error> {
        if directory.join("project.json").exists() || directory.join(".scenesparrow").exists() {
            return Self::open_format(directory).map_err(|_| Error::Storage);
        }
        Self::open_with_mode(directory, true)
    }

    fn open_with_mode(directory: &Path, require_existing: bool) -> Result<Self, Error> {
        Self::open_storage(directory, require_existing, None)
    }
    fn open_managed_existing(root: &Path) -> Result<Self, Error> {
        Self::open_storage(&root.join(".scenesparrow"), true, Some(root))
    }
    fn open_storage(
        directory: &Path,
        require_existing: bool,
        creative_root: Option<&Path>,
    ) -> Result<Self, Error> {
        if require_existing && !storage(std::fs::metadata(directory))?.is_dir() {
            return Err(Error::Storage);
        }
        for component in ["objects", "staging", "exports"] {
            let path = directory.join(component);
            if path.exists()
                && (!storage(std::fs::symlink_metadata(&path))?.is_dir()
                    || storage(std::fs::symlink_metadata(&path))?
                        .file_type()
                        .is_symlink())
            {
                return Err(Error::Storage);
            }
        }
        for component in ["project.sqlite", ".core.lock"] {
            let path = directory.join(component);
            if std::fs::symlink_metadata(&path)
                .is_ok_and(|m| !m.is_file() || m.file_type().is_symlink())
            {
                return Err(Error::Storage);
            }
        }
        if !require_existing {
            storage(std::fs::create_dir_all(directory))?;
        }
        let owner = storage(
            File::options()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(directory.join(".core.lock")),
        )?;
        let owner = ProjectOwner::acquire(owner)?;
        let mut flags = rusqlite::OpenFlags::default();
        if require_existing {
            flags.remove(rusqlite::OpenFlags::SQLITE_OPEN_CREATE);
        }
        let mut connection = storage(Connection::open_with_flags(
            directory.join("project.sqlite"),
            flags,
        ))?;
        storage(connection.busy_timeout(Duration::from_secs(3)))?;
        let version: i64 =
            storage(connection.pragma_query_value(None, "user_version", |row| row.get(0)))?;
        if version > 13 || (require_existing && version < 1) {
            return Err(Error::SchemaUnsupported);
        }
        storage(connection.pragma_update(None, "journal_mode", "WAL"))?;
        storage(connection.pragma_update(None, "synchronous", "FULL"))?;
        storage(connection.pragma_update(None, "foreign_keys", true))?;
        if version == 0 {
            let transaction = storage(connection.transaction())?;
            storage(transaction.execute_batch(include_str!("../migrations/001_project.sql")))?;
            storage(transaction.commit())?;
        }
        if version < 2 {
            backup::migration_backup(&connection, directory, 2)?;
            // Keep the original bare SQLite compatibility restore point as well.
            // SQLite's backup API includes committed WAL pages in a consistent snapshot.
            let mut backup_path = directory.join("pre-migration-002.sqlite");
            if backup_path.exists() {
                backup_path =
                    directory.join(format!("pre-migration-002-{}.sqlite", uuid::Uuid::new_v4()));
            }
            let mut backup = storage(Connection::open(&backup_path))?;
            storage(rusqlite::backup::Backup::new(&connection, &mut backup))?
                .run_to_completion(32, Duration::from_millis(10), None)
                .map_err(|_| Error::Storage)?;
            let transaction = storage(connection.transaction())?;
            storage(transaction.execute_batch(include_str!("../migrations/002_manuscript.sql")))?;
            if read_project(&transaction)?.is_some() {
                manuscript::initialize(&transaction)?;
            }
            storage(transaction.commit())?;
        }
        if version < 3 {
            backup::migration_backup(&connection, directory, 3)?;
            let transaction = storage(connection.transaction())?;
            storage(transaction.execute_batch(include_str!("../migrations/003_history.sql")))?;
            storage(transaction.commit())?;
        }
        if version < 4 {
            backup::migration_backup(&connection, directory, 4)?;
            let transaction = storage(connection.transaction())?;
            storage(
                transaction.execute_batch(include_str!("../migrations/004_sources_import.sql")),
            )?;
            storage(transaction.commit())?;
        }
        if version < 5 {
            backup::migration_backup(&connection, directory, 5)?;
            let tx = storage(connection.transaction())?;
            storage(tx.execute_batch(include_str!("../migrations/005_shared_ai.sql")))?;
            storage(tx.execute(
                "INSERT INTO ai_execution_origin VALUES(1,?1,0)",
                [uuid::Uuid::new_v4().to_string()],
            ))?;
            storage(tx.commit())?;
        }
        if version < 6 {
            backup::migration_backup(&connection, directory, 6)?;
            let tx = storage(connection.transaction())?;
            storage(tx.execute_batch(include_str!("../migrations/006_planning.sql")))?;
            storage(tx.execute("INSERT OR IGNORE INTO planning_state(singleton,revision,content_json) VALUES(1,0,?1)", [serde_json::to_string(&scenesparrow_domain::planning::empty()).map_err(|_| Error::Storage)?]))?;
            storage(tx.commit())?;
        }
        if version < 7 {
            backup::migration_backup(&connection, directory, 7)?;
            let tx = storage(connection.transaction())?;
            storage(tx.execute_batch(include_str!("../migrations/007_review.sql")))?;
            storage(tx.commit())?;
        }
        if version < 8 {
            backup::migration_backup(&connection, directory, 8)?;
            let tx = storage(connection.transaction())?;
            storage(tx.execute_batch(include_str!("../migrations/008_finalization.sql")))?;
            storage(tx.commit())?;
        }
        if version < 9 {
            backup::migration_backup(&connection, directory, 9)?;
            let tx = storage(connection.transaction())?;
            storage(tx.execute_batch(include_str!("../migrations/009_exports.sql")))?;
            storage(tx.commit())?;
        }
        if version < 10 {
            backup::migration_backup(&connection, directory, 10)?;
            let tx = storage(connection.transaction())?;
            storage(tx.execute_batch(include_str!("../migrations/010_project_metadata.sql")))?;
            storage(tx.commit())?;
        }
        if version < 11 {
            backup::migration_backup(&connection, directory, 11)?;
            let tx = storage(connection.transaction())?;
            storage(tx.execute_batch(include_str!("../migrations/011_open_source.sql")))?;
            storage(tx.commit())?;
        }
        if version < 12 {
            backup::migration_backup(&connection, directory, 12)?;
            let tx = storage(connection.transaction())?;
            storage(tx.execute_batch(include_str!("../migrations/012_source_candidates.sql")))?;
            storage(tx.commit())?;
        }
        if version < 13 {
            backup::migration_backup(&connection, directory, 13)?;
            let tx = storage(connection.transaction())?;
            storage(tx.execute_batch(include_str!("../migrations/013_file_graph.sql")))?;
            storage(tx.commit())?;
        }
        storage(std::fs::create_dir_all(directory.join("exports")))?;
        storage(std::fs::create_dir_all(directory.join("objects")))?;
        storage(std::fs::create_dir_all(directory.join("staging")))?;
        let repository = Self {
            #[cfg(test)]
            source_fault: Mutex::new(None),
            #[cfg(test)]
            source_action: Mutex::new(None),
            #[cfg(test)]
            business_read_count: std::sync::atomic::AtomicUsize::new(0),
            #[cfg(test)]
            fail_export_directory_sync: std::sync::atomic::AtomicBool::new(false),
            source_observation: Mutex::new(open_source::Observation::default()),
            connection: Mutex::new(connection),
            quiescing: std::sync::atomic::AtomicBool::new(false),
            workers: std::sync::atomic::AtomicUsize::new(0),
            directory: directory.to_path_buf(),
            creative_root: creative_root.map(std::path::Path::to_path_buf),
            policy: Arc::new(scenesparrow_domain::manuscript::Unrestricted),
            ai_consumers: Mutex::new(std::collections::BTreeMap::new()),
            _owner: Some(owner),
        };
        if version < 5 {
            repository
                .initialize_ai_origin()
                .map_err(|_| Error::Storage)?;
        }
        // Recover creative generations before projections, jobs or collection.
        repository
            .recover_source_intents()
            .map_err(|_| Error::Storage)?;
        if repository.creative_root.is_some() {
            repository
                .verify_source_state()
                .map_err(|_| Error::Storage)?;
        }
        // Validate acknowledged data before startup recovery mutates task state.
        repository.verify_manuscript()?;
        {
            let c = storage(repository.connection.lock())?;
            storage(c.execute(
                "UPDATE downstream_inputs SET status='cancelled' WHERE status='using'",
                [],
            ))?;
        }
        scenesparrow_application::ai::AiExecutionPort::reconcile_execution(&repository)
            .map_err(|_| Error::Storage)?;
        repository.recover_exports().map_err(|_| Error::Storage)?;
        repository.recover_documents().map_err(|_| Error::Storage)?;
        repository
            .initialize_planning()
            .map_err(|_| Error::Storage)?;
        repository.verify_manuscript()?;
        repository
            .collect_objects(Duration::from_secs(60))
            .map_err(|_| Error::Storage)?;
        {
            let mut c = storage(repository.connection.lock())?;
            let tx = storage(c.transaction())?;
            let closed = storage(tx.execute(
                "UPDATE edit_groups SET closed=1,before_hash=NULL,after_hash='' WHERE closed=0",
                [],
            ))?;
            if closed > 0 {
                let revision: i64 = storage(tx.query_row(
                    "SELECT history_revision FROM history_cursor",
                    [],
                    |r| r.get(0),
                ))?;
                let next =
                    scenesparrow_domain::manuscript::next_revision(revision).unwrap_or(revision);
                storage(tx.execute("UPDATE history_cursor SET history_revision=?1", [next]))?;
            }
            storage(tx.commit())?;
        }
        Ok(repository)
    }
    pub fn with_policy(
        mut self,
        policy: Arc<dyn scenesparrow_domain::manuscript::MutationPolicy>,
    ) -> Self {
        self.policy = policy;
        self
    }
}

impl ProjectRepository for SqliteProjectRepository {
    fn read(&self) -> Result<Option<Project>, Error> {
        let connection = storage(self.connection.lock())?;
        read_project(&connection)
    }

    fn create(&self, request_id: &str, title: &str) -> Result<Project, Error> {
        let mut connection = storage(self.connection.lock())?;
        if self.is_quiescing() {
            return Err(Error::Closing);
        }
        let transaction = storage(connection.transaction())?;
        if let Some(project) = read_project(&transaction)? {
            let previous_request: String = storage(transaction.query_row(
                "SELECT request_id FROM project WHERE singleton = 1",
                [],
                |row| row.get(0),
            ))?;
            return if request_id == previous_request && title == project.title {
                Ok(project)
            } else {
                Err(Error::Conflict)
            };
        }
        let project = initialize_project(&transaction, request_id, title)?;
        storage(transaction.commit())?;
        Ok(project)
    }

    fn ensure(&self, request_id: &str, title: &str) -> Result<Project, Error> {
        let mut connection = storage(self.connection.lock())?;
        if self.is_quiescing() {
            return Err(Error::Closing);
        }
        let transaction = storage(connection.transaction())?;
        if let Some(project) = read_project(&transaction)? {
            return Ok(project);
        }
        let project = initialize_project(&transaction, request_id, title)?;
        storage(transaction.commit())?;
        Ok(project)
    }

    fn rename(
        &self,
        request_id: &str,
        project_id: &str,
        previous_title: &str,
        title: &str,
    ) -> Result<Project, Error> {
        let mut connection = storage(self.connection.lock())?;
        if self.is_quiescing() {
            return Err(Error::Closing);
        }
        if open_source::graph::graph_row(&connection)
            .map_err(|_| Error::Storage)?
            .is_some()
        {
            return self.rename_file_graph_locked(
                &mut connection,
                request_id,
                project_id,
                previous_title,
                title,
            );
        }
        let tx = storage(connection.transaction())?;
        let Some(mut project) = read_project(&tx)? else {
            return Err(Error::Conflict);
        };
        let receipt: Option<(String, String, String, i64)> = storage(tx.query_row(
            "SELECT project_id, previous_title, title, sequence FROM project_rename_receipts WHERE request_id=?1",
            [request_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        ).optional())?;
        if let Some((saved_id, saved_previous, saved_title, sequence)) = receipt {
            let latest: i64 = storage(tx.query_row(
                "SELECT MAX(sequence) FROM project_rename_receipts",
                [],
                |r| r.get(0),
            ))?;
            // A replay never performs another write, even after an intervening ABA rename.
            return if saved_id == project_id
                && saved_previous == previous_title
                && saved_title == title
                && project.id == project_id
                && project.title == title
                && sequence == latest
            {
                Ok(project)
            } else {
                Err(Error::Conflict)
            };
        }
        if project.id != project_id || project.title != previous_title {
            return Err(Error::Conflict);
        }
        storage(tx.execute("UPDATE project SET title=?1 WHERE singleton=1", [title]))?;
        storage(tx.execute(
            "INSERT INTO project_rename_receipts(request_id,project_id,previous_title,title) VALUES(?1,?2,?3,?4)",
            params![request_id, project_id, previous_title, title],
        ))?;
        storage(tx.commit())?;
        project.title = title.to_owned();
        Ok(project)
    }
}

fn initialize_project(
    connection: &Connection,
    request_id: &str,
    title: &str,
) -> Result<Project, Error> {
    let project = Project {
        id: uuid::Uuid::new_v4().to_string(),
        title: title.to_owned(),
        working_revision: 0,
        approved_baseline: None,
    };
    storage(connection.execute(
        "INSERT INTO project (singleton, id, title, request_id, working_revision, approved_baseline) VALUES (1, ?1, ?2, ?3, 0, NULL)",
        params![project.id, project.title, request_id],
    ))?;
    manuscript::initialize(connection)?;
    Ok(project)
}

#[cfg(test)]
mod tests {
    use super::*;
    use scenesparrow_application::ProjectService;

    #[test]
    fn persists_reopens_and_enforces_idempotency() {
        let directory = tempfile::tempdir().unwrap();
        let service = ProjectService::new(SqliteProjectRepository::open(directory.path()).unwrap());
        assert!(service.read().unwrap().is_none());
        assert!(matches!(
            service.create("request-1", " "),
            Err(Error::InvalidTitle)
        ));
        let project = service.create("request-1", "幕雀 project").unwrap();
        assert_eq!(
            service.create("request-1", "幕雀 project").unwrap(),
            project
        );
        assert!(matches!(
            service.create("request-1", "Different"),
            Err(Error::Conflict)
        ));
        assert!(matches!(
            service.create("request-2", "幕雀 project"),
            Err(Error::Conflict)
        ));
        assert!(matches!(
            service.create("bad request", "Title"),
            Err(Error::InvalidRequest)
        ));
        assert!(SqliteProjectRepository::open(directory.path()).is_err());
        drop(service);
        let reopened = SqliteProjectRepository::open(directory.path()).unwrap();
        assert_eq!(reopened.read().unwrap(), Some(project));
    }

    #[test]
    fn concurrent_first_open_returns_one_project_and_existing_ensure_is_read_only() {
        use scenesparrow_application::manuscript::ManuscriptRepository;
        let directory = tempfile::tempdir().unwrap();
        let service = Arc::new(ProjectService::new(
            SqliteProjectRepository::open(directory.path()).unwrap(),
        ));
        let barrier = Arc::new(std::sync::Barrier::new(12));
        let threads = (0..12)
            .map(|n| {
                let service = service.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    service
                        .ensure(
                            &format!("browser-{n}"),
                            if n % 2 == 0 {
                                "Untitled project"
                            } else {
                                "未命名项目"
                            },
                        )
                        .unwrap()
                })
            })
            .collect::<Vec<_>>();
        let projects = threads
            .into_iter()
            .map(|t| t.join().unwrap())
            .collect::<Vec<_>>();
        assert!(projects.iter().all(|p| p == &projects[0]));
        let manuscript = service.repository().read_manuscript().unwrap();
        let history = service.repository().read_history().unwrap();
        assert_eq!(
            service.ensure("retry", "Different default").unwrap(),
            projects[0]
        );
        assert_eq!(service.repository().read_manuscript().unwrap(), manuscript);
        assert_eq!(service.repository().read_history().unwrap(), history);
        assert_eq!(service.read().unwrap(), Some(projects[0].clone()));
        assert!(matches!(
            service.create("explicit-create", "Other project"),
            Err(Error::Conflict)
        ));
    }

    #[test]
    fn rename_compares_identity_title_and_receipts_without_replaying_later_renames() {
        let directory = tempfile::tempdir().unwrap();
        let service = ProjectService::new(SqliteProjectRepository::open(directory.path()).unwrap());
        let project = service.ensure("first", "Untitled project").unwrap();
        for (request, id, previous, title) in [
            (
                "bad request",
                project.id.clone(),
                project.title.as_str(),
                "Title",
            ),
            (
                "bad-id",
                "not-a-project-id".into(),
                project.title.as_str(),
                "Title",
            ),
            (
                "bad-previous",
                project.id.clone(),
                " Untitled project ",
                "Title",
            ),
        ] {
            assert!(matches!(
                service.rename(request, &id, previous, title),
                Err(Error::InvalidRequest)
            ));
        }
        assert!(matches!(
            service.rename("empty", &project.id, &project.title, " "),
            Err(Error::InvalidTitle)
        ));
        assert!(matches!(
            service.rename(
                "mismatch",
                &uuid::Uuid::new_v4().to_string(),
                &project.title,
                "Title"
            ),
            Err(Error::Conflict)
        ));
        let renamed = service
            .rename(
                "rename-one",
                &project.id,
                &project.title,
                "  My film 幕雀  ",
            )
            .unwrap();
        assert_eq!(renamed.title, "My film 幕雀");
        assert_eq!(
            service
                .rename("rename-one", &project.id, &project.title, "My film 幕雀")
                .unwrap(),
            renamed
        );
        assert!(matches!(
            service.rename("rename-one", &project.id, &project.title, "Changed payload"),
            Err(Error::Conflict)
        ));
        assert!(matches!(
            service.rename("stale", &project.id, &project.title, "Stale edit"),
            Err(Error::Conflict)
        ));
        let third = service
            .rename("rename-two", &project.id, &renamed.title, "Later name")
            .unwrap();
        assert!(matches!(
            service.rename("rename-one", &project.id, &project.title, &renamed.title),
            Err(Error::Conflict)
        ));
        // Even returning to the previous title cannot make an old receipt write again.
        service
            .rename("rename-three", &project.id, &third.title, &project.title)
            .unwrap();
        assert!(matches!(
            service.rename("rename-one", &project.id, &project.title, &renamed.title),
            Err(Error::Conflict)
        ));
        assert_eq!(service.read().unwrap(), Some(project.clone()));
        drop(service);
        let service = ProjectService::new(SqliteProjectRepository::open(directory.path()).unwrap());
        assert_eq!(
            service
                .ensure("next-launch", "Another locale default")
                .unwrap(),
            project
        );
        assert!(matches!(
            service.rename("rename-one", &project.id, &project.title, &renamed.title),
            Err(Error::Conflict)
        ));
        assert_eq!(
            service
                .rename("rename-three", &project.id, &third.title, &project.title)
                .unwrap(),
            project
        );
    }

    #[test]
    fn quiescing_fences_project_metadata_writes_until_resume() {
        let directory = tempfile::tempdir().unwrap();
        let repo = SqliteProjectRepository::open(directory.path()).unwrap();
        repo.quiesce().unwrap();
        assert!(matches!(
            repo.ensure("first", "Untitled project"),
            Err(Error::Closing)
        ));
        assert!(repo.read().unwrap().is_none());
        repo.resume();
        let project = repo.ensure("first", "Untitled project").unwrap();
        repo.quiesce().unwrap();
        assert!(matches!(
            repo.rename("rename", &project.id, &project.title, "Changed"),
            Err(Error::Closing)
        ));
        assert_eq!(repo.read().unwrap(), Some(project.clone()));
        repo.resume();
        assert_eq!(
            repo.rename("rename", &project.id, &project.title, "Changed")
                .unwrap()
                .title,
            "Changed"
        );
    }

    #[test]
    fn failed_rename_receipt_insert_rolls_back_title_and_remains_retryable() {
        let directory = tempfile::tempdir().unwrap();
        let repo = SqliteProjectRepository::open(directory.path()).unwrap();
        let project = repo.ensure("first", "Untitled project").unwrap();
        repo.connection.lock().unwrap().execute_batch(
            "CREATE TEMP TRIGGER fail_rename BEFORE INSERT ON project_rename_receipts BEGIN SELECT RAISE(FAIL,'injected'); END;"
        ).unwrap();
        assert!(matches!(
            repo.rename("rename", &project.id, &project.title, "New title"),
            Err(Error::Storage)
        ));
        assert_eq!(repo.read().unwrap(), Some(project.clone()));
        {
            let c = repo.connection.lock().unwrap();
            assert_eq!(
                c.query_row("SELECT COUNT(*) FROM project_rename_receipts", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
            c.execute_batch("DROP TRIGGER fail_rename").unwrap();
        }
        assert_eq!(
            repo.rename("rename", &project.id, &project.title, "New title")
                .unwrap()
                .title,
            "New title"
        );
    }

    #[test]
    fn migration010_failure_preserves_v9_project_and_retries_from_verified_backup() {
        use scenesparrow_application::manuscript::ManuscriptRepository;
        let directory = tempfile::tempdir().unwrap();
        let repo = SqliteProjectRepository::open(directory.path()).unwrap();
        let project = repo.create("legacy", "Existing project").unwrap();
        let manuscript = repo.read_manuscript().unwrap();
        let history = repo.read_history().unwrap();
        drop(repo);
        let c = Connection::open(directory.path().join("project.sqlite")).unwrap();
        drop_file_graph_schema_for_legacy_fixture(&c);
        c.execute_batch("DROP TABLE authored_source;DROP TABLE source_operations;DROP TABLE source_pins;DROP TABLE source_candidates;DROP TABLE source_candidate_observation;DROP TABLE source_recovery_evidence;DROP TABLE source_recovery_decisions;ALTER TABLE export_jobs DROP COLUMN serializer_version;DROP TABLE project_rename_receipts; PRAGMA user_version=9; CREATE TABLE project_rename_receipts(conflict INTEGER);").unwrap();
        assert!(SqliteProjectRepository::open(directory.path()).is_err());
        assert_eq!(
            c.pragma_query_value::<i64, _>(None, "user_version", |r| r.get(0))
                .unwrap(),
            9
        );
        assert_eq!(read_project(&c).unwrap(), Some(project.clone()));
        let backup = std::fs::read_dir(directory.path())
            .unwrap()
            .map(|e| e.unwrap().path())
            .find(|p| {
                p.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("pre-migration-010-")
            })
            .unwrap();
        SqliteProjectRepository::inspect_project(&backup).unwrap();
        c.execute_batch("DROP TABLE project_rename_receipts")
            .unwrap();
        drop(c);
        let repo = SqliteProjectRepository::open(directory.path()).unwrap();
        assert_eq!(repo.read().unwrap(), Some(project.clone()));
        assert_eq!(repo.read_manuscript().unwrap(), manuscript);
        assert_eq!(repo.read_history().unwrap(), history);
        assert_eq!(
            repo.rename("rename", &project.id, &project.title, "New title")
                .unwrap()
                .id,
            project.id
        );
    }

    #[test]
    fn existing_open_never_creates_missing_paths_or_initializes_schema_zero() {
        let root = tempfile::tempdir().unwrap();
        let missing = root.path().join("missing");
        assert!(SqliteProjectRepository::open_existing(&missing).is_err());
        assert!(!missing.exists());
        let database = root.path().join("project.sqlite");
        assert!(SqliteProjectRepository::open_existing(root.path()).is_err());
        assert!(!database.exists());
        std::fs::write(&database, []).unwrap();
        assert!(matches!(
            SqliteProjectRepository::open_existing(root.path()),
            Err(Error::SchemaUnsupported)
        ));
        assert!(std::fs::read(&database).unwrap().is_empty());
        let connection = Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE preserved(value TEXT); INSERT INTO preserved VALUES('original');",
            )
            .unwrap();
        drop(connection);
        let before = std::fs::read(&database).unwrap();
        assert!(matches!(
            SqliteProjectRepository::open_existing(root.path()),
            Err(Error::SchemaUnsupported)
        ));
        assert_eq!(std::fs::read(&database).unwrap(), before);
        assert!(!root.path().join("objects").exists());
    }

    #[test]
    fn existing_open_migrates_supported_legacy_database_without_changing_project_identity() {
        let directory = tempfile::tempdir().unwrap();
        let connection = Connection::open(directory.path().join("project.sqlite")).unwrap();
        connection
            .execute_batch(include_str!("../migrations/001_project.sql"))
            .unwrap();
        connection.execute("INSERT INTO project VALUES(1,'legacy-id','Legacy project','legacy-request',0,NULL)", []).unwrap();
        let original = read_project(&connection).unwrap().unwrap();
        drop(connection);
        SqliteProjectRepository::inspect_available_project(directory.path()).unwrap();
        let repository = SqliteProjectRepository::open_existing(directory.path()).unwrap();
        assert_eq!(repository.read().unwrap(), Some(original));
        let connection = repository.connection.lock().unwrap();
        assert_eq!(
            connection
                .pragma_query_value::<i64, _>(None, "user_version", |row| row.get(0))
                .unwrap(),
            13
        );
        assert!(directory.path().join("pre-migration-002.sqlite").exists());
    }

    #[test]
    fn refuses_an_unknown_schema_version() {
        let directory = tempfile::tempdir().unwrap();
        let connection = Connection::open(directory.path().join("project.sqlite")).unwrap();
        connection.pragma_update(None, "user_version", 99).unwrap();
        drop(connection);
        assert!(SqliteProjectRepository::open(directory.path()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn reopen_releases_owner_lock_even_while_an_inherited_descriptor_remains_open() {
        let directory = tempfile::tempdir().unwrap();
        let repository = SqliteProjectRepository::open(directory.path()).unwrap();
        // A forked utility holds the same open file description until exec closes it.
        let inherited = repository._owner.as_ref().unwrap().0.try_clone().unwrap();
        assert!(SqliteProjectRepository::open(directory.path()).is_err());
        drop(repository);
        let reopened = SqliteProjectRepository::open(directory.path()).unwrap();
        assert!(SqliteProjectRepository::open(directory.path()).is_err());
        drop(inherited);
        assert!(SqliteProjectRepository::open(directory.path()).is_err());
        drop(reopened);
        assert!(SqliteProjectRepository::open(directory.path()).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn failed_initialization_releases_owner_lock_with_an_inherited_descriptor() {
        let directory = tempfile::tempdir().unwrap();
        let file = File::options()
            .read(true)
            .write(true)
            .create_new(true)
            .open(directory.path().join(".core.lock"))
            .unwrap();
        let mut inherited = None;
        let result: Result<(), Error> = (|| {
            let owner = ProjectOwner::acquire(file)?;
            inherited = Some(owner.0.try_clone().unwrap());
            // Startup may fail after acquisition, before a repository exists.
            Err(Error::SchemaUnsupported)
        })();
        assert!(matches!(result, Err(Error::SchemaUnsupported)));
        assert!(SqliteProjectRepository::open(directory.path()).is_ok());
        drop(inherited);
    }
}

mod finalization;
mod history;
pub mod manuscript;
#[cfg(test)]
mod manuscript_tests;

mod documents;

pub mod ai;
pub mod credentials;

#[cfg(test)]
fn drop_file_graph_schema_for_legacy_fixture(c: &Connection) {
    c.execute_batch("DROP TABLE accepted_file_graph;DROP TABLE history_file_graphs;DROP TABLE file_graph_pins;DROP TABLE approved_file_graphs;DROP TABLE graph_recovery_members;DROP TABLE graph_recovery_decisions;").unwrap();
}
#[cfg(test)]
fn drop_finalization_schema_for_legacy_fixture(c: &Connection) {
    drop_file_graph_schema_for_legacy_fixture(c);
    c.execute_batch(
        "DROP TABLE authored_source;DROP TABLE source_operations;DROP TABLE source_pins;DROP TABLE source_candidates;DROP TABLE source_candidate_observation;DROP TABLE source_recovery_evidence;DROP TABLE source_recovery_decisions;",
    )
    .unwrap();
    c.execute_batch("DROP TABLE project_rename_receipts;")
        .unwrap();
    c.execute_batch("DROP TABLE copy_preparations;DROP TABLE export_deliveries;DROP TABLE export_controls;DROP TABLE export_jobs;").unwrap();
    c.execute_batch("DROP TABLE downstream_dependencies;DROP TABLE downstream_inputs;DROP TABLE review_candidate_bindings;DROP TABLE review_history_evidence;DROP TABLE manuscript_baseline;DROP TABLE approved_manifest_history;DROP TABLE approved_manifests;DROP TABLE user_locks;").unwrap();
}
#[cfg(test)]
fn drop_ai_schema_for_legacy_fixture(c: &Connection) {
    drop_finalization_schema_for_legacy_fixture(c);
    c.execute_batch("DROP TABLE history_entry_identities;DROP TABLE review_messages;DROP TABLE review_decisions;DROP TABLE review_comparisons;DROP TABLE review_reservations;DROP TABLE review_claims;DROP TABLE review_candidates;DROP TABLE review_tasks;DROP TABLE review_threads;").unwrap();
    c.execute_batch("DROP TABLE planning_visuals; DROP TABLE draft_generation_manifests; DROP TABLE outline_confirmations; DROP TABLE script_ai_tasks; DROP TABLE planning_preparations; DROP TABLE planning_node_identities; DROP TABLE planning_state; DROP TABLE planning_history_epoch; DROP TABLE ai_preparations; DROP TABLE ai_consumer_cleanup; DROP TABLE application_execution_bindings; DROP TABLE ai_events; DROP TABLE ai_artifacts; DROP TABLE ai_dispatches; DROP TABLE ai_attempts; DROP TABLE ai_runs; DROP TABLE ai_input_snapshots; DROP TABLE ai_execution_origin;").unwrap();
}

pub mod planning;

pub mod review;

mod backup;
pub mod exports;

struct WorkerGuard<'a>(&'a std::sync::atomic::AtomicUsize);
impl Drop for WorkerGuard<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
    }
}
impl SqliteProjectRepository {
    fn worker_guard(&self) -> WorkerGuard<'_> {
        self.workers
            .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        WorkerGuard(&self.workers)
    }
    pub fn is_quiescing(&self) -> bool {
        self.quiescing.load(std::sync::atomic::Ordering::Acquire)
    }
    pub fn resume(&self) {
        self.quiescing
            .store(false, std::sync::atomic::Ordering::Release);
    }
    pub fn quiesce(&self) -> Result<(), Error> {
        self.quiescing
            .store(true, std::sync::atomic::Ordering::Release);
        self.stop_source_watcher().map_err(|_| Error::Storage)?;
        scenesparrow_application::ai::AiExecutionPort::reconcile_execution(self)
            .map_err(|_| Error::Storage)?;
        self.reconcile_planning().map_err(|_| Error::Storage)?;
        self.reconcile_reviews().map_err(|_| Error::Storage)?;
        {
            let c = storage(self.connection.lock())?;
            storage(c.execute("UPDATE document_attempts SET status='interrupted',attempt=attempt+1,error='DOCUMENT_JOB_INTERRUPTED' WHERE status='running'",[]))?;
            storage(c.execute("UPDATE planning_visuals SET status='interrupted',error='DOCUMENT_JOB_INTERRUPTED' WHERE status='running'",[]))?;
        }
        let start = std::time::Instant::now();
        while self.workers.load(std::sync::atomic::Ordering::Acquire) > 0 {
            if start.elapsed() > Duration::from_secs(65) {
                return Err(Error::Storage);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        Ok(())
    }
}

mod storage;
mod worker_process;

pub mod open_source;
