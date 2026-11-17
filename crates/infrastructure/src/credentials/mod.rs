//! Native backends are source-integrated; target-host validation is tracked separately.
use scenesparrow_application::ai::{CredentialLease, CredentialStore};
use scenesparrow_domain::ai::{AiError, Result, ensure};
use std::{path::Path, sync::Arc};
pub mod encrypted;

/// Explicit configuration keeps tests and embedders independent of process-global environment.
pub fn for_application(
    directory: &Path,
    master_key_file: Option<&Path>,
) -> Result<Arc<dyn CredentialStore>> {
    if let Some(key) = master_key_file {
        return Ok(Arc::new(encrypted::EncryptedCredentials::open(
            directory, key,
        )?));
    }
    ensure(
        !encrypted::has_vault_data(directory)?,
        "CREDENTIAL_UNAVAILABLE",
    )?;
    Ok(Arc::new(PlatformCredentials::default()))
}
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
use std::{collections::BTreeMap, sync::Mutex};

#[derive(Default)]
pub struct PlatformCredentials {
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    entries: Mutex<BTreeMap<String, String>>,
}
impl CredentialStore for PlatformCredentials {
    fn put_new_revision(&self, revision: &str, secret: &str) -> Result<()> {
        ensure(
            !secret.is_empty() && secret.len() <= 8192 && !secret.chars().any(char::is_control),
            "INVALID_CREDENTIAL",
        )?;
        let id = revision.to_owned();
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        keyring::Entry::new("scenesparrow.ai", &id)
            .and_then(|e| e.set_password(secret))
            .map_err(|_| AiError("CREDENTIAL_UNAVAILABLE"))?;
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        self.entries
            .lock()
            .map_err(|_| AiError("CREDENTIAL_UNAVAILABLE"))?
            .insert(id.clone(), secret.to_owned());
        Ok(())
    }
    fn acquire_scoped_lease(&self, revision: &str) -> Result<CredentialLease> {
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        let secret = keyring::Entry::new("scenesparrow.ai", revision)
            .and_then(|e| e.get_password())
            .map_err(|_| AiError("CREDENTIAL_UNAVAILABLE"))?;
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        let secret = self
            .entries
            .lock()
            .map_err(|_| AiError("CREDENTIAL_UNAVAILABLE"))?
            .get(revision)
            .cloned()
            .ok_or(AiError("CREDENTIAL_UNAVAILABLE"))?;
        Ok(CredentialLease::new(Some(secret)))
    }
    fn delete(&self, revision: &str) -> Result<()> {
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        match keyring::Entry::new("scenesparrow.ai", revision).and_then(|e| e.delete_credential()) {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(_) => return Err(AiError("CREDENTIAL_UNAVAILABLE")),
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        self.entries
            .lock()
            .map_err(|_| AiError("CREDENTIAL_UNAVAILABLE"))?
            .remove(revision);
        Ok(())
    }
    fn present(&self, revision: &str) -> bool {
        self.acquire_scoped_lease(revision).is_ok()
    }
    fn persistent(&self) -> bool {
        cfg!(any(target_os = "windows", target_os = "macos"))
    }
}
