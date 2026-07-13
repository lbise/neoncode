use std::{env, net::SocketAddr};

use anyhow::{Context, Result};
use tracing::{error, info};
use tracing_subscriber::{EnvFilter, fmt};

const DEFAULT_BIND: &str = "127.0.0.1:44777";

#[tokio::main]
async fn main() -> Result<()> {
    init_logging();

    let bind = env::var("NEONCODE_HUB_BIND")
        .or_else(|_| env::var("WORKSPACE_HUB_BIND"))
        .unwrap_or_else(|_| DEFAULT_BIND.to_string());
    let addr: SocketAddr = bind
        .parse()
        .with_context(|| format!("invalid NEONCODE_HUB_BIND address: {bind}"))?;

    let listener = tokio::net::TcpListener::bind(addr).await?;
    info!(%addr, "neoncode-hub listening");

    axum::serve(listener, neoncode_hub::app())
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    Ok(())
}

fn init_logging() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    fmt().with_env_filter(filter).init();
}

async fn shutdown_signal() {
    if let Err(err) = tokio::signal::ctrl_c().await {
        error!(%err, "failed to install Ctrl+C handler");
    }
    info!("shutdown requested");
}
