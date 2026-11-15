use scenesparrow_domain::{contracts::*, manuscript::ManuscriptError};

pub trait ManuscriptRepository: Send + Sync {
    fn read_history(&self) -> Result<HistoryState, ManuscriptError>;
    fn read_manuscript(&self) -> Result<ManuscriptState, ManuscriptError>;
    fn execute_manuscript(
        &self,
        command: &ManuscriptCommand,
    ) -> Result<CommandReceipt, ManuscriptError>;
    fn command_receipt(&self, request_id: &str) -> Result<CommandReceipt, ManuscriptError>;
}

/// Named source/document operations; no renderer paths or generic object access.
pub trait DocumentRepository: Send + Sync {
    fn read_sources(&self, after: Option<&str>) -> Result<SourcePage, ManuscriptError>;
    fn begin_intake(&self, id: &str, name: &str, mime: &str) -> Result<(), ManuscriptError>;
    fn append_intake(&self, id: &str, bytes: &[u8]) -> Result<(), ManuscriptError>;
    fn complete_intake(&self, id: &str) -> Result<Intake, ManuscriptError>;
    fn read_intake(&self, id: &str) -> Result<Intake, ManuscriptError>;
    fn cancel_intake(&self, id: &str) -> Result<(), ManuscriptError>;
    fn document_action(&self, action: &DocumentAction) -> Result<DocumentJob, ManuscriptError>;
    fn document_job(&self, id: &str) -> Result<DocumentJob, ManuscriptError>;
    fn extraction_page(&self, id: &str, offset: usize) -> Result<ExtractionPage, ManuscriptError>;
    fn events(&self, after: i64) -> Result<EventPage, ManuscriptError>;
}
