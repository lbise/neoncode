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
- start connection-scoped or persistent PTY sessions;
- send terminal input;
- stream terminal output through a session-owned event broadcaster;
- resize PTY;
- kill PTY session;
- maintain sessions in a shared in-process session registry;
- list active sessions with effective command, configured cwd, observed foreground-job cwd, bounded Git branch/dirty metadata, persistence, attachment count, retained latest-exit attention, and latest notification/error metadata;
- attach a WebSocket with bounded recent terminal-output replay followed by live events;
- detach a WebSocket from a session;
- require the Electron `file://` origin and a per-user capability challenge-response on WebSockets;
- enforce loopback-only binding and bounded connection/session resources;
- allow explicitly detached sessions to survive the creating WebSocket closing;
- kill still-owned sessions when their owning WebSocket disconnects;
- structured logging via `tracing` / `RUST_LOG`.

Current limitations:

- Electron panes automatically reconnect/attach with bounded exponential backoff; other clients still manage reconnect explicitly;
- output replay is bounded to 2 MiB per session and now has incarnation-aware cursor/checkpoint semantics, but remains raw terminal bytes rather than a canonical screen snapshot;
- the session registry is in-process only and does not persist across hub restarts;
- session IDs are currently frontend-provided;
- natural process exits report a typed reason and exit code when `portable-pty` provides one; signal-specific fidelity remains unavailable;
- latest exits are retained only in memory, bounded to 64 session IDs, and disappear on hub restart;
- terminal input/output is JSON text with base64 payloads, not binary frames;
- remote access is intentionally unsupported; the process refuses non-loopback bind addresses.

## Local security model

The current hub protects a local development service from browser cross-origin requests, accidental LAN exposure, and clients that cannot complete the capability exchange. Hostile native local processes—including processes under another local account that can bind/relay loopback traffic—are outside this prototype boundary. A non-relayable boundary requires pinned TLS, OS-protected IPC, or authenticated encryption of every message.

`./dev` creates a random 256-bit hexadecimal capability token at:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/neoncode/hub-token
```

The file is mode `0600`. The wrapper loads the same token for `./dev hub`, `./dev app`, `./dev electron`, and `./dev electron-test`, passing it to Windows Electron through the process environment. It is never copied into the published app directory, and the hub explicitly removes `NEONCODE_HUB_TOKEN` from every spawned PTY child environment. Rotate it and restart both processes with:

```bash
./dev reset-token
```

A WebSocket upgrade must provide:

```text
Origin: file://
Sec-WebSocket-Protocol: neoncode.v1
```

After upgrading, the server sends a fresh 256-bit `auth_challenge` nonce. The client sends its own fresh nonce plus `HMAC-SHA256(token, "client:" + server_nonce)`. The server verifies it and returns `HMAC-SHA256(token, "server:" + client_nonce)` in `authenticated`; the renderer verifies that proof before opening the protocol client. Authentication must finish within five seconds. The raw capability token is never sent over the socket, so an impostor cannot capture a reusable credential; however, the current plaintext channel does not prevent an active local relay from forwarding the complete exchange.

Origin validation is defense in depth rather than authentication: all local file renderers share the same origin, so the challenge-response remains required. The hub also caps authenticated/authenticating WebSockets at 128.

The `/health` endpoint is intentionally unauthenticated and returns no state. The hub refuses non-loopback bind addresses. A future hostile-multi-user or remote mode will require a non-relayable authenticated/encrypted design rather than relaxing these checks.

## Run

From the repository root in WSL/Linux:

```bash
./dev hub
```

Equivalent direct command after loading a valid token:

```bash
export NEONCODE_HUB_TOKEN="$(tr -d '\r\n' < "${XDG_STATE_HOME:-$HOME/.local/state}/neoncode/hub-token")"
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
RUST_LOG=trace ./dev hub
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

Main authenticated WebSocket endpoint for terminal control and data. Clients must use the required origin and subprotocol capability described above.

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

Current resource bounds:

- 64 KiB maximum WebSocket text message/frame;
- 32 KiB maximum decoded terminal input per message;
- 256 queued server messages per connection with asynchronous backpressure;
- 64 attached sessions per connection and 128 WebSockets per hub;
- 64 active PTY sessions/top-level child processes per hub (descendant containment is future work);
- 256 live session events plus at most 4,096 replay entries / 2 MiB raw replay data per session;
- 1–1,000 terminal rows/columns;
- restricted 1–128 byte session IDs, 128 arguments, and 4 KiB command/argument/cwd strings.

See [`protocol.md`](protocol.md) for exact JSON examples.

