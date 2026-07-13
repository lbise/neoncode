# NeonCode hub

`neoncode-hub` is the Rust backend process for NeonCode terminal sessions.

It runs on WSL/Linux today and exposes a small HTTP/WebSocket API that frontends use to create and control PTY sessions.

Current path:

```text
Electron xterm.js frontend
  ⇄ ws://127.0.0.1:44777/ws
neoncode-hub WebSocket handler
  ⇄ in-process session registry
  ⇄ session-owned event broadcaster
  ⇄ portable-pty
PTY child process, usually bash in WSL/Linux
```

## Status

The hub is still a prototype service, but it is now the shared foundation for the Electron xterm.js app.

Current capabilities:

- health endpoint;
- WebSocket endpoint;
- start PTY session;
- send terminal input;
- stream terminal output through a session-owned event broadcaster;
- resize PTY;
- kill PTY session;
- maintain sessions in a shared in-process session registry;
- list active sessions;
- attach a WebSocket with bounded recent terminal-output replay followed by live events;
- detach a WebSocket from a session;
- allow explicitly detached sessions to survive the creating WebSocket closing;
- kill still-owned sessions when their owning WebSocket disconnects;
- structured logging via `tracing` / `RUST_LOG`.

Current limitations:

- reconnect is not automatic yet; clients must explicitly `list_sessions` and `attach`;
- output replay is bounded to 2 MiB per session and is raw terminal bytes, not a canonical screen snapshot;
- the session registry is in-process only and does not persist across hub restarts;
- session IDs are currently frontend-provided;
- natural process exits report an exit code when `portable-pty` provides one; `status` remains nullable for unavailable/error cases;
- terminal input/output is JSON text with base64 payloads, not binary frames;
- no authentication or remote access hardening yet; bind to loopback for now.

## Run

From the repository root in WSL/Linux:

```bash
./dev hub
```

Equivalent direct command:

```bash
cargo run -p neoncode-hub
```

Default bind address:

```text
127.0.0.1:44777
```

Override:

```bash
NEONCODE_HUB_BIND=127.0.0.1:44777 cargo run -p neoncode-hub
```

Legacy environment variable compatibility is still accepted for now:

```bash
WORKSPACE_HUB_BIND=127.0.0.1:44777 cargo run -p neoncode-hub
```

## Logging

Default log level is `info`.

Use `RUST_LOG` for more detail:

```bash
RUST_LOG=debug ./dev hub
```

Useful examples:

```bash
RUST_LOG=neoncode_hub=debug,tower_http=debug ./dev hub
RUST_LOG=trace cargo run -p neoncode-hub
```

The hub logs:

- bind/listen address;
- WebSocket connect/disconnect;
- PTY session start;
- protocol errors;
- PTY read/write/resize failures;
- session cleanup on disconnect;
- output broadcaster lag or missing-subscriber diagnostics.

## HTTP endpoints

### `GET /health`

Returns:

```text
ok
```

Example:

```bash
curl http://127.0.0.1:44777/health
```

### `WS /ws`

Main WebSocket endpoint for terminal control and data.

Protocol details live in [`protocol.md`](protocol.md).

## Protocol summary

All current WebSocket frames are JSON text frames.

Client messages:

```text
start
list_sessions
attach
detach
input
resize
kill
```

Server messages:

```text
started
session_list
attached
detached
output
exit
killed
error
```

Terminal bytes are base64-encoded in `data_b64` fields.

See [`protocol.md`](protocol.md) for exact JSON examples.

## Session lifecycle

### Start

Frontend sends `start` with a frontend-owned `session_id`.

The hub:

1. creates a session-owned event broadcaster and initial receiver before the child can emit output;
2. opens a PTY with requested/default rows and columns;
3. spawns the requested command or default shell;
4. starts a reader thread for PTY output and a waiter thread for process exit/reaping;
5. registers the new session in the shared in-process registry;
6. emits `started`;
7. forwards session events as `output`, `exit`, and `error` messages.

Default shell resolution:

1. `$SHELL`;
2. `bash`.

Default size:

