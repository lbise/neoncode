use axum::{Router, http::StatusCode, response::IntoResponse, routing::get};
use tower_http::{cors::CorsLayer, trace::TraceLayer};

mod protocol;
mod session;
mod state;
mod ws;

pub fn app() -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/ws", get(ws::ws_handler))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state::AppState::default())
}

async fn health() -> impl IntoResponse {
    (StatusCode::OK, "ok\n")
}
