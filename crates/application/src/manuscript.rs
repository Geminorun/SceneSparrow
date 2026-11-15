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
