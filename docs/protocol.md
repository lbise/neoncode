# NeonCode hub protocol

This is the current WebSocket protocol for `neoncode-hub`.
It is intentionally simple and optimized for getting Electron/xterm frontends talking to WSL/Linux PTYs quickly. Protocol v1 is extensible: clients must ignore unknown object fields. Additive response metadata does not require a version bump; incompatible semantics or required fields do.

For hub run commands, logging, lifecycle, and source layout, see [`hub.md`](hub.md).

## Endpoint

```text
GET /health
WS  /ws
```

Default bind address:

```text
127.0.0.1:44777
```

The process refuses non-loopback bind addresses. `NEONCODE_HUB_BIND` may select a different loopback address/port.

## WebSocket authorization

Every `/ws` upgrade must include:

```text
Origin: file://
Sec-WebSocket-Protocol: neoncode.v1
```

The hub responds with `Sec-WebSocket-Protocol: neoncode.v1`. Missing/foreign origins receive HTTP `403`, and a missing app subprotocol receives HTTP `400`.

Immediately after upgrade, the hub sends a fresh random `auth_challenge`. The client generates its own fresh nonce and computes `HMAC-SHA256(token_bytes, "client:" + server_nonce_ascii)`, then sends both in `authenticate`. The hub verifies it and returns `HMAC-SHA256(token_bytes, "server:" + client_nonce_ascii)` in `authenticated`; the client must verify that proof before sending operations. The hub rejects/closes connections whose first message is not valid authentication or which do not authenticate within five seconds. The token itself is never transmitted.

`./dev` creates and propagates the per-user token automatically. See [`hub.md`](hub.md) for the threat model and token lifecycle.

`GET /health` remains unauthenticated and returns only `ok`.

## Framing and limits

For the current prototype, all WebSocket messages are JSON text frames.
Terminal bytes are base64-encoded in `data_b64` fields.

Client text messages and frames are limited to 64 KiB. Decoded `input` data is limited to 32 KiB per message. Each WebSocket has a bounded 256-message server queue and may attach to at most 64 sessions. The hub permits at most 128 WebSockets and 64 active sessions/top-level PTY child processes; descendant process containment is not implemented yet. Oversized WebSocket messages are closed by the transport; semantic limit violations produce scoped `error` messages where possible.

This is not the final high-performance protocol. Later we can move terminal output/input to binary frames while keeping JSON for control messages.

The Rust protocol types live in:

```text
hub/src/protocol.rs
```

## Client messages

### Authenticate

Respond to the server's challenge before sending any session operation:

```json
{
  "type": "authenticate",
  "client_nonce": "<fresh-64-hex-character nonce>",
  "hmac": "<HMAC-SHA256 over client:<server_nonce>>"
}
```

### Start a PTY session

```json
{
  "type": "start",
  "session_id": "shell-1",
  "command": "bash",
  "args": [],
  "cwd": "/home/me/src/project",
  "rows": 30,
  "cols": 120,
  "persistent": true
}
```

Fields:

- `session_id`: frontend-owned ID, unique among active hub sessions; 1–128 ASCII letters, digits, `.`, `_`, or `-`.
- `command`: executable to spawn, at most 4 KiB. Defaults to `$SHELL`, then `bash`.
- `args`: optional argument list; at most 128 arguments and 4 KiB per argument.
- `cwd`: optional working directory, at most 4 KiB.
- `rows`, `cols`: optional terminal size in the range 1–1,000. Defaults to `24x80`.
- `persistent`: optional boolean, default `false`. Persistent sessions survive an unexpected creating-WebSocket disconnect; explicit `kill` still removes them.

### List active sessions

```json
{
  "type": "list_sessions"
}
```

Returns `session_list` with active session IDs plus hub-owned launch/lifecycle metadata.

### Attach to an existing session

```json
{
  "type": "attach",
  "session_id": "shell-1"
}
```

Subscribes this WebSocket to the session. The hub sends `attached`, replays its bounded recent terminal output in sequence order, and then forwards live output/exit/error events without a replay/live gap.

### Detach from a session

```json
{
  "type": "detach",
  "session_id": "shell-1"
}
```

Stops forwarding session events to this WebSocket.
If the detaching WebSocket created the session, the session is released from that WebSocket lifetime and can survive that WebSocket closing.

