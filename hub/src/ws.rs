use anyhow::{Context, Result};
use axum::{
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    response::IntoResponse,
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use futures_util::{SinkExt, StreamExt};
use tokio::{
    sync::{broadcast, mpsc},
    task::JoinHandle,
};
use tracing::{debug, error, info, warn};

use crate::{
    protocol::{ClientMessage, ServerMessage},
    session::SessionEvent,
    state::{AppState, StartSessionRequest},
};

pub async fn ws_handler(State(state): State<AppState>, ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
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

    let mut session_forwarders = Vec::new();

    while let Some(message) = ws_receiver.next().await {
        match message {
            Ok(Message::Text(text)) => {
                match handle_client_text(&peer_id, &text, &outgoing_tx, &state) {
                    Ok(Some(forwarder)) => session_forwarders.push(forwarder),
                    Ok(None) => {}
                    Err(err) => {
                        warn!(%err, "client message failed");
                        let _ = outgoing_tx.send(ServerMessage::Error {
                            session_id: None,
                            message: err.to_string(),
                        });
                    }
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

    let killed_count = match state.registry().kill_sessions_for_connection(&peer_id) {
        Ok(count) => count,
        Err(err) => {
            warn!(%err, %peer_id, "failed to clean up websocket sessions");
            0
        }
    };
    info!(%peer_id, killed_count, "websocket disconnected; killed owned sessions");

    for forwarder in session_forwarders {
        forwarder.abort();
    }
    drop(outgoing_tx);
    writer.abort();
}

fn handle_client_text(
    connection_id: &str,
    text: &str,
    outgoing: &mpsc::UnboundedSender<ServerMessage>,
    state: &AppState,
) -> Result<Option<JoinHandle<()>>> {
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
            let events = state.registry().start_session(
                connection_id,
                StartSessionRequest {
                    session_id: session_id.clone(),
                    command,
                    args,
                    cwd,
                    rows,
                    cols,
                },
            )?;
            outgoing.send(ServerMessage::Started {
                session_id: session_id.clone(),
            })?;
            let forwarder = spawn_session_event_forwarder(session_id, events, outgoing.clone());
            Ok(Some(forwarder))
        }
        ClientMessage::Input {
            session_id,
            data_b64,
        } => {
            let bytes = BASE64
                .decode(data_b64.as_bytes())
                .context("invalid input data_b64")?;
            state.registry().write_input(&session_id, &bytes)?;
            Ok(None)
        }
        ClientMessage::Resize {
            session_id,
            rows,
            cols,
        } => {
            state.registry().resize(&session_id, rows, cols)?;
            Ok(None)
        }
        ClientMessage::Kill { session_id } => {
            state.registry().kill_session(&session_id)?;
            outgoing.send(ServerMessage::Killed { session_id })?;
            Ok(None)
        }
    }
}

fn spawn_session_event_forwarder(
    session_id: String,
    mut events: broadcast::Receiver<SessionEvent>,
    outgoing: mpsc::UnboundedSender<ServerMessage>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            let message = match events.recv().await {
                Ok(SessionEvent::Output { data_b64 }) => ServerMessage::Output {
                    session_id: session_id.clone(),
                    data_b64,
                },
                Ok(SessionEvent::Exit { status }) => ServerMessage::Exit {
                    session_id: session_id.clone(),
                    status,
                },
                Ok(SessionEvent::Error { message }) => ServerMessage::Error {
                    session_id: Some(session_id.clone()),
                    message,
                },
                Err(broadcast::error::RecvError::Lagged(count)) => ServerMessage::Error {
                    session_id: Some(session_id.clone()),
                    message: format!("session output lagged by {count} messages"),
                },
                Err(broadcast::error::RecvError::Closed) => break,
            };

            if outgoing.send(message).is_err() {
                break;
            }
        }
    })
}
