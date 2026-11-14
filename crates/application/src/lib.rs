use scenesparrow_domain::{Project, normalize_title};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Invalid project title")]
    InvalidTitle,
    #[error("Invalid request identifier")]
    InvalidRequest,
    #[error("The request conflicts with existing project state")]
    Conflict,
    #[error("Project storage is unavailable")]
    Storage,
}

pub trait ProjectRepository: Send + Sync {
    fn read(&self) -> Result<Option<Project>, Error>;
    fn create(&self, request_id: &str, title: &str) -> Result<Project, Error>;
}

pub struct ProjectService<R> {
    repository: R,
}

impl<R: ProjectRepository> ProjectService<R> {
    pub fn new(repository: R) -> Self {
        Self { repository }
    }

    pub fn read(&self) -> Result<Option<Project>, Error> {
        self.repository.read()
    }

    pub fn create(&self, request_id: &str, title: &str) -> Result<Project, Error> {
        if request_id.is_empty()
            || request_id.len() > 128
            || !request_id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-')
        {
            return Err(Error::InvalidRequest);
        }
        let title = normalize_title(title).map_err(|_| Error::InvalidTitle)?;
        self.repository.create(request_id, &title)
    }
}
