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
    business_read_count: std::sync::atomic::AtomicUsize,
    #[cfg(test)]
    fail_export_directory_sync: std::sync::atomic::AtomicBool,
    connection: Mutex<Connection>,
    quiescing: std::sync::atomic::AtomicBool,
    workers: std::sync::atomic::AtomicUsize,
    directory: std::path::PathBuf,
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
        storage(std::fs::create_dir_all(directory))?;
        let owner = storage(
            File::options()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(directory.join(".core.lock")),
        )?;
        let owner = ProjectOwner::acquire(owner)?;
        let mut connection = storage(Connection::open(directory.join("project.sqlite")))?;
        storage(connection.busy_timeout(Duration::from_secs(3)))?;
        let version: i64 =
            storage(connection.pragma_query_value(None, "user_version", |row| row.get(0)))?;
        if version > 9 {
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
        storage(std::fs::create_dir_all(directory.join("exports")))?;
        storage(std::fs::create_dir_all(directory.join("objects")))?;
        storage(std::fs::create_dir_all(directory.join("staging")))?;
        let repository = Self {
            #[cfg(test)]
            business_read_count: std::sync::atomic::AtomicUsize::new(0),
            #[cfg(test)]
            fail_export_directory_sync: std::sync::atomic::AtomicBool::new(false),
            connection: Mutex::new(connection),
            quiescing: std::sync::atomic::AtomicBool::new(false),
            workers: std::sync::atomic::AtomicUsize::new(0),
            directory: directory.to_path_buf(),
            policy: Arc::new(scenesparrow_domain::manuscript::Unrestricted),
            ai_consumers: Mutex::new(std::collections::BTreeMap::new()),
            _owner: Some(owner),
        };
        if version < 5 {
            repository
                .initialize_ai_origin()
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
        let project = Project {
            id: uuid::Uuid::new_v4().to_string(),
            title: title.to_owned(),
            working_revision: 0,
            approved_baseline: None,
        };
        storage(transaction.execute(
            "INSERT INTO project (singleton, id, title, request_id, working_revision, approved_baseline) VALUES (1, ?1, ?2, ?3, 0, NULL)",
            params![project.id, project.title, request_id],
        ))?;
        manuscript::initialize(&transaction)?;
        storage(transaction.commit())?;
        Ok(project)
    }
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
fn drop_finalization_schema_for_legacy_fixture(c: &Connection) {
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

mod operation;
