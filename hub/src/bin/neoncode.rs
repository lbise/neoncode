use std::env;

use anyhow::{Context, Result, anyhow, bail};
use futures_util::{SinkExt, StreamExt};
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message, client::IntoClientRequest, http::header},
};

type HmacSha256 = Hmac<Sha256>;

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("neoncode: {error:#}");
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    let command = arguments.first().map(String::as_str).unwrap_or("help");
    if command == "help" || command == "--help" || command == "-h" {
        print_help();
        return Ok(());
    }
    let token =
        neoncode_hub::load_capability_token().context("load neoncode-hub capability token")?;
    let token = hex::decode(&token).context("hub capability token must be hexadecimal")?;
    if token.len() != 32 {
        bail!("hub capability token must contain exactly 64 hexadecimal characters");
    }
    let endpoint =
        env::var("NEONCODE_HUB_ENDPOINT").unwrap_or_else(|_| "ws://127.0.0.1:44777/ws".to_string());
    let mut request = endpoint.into_client_request()?;
    request
        .headers_mut()
        .insert(header::ORIGIN, "file://".parse()?);
    request
        .headers_mut()
        .insert(header::SEC_WEBSOCKET_PROTOCOL, "neoncode.v1".parse()?);
    let (mut socket, _) = connect_async(request)
        .await
        .context("connect to neoncode-hub")?;
    authenticate(&mut socket, &token).await?;

    match command {
        "sessions" | "status" => {
            socket
                .send(Message::Text(
                    json!({ "type": "list_sessions" }).to_string().into(),
                ))
                .await?;
            let response = next_json(&mut socket).await?;
            if response["type"] != "session_list" {
                bail!("unexpected hub response: {response}");
            }
            if command == "sessions" {
                println!("{}", serde_json::to_string_pretty(&response["sessions"])?);
            } else {
                let sessions = response["sessions"]
                    .as_array()
                    .ok_or_else(|| anyhow!("invalid session list"))?;
                let running = sessions
                    .iter()
                    .filter(|session| session["state"] == "running")
                    .count();
                let attention = sessions
                    .iter()
                    .filter(|session| {
                        !session["latest_exit"].is_null()
                            || !session["latest_notification"].is_null()
                    })
                    .count();
                println!("hub: connected");
                println!(
                    "sessions: {} total, {running} running, {attention} needing attention",
                    sessions.len()
                );
            }
        }
        "notify" => {
            if arguments.len() < 5 {
                bail!("usage: neoncode notify <session-id> <info|warning|error> <title> <message>");
            }
            let level = arguments[2].as_str();
            if !matches!(level, "info" | "warning" | "error") {
                bail!("notification level must be info, warning, or error");
            }
            socket
                .send(Message::Text(
                    json!({
                        "type": "publish_notification",
                        "session_id": arguments[1],
                        "kind": "notification",
                        "level": level,
                        "title": arguments[3],
                        "message": arguments[4..].join(" ")
                    })
                    .to_string()
                    .into(),
                ))
                .await?;
            let response = next_json(&mut socket).await?;
            if response["type"] != "notification_published" {
                bail!("unexpected hub response: {response}");
            }
            println!(
                "notification {} published for {}",
                response["notification_id"].as_str().unwrap_or("<unknown>"),
                arguments[1]
            );
        }
        _ => bail!("unknown command {command:?}; use 'neoncode help'"),
    }
    let _ = socket.close(None).await;
    Ok(())
}

async fn authenticate<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    token: &[u8],
) -> Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let challenge = next_json(socket).await?;
    let server_nonce = challenge["nonce"]
        .as_str()
        .ok_or_else(|| anyhow!("invalid auth challenge"))?;
    if challenge["type"] != "auth_challenge" || server_nonce.len() != 64 {
        bail!("invalid auth challenge");
    }
    let mut nonce = [0_u8; 32];
    getrandom::fill(&mut nonce).map_err(|error| anyhow!("generate client nonce: {error}"))?;
    let client_nonce = hex::encode(nonce);
    let proof = hmac_hex(token, &format!("client:{server_nonce}"))?;
    socket
        .send(Message::Text(
            json!({
                "type": "authenticate", "client_nonce": client_nonce, "hmac": proof
            })
            .to_string()
            .into(),
        ))
        .await?;
    let authenticated = next_json(socket).await?;
    let server_proof = authenticated["hmac"]
        .as_str()
        .ok_or_else(|| anyhow!("invalid hub proof"))?;
    if authenticated["type"] != "authenticated"
        || server_proof != hmac_hex(token, &format!("server:{client_nonce}"))?
    {
        bail!("hub authentication proof is invalid");
    }
    let welcome = next_json(socket).await?;
    if welcome["type"] != "welcome" || welcome["protocol_version"] != 1 {
        bail!("hub protocol version is unsupported");
    }
    Ok(())
}

fn hmac_hex(token: &[u8], payload: &str) -> Result<String> {
    let mut mac =
        HmacSha256::new_from_slice(token).map_err(|_| anyhow!("invalid capability token"))?;
    mac.update(payload.as_bytes());
    Ok(hex::encode(mac.finalize().into_bytes()))
}

async fn next_json<S>(socket: &mut tokio_tungstenite::WebSocketStream<S>) -> Result<Value>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    loop {
        let frame = socket
            .next()
            .await
            .ok_or_else(|| anyhow!("hub closed the connection"))??;
        if let Message::Text(text) = frame {
            return serde_json::from_str(&text).context("parse hub response");
        }
    }
}

fn print_help() {
    println!(
        "NeonCode CLI\n\n  neoncode status\n  neoncode sessions\n  neoncode notify <session-id> <info|warning|error> <title> <message>"
    );
}
