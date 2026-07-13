use std::{collections::HashMap, time::Duration};

use anyhow::{Context, Result, anyhow};
use axum::{
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{
        HeaderMap, StatusCode,
        header::{ORIGIN, SEC_WEBSOCKET_PROTOCOL},
    },
    response::{IntoResponse, Response},
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use futures_util::{SinkExt, StreamExt};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use tokio::{
    sync::{OwnedSemaphorePermit, broadcast, mpsc},
    task::JoinHandle,
    time::timeout,
};
use tracing::{debug, error, info, warn};

const APP_WEBSOCKET_PROTOCOL: &str = "neoncode.v1";
const AUTHENTICATION_TIMEOUT: Duration = Duration::from_secs(5);
const OUTGOING_MESSAGE_BUFFER: usize = 256;
const MAX_CLIENT_MESSAGE_BYTES: usize = 64 * 1024;
const MAX_INPUT_BYTES: usize = 32 * 1024;
const MAX_ATTACHMENTS_PER_CONNECTION: usize = 64;

use crate::{
    protocol::{ClientMessage, ServerMessage},
    session::{SessionEvent, SessionSubscription},
    state::{AppState, StartSessionRequest},
};

pub async fn ws_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let origin = headers.get(ORIGIN).and_then(|value| value.to_str().ok());
    if origin != Some("file://") {
        warn!(?origin, "rejected websocket origin");
        return (StatusCode::FORBIDDEN, "websocket origin is not allowed\n").into_response();
    }
    if !has_app_protocol(&headers) {
        warn!("rejected websocket without neoncode.v1 subprotocol");
        return (
            StatusCode::BAD_REQUEST,
            "websocket subprotocol is not supported\n",
        )
            .into_response();
    }
    let connection_permit = match state.try_acquire_websocket() {
        Ok(permit) => permit,
        Err(err) => {
            warn!(%err, "rejected websocket connection");
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                "websocket connection limit reached\n",
            )
                .into_response();
        }
    };

    ws.protocols([APP_WEBSOCKET_PROTOCOL])
        .max_message_size(MAX_CLIENT_MESSAGE_BYTES)
        .max_frame_size(MAX_CLIENT_MESSAGE_BYTES)
        .on_upgrade(move |socket| handle_socket(socket, state, connection_permit))
        .into_response()
}

fn has_app_protocol(headers: &HeaderMap) -> bool {
    headers
        .get(SEC_WEBSOCKET_PROTOCOL)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|protocols| {
            protocols
                .split(',')
                .map(str::trim)
                .any(|protocol| protocol == APP_WEBSOCKET_PROTOCOL)
        })
}

async fn authenticate_socket(socket: &mut WebSocket, capability_token: &str) -> Result<()> {
    let mut nonce_bytes = [0_u8; 32];
    getrandom::fill(&mut nonce_bytes).context("failed to generate authentication nonce")?;
    let nonce = hex::encode(nonce_bytes);
    send_direct(
        socket,
        &ServerMessage::AuthChallenge {
            nonce: nonce.clone(),
        },
    )
    .await?;

    let frame = timeout(AUTHENTICATION_TIMEOUT, socket.recv())
        .await
        .context("authentication timed out")?
        .ok_or_else(|| anyhow!("websocket closed during authentication"))?
        .context("failed to receive authentication response")?;
    let Message::Text(text) = frame else {
        return Err(anyhow!("authentication response must be a text message"));
    };
    let ClientMessage::Authenticate { client_nonce, hmac } =
        serde_json::from_str(&text).context("invalid authentication response")?
    else {
        return Err(anyhow!("first client message must authenticate"));
    };

    let key = hex::decode(capability_token).context("invalid configured capability token")?;
    let client_nonce_bytes =
        hex::decode(&client_nonce).context("invalid client authentication nonce")?;
    if client_nonce_bytes.len() != 32 {
        return Err(anyhow!("invalid client authentication nonce"));
    }
    let supplied_hmac = hex::decode(hmac).context("invalid authentication HMAC")?;
    let mut expected = Hmac::<Sha256>::new_from_slice(&key)
        .map_err(|_| anyhow!("invalid capability key length"))?;
    expected.update(b"client:");
    expected.update(nonce.as_bytes());
    expected
        .verify_slice(&supplied_hmac)
        .map_err(|_| anyhow!("invalid authentication HMAC"))?;

    let mut server_proof = Hmac::<Sha256>::new_from_slice(&key)
        .map_err(|_| anyhow!("invalid capability key length"))?;
    server_proof.update(b"server:");
    server_proof.update(client_nonce.as_bytes());
    send_direct(
        socket,
        &ServerMessage::Authenticated {
            hmac: hex::encode(server_proof.finalize().into_bytes()),
        },
    )
    .await
}

