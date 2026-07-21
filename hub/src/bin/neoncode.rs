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
    if command == "tab" || command == "tabs" {
        return run_tab_command(&arguments);
    }
    if command == "pane" || command == "panes" {
        return run_pane_command(&arguments);
    }
    if command == "app" {
        return run_app_command(&arguments);
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

fn run_app_command(arguments: &[String]) -> Result<()> {
    let subcommand = arguments.get(1).map(String::as_str).unwrap_or("status");
    match subcommand {
        "status" => {
            let response = app_control_request("GET", "/v1/status", None)?;
            let context = &response["context"];
            println!("app: connected");
            println!(
                "version: {}",
                response["appVersion"].as_str().unwrap_or("unknown")
            );
            println!("pid: {}", response["pid"].as_i64().unwrap_or_default());
            println!(
                "config revision: {}",
                response["configRevision"].as_i64().unwrap_or_default()
            );
            println!(
                "descriptor: {}",
                response["descriptorPath"].as_str().unwrap_or("unknown")
            );
            println!(
                "active workspace: {} ({})",
                context["activeWorkspaceId"].as_str().unwrap_or("none"),
                context["activeWorkspaceName"].as_str().unwrap_or("unknown"),
            );
            println!(
                "active tab: {} ({})",
                context["activeTabId"].as_str().unwrap_or("none"),
                context["activeTabTitle"].as_str().unwrap_or("unknown"),
            );
            println!(
                "active pane: {}",
                context["activePaneId"].as_str().unwrap_or("none")
            );
            let features = response["features"]
                .as_array()
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(",")
                })
                .unwrap_or_default();
            println!("features: {features}");
            Ok(())
        }
        _ => bail!("unknown app command {subcommand:?}; use 'neoncode app status'"),
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
    let args = if let Some(args) = arguments.get(2) {
        Some(serde_json::from_str::<Value>(args).context("parse command JSON args")?)
    } else {
        None
    };
    let result = app_control_execute_command(id, args)?;
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}

fn app_control_execute_command(id: &str, args: Option<Value>) -> Result<Value> {
    app_control_require_command(id)?;
    let command = if let Some(args) = args {
        json!({ "id": id, "args": args })
    } else {
        json!({ "id": id })
    };
    let response = app_control_request(
        "POST",
        "/v1/commands/execute",
        Some(json!({ "command": command })),
    )?;
    Ok(response["result"].clone())
}

fn app_control_require_command(id: &str) -> Result<()> {
    let response = app_control_request("GET", "/v1/capabilities", None)?;
    if response["protocolVersion"] != 1 {
        bail!("unsupported app-control protocol version");
    }
    let commands = response["commands"]
        .as_array()
        .ok_or_else(|| anyhow!("invalid app-control capabilities"))?;
    if !commands
        .iter()
        .any(|command| command["id"].as_str() == Some(id))
    {
        bail!("app-control command is not advertised by the running app: {id}");
    }
    Ok(())
}

fn require_completed(result: &Value, action: &str) -> Result<()> {
    let status = result["status"].as_str().unwrap_or("unknown");
    if status != "completed" {
        bail!(
            "{action} failed: {}",
            result["message"].as_str().unwrap_or(status)
        );
    }
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
            require_completed(&response["result"], "workspace open")?;
            println!("opened workspace {workspace_id}");
            Ok(())
        }
        "create" => {
            if arguments.len() < 7 {
                bail!(
                    "usage: neoncode workspace create <workspace-id> <session-id> <launch-profile> <name> <title>"
                );
            }
            let title = arguments[6..].join(" ");
            let result = app_control_execute_command(
                "workspace.create",
                Some(json!({
                    "workspaceId": arguments[2],
                    "sessionId": arguments[3],
                    "defaultLaunchProfile": arguments[4],
                    "name": arguments[5],
                    "path": null,
                    "title": title,
                })),
            )?;
            require_completed(&result, "workspace create")?;
            println!("created workspace {}", arguments[2]);
            Ok(())
        }
        "rename" => {
            if arguments.len() < 4 {
                bail!("usage: neoncode workspace rename <workspace-id> <name>");
            }
            let name = arguments[3..].join(" ");
            let result = app_control_execute_command(
                "workspace.rename",
                Some(json!({ "workspaceId": arguments[2], "name": name })),
            )?;
            require_completed(&result, "workspace rename")?;
            println!("renamed workspace {}", arguments[2]);
            Ok(())
        }
        "delete" | "remove" => {
            if arguments.len() < 3 || arguments.len() > 4 {
                bail!("usage: neoncode workspace delete <workspace-id> [kill|detach]");
            }
            let disposition = arguments.get(3).map(String::as_str).unwrap_or("kill");
            if disposition != "kill" && disposition != "detach" {
                bail!("workspace delete disposition must be kill or detach");
            }
            let result = app_control_execute_command(
                "workspace.delete",
                Some(json!({ "workspaceId": arguments[2], "disposition": disposition })),
            )?;
            require_completed(&result, "workspace delete")?;
            println!("deleted workspace {}", arguments[2]);
            Ok(())
        }
        _ => bail!(
            "unknown workspace command {subcommand:?}; use 'neoncode workspace list|open|create|rename|delete'"
        ),
    }
}

