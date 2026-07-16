use std::net::SocketAddr;

use anyhow::{Result, bail};
use axum::{Router, http::StatusCode, response::IntoResponse, routing::get};
use tower_http::trace::TraceLayer;

mod git;
mod protocol;
mod session;
mod state;
mod ws;

pub fn app(capability_token: String) -> Result<Router> {
    Ok(Router::new()
        .route("/health", get(health))
        .route("/ws", get(ws::ws_handler))
        .layer(TraceLayer::new_for_http())
        .with_state(state::AppState::new(capability_token)?))
}

pub fn validate_bind_address(address: SocketAddr) -> Result<()> {
    if !address.ip().is_loopback() {
        bail!("non-loopback hub binding is not supported: {address}");
    }
    Ok(())
}

async fn health() -> impl IntoResponse {
    (StatusCode::OK, "ok\n")
}

#[cfg(test)]
mod tests {
    use super::validate_bind_address;

    #[test]
    fn accepts_loopback_bind_addresses() {
        assert!(validate_bind_address("127.0.0.1:44777".parse().unwrap()).is_ok());
        assert!(validate_bind_address("[::1]:44777".parse().unwrap()).is_ok());
    }

    #[test]
    fn rejects_non_loopback_bind_addresses() {
        assert!(validate_bind_address("0.0.0.0:44777".parse().unwrap()).is_err());
        assert!(validate_bind_address("192.168.1.10:44777".parse().unwrap()).is_err());
    }
}
