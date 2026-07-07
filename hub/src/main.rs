use std::{
    collections::HashMap,
    env,
    io::{Read, Write},
    net::SocketAddr,
    sync::{Arc, Mutex},
    thread,
};

use anyhow::{Context, Result, anyhow};
use axum::{
    Router,
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    http::StatusCode,
    response::IntoResponse,
    routing::get,
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use futures_util::{SinkExt, StreamExt};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use tracing::{debug, error, info, warn};
use tracing_subscriber::{EnvFilter, fmt};

const DEFAULT_BIND: &str = "127.0.0.1:44777";
const DEFAULT_ROWS: u16 = 24;
const DEFAULT_COLS: u16 = 80;

#[tokio::main]
async fn main() -> Result<()> {
    init_logging();

    let bind = env::var("NEONCODE_HUB_BIND")
        .or_else(|_| env::var("WORKSPACE_HUB_BIND"))
        .unwrap_or_else(|_| DEFAULT_BIND.to_string());
    let addr: SocketAddr = bind
        .parse()
        .with_context(|| format!("invalid NEONCODE_HUB_BIND address: {bind}"))?;

    let app = Router::new()
        .route("/health", get(health))
        .route("/ws", get(ws_handler))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http());

    let listener = tokio::net::TcpListener::bind(addr).await?;
    info!(%addr, "neoncode-hub listening");

    axum::serve(listener, app)
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

async fn health() -> impl IntoResponse {
    (StatusCode::OK, "ok\n")
}

async fn ws_handler(ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(handle_socket)
}

async fn handle_socket(socket: WebSocket) {
    let peer_id = format!("{:p}", &socket);
    info!(%peer_id, "websocket connected");

    let (mut ws_sender, mut ws_receiver) = socket.split();
    let (outgoing_tx, mut outgoing_rx) = mpsc::unbounded_channel::<ServerMessage>();

    let writer = tokio::spawn(async move {
        while let Some(message) = outgoing_rx.recv().await {
            let payload = match serde_json::to_string(&message) {
                Ok(payload) => payload,
                Err(err) => {
                    error!(%err, "failed to serialize server message");
                    continue;
                }
            };

            if let Err(err) = ws_sender.send(Message::Text(payload.into())).await {
                debug!(%err, "websocket send failed");
                break;
            }
        }
    });

    let mut sessions: HashMap<String, Session> = HashMap::new();

    while let Some(message) = ws_receiver.next().await {
        match message {
            Ok(Message::Text(text)) => {
                if let Err(err) = handle_client_text(&text, &outgoing_tx, &mut sessions) {
                    warn!(%err, "client message failed");
                    let _ = outgoing_tx.send(ServerMessage::Error {
                        session_id: None,
                        message: err.to_string(),
                    });
                }
            }
            Ok(Message::Binary(bytes)) => {
                warn!(
                    len = bytes.len(),
                    "binary websocket messages are not used yet"
                );
                let _ = outgoing_tx.send(ServerMessage::Error {
                    session_id: None,
                    message:
                        "binary websocket messages are not supported yet; send JSON text messages"
                            .to_string(),
                });
            }
            Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => {}
            Ok(Message::Close(_)) => break,
            Err(err) => {
                debug!(%err, "websocket receive failed");
                break;
            }
        }
    }

    info!(%peer_id, session_count = sessions.len(), "websocket disconnected; killing owned sessions");
    for (_, session) in sessions.drain() {
        session.kill();
    }

    drop(outgoing_tx);
    writer.abort();
}

fn handle_client_text(
    text: &str,
    outgoing: &mpsc::UnboundedSender<ServerMessage>,
    sessions: &mut HashMap<String, Session>,
) -> Result<()> {
    let message: ClientMessage = serde_json::from_str(text).context("invalid client JSON")?;

    match message {
        ClientMessage::Start {
            session_id,
            command,
            args,
            cwd,
            rows,
            cols,
        } => {
            if sessions.contains_key(&session_id) {
                return Err(anyhow!("session already exists: {session_id}"));
            }

            let session = Session::spawn(
                session_id.clone(),
                command,
                args.unwrap_or_default(),
                cwd,
                rows.unwrap_or(DEFAULT_ROWS),
                cols.unwrap_or(DEFAULT_COLS),
                outgoing.clone(),
            )?;

            sessions.insert(session_id.clone(), session);
            outgoing.send(ServerMessage::Started { session_id })?;
        }
        ClientMessage::Input {
            session_id,
            data_b64,
        } => {
            let session = sessions
                .get(&session_id)
                .ok_or_else(|| anyhow!("unknown session: {session_id}"))?;
            let bytes = BASE64
                .decode(data_b64.as_bytes())
                .context("invalid input data_b64")?;
            session.write_input(&bytes)?;
        }
        ClientMessage::Resize {
            session_id,
            rows,
            cols,
        } => {
            let session = sessions
                .get(&session_id)
                .ok_or_else(|| anyhow!("unknown session: {session_id}"))?;
            session.resize(rows, cols)?;
        }
        ClientMessage::Kill { session_id } => {
            let session = sessions
                .remove(&session_id)
                .ok_or_else(|| anyhow!("unknown session: {session_id}"))?;
            session.kill();
            outgoing.send(ServerMessage::Killed { session_id })?;
        }
    }

    Ok(())
}

struct Session {
    id: String,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
}

impl Session {
    #[allow(clippy::too_many_arguments)]
    fn spawn(
        id: String,
        command: Option<String>,
        args: Vec<String>,
        cwd: Option<String>,
        rows: u16,
        cols: u16,
        outgoing: mpsc::UnboundedSender<ServerMessage>,
    ) -> Result<Self> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("failed to open PTY")?;

        let command = command.unwrap_or_else(default_shell);
        let mut cmd = CommandBuilder::new(&command);
        for arg in args {
            cmd.arg(arg);
        }
        if let Some(cwd) = cwd {
            cmd.cwd(cwd);
        }

        info!(session_id = %id, %command, rows, cols, "starting PTY session");
        let child = pair
            .slave
            .spawn_command(cmd)
            .with_context(|| format!("failed to spawn command: {command}"))?;
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .context("failed to clone PTY reader")?;
        let writer = pair
            .master
            .take_writer()
            .context("failed to take PTY writer")?;

        let reader_session_id = id.clone();
        thread::Builder::new()
            .name(format!("pty-reader-{reader_session_id}"))
            .spawn(move || {
                let mut buffer = [0_u8; 8192];
                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(n) => {
                            let data_b64 = BASE64.encode(&buffer[..n]);
                            if outgoing
                                .send(ServerMessage::Output {
                                    session_id: reader_session_id.clone(),
                                    data_b64,
                                })
                                .is_err()
                            {
                                break;
                            }
                        }
                        Err(err) => {
                            let _ = outgoing.send(ServerMessage::Error {
                                session_id: Some(reader_session_id.clone()),
                                message: format!("PTY read failed: {err}"),
                            });
                            break;
                        }
                    }
                }

                let _ = outgoing.send(ServerMessage::Exit {
                    session_id: reader_session_id,
                    status: None,
                });
            })
            .context("failed to spawn PTY reader thread")?;

        Ok(Self {
            id,
            writer: Arc::new(Mutex::new(writer)),
            master: Arc::new(Mutex::new(pair.master)),
            child: Arc::new(Mutex::new(child)),
        })
    }

    fn write_input(&self, bytes: &[u8]) -> Result<()> {
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| anyhow!("PTY writer mutex poisoned"))?;
        writer
            .write_all(bytes)
            .context("failed to write PTY input")?;
        writer.flush().context("failed to flush PTY input")?;
        Ok(())
    }

    fn resize(&self, rows: u16, cols: u16) -> Result<()> {
        let master = self
            .master
            .lock()
            .map_err(|_| anyhow!("PTY master mutex poisoned"))?;
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("failed to resize PTY")?;
        Ok(())
    }

    fn kill(self) {
        match self.child.lock() {
            Ok(mut child) => {
                if let Err(err) = child.kill() {
                    debug!(session_id = %self.id, %err, "failed to kill child process");
                }
            }
            Err(_) => warn!(session_id = %self.id, "child mutex poisoned while killing session"),
        }
    }
}

fn default_shell() -> String {
    env::var("SHELL").unwrap_or_else(|_| "bash".to_string())
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMessage {
    Start {
        session_id: String,
        command: Option<String>,
        args: Option<Vec<String>>,
        cwd: Option<String>,
        rows: Option<u16>,
        cols: Option<u16>,
    },
    Input {
        session_id: String,
        data_b64: String,
    },
    Resize {
        session_id: String,
        rows: u16,
        cols: u16,
    },
    Kill {
        session_id: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ServerMessage {
    Started {
        session_id: String,
    },
    Output {
        session_id: String,
        data_b64: String,
    },
    Exit {
        session_id: String,
        status: Option<i32>,
    },
    Killed {
        session_id: String,
    },
    Error {
        session_id: Option<String>,
        message: String,
    },
}
