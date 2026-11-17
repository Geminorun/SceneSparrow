use super::*;
use atomic_write_file::AtomicWriteFile;
use scenesparrow_application::ai::{
    AiSettingsPort, ConfigurationGuard, CredentialLease, CredentialStore,
};
use std::{
    fs::File,
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
};

pub struct SettingsStore {
    directory: PathBuf,
    credentials: Arc<dyn CredentialStore>,
    pub session_id: String,
    #[cfg(test)]
    pub(super) fail_next_write: std::sync::atomic::AtomicBool,
}
pub fn app_data_directory() -> PathBuf {
    if let Some(path) = std::env::var_os("SCENESPARROW_APP_DATA_DIR") {
        return PathBuf::from(path);
    }
    #[cfg(target_os = "windows")]
    if let Some(path) = std::env::var_os("LOCALAPPDATA") {
        return PathBuf::from(path).join("SceneSparrow");
    }
    #[cfg(target_os = "macos")]
    if let Some(path) = std::env::var_os("HOME") {
        return PathBuf::from(path).join("Library/Application Support/SceneSparrow");
    }
    if let Some(path) = std::env::var_os("XDG_CONFIG_HOME") {
        return PathBuf::from(path).join("scenesparrow");
    }
    if let Some(path) = std::env::var_os("HOME") {
        return PathBuf::from(path).join(".config/scenesparrow");
    }
    PathBuf::from(".local/app-data")
}
impl SettingsStore {
    pub fn open(directory: &Path) -> Result<Self> {
        Self::with_credentials(
            directory,
            Arc::new(crate::credentials::PlatformCredentials::default()),
        )
    }
    pub fn with_credentials(
        directory: &Path,
        credentials: Arc<dyn CredentialStore>,
    ) -> Result<Self> {
        safe(std::fs::create_dir_all(directory))?;
        let store = Self {
            directory: directory.to_path_buf(),
            credentials,
            session_id: uuid::Uuid::new_v4().to_string(),
            #[cfg(test)]
            fail_next_write: std::sync::atomic::AtomicBool::new(false),
        };
        let _lock = store.lock()?;
        if !store.directory.join("ai-settings.json").exists() {
            store.write(&default_settings())?;
        }
        store.reconcile_credentials(&store.load()?)?;
        Ok(store)
    }
    fn lock(&self) -> Result<File> {
        let file = safe(
            File::options()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(self.directory.join("ai-settings.lock")),
        )?;
        safe(file.lock())?;
        Ok(file)
    }
    fn load(&self) -> Result<AiSettings> {
        let bytes = safe(std::fs::read(self.directory.join("ai-settings.json")))?;
        ensure(bytes.len() <= 4 * 1024 * 1024, "INVALID_SETTINGS")?;
        let s: AiSettings = safe(serde_json::from_slice(&bytes))?;
        validate_settings(&s)?;
        Ok(s)
    }
    fn write(&self, settings: &AiSettings) -> Result<()> {
        let bytes = safe(serde_json::to_vec(settings))?;
        ensure(bytes.len() <= 4 * 1024 * 1024, "INVALID_SETTINGS")?;
        let mut file = safe(AtomicWriteFile::open(
            self.directory.join("ai-settings.json"),
        ))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            safe(
                file.as_file()
                    .set_permissions(std::fs::Permissions::from_mode(0o600)),
            )?;
        }
        safe(file.write_all(&bytes))?;
        #[cfg(test)]
        if self
            .fail_next_write
            .swap(false, std::sync::atomic::Ordering::SeqCst)
        {
            return Err(AiError("STORAGE_UNAVAILABLE"));
        }
        safe(file.commit())
    }
    fn view(&self, settings: AiSettings) -> AiSettingsView {
        let present_credential_revisions = settings
            .providers
            .iter()
            .filter_map(|p| p.credential_revision.clone())
            .filter(|id| self.credentials.present(id))
            .collect();
        AiSettingsView {
            settings,
            credential_backend: if self.credentials.persistent() {
                AiSettingsViewCredentialBackend::Native
            } else {
                AiSettingsViewCredentialBackend::Sessiononly
            },
            present_credential_revisions,
            session_id: self.session_id.clone(),
        }
    }
    fn credential_inventory(&self) -> Result<Vec<String>> {
        let path = self.directory.join("owned-credential-revisions.json");
        if !path.exists() {
            return Ok(vec![]);
        }
        safe(serde_json::from_slice(&safe(std::fs::read(path))?))
    }
    fn write_inventory(&self, ids: &[String]) -> Result<()> {
        let mut file = safe(AtomicWriteFile::open(
            self.directory.join("owned-credential-revisions.json"),
        ))?;
        safe(file.write_all(&safe(serde_json::to_vec(ids))?))?;
        safe(file.commit())
    }
    fn reconcile_credentials(&self, settings: &AiSettings) -> Result<()> {
        let mut inventory = self.credential_inventory()?;
        inventory.retain(|id| {
            settings
                .providers
                .iter()
                .any(|p| p.credential_revision.as_ref() == Some(id))
                || self.credentials.delete(id).is_err()
        });
        self.write_inventory(&inventory)
    }
    pub fn update_credential(
        &self,
        expected: i64,
        profile_id: &str,
        secret: Option<&str>,
    ) -> Result<AiSettingsView> {
        let s = {
            let _lock = self.lock()?;
            let mut s = self.load()?;
            ensure(s.revision == expected, "SETTINGS_CONFLICT")?;
            let p = s
                .providers
                .iter_mut()
                .find(|p| p.id == profile_id)
                .ok_or(AiError("PROFILE_NOT_FOUND"))?;
            ensure(
                word(&p.auth_mode) == "bearer" || secret.is_none(),
                "INVALID_CREDENTIAL",
            )?;
            let new = secret.map(|_| uuid::Uuid::new_v4().to_string());
            if let (Some(id), Some(value)) = (&new, secret) {
                // A crash before settings reference publication leaves a discoverable
                // nonsecret inventory ID. Startup retries orphan cleanup by identity.
                let mut inventory = self.credential_inventory()?;
                inventory.push(id.clone());
                self.write_inventory(&inventory)?;
                if let Err(error) = self.credentials.put_new_revision(id, value) {
                    let _ = self.reconcile_credentials(&self.load()?);
                    return Err(error);
                }
            }
            p.credential_revision = new;
            p.revision += 1;
            s.revision += 1;
            let result = validate_settings(&s).and_then(|_| self.write(&s));
            if let Err(error) = result {
                let _ = self.reconcile_credentials(&self.load()?);
                return Err(error);
            }
            self.reconcile_credentials(&s)?;
            s
        };
        Ok(self.view(s))
    }
    pub fn lease(&self, config: &AiResolvedConfig) -> Result<CredentialLease> {
        if word(&config.provider.auth_mode) == "none" {
            return Ok(CredentialLease::new(None));
        }
        let _lock = self.lock()?;
        let s = self.load()?;
        let revision = config
            .provider
            .credential_revision
            .as_deref()
            .ok_or(AiError("CREDENTIAL_UNAVAILABLE"))?;
        ensure(
            s.providers.iter().any(|p| {
                p.id == config.provider.id && p.credential_revision.as_deref() == Some(revision)
            }),
            "CREDENTIAL_UNAVAILABLE",
        )?;
        self.credentials.acquire_scoped_lease(revision)
    }
    pub fn resolve_profile(&self, id: &str) -> Result<AiResolvedConfig> {
        let _lock = self.lock()?;
        let s = self.load()?;
        let provider = s
            .providers
            .iter()
            .find(|p| p.id == id)
            .cloned()
            .ok_or(AiError("PROFILE_NOT_FOUND"))?;
        // Discovery requires no binding/model. This placeholder never enters inference.
        let evidence = AiEvidence {
            state: AiEvidenceState::Unknown,
            source: AiEvidenceSource::Unknown,
            scope: "".into(),
            observed_at: None,
        };
        Ok(AiResolvedConfig {
            category: AiCategory::Text,
            capability: AiCapability::Textgenerate,
            provider,
            model: AiModel {
                default_parameters: None,
                provider_id: id.into(),
                id: "discovery-only".into(),
                label: "".into(),
                capabilities: AiCapabilities {
                    images: evidence.clone(),
                    streaming: evidence.clone(),
                    native_json: evidence,
                },
                context_tokens: None,
                output_tokens: None,
                token_field: AiModelTokenField::Maxtokens,
            },
            parameters: AiParameters {
                temperature_milli: None,
                max_output_tokens: 64,
                request_streaming: false,
                request_native_json: false,
            },
            policy: AiPolicy {
                overall_ms: 15000,
                ..s.policy
            },
            adapter_version: "openai-compatible/1".into(),
            fingerprint: "".into(),
            stream: false,
            native_json: false,
        })
    }
    pub fn resolve_test_configuration(&self, target: &AiTestTarget) -> Result<AiReadiness> {
        let _lock = self.lock()?;
        let mut s = self.load()?;
        ensure(
            !target.model_id.trim().is_empty()
                && target.model_id.len() <= 256
                && !target.model_id.chars().any(char::is_control),
            "INVALID_SETTINGS",
        )?;
        ensure(
            s.providers.iter().any(|p| p.id == target.provider_id),
            "PROFILE_NOT_FOUND",
        )?;
        let mut model = s
            .models
            .iter()
            .find(|m| m.provider_id == target.provider_id && m.id == target.model_id)
            .cloned()
            .unwrap_or_else(|| {
                let evidence = AiEvidence {
                    state: AiEvidenceState::Unknown,
                    source: AiEvidenceSource::Unknown,
                    scope: "".into(),
                    observed_at: None,
                };
                AiModel {
                    default_parameters: None,
                    provider_id: target.provider_id.clone(),
                    id: target.model_id.clone(),
                    label: target.model_id.clone(),
                    capabilities: AiCapabilities {
                        images: evidence.clone(),
                        streaming: evidence.clone(),
                        native_json: evidence,
                    },
                    context_tokens: None,
                    output_tokens: None,
                    token_field: AiModelTokenField::Maxtokens,
                }
            });
        model.token_field = safe(serde_json::from_value(safe(serde_json::to_value(
            &target.token_field,
        ))?))?;
        let max_output_tokens = model.output_tokens.unwrap_or(64).min(64);
        s.models
            .retain(|m| !(m.id == target.model_id && m.provider_id == target.provider_id));
        s.models.push(model);
        s.bindings = vec![AiBinding {
            category: AiCategory::Text,
            provider_id: target.provider_id.clone(),
            model_id: target.model_id.clone(),
            parameters: AiParameters {
                temperature_milli: None,
                max_output_tokens,
                request_streaming: false,
                request_native_json: false,
            },
            revision: 1,
        }];
        s.policy = AiPolicy {
            overall_ms: 30000,
            idle_ms: 30000,
            max_output_bytes: 65536,
        };
        let configuration = Self::resolved(&s, AiCategory::Text, AiCapability::Textgenerate)?;
        ensure(
            word(&configuration.provider.auth_mode) == "none"
                || configuration
                    .provider
                    .credential_revision
                    .as_ref()
                    .is_some_and(|id| self.credentials.present(id)),
            "CREDENTIAL_UNAVAILABLE",
        )?;
        Ok(AiReadiness { configuration })
    }
    fn resolved(
        s: &AiSettings,
        category: AiCategory,
        capability: AiCapability,
    ) -> Result<AiResolvedConfig> {
        ensure(
            category == AiCategory::Text && capability == AiCapability::Textgenerate,
            "CAPABILITY_UNSUPPORTED",
        )?;
        let b = s
            .bindings
            .iter()
            .find(|b| b.category == category)
            .ok_or(AiError("CONFIGURATION_UNAVAILABLE"))?;
        let p = s
            .providers
            .iter()
            .find(|p| p.id == b.provider_id)
            .ok_or(AiError("CONFIGURATION_UNAVAILABLE"))?;
        let m = s
            .models
            .iter()
            .find(|m| m.id == b.model_id && m.provider_id == b.provider_id)
            .ok_or(AiError("CONFIGURATION_UNAVAILABLE"))?;
        ensure(
            word(&p.auth_mode) == "none" || p.credential_revision.is_some(),
            "CREDENTIAL_UNAVAILABLE",
        )?;
        let stream =
            b.parameters.request_streaming && word(&m.capabilities.streaming.state) == "supported";
        let native_json = b.parameters.request_native_json
            && word(&m.capabilities.native_json.state) == "supported";
        // Display names and unrelated global settings do not invalidate a prepared start.
        let tuple = serde_json::json!({"category": category,"capability":capability,"providerId":p.id,"adapter":p.adapter,"root":p.base_url,"auth":p.auth_mode,"credential":p.credential_revision,"modelId":m.id,"capabilities":m.capabilities,"context":m.context_tokens,"output":m.output_tokens,"tokenField":m.token_field,"parameters":b.parameters,"policy":s.policy,"adapterVersion":"openai-compatible/1"});
        Ok(AiResolvedConfig {
            category,
            capability,
            provider: p.clone(),
            model: m.clone(),
            parameters: b.parameters.clone(),
            policy: s.policy.clone(),
            adapter_version: "openai-compatible/1".into(),
            fingerprint: hash(&safe(serde_json::to_vec(&tuple))?),
            stream,
            native_json,
        })
    }
}
impl AiSettingsPort for SettingsStore {
    fn read_settings(&self) -> Result<AiSettingsView> {
        let _lock = self.lock()?;
        Ok(self.view(self.load()?))
    }
    fn update_settings(&self, update: &AiSettingsUpdate) -> Result<AiSettingsView> {
        let result = {
            let _lock = self.lock()?;
            let old = self.load()?;
            ensure(
                old.revision == update.expected_revision,
                "SETTINGS_CONFLICT",
            )?;
            let mut s = update.settings.clone();
            s.schema_version = 1;
            s.revision = old
                .revision
                .checked_add(1)
                .ok_or(AiError("SETTINGS_CONFLICT"))?;
            s.retired_profile_ids = old.retired_profile_ids.clone();
            for p in &old.providers {
                if !s.providers.iter().any(|n| n.id == p.id) {
                    s.retired_profile_ids.push(p.id.clone());
                }
            }
            for p in &mut s.providers {
                let previous = old.providers.iter().find(|o| o.id == p.id);
                ensure(
                    p.credential_revision == previous.and_then(|p| p.credential_revision.clone()),
                    "INVALID_CREDENTIAL",
                )?;
                if word(&p.auth_mode) == "none" {
                    p.credential_revision = None;
                }
                p.revision =
                    previous.map_or(1, |o| if o == p { o.revision } else { o.revision + 1 });
            }
            s.models
                .retain(|m| s.providers.iter().any(|p| p.id == m.provider_id));
            s.bindings
                .retain(|b| s.providers.iter().any(|p| p.id == b.provider_id));
            for b in &mut s.bindings {
                b.revision = old
                    .bindings
                    .iter()
                    .find(|o| o.category == b.category)
                    .map_or(1, |o| if o == b { o.revision } else { o.revision + 1 });
            }
            validate_settings(&s)?;
            self.write(&s)?;
            let retired: Vec<String> = old
                .providers
                .iter()
                .filter_map(|p| p.credential_revision.clone())
                .filter(|id| {
                    !s.providers
                        .iter()
                        .any(|p| p.credential_revision.as_ref() == Some(id))
                })
                .collect();
            (s, retired)
        };
        {
            let _lock = self.lock()?;
            self.reconcile_credentials(&self.load()?)?;
        }
        let _ = result.1;
        Ok(self.view(result.0))
    }
    fn resolve_configuration(
        &self,
        category: AiCategory,
        capability: AiCapability,
    ) -> Result<AiReadiness> {
        let _lock = self.lock()?;
        let configuration = Self::resolved(&self.load()?, category, capability)?;
        ensure(
            word(&configuration.provider.auth_mode) == "none"
                || configuration
                    .provider
                    .credential_revision
                    .as_ref()
                    .is_some_and(|id| self.credentials.present(id)),
            "CREDENTIAL_UNAVAILABLE",
        )?;
        Ok(AiReadiness { configuration })
    }
    fn with_resolved_configuration(
        &self,
        fingerprint: &str,
        accept: &mut dyn FnMut(&ConfigurationGuard) -> Result<()>,
    ) -> Result<()> {
        let _lock = self.lock()?;
        let config = Self::resolved(&self.load()?, AiCategory::Text, AiCapability::Textgenerate)?;
        ensure(config.fingerprint == fingerprint, "CONFIGURATION_STALE")?;
        ensure(
            word(&config.provider.auth_mode) == "none"
                || config
                    .provider
                    .credential_revision
                    .as_ref()
                    .is_some_and(|id| self.credentials.present(id)),
            "CREDENTIAL_UNAVAILABLE",
        )?;
        accept(&ConfigurationGuard::locked(config))
    }
}
