//! Internal application ports. No transport can manufacture a configuration guard.
use scenesparrow_domain::{ai::Result, contracts::*};

pub struct ConfigurationGuard {
    configuration: AiResolvedConfig,
}
impl ConfigurationGuard {
    /// Infrastructure calls this only while holding its application settings lock.
    pub fn locked(configuration: AiResolvedConfig) -> Self {
        Self { configuration }
    }
    pub fn configuration(&self) -> &AiResolvedConfig {
        &self.configuration
    }
}
/// A transaction participant stages only its own module records. No concrete SQL
/// handle crosses this boundary; implementations provide a module-specific context.
pub trait ProjectUnitOfWork {
    fn enqueue_in_unit_of_work(
        &mut self,
        guard: &ConfigurationGuard,
        start: &AiStart,
    ) -> Result<AiRun>;
    fn cancel_in_unit_of_work(&mut self, run_id: &str) -> Result<AiRun>;
    fn stage_consumer_record(
        &mut self,
        owner: &str,
        binding_id: &str,
        run_id: &str,
        payload: &str,
    ) -> Result<()>;
    fn fence_consumer(&mut self, owner: &str, binding_id: &str) -> Result<bool>;
}
pub trait ConsumerCoordinator: Send + Sync {
    fn name(&self) -> &str;
    fn terminal_failure(&self, uow: &mut dyn ProjectUnitOfWork, run: &AiRun) -> Result<()> {
        self.cancel(uow, run).map(|_| ())
    }
    fn cancel(&self, uow: &mut dyn ProjectUnitOfWork, run: &AiRun) -> Result<bool>;
}
pub trait AiSettingsPort: Send + Sync {
    fn read_settings(&self) -> Result<AiSettingsView>;
    fn update_settings(&self, update: &AiSettingsUpdate) -> Result<AiSettingsView>;
    fn resolve_configuration(
        &self,
        category: AiCategory,
        capability: AiCapability,
    ) -> Result<AiReadiness>;
    fn with_resolved_configuration(
        &self,
        fingerprint: &str,
        accept: &mut dyn FnMut(&ConfigurationGuard) -> Result<()>,
    ) -> Result<()>;
}
/// Leases deliberately implement neither Debug nor Serialize.
pub struct CredentialLease {
    secret: Option<String>,
}
impl CredentialLease {
    pub fn new(secret: Option<String>) -> Self {
        Self { secret }
    }
    pub fn expose(&self) -> Option<&str> {
        self.secret.as_deref()
    }
}
pub trait CredentialStore: Send + Sync {
    fn put_new_revision(&self, revision: &str, secret: &str) -> Result<()>;
    fn acquire_scoped_lease(&self, revision: &str) -> Result<CredentialLease>;
    fn delete(&self, revision: &str) -> Result<()>;
    fn present(&self, revision: &str) -> bool;
    fn persistent(&self) -> bool;
}
pub trait AiExecutionPort: Send + Sync {
    fn read_run(&self, run_id: &str) -> Result<AiRun>;
    fn read_result(&self, run_id: &str) -> Result<Option<Vec<u8>>>;
    fn observe_run(&self, run_id: &str, after: i64) -> Result<Vec<ProjectEvent>>;
    fn prepare_manual_retry(&self, old_run_id: &str, new_start: &AiStart) -> Result<()>;
    fn reconcile_execution(&self) -> Result<()>;
}
pub trait SourceDiscoveryPort: Send + Sync {
    fn search(&self, query: &str, limit: usize) -> Result<AiSearchResult>;
}
pub struct UnavailableSearch;
impl SourceDiscoveryPort for UnavailableSearch {
    fn search(&self, _: &str, _: usize) -> Result<AiSearchResult> {
        Ok(AiSearchResult {
            available: false,
            entries: vec![],
            reason: Some("CAPABILITY_UNAVAILABLE".into()),
        })
    }
}
