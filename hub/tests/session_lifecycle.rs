use std::time::Duration;

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use futures_util::{SinkExt, StreamExt};
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;
use tokio::{
    net::TcpStream,
    task::JoinHandle,
    time::{Instant, sleep, timeout},
};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{
        Error as WebSocketError, Message,
        client::IntoClientRequest,
        http::{
            HeaderValue, StatusCode,
            header::{ORIGIN, SEC_WEBSOCKET_PROTOCOL},
        },
    },
};

type TestSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

const MESSAGE_TIMEOUT: Duration = Duration::from_secs(5);
const TEST_CAPABILITY_TOKEN: &str =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

struct TestHub {
    ws_url: String,
    server: JoinHandle<()>,
}

impl TestHub {
    async fn start() -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test hub");
        let address = listener.local_addr().expect("test hub address");
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                neoncode_hub::app(TEST_CAPABILITY_TOKEN.to_string()).expect("build test hub"),
            )
            .await
            .expect("serve test hub");
        });

        Self {
            ws_url: format!("ws://{address}/ws"),
            server,
        }
    }

    async fn connect(&self) -> TestSocket {
        let mut socket = self
            .connect_with_origin(Some("file://"))
            .await
            .expect("connect to test hub");
        let response = authenticate(&mut socket, TEST_CAPABILITY_TOKEN).await;
        assert_eq!(response["type"], "authenticated");
        let welcome = next_json_before(&mut socket, Instant::now() + MESSAGE_TIMEOUT).await;
        assert_eq!(welcome["type"], "welcome");
        assert_eq!(welcome["protocol_version"], 1);
        assert_eq!(welcome["boot_id"].as_str().unwrap().len(), 64);
        socket
    }

    async fn connect_with_origin(
        &self,
        origin: Option<&str>,
    ) -> Result<TestSocket, WebSocketError> {
        let mut request = self.ws_url.as_str().into_client_request()?;
        if let Some(origin) = origin {
            request.headers_mut().insert(
                ORIGIN,
                HeaderValue::from_str(origin).expect("valid test origin"),
            );
        }
        request.headers_mut().insert(
            SEC_WEBSOCKET_PROTOCOL,
            HeaderValue::from_static("neoncode.v1"),
        );
        connect_async(request).await.map(|(socket, response)| {
            assert_eq!(
                response
                    .headers()
                    .get(SEC_WEBSOCKET_PROTOCOL)
                    .and_then(|value| value.to_str().ok()),
                Some("neoncode.v1")
            );
            socket
        })
    }
}

impl Drop for TestHub {
    fn drop(&mut self) {
        self.server.abort();
    }
}

async fn send_json(socket: &mut TestSocket, message: Value) {
    socket
        .send(Message::Text(message.to_string().into()))
        .await
        .expect("send WebSocket JSON");
}

async fn next_json_before(socket: &mut TestSocket, deadline: Instant) -> Value {
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let frame = timeout(remaining, socket.next())
            .await
            .expect("timed out waiting for WebSocket message")
            .expect("WebSocket closed before expected message")
            .expect("WebSocket receive failed");

        match frame {
            Message::Text(text) => {
                return serde_json::from_str(text.as_ref()).expect("valid server JSON");
            }
            Message::Ping(payload) => {
                socket
                    .send(Message::Pong(payload))
                    .await
                    .expect("send WebSocket pong");
            }
            Message::Close(frame) => panic!("WebSocket closed unexpectedly: {frame:?}"),
            _ => {}
        }
    }
}

async fn authenticate(socket: &mut TestSocket, capability_token: &str) -> Value {
    let challenge = next_json_before(socket, Instant::now() + MESSAGE_TIMEOUT).await;
    assert_eq!(challenge["type"], "auth_challenge");
    let nonce = challenge["nonce"].as_str().expect("authentication nonce");
    let key = hex::decode(capability_token).expect("valid test capability");
    let client_nonce = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
    let mut hmac = Hmac::<Sha256>::new_from_slice(&key).expect("valid HMAC key");
    hmac.update(b"client:");
    hmac.update(nonce.as_bytes());
    send_json(
        socket,
        json!({
            "type": "authenticate",
            "client_nonce": client_nonce,
            "hmac": hex::encode(hmac.finalize().into_bytes())
        }),
    )
    .await;
    let response = next_json_before(socket, Instant::now() + MESSAGE_TIMEOUT).await;
    if response["type"] == "authenticated" {
        let supplied_proof = hex::decode(response["hmac"].as_str().expect("server proof"))
            .expect("valid server proof hex");
        let mut expected_proof = Hmac::<Sha256>::new_from_slice(&key).expect("valid HMAC key");
        expected_proof.update(b"server:");
        expected_proof.update(client_nonce.as_bytes());
        expected_proof
            .verify_slice(&supplied_proof)
            .expect("valid server authentication proof");
    }
    response
}