fn run_tab_command(arguments: &[String]) -> Result<()> {
    let subcommand = arguments.get(1).map(String::as_str).unwrap_or("help");
    match subcommand {
        "list" | "ls" => {
            let requested_workspace = arguments.get(2).map(String::as_str);
            let layout = app_control_request("GET", "/v1/layout", None)?;
            let active_workspace = layout["activeWorkspaceId"].as_str().unwrap_or("");
            let workspaces = layout["workspaces"]
                .as_array()
                .ok_or_else(|| anyhow!("invalid app-control layout snapshot"))?;
            let mut printed = false;
            for workspace in workspaces {
                let workspace_id = workspace["id"].as_str().unwrap_or("<unknown>");
                if requested_workspace
                    .map(|requested| requested != workspace_id)
                    .unwrap_or(workspace_id != active_workspace)
                {
                    continue;
                }
                let tabs = workspace["tabs"]
                    .as_array()
                    .ok_or_else(|| anyhow!("invalid app-control tab list"))?;
                for tab in tabs {
                    let tab_id = tab["tabId"].as_str().unwrap_or("<unknown>");
                    let title = tab["title"].as_str().unwrap_or(tab_id);
                    let active = workspace_id == active_workspace && tab["active"] == true;
                    let marker = if active { "*" } else { " " };
                    println!("{marker} {workspace_id}\t{tab_id}\t{title}");
                    printed = true;
                }
            }
            if !printed && requested_workspace.is_some() {
                bail!(
                    "workspace not found: {}",
                    requested_workspace.unwrap_or_default()
                );
            }
            Ok(())
        }
        "create" => {
            if arguments.len() < 7 {
                bail!(
                    "usage: neoncode tab create <workspace-id> <tab-id> <session-id> <launch-profile> <title>"
                );
            }
            let title = arguments[6..].join(" ");
            let result = app_control_execute_command(
                "tab.create",
                Some(json!({
                    "workspaceId": arguments[2],
                    "tabId": arguments[3],
                    "sessionId": arguments[4],
                    "launchProfile": arguments[5],
                    "title": title,
                })),
            )?;
            require_completed(&result, "tab create")?;
            println!("created tab {}", arguments[3]);
            Ok(())
        }
        "open" => {
            if arguments.len() != 4 {
                bail!("usage: neoncode tab open <workspace-id> <tab-id>");
            }
            let result = app_control_execute_command(
                "tab.open",
                Some(json!({ "workspaceId": arguments[2], "tabId": arguments[3] })),
            )?;
            require_completed(&result, "tab open")?;
            println!("opened tab {}", arguments[3]);
            Ok(())
        }
        "rename" => {
            if arguments.len() < 5 {
                bail!("usage: neoncode tab rename <workspace-id> <tab-id> <title>");
            }
            let title = arguments[4..].join(" ");
            let result = app_control_execute_command(
                "tab.rename",
                Some(json!({ "workspaceId": arguments[2], "tabId": arguments[3], "title": title })),
            )?;
            require_completed(&result, "tab rename")?;
            println!("renamed tab {}", arguments[3]);
            Ok(())
        }
        "move" => {
            if arguments.len() != 5 {
                bail!("usage: neoncode tab move <workspace-id> <tab-id> <to-index>");
            }
            let to_index = arguments[4]
                .parse::<u8>()
                .context("tab move index must be an integer")?;
            let result = app_control_execute_command(
                "tab.move",
                Some(
                    json!({ "workspaceId": arguments[2], "tabId": arguments[3], "toIndex": to_index }),
                ),
            )?;
            require_completed(&result, "tab move")?;
            println!("moved tab {}", arguments[3]);
            Ok(())
        }
        "close" => {
            if arguments.len() != 4 {
                bail!("usage: neoncode tab close <workspace-id> <tab-id>");
            }
            let result = app_control_execute_command(
                "tab.close",
                Some(json!({ "workspaceId": arguments[2], "tabId": arguments[3] })),
            )?;
            require_completed(&result, "tab close")?;
            println!("closed tab {}", arguments[3]);
            Ok(())
        }
        _ => bail!(
            "unknown tab command {subcommand:?}; use 'neoncode tab list|create|open|rename|move|close'"
        ),
    }
}

