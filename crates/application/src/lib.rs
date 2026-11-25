use scenesparrow_domain::{Project, normalize_title};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Invalid project title")]
    InvalidTitle,
    #[error("Invalid request identifier")]
    InvalidRequest,
    #[error("The request conflicts with existing project state")]
    Conflict,
    #[error("Project is closing")]
    Closing,
    #[error("Unsupported project schema")]
    SchemaUnsupported,
    #[error("Project storage is unavailable")]
    Storage,
}

pub trait ProjectRepository: Send + Sync {
    fn read(&self) -> Result<Option<Project>, Error>;
    fn create(&self, request_id: &str, title: &str) -> Result<Project, Error>;
    fn ensure(&self, request_id: &str, title: &str) -> Result<Project, Error>;
    fn rename(
        &self,
        request_id: &str,
        project_id: &str,
        previous_title: &str,
        title: &str,
    ) -> Result<Project, Error>;
}

pub struct ProjectService<R> {
    repository: R,
}

impl<R: ProjectRepository> ProjectService<R> {
    pub fn new(repository: R) -> Self {
        Self { repository }
    }

    pub fn repository(&self) -> &R {
        &self.repository
    }

    pub fn read(&self) -> Result<Option<Project>, Error> {
        self.repository.read()
    }

    pub fn create(&self, request_id: &str, title: &str) -> Result<Project, Error> {
        validate_request_id(request_id)?;
        let title = normalize_title(title).map_err(|_| Error::InvalidTitle)?;
        self.repository.create(request_id, &title)
    }
    pub fn ensure(&self, request_id: &str, title: &str) -> Result<Project, Error> {
        validate_request_id(request_id)?;
        let title = normalize_title(title).map_err(|_| Error::InvalidTitle)?;
        self.repository.ensure(request_id, &title)
    }

    pub fn rename(
        &self,
        request_id: &str,
        project_id: &str,
        previous_title: &str,
        title: &str,
    ) -> Result<Project, Error> {
        validate_request_id(request_id)?;
        if !scenesparrow_domain::manuscript::uuid4(project_id) {
            return Err(Error::InvalidRequest);
        }
        // Match the exact persisted title; normalizing a stale comparison can hide a conflict.
        if normalize_title(previous_title).map_err(|_| Error::InvalidTitle)? != previous_title {
            return Err(Error::InvalidRequest);
        }
        let title = normalize_title(title).map_err(|_| Error::InvalidTitle)?;
        self.repository
            .rename(request_id, project_id, previous_title, &title)
    }
}

fn validate_request_id(request_id: &str) -> Result<(), Error> {
    if request_id.is_empty()
        || request_id.len() > 128
        || !request_id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
    {
        return Err(Error::InvalidRequest);
    }
    Ok(())
}

pub mod manuscript;

pub mod ai;

pub mod planning;

pub mod review;

pub mod markdown_writing;

pub mod external_agent;
