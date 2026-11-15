use std::{
    fs::File,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

use rusqlite::{Connection, OptionalExtension, params};
use scenesparrow_application::{Error, ProjectRepository};
use scenesparrow_domain::Project;

pub struct SqliteProjectRepository {
    #[cfg(test)]
    business_read_count: std::sync::atomic::AtomicUsize,
    connection: Mutex<Connection>,
    directory: std::path::PathBuf,
    policy: Arc<dyn scenesparrow_domain::manuscript::MutationPolicy>,
    // Holding the file lock prevents a second core from owning this project.
    _owner: File,
    ai_consumers: Mutex<
        std::collections::BTreeMap<
            String,
            Arc<dyn scenesparrow_application::ai::ConsumerCoordinator>,
        >,
    >,
}

fn storage<T>(result: Result<T, impl std::fmt::Debug>) -> Result<T, Error> {
    result.map_err(|_| Error::Storage)
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
        storage(std::fs::create_dir_all(directory))?;
        let owner = storage(
            File::options()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(directory.join(".core.lock")),
        )?;
        storage(owner.try_lock())?;
        let mut connection = storage(Connection::open(directory.join("project.sqlite")))?;
        storage(connection.busy_timeout(Duration::from_secs(3)))?;
        let version: i64 =
            storage(connection.pragma_query_value(None, "user_version", |row| row.get(0)))?;
        if version > 6 {
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
            // Backup API pins committed WAL pages. Preserve object bytes alongside the
            // database so future GC cannot invalidate a pre-migration restore point.
            let backup_directory =
                directory.join(format!("pre-migration-003-{}", uuid::Uuid::new_v4()));
            storage(std::fs::create_dir(&backup_directory))?;
            let mut backup = storage(Connection::open(backup_directory.join("project.sqlite")))?;
            storage(rusqlite::backup::Backup::new(&connection, &mut backup))?
                .run_to_completion(32, Duration::from_millis(10), None)
                .map_err(|_| Error::Storage)?;
            let objects = backup_directory.join("objects");
            storage(std::fs::create_dir(&objects))?;
            if directory.join("objects").exists() {
                for entry in storage(std::fs::read_dir(directory.join("objects")))? {
                    let entry = storage(entry)?;
                    if storage(entry.file_type())?.is_file() {
                        let destination = objects.join(entry.file_name());
                        storage(std::fs::copy(entry.path(), &destination))?;
                        if storage(std::fs::read(entry.path()))?
                            != storage(std::fs::read(&destination))?
                        {
                            return Err(Error::Storage);
                        }
                        // Windows FlushFileBuffers requires a writable file handle.
                        storage(
                            File::options()
                                .read(true)
                                .write(true)
                                .open(destination)
                                .and_then(|file| file.sync_all()),
                        )?;
                    }
                }
            }
            storage(
                File::options()
                    .read(true)
                    .write(true)
                    .open(backup_directory.join("project.sqlite"))
                    .and_then(|file| file.sync_all()),
            )?;
            #[cfg(unix)]
            {
                storage(File::open(&objects).and_then(|file| file.sync_all()))?;
                storage(File::open(&backup_directory).and_then(|file| file.sync_all()))?;
                storage(File::open(directory).and_then(|file| file.sync_all()))?;
            }
            let transaction = storage(connection.transaction())?;
            storage(transaction.execute_batch(include_str!("../migrations/003_history.sql")))?;
            storage(transaction.commit())?;
        }
        if version < 4 {
            let backup_directory =
                directory.join(format!("pre-migration-004-{}", uuid::Uuid::new_v4()));
            storage(std::fs::create_dir(&backup_directory))?;
            let mut backup = storage(Connection::open(backup_directory.join("project.sqlite")))?;
            storage(rusqlite::backup::Backup::new(&connection, &mut backup))?
                .run_to_completion(32, Duration::from_millis(10), None)
                .map_err(|_| Error::Storage)?;
            let objects = backup_directory.join("objects");
            storage(std::fs::create_dir(&objects))?;
            if directory.join("objects").exists() {
                for entry in storage(std::fs::read_dir(directory.join("objects")))? {
                    let entry = storage(entry)?;
                    if storage(entry.file_type())?.is_file() {
                        let destination = objects.join(entry.file_name());
                        storage(std::fs::copy(entry.path(), &destination))?;
                        if storage(std::fs::read(entry.path()))?
                            != storage(std::fs::read(&destination))?
                        {
                            return Err(Error::Storage);
                        }
                        storage(
                            File::options()
                                .read(true)
                                .write(true)
                                .open(destination)
                                .and_then(|f| f.sync_all()),
                        )?;
                    }
                }
            }
            storage(
                File::options()
                    .read(true)
                    .write(true)
                    .open(backup_directory.join("project.sqlite"))
                    .and_then(|f| f.sync_all()),
            )?;
            #[cfg(unix)]
            {
                storage(File::open(&objects).and_then(|f| f.sync_all()))?;
                storage(File::open(&backup_directory).and_then(|f| f.sync_all()))?;
                storage(File::open(directory).and_then(|f| f.sync_all()))?;
            }
            let transaction = storage(connection.transaction())?;
            storage(
                transaction.execute_batch(include_str!("../migrations/004_sources_import.sql")),
            )?;
            storage(transaction.commit())?;
        }
        if version < 5 {
            let backup_directory =
                directory.join(format!("pre-migration-005-{}", uuid::Uuid::new_v4()));
            storage(std::fs::create_dir(&backup_directory))?;
            let mut backup = storage(Connection::open(backup_directory.join("project.sqlite")))?;
            storage(rusqlite::backup::Backup::new(&connection, &mut backup))?
                .run_to_completion(32, Duration::from_millis(10), None)
                .map_err(|_| Error::Storage)?;
            let objects = backup_directory.join("objects");
            storage(std::fs::create_dir(&objects))?;
            if directory.join("objects").exists() {
                for entry in storage(std::fs::read_dir(directory.join("objects")))? {
                    let entry = storage(entry)?;
                    if storage(entry.file_type())?.is_file() {
                        let target = objects.join(entry.file_name());
                        storage(std::fs::copy(entry.path(), &target))?;
                        if storage(std::fs::read(entry.path()))? != storage(std::fs::read(&target))?
                        {
                            return Err(Error::Storage);
                        }
                        storage(
                            File::options()
                                .read(true)
                                .write(true)
                                .open(target)
                                .and_then(|f| f.sync_all()),
                        )?;
                    }
                }
            }
            storage(
                File::options()
                    .read(true)
                    .write(true)
                    .open(backup_directory.join("project.sqlite"))
                    .and_then(|f| f.sync_all()),
            )?;
            #[cfg(unix)]
            {
                storage(File::open(&objects).and_then(|f| f.sync_all()))?;
                storage(File::open(&backup_directory).and_then(|f| f.sync_all()))?;
                storage(File::open(directory).and_then(|f| f.sync_all()))?;
            }
            let tx = storage(connection.transaction())?;
            storage(tx.execute_batch(include_str!("../migrations/005_shared_ai.sql")))?;
            storage(tx.execute(
                "INSERT INTO ai_execution_origin VALUES(1,?1,0)",
                [uuid::Uuid::new_v4().to_string()],
            ))?;
            storage(tx.commit())?;
        }
        if version < 6 {
            let backup_directory =
                directory.join(format!("pre-migration-006-{}", uuid::Uuid::new_v4()));
            storage(std::fs::create_dir(&backup_directory))?;
            let mut backup = storage(Connection::open(backup_directory.join("project.sqlite")))?;
            storage(rusqlite::backup::Backup::new(&connection, &mut backup))?
                .run_to_completion(32, Duration::from_millis(10), None)
                .map_err(|_| Error::Storage)?;
            let objects = backup_directory.join("objects");
            storage(std::fs::create_dir(&objects))?;
            if directory.join("objects").exists() {
                for entry in storage(std::fs::read_dir(directory.join("objects")))? {
                    let entry = storage(entry)?;
                    if storage(entry.file_type())?.is_file() {
                        let target = objects.join(entry.file_name());
                        storage(std::fs::copy(entry.path(), &target))?;
                        if storage(std::fs::read(entry.path()))? != storage(std::fs::read(&target))?
                        {
                            return Err(Error::Storage);
                        }
                        storage(
                            File::options()
                                .read(true)
                                .write(true)
                                .open(target)
                                .and_then(|f| f.sync_all()),
                        )?;
                    }
                }
            }
            storage(
                File::options()
                    .read(true)
                    .write(true)
                    .open(backup_directory.join("project.sqlite"))
                    .and_then(|f| f.sync_all()),
            )?;
            #[cfg(unix)]
            {
                storage(File::open(&objects).and_then(|f| f.sync_all()))?;
                storage(File::open(&backup_directory).and_then(|f| f.sync_all()))?;
                storage(File::open(directory).and_then(|f| f.sync_all()))?;
            }
            let tx = storage(connection.transaction())?;
            storage(tx.execute_batch(include_str!("../migrations/006_planning.sql")))?;
            storage(tx.commit())?;
        }
        storage(std::fs::create_dir_all(directory.join("objects")))?;
        storage(std::fs::create_dir_all(directory.join("staging")))?;
        let repository = Self {
            #[cfg(test)]
            business_read_count: std::sync::atomic::AtomicUsize::new(0),
            connection: Mutex::new(connection),
            directory: directory.to_path_buf(),
            policy: Arc::new(scenesparrow_domain::manuscript::Unrestricted),
            _owner: owner,
            ai_consumers: Mutex::new(std::collections::BTreeMap::new()),
        };
        if version < 5 {
            repository
                .initialize_ai_origin()
                .map_err(|_| Error::Storage)?;
        }
        scenesparrow_application::ai::AiExecutionPort::reconcile_execution(&repository)
            .map_err(|_| Error::Storage)?;
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
}

mod history;
pub mod manuscript;
#[cfg(test)]
mod manuscript_tests;

mod documents;

pub mod ai;
pub mod credentials;

#[cfg(test)]
fn drop_ai_schema_for_legacy_fixture(c: &Connection) {
    c.execute_batch("DROP TABLE planning_visuals; DROP TABLE draft_generation_manifests; DROP TABLE outline_confirmations; DROP TABLE script_ai_tasks; DROP TABLE planning_preparations; DROP TABLE planning_node_identities; DROP TABLE planning_state; DROP TABLE planning_history_epoch; DROP TABLE ai_preparations; DROP TABLE ai_consumer_cleanup; DROP TABLE application_execution_bindings; DROP TABLE ai_events; DROP TABLE ai_artifacts; DROP TABLE ai_dispatches; DROP TABLE ai_attempts; DROP TABLE ai_runs; DROP TABLE ai_input_snapshots; DROP TABLE ai_execution_origin;").unwrap();
}

pub mod planning;
