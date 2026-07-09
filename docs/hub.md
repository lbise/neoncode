# NeonCode hub

`neoncode-hub` is the Rust backend process for NeonCode terminal sessions.

It runs on WSL/Linux today and exposes a small HTTP/WebSocket API that frontends use to create and control PTY sessions.

Current path:

```text
frontend/native terminal host
  ⇄ ws://127.0.0.1:44777/ws
neoncode-hub
  ⇄ portable-pty
PTY child process, usually bash in WSL/Linux
```

## Status

The hub is still a prototype service, but it is now the shared foundation for WPF, Electron, and future native coordinator work.

Current capabilities:

- health endpoint;
- WebSocket endpoint;
- start PTY session;
- send terminal input;
- stream terminal output;
- resize PTY;
- kill PTY session;
- kill all sessions owned by a WebSocket when that WebSocket disconnects;
- structured logging via `tracing` / `RUST_LOG`.

Current limitations:

- sessions are owned by a single WebSocket connection;
- no attach/detach/reconnect yet;
- no global session registry yet;
- session IDs are currently frontend-provided;
- exit status is currently usually `null`;
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

Legacy fallback is still accepted for now:

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
- session cleanup on disconnect.

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
input
resize
kill
```

Server messages:

```text
started
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

1. opens a PTY with requested/default rows and columns;
2. spawns the requested command or default shell;
3. starts a reader thread for PTY output;
4. emits `started`;
5. streams `output` messages.

Default shell resolution:

1. `$SHELL`;
2. `bash`.

Default size:

```text
24 rows x 80 columns
```

### Input

Frontend sends base64-encoded bytes with `input`.

The hub decodes the bytes and writes them to the PTY writer.

### Resize

Frontend sends `resize` with rows/columns.

The hub calls `portable-pty` resize with zero pixel dimensions for now.

### Kill

Frontend sends `kill` with `session_id`.

The hub removes the session, kills the child process, and emits `killed`.

### WebSocket disconnect

All sessions owned by that WebSocket are killed when the WebSocket disconnects.

This is intentional for the POC but will change when attach/detach/reconnect is implemented.

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

Kill:

```json
{"type":"kill","session_id":"shell"}
```

## Source layout

```text
hub/src/main.rs       process setup, routing, logging, shutdown
hub/src/protocol.rs   JSON protocol structs/enums
hub/src/session.rs    PTY session lifecycle and IO
hub/src/ws.rs         WebSocket handling and per-connection session map
```

## Development checks

From repo root:

```bash
cargo fmt --check
cargo check -p neoncode-hub
cargo clippy -p neoncode-hub --all-targets -- -D warnings
```

Or run the broader project check:

```bash
./dev check
```

## Near-term hub roadmap

Next hub work should focus on UI-independent session semantics:

- replace per-WebSocket-only sessions with a real session registry;
- decide whether session IDs are backend-generated or frontend-provided;
- add list sessions;
- add attach/detach/reconnect;
- report session exit status/reason;
- define launch profiles for local WSL shell, project shell, SSH, tmux attach/create, and custom commands;
- consider binary WebSocket frames for terminal data after semantics stabilize.
