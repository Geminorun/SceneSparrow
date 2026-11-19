pub(crate) mod ai;
mod authored_source;
mod documents;
mod exports;
pub(crate) mod manuscript;
mod planning;
mod review;

use crate::{AppState, Router};

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .merge(manuscript::routes())
        .merge(authored_source::routes())
        .merge(documents::routes())
        .merge(exports::routes())
        .merge(ai::routes())
        .merge(planning::routes())
        .merge(review::routes())
}
