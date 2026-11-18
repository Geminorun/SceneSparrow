pub(crate) mod ai;
mod documents;
mod exports;
pub(crate) mod manuscript;
mod planning;
mod review;

use crate::{AppState, Router};

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .merge(manuscript::routes())
        .merge(documents::routes())
        .merge(exports::routes())
        .merge(ai::routes())
        .merge(planning::routes())
        .merge(review::routes())
}