```text
24 rows x 80 columns
```

### List

Frontend sends `list_sessions` to get active session IDs from the in-process registry. Naturally exited sessions are pruned and are not returned; their IDs can be reused.

### Attach

Frontend sends `attach` with a `session_id` to subscribe the current WebSocket to that session.

The hub atomically captures a live broadcast receiver and the session's bounded output history. It sends `attached`, queues replayed output in sequence order, and then forwards live events. Holding the same event-state lock while subscribing and snapshotting prevents gaps or duplicates at the replay/live boundary.

The replay buffer retains up to 2 MiB of raw terminal output per session. This restores normal shell history and prompts but is not a canonical terminal-screen snapshot; output older than the bound is discarded.

### Detach

Frontend sends `detach` with a `session_id` to stop forwarding that session's events to the current WebSocket.

If the detaching WebSocket originally created the session, the hub releases that session from the WebSocket lifetime. Closing the WebSocket after detach will not kill that session.

### Input

Frontend sends base64-encoded bytes with `input`.

The hub decodes the bytes and writes them to the PTY writer.

### Resize

Frontend sends `resize` with rows/columns.

The hub calls `portable-pty` resize with zero pixel dimensions for now.

### Kill

Frontend sends `kill` with `session_id`.

The hub removes the session, kills the child process, and emits `killed`.

### Output forwarding

PTY reader threads do not write directly to WebSocket channels anymore.

Instead, each session owns an internal broadcast channel:

```text
PTY reader/waiter threads
  → ordered SessionEvent::{Output, Exit, Error}
  → bounded per-session output replay + live broadcast
  → attached WebSocket forwarder task
  → ServerMessage::{output, exit, error}
```

The creating WebSocket subscribes automatically on `start`. Additional/new WebSockets can subscribe with `attach` and receive buffered output before live output continues.

### WebSocket disconnect

Sessions still owned by that WebSocket are removed from the shared registry and killed when the WebSocket disconnects.

Sessions explicitly detached before disconnect are left running in the registry and can be discovered with `list_sessions` and reattached with `attach`.

## Manual smoke test

Start the hub:

```bash
./dev hub
```

Check health:

```bash
curl http://127.0.0.1:44777/health
```

If `websocat` is available:

```bash
websocat ws://127.0.0.1:44777/ws
```

Start a shell:

```json
{"type":"start","session_id":"shell","command":"bash","rows":24,"cols":80}
```

Send `echo hi` followed by Enter:

```json
{"type":"input","session_id":"shell","data_b64":"ZWNobyBoaQo="}
```

Resize:

```json
{"type":"resize","session_id":"shell","rows":40,"cols":120}
```

Detach so the session can survive closing this WebSocket:

```json
{"type":"detach","session_id":"shell"}
```

On a new WebSocket, list and attach:

```json
{"type":"list_sessions"}
{"type":"attach","session_id":"shell"}
```

Kill:

```json
{"type":"kill","session_id":"shell"}
```

## Source layout

```text
hub/src/main.rs       process setup, logging, shutdown
hub/src/lib.rs        reusable Axum application/router
hub/src/protocol.rs   JSON protocol structs/enums
hub/src/session.rs    PTY session lifecycle, IO, and session event broadcasting
hub/src/state.rs      shared app state and in-process session registry
hub/src/ws.rs         WebSocket handling, protocol dispatch, and event forwarding
hub/tests/            real WebSocket and PTY integration tests
```

## Development checks

From repo root:

```bash
cargo fmt --check
cargo check -p neoncode-hub
cargo test -p neoncode-hub
cargo clippy -p neoncode-hub --all-targets -- -D warnings
```

Or run the broader project check:

```bash
./dev check
```

## Near-term hub roadmap

Next hub work should focus on UI-independent session semantics:

- decide whether session IDs are backend-generated or frontend-provided;
- add automatic reconnect semantics around the current explicit list/attach flow;
- report session exit status/reason;
- define launch profiles for local WSL shell, project shell, SSH, tmux attach/create, and custom commands;
- consider binary WebSocket frames for terminal data after semantics stabilize.
