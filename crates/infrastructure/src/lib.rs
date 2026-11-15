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
    connection: Mutex<Connection>,
    directory: std::path::PathBuf,
    policy: Arc<dyn scenesparrow_domain::manuscript::MutationPolicy>,
    // Holding the file lock prevents a second core from owning this project.
    _owner: File,
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
        if version > 2 {
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
        storage(std::fs::create_dir_all(directory.join("objects")))?;
        storage(std::fs::create_dir_all(directory.join("staging")))?;
        let repository = Self {
            connection: Mutex::new(connection),
            directory: directory.to_path_buf(),
            policy: Arc::new(scenesparrow_domain::manuscript::Unrestricted),
            _owner: owner,
        };
        repository.verify_manuscript()?;
        storage(
            storage(repository.connection.lock())?
                .execute("UPDATE edit_groups SET closed=1 WHERE closed=0", []),
        )?;
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

pub mod manuscript;
#[cfg(test)]
mod manuscript_tests;
