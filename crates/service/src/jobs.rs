use crate::AppState;
use scenesparrow_domain::manuscript::ManuscriptError;
use std::sync::Arc;

pub(crate) fn start(state: &AppState) {
    drive_ai_and_maintenance(state);
    drive_exports(state);
}

fn drive_ai_and_maintenance(state: &AppState) {
    let service = Arc::downgrade(&state.service);
    let ai = Arc::downgrade(&state.ai);
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(250));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut maintenance = std::time::Instant::now();
        loop {
            interval.tick().await;
            let run_maintenance = maintenance.elapsed() >= std::time::Duration::from_secs(60);
            if run_maintenance {
                maintenance = std::time::Instant::now();
            }
            let (Some(service), Some(ai)) = (service.upgrade(), ai.upgrade()) else {
                break;
            };
            let _ = tokio::task::spawn_blocking(move || -> Result<(), ManuscriptError> {
                let repository = service.repository();
                repository.reconcile_planning()?;
                repository.reconcile_reviews()?;
                if run_maintenance
                    && scenesparrow_application::ProjectRepository::read(repository)
                        .map_err(|_| ManuscriptError("STORAGE_UNAVAILABLE", None))?
                        .is_some()
                {
                    repository.prune_export_inputs()?;
                    repository.prune_planning_payloads()?;
                    repository.prune_review_payloads()?;
                }
                if repository.has_queued_ai()? {
                    let settings = ai.settings().map_err(|e| ManuscriptError(e.0, None))?;
                    repository
                        .execute_next_ai(settings)
                        .map_err(|e| ManuscriptError(e.0, None))?;
                    repository.reconcile_planning()?;
                    repository.reconcile_reviews()?;
                }
                Ok(())
            })
            .await;
        }
    });
}

fn drive_exports(state: &AppState) {
    let service = Arc::downgrade(&state.service);
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            let Some(service) = service.upgrade() else {
                break;
            };
            let _ = tokio::task::spawn_blocking(move || {
                if let Ok(Some(id)) = service.repository().next_export() {
                    let _ = service.repository().run_export(&id);
                }
            })
            .await;
        }
    });
}