### Send terminal input

```json
{
  "type": "input",
  "session_id": "shell-1",
  "data_b64": "bHMgLWxhCg=="
}
```

### Resize terminal

```json
{
  "type": "resize",
  "session_id": "shell-1",
  "rows": 40,
  "cols": 140
}
```

### Kill terminal session

```json
{
  "type": "kill",
  "session_id": "shell-1"
}
```

## Server messages

### Authentication challenge

The first server message on every WebSocket:

```json
{
  "type": "auth_challenge",
  "nonce": "<64-hex-character random nonce>"
}
```

### Authenticated

```json
{
  "type": "authenticated",
  "hmac": "<HMAC-SHA256 over server:<client_nonce>>"
}
```

The client verifies this server proof, then waits for `welcome` before sending session operations.

### Welcome

```json
{
  "type": "welcome",
  "protocol_version": 1,
  "boot_id": "<64-hex-character hub boot identity>"
}
```

`boot_id` is stable for one hub process and changes after restart. Clients must reject unsupported protocol versions.

### Session started

```json
{
  "type": "started",
  "session_id": "shell-1"
}
```

### Session list

```json
{
  "type": "session_list",
  "sessions": [
    {
      "session_id": "shell-1",
      "command": "bash",
      "cwd": "/home/me/src/project",
      "persistent": true,
      "attachment_count": 0
    }
  ]
}
```

Summary fields:

- `session_id`: stable active-session ID.
- `command`: effective executable launched by the hub. Arguments are deliberately omitted because they can contain sensitive values.
- `cwd`: configured launch cwd, or `null` for the hub/default inherited cwd. It is not the shell's current working directory after launch.
- `persistent`: whether the session survives its creating connection disappearing.
- `attachment_count`: number of authenticated WebSocket connections currently forwarding this session. `start` counts as one attachment; `detach` and socket disconnect decrement it.

These four metadata fields are emitted as one atomic additive bundle within protocol v1. Updated clients accept legacy ID-only summaries and treat their metadata as unavailable, but reject partially populated bundles as malformed.

### Session attached

```json
{
  "type": "attached",
  "session_id": "shell-1"
}
```

### Session detached

```json
{
  "type": "detached",
  "session_id": "shell-1"
}
```

### Terminal output

```json
{
  "type": "output",
  "session_id": "shell-1",
  "seq": 42,
  "data_b64": "..."
}
```

`seq` is a monotonic per-session terminal-output sequence number. Replay may start above `1` when older output has been evicted from the bounded buffer. After replay, live output continues at the next sequence number.

### Session exited

```json
{
  "type": "exit",
  "session_id": "shell-1",
  "status": 0
}
```

`status` is the process exit code when available. It is `null` if the child wait operation cannot provide a status.

### Session killed

```json
{
  "type": "killed",
  "session_id": "shell-1"
}
```

### Error

```json
{
  "type": "error",
  "session_id": "shell-1",
  "message": "failed to resize PTY"
}
```

`session_id` identifies the requested session for session operations, including failed start/attach/detach/input/resize/kill requests. It is `null` for connection-level errors or messages without a session ID.

## Manual smoke test

Start the hub:

```bash
./dev hub
```

`./dev hub` creates/loads the local capability automatically. In another shell, if `websocat` is available:

```bash
export NEONCODE_HUB_TOKEN="$(tr -d '\r\n' < "${XDG_STATE_HOME:-$HOME/.local/state}/neoncode/hub-token")"
websocat -H='Origin: file://' --protocol neoncode.v1 ws://127.0.0.1:44777/ws
```

Complete the `auth_challenge` HMAC flow documented above, wait for `authenticated`, then send:

```json
{"type":"start","session_id":"shell","command":"bash","rows":24,"cols":80}
```

Send `echo hi` followed by enter:

```json
{"type":"input","session_id":"shell","data_b64":"ZWNobyBoaQo="}
```

List sessions:

```json
{"type":"list_sessions"}
```

Detach the session so it can survive this WebSocket closing:

```json
{"type":"detach","session_id":"shell"}
```

On a new WebSocket, attach it again:

```json
{"type":"attach","session_id":"shell"}
```