## Session lifecycle

### Start

Frontend sends `start` with a frontend-owned `session_id`. `persistent: true` keeps the session across unexpected WebSocket loss; omitted/false retains connection-scoped cleanup compatibility.

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

Frontend sends `list_sessions` to get active session IDs and hub-owned metadata from the in-process registry: effective command, configured launch cwd, observed runtime cwd, persistence, current attachment count, running/exited state, and retained latest exit. Arguments are not exposed because they may contain sensitive values. Runtime cwd is observed from the PTY foreground process group plus a bounded same-session descendant walk under `/proc`; terminal output and shell prompts are not parsed or modified. Transient observation failures retain the last known path as stale, and exited attention retains its final observation. The hub probes Git directly without a shell using sanitized environment variables, two fixed workers, a 64-job queue, two-second refresh/timeout bounds, and 64 KiB output caps. The frontend polls summaries at a bounded interval. Naturally exited PTYs are removed, but their latest exit metadata remains discoverable until acknowledged. IDs can be reused immediately; a running replacement retains the prior attention until explicit acknowledgement.

### Attach

Frontend sends `attach` with a `session_id` to subscribe the current WebSocket to that session. The registry records the authenticated connection as an attachment so later session lists report the count accurately.

The hub atomically captures a live broadcast receiver, replay bounds, session incarnation, and the session's bounded output history. It sends an `attached` checkpoint manifest, queues selected replay output in sequence order, and then forwards live events. Holding the same event-state lock while subscribing and snapshotting prevents gaps or duplicates at the replay/live boundary.

The replay buffer retains up to 2 MiB/4,096 raw-output chunks per session. A matching `instance_id`/`after_output_seq` cursor receives only missed output. Cursors older than retained history report truncation; mismatched incarnations or ahead cursors require renderer reset. Fresh/legacy attaches still receive full bounded replay. This restores normal shell history and prompts but is not a canonical terminal-screen snapshot; output older than the bound is discarded and arbitrary full-screen state cannot be reconstructed exactly.

### Detach

Frontend sends `detach` with a `session_id` to stop forwarding that session's events to the current WebSocket.

Detach removes the current connection from the session's attachment set. If the detaching WebSocket originally created the session, the hub also releases that session from the WebSocket lifetime and marks it persistent. Closing the WebSocket after detach will not kill that session.

### Exit attention

Natural exits retain a bounded latest record per session ID with nullable status and reason `process_exit` or `wait_failed`. Explicit kill does not create attention. A running replacement can coexist with its previous attention. `acknowledge_attention` compare-and-clears only the specified 32-hex attention generation and never kills the replacement; stale acknowledgements cannot clear a newer exit. At most 64 latest-exit records are retained in process memory; oldest records are evicted and hub restart clears them.

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

The registry removes the disconnected connection from every attachment set. Nonpersistent sessions still owned by that WebSocket are then removed from the shared registry and killed.

Persistent sessions and sessions explicitly detached before disconnect are left running, report zero/fewer attachments through `list_sessions`, and can be reattached with `attach`.

## CLI automation

`./dev cli` loads the managed hub token through the environment and performs the same mutual WebSocket authentication as Electron. It never places the token on the command line.

```bash
./dev cli status
./dev cli sessions
./dev cli notify shell info "Tests complete" "All checks passed"
```

`status` prints bounded aggregate counts, `sessions` emits authenticated JSON summaries, and `notify` publishes retained generation-safe workspace attention. Workspace open/switch commands remain future work.

## Manual smoke test

Start the hub:

```bash
./dev hub
```

Check health:

```bash
curl http://127.0.0.1:44777/health
```

If `websocat` is available, load the token and connect with the required origin/protocol:

```bash
export NEONCODE_HUB_TOKEN="$(tr -d '\r\n' < "${XDG_STATE_HOME:-$HOME/.local/state}/neoncode/hub-token")"
websocat -H='Origin: file://' --protocol neoncode.v1 ws://127.0.0.1:44777/ws
```

The first server message is `auth_challenge`. Compute the response over its hexadecimal nonce (as ASCII, not decoded bytes):

```bash
printf %s 'client:<server-nonce>' | openssl dgst -sha256 -mac HMAC \
  -macopt "hexkey:$NEONCODE_HUB_TOKEN"
```

Then send the resulting hexadecimal digest:

```json
{"type":"authenticate","client_nonce":"<fresh-64-hex-character-nonce>","hmac":"<digest>"}
```

Verify the `authenticated.hmac` digest over `server:<client_nonce>` before sending session messages.

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
