use std::{env, fs, net::SocketAddr, path::PathBuf};

use anyhow::{Context, Result, bail};
use axum::{Router, http::StatusCode, response::IntoResponse, routing::get};
use tower_http::trace::TraceLayer;

mod git;
mod protocol;
mod session;
mod state;
mod ws;

const TOKEN_ENV: &str = "NEONCODE_HUB_TOKEN";
const MANAGED_TOKEN_PATH: &str = "neoncode/hub-token";

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

pub fn managed_token_file_path() -> Result<PathBuf> {
    if let Some(state_home) = env::var_os("XDG_STATE_HOME")
        && !state_home.is_empty()
    {
        return Ok(PathBuf::from(state_home).join(MANAGED_TOKEN_PATH));
    }
    let home = env::var_os("HOME").context(
        "NEONCODE_HUB_TOKEN is absent and HOME is unavailable for the managed token file",
    )?;
    Ok(PathBuf::from(home)
        .join(".local")
        .join("state")
        .join(MANAGED_TOKEN_PATH))
}

pub fn validate_capability_token(token: &str, source: &str) -> Result<String> {
    let normalized = token.trim();
    if normalized.len() != 64 || !normalized.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        bail!("{source} must contain exactly 64 hexadecimal characters");
    }
    Ok(normalized.to_string())
}

pub fn load_capability_token() -> Result<String> {
    if let Ok(token) = env::var(TOKEN_ENV) {
        return validate_capability_token(&token, TOKEN_ENV);
    }
    let token_path = managed_token_file_path()?;
    let token = fs::read_to_string(&token_path).with_context(|| {
        format!(
            "{TOKEN_ENV} is absent and managed token file could not be read: {}",
            token_path.display()
        )
    })?;
    validate_capability_token(&token, "managed hub token file")
}

async fn health() -> impl IntoResponse {
    (StatusCode::OK, "ok\n")
}

#[cfg(test)]
mod tests {
    use super::{validate_bind_address, validate_capability_token};

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

    #[test]
    fn validates_capability_token_shape() {
        let token = "0123456789abcdef".repeat(4);
        assert_eq!(validate_capability_token(&token, "test").unwrap(), token);
        assert!(validate_capability_token("not-a-token", "test").is_err());
        assert!(validate_capability_token(&"a".repeat(63), "test").is_err());
    }
}
