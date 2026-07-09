use std::collections::HashMap;

use anyhow::{Context, Result, anyhow};
use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    response::IntoResponse,
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

use crate::{
    protocol::{ClientMessage, ServerMessage},
    session::Session,
};

const DEFAULT_ROWS: u16 = 24;
const DEFAULT_COLS: u16 = 80;

pub async fn ws_handler(ws: WebSocketUpgrade) -> impl IntoResponse {
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