async fn wait_for_type(socket: &mut TestSocket, message_type: &str) -> Value {
    let deadline = Instant::now() + MESSAGE_TIMEOUT;
    loop {
        let message = next_json_before(socket, deadline).await;
        if message["type"] == message_type {
            return message;
        }
        assert_ne!(message["type"], "error", "unexpected hub error: {message}");
    }
}

async fn wait_for_session_type(
    socket: &mut TestSocket,
    message_type: &str,
    session_id: &str,
) -> Value {
    let deadline = Instant::now() + MESSAGE_TIMEOUT;
    loop {
        let message = next_json_before(socket, deadline).await;
        if message["type"] == message_type && message["session_id"] == session_id {
            return message;
        }
        assert_ne!(message["type"], "error", "unexpected hub error: {message}");
    }
}

async fn wait_for_output(socket: &mut TestSocket, session_id: &str, expected: &str) {
    let deadline = Instant::now() + MESSAGE_TIMEOUT;
    let mut output = String::new();

    loop {
        let message = next_json_before(socket, deadline).await;
        match message["type"].as_str() {
            Some("output") if message["session_id"] == session_id => {
                let bytes = BASE64
                    .decode(message["data_b64"].as_str().expect("output data_b64"))
                    .expect("valid output base64");
                output.push_str(&String::from_utf8_lossy(&bytes));
                if output.contains(expected) {
                    return;
                }
            }
            Some("exit") if message["session_id"] == session_id => {
                panic!("session exited before expected output {expected:?}; output={output:?}");
            }
            Some("error") => panic!("unexpected hub error: {message}"),
            _ => {}
        }
    }
}

async fn list_session_ids(socket: &mut TestSocket) -> Vec<String> {
    send_json(socket, json!({ "type": "list_sessions" })).await;
    let message = wait_for_type(socket, "session_list").await;
    message["sessions"]
        .as_array()
        .expect("sessions array")
        .iter()
        .map(|session| {
            session["session_id"]
                .as_str()
                .expect("session_id string")
                .to_string()
        })
        .collect()
}

async fn start_shell(socket: &mut TestSocket, session_id: &str) {
    send_json(
        socket,
        json!({
            "type": "start",
            "session_id": session_id,
            "command": "sh",
            "rows": 24,
            "cols": 80
        }),
    )
    .await;
    wait_for_session_type(socket, "started", session_id).await;
}

async fn start_persistent_shell(socket: &mut TestSocket, session_id: &str) {
    send_json(
        socket,
        json!({
            "type": "start",
            "session_id": session_id,
            "command": "sh",
            "rows": 24,
            "cols": 80,
            "persistent": true
        }),
    )
    .await;
    wait_for_session_type(socket, "started", session_id).await;
}

