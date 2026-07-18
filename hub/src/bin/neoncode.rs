use std::{
    env, fs,
    io::{Read, Write},
    net::TcpStream,
    path::PathBuf,
};

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
    if command == "workspace" || command == "workspaces" {
        return run_workspace_command(&arguments);
    }
    if command == "commands" {
        return run_commands_command();
    }
    if command == "command" {
        return run_command_execute(&arguments);
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

fn app_control_descriptor_path() -> Result<PathBuf> {
    if let Ok(path) = env::var("NEONCODE_APP_CONTROL_DESCRIPTOR") {
        return Ok(PathBuf::from(path));
    }
    if let Ok(path) = env::var("NEONCODE_TEST_CONFIG_DIR") {
        return Ok(PathBuf::from(path).join("app-control.json"));
    }
    #[cfg(target_os = "windows")]
    {
        let appdata = env::var("APPDATA").context("APPDATA is not set")?;
        return Ok(PathBuf::from(appdata)
            .join("NeonCode")
            .join("app-control.json"));
    }
    #[cfg(target_os = "macos")]
    {
        let home = env::var("HOME").context("HOME is not set")?;
        return Ok(PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("NeonCode")
            .join("app-control.json"));
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let base = env::var("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|_| env::var("HOME").map(|home| PathBuf::from(home).join(".config")))
            .context("XDG_CONFIG_HOME and HOME are not set")?;
        Ok(base.join("NeonCode").join("app-control.json"))
    }
}

fn run_commands_command() -> Result<()> {
    let response = app_control_request("GET", "/v1/capabilities", None)?;
    let commands = response["commands"]
        .as_array()
        .ok_or_else(|| anyhow!("invalid app-control capabilities"))?;
    for command in commands {
        let id = command["id"].as_str().unwrap_or("<unknown>");
        let title = command["title"].as_str().unwrap_or(id);
        let context = command["context"].as_str().unwrap_or("unknown");
        println!("{id}\t{context}\t{title}");
    }
    Ok(())
}

fn run_command_execute(arguments: &[String]) -> Result<()> {
    let id = arguments
        .get(1)
        .ok_or_else(|| anyhow!("usage: neoncode command <command-id> [json-args]"))?;
    let command = if let Some(args) = arguments.get(2) {
        json!({ "id": id, "args": serde_json::from_str::<Value>(args).context("parse command JSON args")? })
    } else {
        json!({ "id": id })
    };
    let response = app_control_request(
        "POST",
        "/v1/commands/execute",
        Some(json!({ "command": command })),
    )?;
    println!("{}", serde_json::to_string_pretty(&response["result"])?);
    Ok(())
}

fn run_workspace_command(arguments: &[String]) -> Result<()> {
    let subcommand = arguments.get(1).map(String::as_str).unwrap_or("list");
    match subcommand {
        "list" | "ls" => {
            let response = app_control_request("GET", "/v1/workspaces", None)?;
            let active = response["activeWorkspaceId"].as_str().unwrap_or("");
            let workspaces = response["workspaces"]
                .as_array()
                .ok_or_else(|| anyhow!("invalid app-control workspace list"))?;
            for workspace in workspaces {
                let id = workspace["id"].as_str().unwrap_or("<unknown>");
                let name = workspace["name"].as_str().unwrap_or(id);
                let marker = if id == active { "*" } else { " " };
                println!("{marker} {id}\t{name}");
            }
            Ok(())
        }
        "open" => {
            let workspace_id = arguments
                .get(2)
                .ok_or_else(|| anyhow!("usage: neoncode workspace open <workspace-id>"))?;
            let response = app_control_request(
                "POST",
                "/v1/workspaces/open",
                Some(json!({ "workspaceId": workspace_id })),
            )?;
            let status = response["result"]["status"].as_str().unwrap_or("unknown");
            if status != "completed" {
                bail!(
                    "workspace open failed: {}",
                    response["result"]["message"].as_str().unwrap_or(status)
                );
            }
            println!("opened workspace {workspace_id}");
            Ok(())
        }
        _ => bail!("unknown workspace command {subcommand:?}; use 'neoncode workspace list|open'"),
    }
}

fn app_control_request(method: &str, path: &str, body: Option<Value>) -> Result<Value> {
    let descriptor_path = app_control_descriptor_path()?;
    let descriptor: Value =
        serde_json::from_str(&fs::read_to_string(&descriptor_path).with_context(|| {
            format!(
                "read app-control descriptor at {}",
                descriptor_path.display()
            )
        })?)
        .context("parse app-control descriptor")?;
    if descriptor["protocolVersion"] != 1 {
        bail!("unsupported app-control protocol version");
    }
    let endpoint = descriptor["endpoint"]
        .as_str()
        .ok_or_else(|| anyhow!("app-control descriptor is missing endpoint"))?;
    let token = descriptor["token"]
        .as_str()
        .ok_or_else(|| anyhow!("app-control descriptor is missing token"))?;
    let port = endpoint
        .strip_prefix("http://127.0.0.1:")
        .and_then(|suffix| suffix.parse::<u16>().ok())
        .ok_or_else(|| anyhow!("unsupported app-control endpoint: {endpoint}"))?;
    let body_text = body.map(|value| value.to_string()).unwrap_or_default();
    let mut stream =
        TcpStream::connect(("127.0.0.1", port)).context("connect to NeonCode app-control")?;
    write!(
        stream,
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body_text.len(),
        body_text
    )?;
    let mut response = String::new();
    stream.read_to_string(&mut response)?;
    let (head, body) = response
        .split_once("\r\n\r\n")
        .ok_or_else(|| anyhow!("invalid app-control HTTP response"))?;
    if !head.starts_with("HTTP/1.1 200 ") {
        let error = serde_json::from_str::<Value>(body)
            .ok()
            .and_then(|value| value["error"].as_str().map(str::to_string))
            .unwrap_or_else(|| head.lines().next().unwrap_or("HTTP error").to_string());
        bail!("app-control request failed: {error}");
    }
    let value: Value = serde_json::from_str(body).context("parse app-control response")?;
    if value["ok"] != true {
        bail!(
            "app-control request failed: {}",
            value["error"].as_str().unwrap_or("unknown error")
        );
    }
    Ok(value)
}

fn print_help() {
    println!(
        "NeonCode CLI\n\n  neoncode status\n  neoncode sessions\n  neoncode workspace list\n  neoncode workspace open <workspace-id>\n  neoncode commands\n  neoncode command <command-id> [json-args]\n  neoncode notify <session-id> <info|warning|error> <title> <message>"
    );
}