async fn send_direct(socket: &mut WebSocket, message: &ServerMessage) -> Result<()> {
    let payload = serde_json::to_string(message).context("failed to serialize server message")?;
    socket
        .send(Message::Text(payload.into()))
        .await
        .context("failed to send websocket message")
}

async fn handle_socket(
    mut socket: WebSocket,
    state: AppState,
    _connection_permit: OwnedSemaphorePermit,
) {
    let peer_id = format!("{:p}", &socket);
    if let Err(err) = authenticate_socket(&mut socket, state.capability_token()).await {
        warn!(%peer_id, %err, "websocket authentication failed");
        let _ = send_direct(
            &mut socket,
            &ServerMessage::Error {
                session_id: None,
                message: "websocket authentication failed".to_string(),
            },
        )
        .await;
        let _ = socket.send(Message::Close(None)).await;
        return;
    }
    info!(%peer_id, "websocket authenticated");

    let (mut ws_sender, mut ws_receiver) = socket.split();
    let (outgoing_tx, mut outgoing_rx) = mpsc::channel::<ServerMessage>(OUTGOING_MESSAGE_BUFFER);

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

    let mut session_forwarders = HashMap::new();

    while let Some(message) = ws_receiver.next().await {
        match message {
            Ok(Message::Text(text)) => {
                if text.len() > MAX_CLIENT_MESSAGE_BYTES {
                    warn!(len = text.len(), "client text message exceeded limit");
                    break;
                }
                if let Err(err) = handle_client_text(
                    &peer_id,
                    &text,
                    &outgoing_tx,
                    &state,
                    &mut session_forwarders,
                )
                .await
                {
                    warn!(%err, "client message failed");
                    let _ = outgoing_tx
                        .send(ServerMessage::Error {
                            session_id: session_id_from_client_text(&text),
                            message: err.to_string(),
                        })
                        .await;
                }
            }
            Ok(Message::Binary(bytes)) => {
                warn!(
                    len = bytes.len(),
                    "binary websocket messages are not used yet"
                );
                let _ = outgoing_tx
                    .send(ServerMessage::Error {
                        session_id: None,
                        message:
                            "binary websocket messages are not supported yet; send JSON text messages"
                                .to_string(),
                    })
                    .await;
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

    for (_, forwarder) in session_forwarders {
        forwarder.abort();
    }
    drop(outgoing_tx);
    writer.abort();
}

fn session_id_from_client_text(text: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()?
        .get("session_id")?
        .as_str()
        .filter(|session_id| session_id.len() <= 128)
        .map(str::to_string)
}

async fn handle_client_text(
    connection_id: &str,
    text: &str,
    outgoing: &mpsc::Sender<ServerMessage>,
    state: &AppState,
    session_forwarders: &mut HashMap<String, JoinHandle<()>>,
) -> Result<()> {
    let message: ClientMessage = serde_json::from_str(text).context("invalid client JSON")?;
    session_forwarders.retain(|_, forwarder| !forwarder.is_finished());

    match message {
        ClientMessage::Authenticate { .. } => {
            return Err(anyhow!("websocket is already authenticated"));
        }
        ClientMessage::Start {
            session_id,
            command,
            args,
            cwd,
            rows,
            cols,
        } => {
            if session_forwarders.len() >= MAX_ATTACHMENTS_PER_CONNECTION {
                return Err(anyhow!("connection attachment limit reached"));
            }
            let subscription = state.registry().start_session(
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
            outgoing
                .send(ServerMessage::Started {
                    session_id: session_id.clone(),
                })
                .await?;
            attach_subscription(session_id, subscription, outgoing, session_forwarders).await?;
        }
        ClientMessage::ListSessions => {
            let sessions = state.registry().list_sessions()?;
            outgoing
                .send(ServerMessage::SessionList { sessions })
                .await?;
        }
        ClientMessage::Attach { session_id } => {
            if session_forwarders.len() >= MAX_ATTACHMENTS_PER_CONNECTION {
                return Err(anyhow!("connection attachment limit reached"));
            }
            if session_forwarders.contains_key(&session_id) {
                return Err(anyhow!(
                    "session already attached on this websocket: {session_id}"
                ));
            }

            let subscription = state.registry().subscribe_session(&session_id)?;
            outgoing
                .send(ServerMessage::Attached {
                    session_id: session_id.clone(),
                })
                .await?;
            attach_subscription(session_id, subscription, outgoing, session_forwarders).await?;
        }
        ClientMessage::Detach { session_id } => {
            let forwarder = session_forwarders.remove(&session_id).ok_or_else(|| {
                anyhow!("session is not attached on this websocket: {session_id}")
            })?;
            forwarder.abort();
            state
                .registry()
                .release_owner_if_matches(&session_id, connection_id)?;
            outgoing
                .send(ServerMessage::Detached { session_id })
                .await?;
        }
        ClientMessage::Input {
            session_id,
            data_b64,
        } => {
            let bytes = BASE64
                .decode(data_b64.as_bytes())
                .context("invalid input data_b64")?;
            if bytes.len() > MAX_INPUT_BYTES {
                return Err(anyhow!("terminal input exceeds {MAX_INPUT_BYTES} bytes"));
            }
            state.registry().write_input(&session_id, &bytes)?;
        }
        ClientMessage::Resize {
            session_id,
            rows,
            cols,
        } => {
            state.registry().resize(&session_id, rows, cols)?;
        }
        ClientMessage::Kill { session_id } => {
            if let Some(forwarder) = session_forwarders.remove(&session_id) {
                forwarder.abort();
            }
            state.registry().kill_session(&session_id)?;
            outgoing.send(ServerMessage::Killed { session_id }).await?;
        }
    }

    Ok(())
}

async fn attach_subscription(
    session_id: String,
    subscription: SessionSubscription,
    outgoing: &mpsc::Sender<ServerMessage>,
    session_forwarders: &mut HashMap<String, JoinHandle<()>>,
) -> Result<()> {
    if session_forwarders.contains_key(&session_id) {
        return Err(anyhow!(
            "session already attached on this websocket: {session_id}"
        ));
    }

    for event in subscription.replay {
        outgoing
            .send(server_message_from_event(&session_id, event))
            .await?;
    }

    let forwarder =
        spawn_session_event_forwarder(session_id.clone(), subscription.events, outgoing.clone());
    session_forwarders.insert(session_id, forwarder);
    Ok(())
}

fn spawn_session_event_forwarder(
    session_id: String,
    mut events: broadcast::Receiver<SessionEvent>,
    outgoing: mpsc::Sender<ServerMessage>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            let (message, terminal) = match events.recv().await {
                Ok(event) => {
                    let terminal = matches!(event, SessionEvent::Exit { .. });
                    (server_message_from_event(&session_id, event), terminal)
                }
                Err(broadcast::error::RecvError::Lagged(count)) => (
                    ServerMessage::Error {
                        session_id: Some(session_id.clone()),
                        message: format!("session output lagged by {count} messages"),
                    },
                    false,
                ),
                Err(broadcast::error::RecvError::Closed) => break,
            };

            if outgoing.send(message).await.is_err() || terminal {
                break;
            }
        }
    })
}

fn server_message_from_event(session_id: &str, event: SessionEvent) -> ServerMessage {
    match event {
        SessionEvent::Output { seq, data_b64 } => ServerMessage::Output {
            session_id: session_id.to_string(),
            seq,
            data_b64,
        },
        SessionEvent::Exit { status } => ServerMessage::Exit {
            session_id: session_id.to_string(),
            status,
        },
        SessionEvent::Error { message } => ServerMessage::Error {
            session_id: Some(session_id.to_string()),
            message,
        },
    }
}