async fn send_input(socket: &mut TestSocket, session_id: &str, input: &str) {
    send_json(
        socket,
        json!({
            "type": "input",
            "session_id": session_id,
            "data_b64": BASE64.encode(input.as_bytes())
        }),
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn websocket_origin_must_be_the_electron_file_origin() {
    let hub = TestHub::start().await;

    for origin in [None, Some("https://evil.example")] {
        let error = hub
            .connect_with_origin(origin)
            .await
            .expect_err("unauthorized origin unexpectedly connected");
        match error {
            WebSocketError::Http(response) => {
                assert_eq!(response.status(), StatusCode::FORBIDDEN);
            }
            other => panic!("expected HTTP rejection, got {other:?}"),
        }
    }

    let mut authorized = hub.connect().await;
    assert!(list_session_ids(&mut authorized).await.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn websocket_requires_the_capability_token() {
    let hub = TestHub::start().await;
    let wrong_token = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

    let mut missing = hub
        .connect_with_origin(Some("file://"))
        .await
        .expect("connect without authenticating");
    let challenge = next_json_before(&mut missing, Instant::now() + MESSAGE_TIMEOUT).await;
    assert_eq!(challenge["type"], "auth_challenge");
    send_json(&mut missing, json!({ "type": "list_sessions" })).await;
    let missing_error = next_json_before(&mut missing, Instant::now() + MESSAGE_TIMEOUT).await;
    assert_eq!(missing_error["type"], "error");
    assert!(
        missing_error["message"]
            .as_str()
            .unwrap()
            .contains("authentication")
    );

    let mut incorrect = hub
        .connect_with_origin(Some("file://"))
        .await
        .expect("connect with incorrect capability");
    let incorrect_error = authenticate(&mut incorrect, wrong_token).await;
    assert_eq!(incorrect_error["type"], "error");
    assert!(
        incorrect_error["message"]
            .as_str()
            .unwrap()
            .contains("authentication")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn oversized_websocket_message_closes_the_connection() {
    let hub = TestHub::start().await;
    let mut socket = hub.connect().await;
    socket
        .send(Message::Text("x".repeat(64 * 1024 + 1).into()))
        .await
        .expect("send oversized test message");

    let result = timeout(MESSAGE_TIMEOUT, socket.next())
        .await
        .expect("timed out waiting for oversized-message disconnect");
    assert!(
        matches!(result, None | Some(Err(_)) | Some(Ok(Message::Close(_)))),
        "oversized message did not close the connection: {result:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn session_operation_errors_include_the_session_id() {
    let hub = TestHub::start().await;
    let mut socket = hub.connect().await;

    send_json(
        &mut socket,
        json!({ "type": "attach", "session_id": "missing-session" }),
    )
    .await;
    let attach_error = wait_for_type(&mut socket, "error").await;
    assert_eq!(attach_error["session_id"], "missing-session");

    let session_id = "duplicate-start";
    start_shell(&mut socket, session_id).await;
    send_json(
        &mut socket,
        json!({
            "type": "start",
            "session_id": session_id,
            "command": "sh",
            "rows": 24,
            "cols": 80
        }),
    )
    .await;
    let start_error = wait_for_type(&mut socket, "error").await;
    assert_eq!(start_error["session_id"], session_id);

    send_json(
        &mut socket,
        json!({
            "type": "start",
            "session_id": "../invalid",
            "command": "sh"
        }),
    )
    .await;
    let invalid_id_error = wait_for_type(&mut socket, "error").await;
    assert_eq!(invalid_id_error["session_id"], "../invalid");
    assert!(
        invalid_id_error["message"]
            .as_str()
            .unwrap()
            .contains("session_id")
    );

    let overlong_session_id = "x".repeat(129);
    send_json(
        &mut socket,
        json!({ "type": "attach", "session_id": overlong_session_id }),
    )
    .await;
    let overlong_id_error = wait_for_type(&mut socket, "error").await;
    assert!(overlong_id_error["session_id"].is_null());
    assert!(
        overlong_id_error["message"]
            .as_str()
            .unwrap()
            .contains("session_id")
    );

    send_json(
        &mut socket,
        json!({
            "type": "resize",
            "session_id": session_id,
            "rows": 0,
            "cols": 80
        }),
    )
    .await;
    let resize_error = wait_for_type(&mut socket, "error").await;
    assert_eq!(resize_error["session_id"], session_id);
    assert!(
        resize_error["message"]
            .as_str()
            .unwrap()
            .contains("terminal size")
    );

    let oversized_input = vec![b'x'; 32 * 1024 + 1];
    send_json(
        &mut socket,
        json!({
            "type": "input",
            "session_id": session_id,
            "data_b64": BASE64.encode(oversized_input)
        }),
    )
    .await;
    let input_error = wait_for_type(&mut socket, "error").await;
    assert_eq!(input_error["session_id"], session_id);
    assert!(
        input_error["message"]
            .as_str()
            .unwrap()
            .contains("input exceeds")
    );

    send_json(
        &mut socket,
        json!({ "type": "kill", "session_id": session_id }),
    )
    .await;
    wait_for_session_type(&mut socket, "killed", session_id).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fast_command_preserves_output_reports_exit_and_reuses_id() {
    let hub = TestHub::start().await;
    let mut socket = hub.connect().await;
    let session_id = "fast-command";

    send_json(
        &mut socket,
        json!({
            "type": "start",
            "session_id": session_id,
            "command": "sh",
            "args": ["-c", "printf 'fast-output'; exit 7"],
            "rows": 24,
            "cols": 80
        }),
    )
    .await;

    let deadline = Instant::now() + MESSAGE_TIMEOUT;
    let mut output = String::new();
    let mut exit_status = None;
    while !output.contains("fast-output") || exit_status.is_none() {
        let message = next_json_before(&mut socket, deadline).await;
        match message["type"].as_str() {
            Some("output") if message["session_id"] == session_id => {
                let bytes = BASE64
                    .decode(message["data_b64"].as_str().expect("output data_b64"))
                    .expect("valid output base64");
                output.push_str(&String::from_utf8_lossy(&bytes));
            }
            Some("exit") if message["session_id"] == session_id => {
                exit_status = message["status"].as_i64();
            }
            Some("error") => panic!("unexpected hub error: {message}"),
            _ => {}
        }
    }

    assert_eq!(exit_status, Some(7));
    assert!(
        !list_session_ids(&mut socket)
            .await
            .contains(&session_id.to_string())
    );

    send_json(
        &mut socket,
        json!({
            "type": "start",
            "session_id": session_id,
            "command": "sh",
            "args": ["-c", "printf 'reused-id'"],
            "rows": 24,
            "cols": 80
        }),
    )
    .await;
    wait_for_session_type(&mut socket, "started", session_id).await;
    wait_for_output(&mut socket, session_id, "reused-id").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn persistent_session_survives_unexpected_websocket_disconnect() {
    let hub = TestHub::start().await;
    let session_id = "persistent-disconnect";
    let mut owner = hub.connect().await;
    start_persistent_shell(&mut owner, session_id).await;
    send_input(
        &mut owner,
        session_id,
        "PERSIST_VALUE=still-here; printf 'persistent-seeded\\n'\n",
    )
    .await;
    wait_for_output(&mut owner, session_id, "persistent-seeded").await;
    owner.close(None).await.expect("close persistent owner");

    let mut attached = hub.connect().await;
    let deadline = Instant::now() + MESSAGE_TIMEOUT;
    loop {
        if list_session_ids(&mut attached)
            .await
            .contains(&session_id.to_string())
        {
            break;
        }
        assert!(Instant::now() < deadline, "persistent session disappeared");
        sleep(Duration::from_millis(25)).await;
    }
    send_json(
        &mut attached,
        json!({ "type": "attach", "session_id": session_id }),
    )
    .await;
    wait_for_session_type(&mut attached, "attached", session_id).await;
    send_input(
        &mut attached,
        session_id,
        "printf 'persistent-%s\\n' \"$PERSIST_VALUE\"\n",
    )
    .await;
    wait_for_output(&mut attached, session_id, "persistent-still-here").await;
    send_json(
        &mut attached,
        json!({ "type": "kill", "session_id": session_id }),
    )
    .await;
    wait_for_session_type(&mut attached, "killed", session_id).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn owned_session_is_removed_when_its_websocket_disconnects() {
    let hub = TestHub::start().await;
    let session_id = "owned-disconnect";
    let mut owner = hub.connect().await;
    start_shell(&mut owner, session_id).await;
    owner.close(None).await.expect("close owner WebSocket");

    let mut observer = hub.connect().await;
    for _ in 0..40 {
        if !list_session_ids(&mut observer)
            .await
            .contains(&session_id.to_string())
        {
            return;
        }
        sleep(Duration::from_millis(25)).await;
    }

    panic!("owned session remained after owner WebSocket disconnected");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn detached_session_survives_disconnect_and_can_be_attached() {
    let hub = TestHub::start().await;
    let session_id = "detach-reattach";
    let mut owner = hub.connect().await;
    start_shell(&mut owner, session_id).await;

    send_json(
        &mut owner,
        json!({ "type": "detach", "session_id": session_id }),
    )
    .await;
    wait_for_session_type(&mut owner, "detached", session_id).await;
    send_input(&mut owner, session_id, "printf 'buffered-%s\\n' 'output'\n").await;
    sleep(Duration::from_millis(100)).await;
    owner.close(None).await.expect("close detached owner");

    let mut attached = hub.connect().await;
    assert!(
        list_session_ids(&mut attached)
            .await
            .contains(&session_id.to_string())
    );

    send_json(
        &mut attached,
        json!({ "type": "attach", "session_id": session_id }),
    )
    .await;
    wait_for_session_type(&mut attached, "attached", session_id).await;
    wait_for_output(&mut attached, session_id, "buffered-output").await;

    send_json(
        &mut attached,
        json!({
            "type": "resize",
            "session_id": session_id,
            "rows": 41,
            "cols": 97
        }),
    )
    .await;
    send_input(
        &mut attached,
        session_id,
        "printf 'size-%s\\n' \"$(stty size | tr ' ' x)\"\n",
    )
    .await;
    wait_for_output(&mut attached, session_id, "size-41x97").await;

    send_input(
        &mut attached,
        session_id,
        "printf 'reattach-%s\\n' 'works'\n",
    )
    .await;
    wait_for_output(&mut attached, session_id, "reattach-works").await;

    send_json(
        &mut attached,
        json!({ "type": "kill", "session_id": session_id }),
    )
    .await;
    wait_for_session_type(&mut attached, "killed", session_id).await;
}
