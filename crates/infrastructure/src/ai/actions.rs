//! Application-session actions have their own exactly-once receipt, outside projects.
use super::*;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, OnceLock},
};
use worker::{WorkerOperation, run_worker};

type TextReceipt = (String, Option<Result<String>>);
pub struct TextAction<'a> {
    pub action_id: &'a str,
    pub session_id: &'a str,
    pub fingerprint: &'a str,
    pub context: &'a str,
    pub input: &'a AiInput,
}
type TestCell = Arc<OnceLock<Result<AiTestReceipt>>>;
#[derive(Default)]
pub struct SettingsActions {
    tests: Mutex<BTreeMap<String, (String, TestCell)>>,
    inference_slot: Mutex<()>,
    texts: Mutex<BTreeMap<String, TextReceipt>>,
}
fn input() -> AiInput {
    AiInput {
        protocol_version: 1,
        messages: vec![AiMessage {
            role: AiMessageRole::User,
            content: vec![AiPart::Text {
                text: "Reply with OK.".into(),
            }],
        }],
        input_artifacts: vec![],
        output_spec: AiOutputSpec {
            mime: AiOutputSpecMime::Textplain,
            schema_id: "settings-test/1".into(),
            schema_version: 1,
            schema_artifact_id: None,
            max_bytes: 65536,
        },
        image_decision: AiInputImageDecision::None,
    }
}
fn action_run(
    config: AiResolvedConfig,
    action: &str,
    input: &AiInput,
) -> Result<(AiRun, Vec<u8>, String)> {
    let bytes = safe(serde_json::to_vec(input))?;
    let fence = uuid::Uuid::new_v4().to_string();
    Ok((
        AiRun {
            usage: None,
            run_id: action.into(),
            request_id: action.into(),
            input_hash: hash(&bytes),
            configuration: config,
            status: AiRunStatus::Running,
            attempt: 1,
            error: None,
            result: None,
            retry_of_run_id: None,
            consumer: "settings".into(),
            binding_id: action.into(),
        },
        bytes,
        fence,
    ))
}
impl SettingsActions {
    /// Reserve in this process before dispatch. Live duplicates fail; completed duplicates reuse the receipt.
    pub fn text(
        &self,
        settings: &settings::SettingsStore,
        action: TextAction<'_>,
    ) -> Result<String> {
        use scenesparrow_application::ai::AiSettingsPort;
        let TextAction {
            action_id,
            session_id,
            fingerprint,
            context,
            input,
        } = action;
        ensure(valid_id(action_id), "INVALID_REQUEST")?;
        ensure(session_id == settings.session_id, "ACTION_SESSION_ENDED")?;
        ensure(input.output_spec.max_bytes <= 262144, "INPUT_TOO_LARGE")?;
        let digest = hash(&safe(serde_json::to_vec(&(fingerprint, context, input)))?);
        {
            let mut texts = safe(self.texts.lock())?;
            if let Some((previous, result)) = texts.get(action_id) {
                ensure(previous == &digest, "REQUEST_ID_REUSED")?;
                return result.clone().unwrap_or(Err(AiError("ACTION_IN_PROGRESS")));
            }
            // Keep compact identities for this service session; never evict an identity into redispatch.
            ensure(texts.len() < 16384, "ACTION_SESSION_FULL")?;
            if texts
                .values()
                .filter(|(_, result)| matches!(result, Some(Ok(_))))
                .count()
                >= 32
                && let Some((_, result)) = texts
                    .values_mut()
                    .find(|(_, result)| matches!(result, Some(Ok(_))))
            {
                *result = Some(Err(AiError("ACTION_RESULT_EXPIRED")));
            }
            texts.insert(action_id.into(), (digest, None));
        }
        let outcome = (|| {
            let _slot = self
                .inference_slot
                .try_lock()
                .map_err(|_| AiError("QUEUE_FULL"))?;
            let mut frozen = None;
            settings.with_resolved_configuration(fingerprint, &mut |guard| {
                frozen = Some(guard.configuration().clone());
                Ok(())
            })?;
            let config = frozen.ok_or(AiError("CONFIGURATION_UNAVAILABLE"))?;
            validate_input(input, &config)?;
            let lease = settings.lease(&config)?;
            let (run, bytes, fence) = action_run(config, action_id, input)?;
            let (_, output) = run_worker(
                &run,
                &fence,
                lease,
                &bytes,
                &BTreeMap::new(),
                WorkerOperation::Generate,
                &mut || Ok(()),
                &mut || false,
            )?;
            ensure(
                output.len() <= input.output_spec.max_bytes as usize,
                "OUTPUT_TOO_LARGE",
            )?;
            String::from_utf8(output).map_err(|_| AiError("OUTPUT_INVALID"))
        })();
        if let Some((_, result)) = safe(self.texts.lock())?.get_mut(action_id) {
            *result = Some(outcome.clone());
        }
        outcome
    }
    pub fn discover(
        &self,
        settings: &settings::SettingsStore,
        provider_id: &str,
    ) -> Result<AiDiscovery> {
        let config = settings.resolve_profile(provider_id)?;
        let lease = settings.lease(&config)?;
        let action = uuid::Uuid::new_v4().to_string();
        let input = input();
        let (run, bytes, fence) = action_run(config, &action, &input)?;
        let (_, output) = run_worker(
            &run,
            &fence,
            lease,
            &bytes,
            &BTreeMap::new(),
            WorkerOperation::Discover,
            &mut || Ok(()),
            &mut || false,
        )?;
        safe(serde_json::from_slice(&output))
    }
    pub fn test(
        &self,
        settings: &settings::SettingsStore,
        action: &AiTestAction,
    ) -> Result<AiTestReceipt> {
        ensure(valid_id(&action.action_id), "INVALID_REQUEST")?;
        ensure(
            action.session_id == settings.session_id,
            "TEST_STATUS_UNKNOWN",
        )?;
        let digest = hash(&safe(serde_json::to_vec(action))?);
        let cell = {
            let mut tests = safe(self.tests.lock())?;
            if let Some((previous, cell)) = tests.get(&action.action_id) {
                ensure(previous == &digest, "REQUEST_ID_REUSED")?;
                cell.clone()
            } else {
                ensure(tests.len() < 1024, "QUEUE_FULL")?;
                let cell = Arc::new(OnceLock::new());
                tests.insert(action.action_id.clone(), (digest, cell.clone()));
                cell
            }
        };
        cell.get_or_init(|| {
            let mut tested_root = None;
            let result: Result<()> = (|| {
                let _slot = self
                    .inference_slot
                    .try_lock()
                    .map_err(|_| AiError("QUEUE_FULL"))?;
                let config = settings
                    .resolve_test_configuration(&action.target)?
                    .configuration;
                ensure(
                    config.fingerprint == action.fingerprint,
                    "CONFIGURATION_STALE",
                )?;
                tested_root = Some(config.provider.base_url.clone());
                let lease = settings.lease(&config)?;
                let input = input();
                let (run, bytes, fence) = action_run(config, &action.action_id, &input)?;
                run_worker(
                    &run,
                    &fence,
                    lease,
                    &bytes,
                    &BTreeMap::new(),
                    WorkerOperation::Generate,
                    &mut || Ok(()),
                    &mut || false,
                )?;
                Ok(())
            })();
            let error = result.err();
            Ok(AiTestReceipt {
                target: action.target.clone(),
                provider_root: tested_root,
                action_id: action.action_id.clone(),
                fingerprint: action.fingerprint.clone(),
                status: if error.is_none() {
                    AiTestReceiptStatus::Succeeded
                } else {
                    AiTestReceiptStatus::Failed
                },
                error: error.map(|e| e.0.into()),
                observed_at: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis()
                    .to_string(),
                scope: AiTestReceiptScope::Textonly,
            })
        })
        .clone()
    }
}