fn run_pane_command(arguments: &[String]) -> Result<()> {
    let subcommand = arguments.get(1).map(String::as_str).unwrap_or("help");
    match subcommand {
        "list" | "ls" => {
            let requested_workspace = arguments.get(2).map(String::as_str);
            let layout = app_control_request("GET", "/v1/layout", None)?;
            let active_workspace = layout["activeWorkspaceId"].as_str().unwrap_or("");
            let workspaces = layout["workspaces"]
                .as_array()
                .ok_or_else(|| anyhow!("invalid app-control layout snapshot"))?;
            let mut printed = false;
            for workspace in workspaces {
                let workspace_id = workspace["id"].as_str().unwrap_or("<unknown>");
                if requested_workspace
                    .map(|requested| requested != workspace_id)
                    .unwrap_or(workspace_id != active_workspace)
                {
                    continue;
                }
                let tabs = workspace["tabs"]
                    .as_array()
                    .ok_or_else(|| anyhow!("invalid app-control pane list"))?;
                for tab in tabs {
                    let tab_id = tab["tabId"].as_str().unwrap_or("<unknown>");
                    let tab_active = tab["active"] == true;
                    let panes = tab["panes"]
                        .as_array()
                        .ok_or_else(|| anyhow!("invalid app-control pane list"))?;
                    for pane in panes {
                        let pane_id = pane["paneId"].as_str().unwrap_or("<unknown>");
                        let session_key = pane["sessionKey"].as_str().unwrap_or(pane_id);
                        let title = pane["title"].as_str().unwrap_or(session_key);
                        let focused = workspace_id == active_workspace
                            && tab_active
                            && pane["focused"] == true;
                        let marker = if focused { "*" } else { " " };
                        println!(
                            "{marker} {workspace_id}\t{tab_id}\t{pane_id}\t{session_key}\t{title}"
                        );
                        printed = true;
                    }
                }
            }
            if !printed && requested_workspace.is_some() {
                bail!(
                    "workspace not found: {}",
                    requested_workspace.unwrap_or_default()
                );
            }
            Ok(())
        }
        "focus" => {
            if arguments.len() != 3 {
                bail!("usage: neoncode pane focus <pane-id>");
            }
            let result =
                app_control_execute_command("pane.focus", Some(json!({ "paneId": arguments[2] })))?;
            require_completed(&result, "pane focus")?;
            println!("focused pane {}", arguments[2]);
            Ok(())
        }
        "focus-index" | "focusIndex" => {
            if arguments.len() != 3 {
                bail!("usage: neoncode pane focus-index <index>");
            }
            let index = arguments[2]
                .parse::<u8>()
                .context("pane focus index must be an integer")?;
            let result =
                app_control_execute_command("pane.focusIndex", Some(json!({ "index": index })))?;
            require_completed(&result, "pane focus-index")?;
            println!("focused pane index {index}");
            Ok(())
        }
        "send" | "send-enter" | "sendEnter" => {
            if arguments.len() < 4 {
                bail!("usage: neoncode pane {subcommand} <pane-id> <text>");
            }
            let text = arguments[3..].join(" ");
            let command_id = if subcommand == "send" {
                "pane.send"
            } else {
                "pane.sendEnter"
            };
            let result = app_control_execute_command(
                command_id,
                Some(json!({ "paneId": arguments[2], "text": text })),
            )?;
            require_completed(&result, &format!("pane {subcommand}"))?;
            println!("sent text to pane {}", arguments[2]);
            Ok(())
        }
        "split" => {
            if arguments.len() < 10 {
                bail!(
                    "usage: neoncode pane split <workspace-id> <pane-id> <session-id> <split-id> <horizontal|vertical> <before|after> <launch-profile> <title>"
                );
            }
            let title = arguments[9..].join(" ");
            let result = app_control_execute_command(
                "pane.split",
                Some(json!({
                    "workspaceId": arguments[2],
                    "paneId": arguments[3],
                    "sessionId": arguments[4],
                    "splitId": arguments[5],
                    "direction": arguments[6],
                    "position": arguments[7],
                    "launchProfile": arguments[8],
                    "title": title,
                })),
            )?;
            require_completed(&result, "pane split")?;
            println!("split pane {}", arguments[3]);
            Ok(())
        }
        "resize" => {
            if arguments.len() != 5 {
                bail!("usage: neoncode pane resize <workspace-id> <split-id> <delta>");
            }
            let delta = arguments[4]
                .parse::<f64>()
                .context("pane resize delta must be a number")?;
            let result = app_control_execute_command(
                "split.resize",
                Some(
                    json!({ "workspaceId": arguments[2], "splitId": arguments[3], "delta": delta }),
                ),
            )?;
            require_completed(&result, "pane resize")?;
            println!("resized split {}", arguments[3]);
            Ok(())
        }
        "close" | "kill" | "restart" => {
            if arguments.len() != 4 {
                bail!("usage: neoncode pane {subcommand} <workspace-id> <pane-id>");
            }
            let command_id = match subcommand {
                "close" => "pane.close",
                "kill" => "pane.kill",
                "restart" => "pane.restart",
                _ => unreachable!(),
            };
            let result = app_control_execute_command(
                command_id,
                Some(json!({ "workspaceId": arguments[2], "paneId": arguments[3] })),
            )?;
            require_completed(&result, &format!("pane {subcommand}"))?;
            println!("{subcommand} pane {}", arguments[3]);
            Ok(())
        }
        _ => bail!(
            "unknown pane command {subcommand:?}; use 'neoncode pane list|focus|focus-index|send|send-enter|split|resize|close|kill|restart'"
        ),
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
        "NeonCode CLI\n\n  neoncode status\n  neoncode sessions\n  neoncode app status\n  neoncode workspace list\n  neoncode workspace open <workspace-id>\n  neoncode workspace create <workspace-id> <session-id> <launch-profile> <name> <title>\n  neoncode workspace rename <workspace-id> <name>\n  neoncode workspace delete <workspace-id> [kill|detach]\n  neoncode tab list [workspace-id]\n  neoncode tab create <workspace-id> <tab-id> <session-id> <launch-profile> <title>\n  neoncode tab open <workspace-id> <tab-id>\n  neoncode tab rename <workspace-id> <tab-id> <title>\n  neoncode tab move <workspace-id> <tab-id> <to-index>\n  neoncode tab close <workspace-id> <tab-id>\n  neoncode pane list [workspace-id]\n  neoncode pane focus <pane-id>\n  neoncode pane focus-index <index>\n  neoncode pane send <pane-id> <text>\n  neoncode pane send-enter <pane-id> <text>\n  neoncode pane split <workspace-id> <pane-id> <session-id> <split-id> <horizontal|vertical> <before|after> <launch-profile> <title>\n  neoncode pane resize <workspace-id> <split-id> <delta>\n  neoncode pane close <workspace-id> <pane-id>\n  neoncode pane kill <workspace-id> <pane-id>\n  neoncode pane restart <workspace-id> <pane-id>\n  neoncode commands\n  neoncode command <command-id> [json-args]\n  neoncode notify <session-id> <info|warning|error> <title> <message>"
    );
}