#[cfg(test)]
mod text_tests {
    use super::*;

    #[test]
    fn compact_receipts_outlive_evicted_text_and_never_become_another_dispatch() {
        let directory = tempfile::tempdir().unwrap();
        let settings = settings::SettingsStore::open(directory.path()).unwrap();
        let actions = SettingsActions::default();
        let input = input();
        let digest = hash(&serde_json::to_vec(&("fingerprint", "project", &input)).unwrap());
        let first = uuid::Uuid::new_v4().to_string();
        {
            let mut texts = actions.texts.lock().unwrap();
            texts.insert(
                first.clone(),
                (digest.clone(), Some(Ok("Retained result".into()))),
            );
            for _ in 1..32 {
                texts.insert(
                    uuid::Uuid::new_v4().to_string(),
                    (digest.clone(), Some(Ok("Other result".into()))),
                );
            }
        }
        let action = |id, context| TextAction {
            action_id: id,
            session_id: &settings.session_id,
            fingerprint: "fingerprint",
            context,
            input: &input,
        };
        assert_eq!(
            actions.text(&settings, action(&first, "project")).unwrap(),
            "Retained result"
        );
        assert_eq!(
            actions.text(&settings, action(&first, "another project")),
            Err(AiError("REQUEST_ID_REUSED"))
        );
        // A new action has no configured model; it is still reserved and cannot erase prior identities.
        let fresh = uuid::Uuid::new_v4().to_string();
        assert_eq!(
            actions.text(&settings, action(&fresh, "project")),
            Err(AiError("CONFIGURATION_UNAVAILABLE"))
        );
        let expired = actions
            .texts
            .lock()
            .unwrap()
            .iter()
            .find(|(_, (_, result))| matches!(result, Some(Err(AiError("ACTION_RESULT_EXPIRED")))))
            .unwrap()
            .0
            .clone();
        assert_eq!(
            actions.text(&settings, action(&expired, "project")),
            Err(AiError("ACTION_RESULT_EXPIRED"))
        );
        assert_eq!(actions.texts.lock().unwrap().len(), 33);
    }
}
