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
  "session_id": "shell-1",
  "instance_id": "<optional 32-hex session incarnation>",
  "after_output_seq": 41
}
```

`instance_id` and `after_output_seq` must be supplied together or both omitted. With a matching cursor, the hub replays only output after that sequence. Omitting the cursor preserves legacy full bounded replay.

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

### Acknowledge retained exit attention

```json
{
  "type": "acknowledge_attention",
  "session_id": "shell-1",
  "attention_id": "<32-hex attention generation>"
}
```

Compare-and-clears the specified retained exit without affecting a running replacement or a newer exit. The hub responds with `attention_acknowledged`. Missing/already-cleared records acknowledge idempotently; a different current `attention_id` returns an error so a stale UI cannot clear newer attention.

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
  "boot_id": "<64-hex-character hub boot identity>",
  "capabilities": ["session_metadata", "session_exit_attention", "session_replay_checkpoint", "session_runtime_cwd", "session_runtime_git"]
}
```

`boot_id` is stable for one hub process and changes after restart. `capabilities` advertises additive protocol-v1 features; legacy hubs may omit it. Clients must reject unsupported protocol versions.

### Session started

```json
{
  "type": "started",
  "session_id": "shell-1",
  "instance_id": "<32-hex session incarnation>"
}
```

### Session list

```json
{
  "type": "session_list",
  "sessions": [
    {
      "session_id": "shell-1",
      "instance_id": "<32-hex session incarnation>",
      "command": "bash",
      "cwd": "/home/me/src/project",
      "runtime_cwd": {
        "path": "/home/me/src/project/subdirectory",
        "state": "current",
        "stale": false
      },
      "runtime_git": {
        "state": "repository",
        "branch": "main",
        "detached": false,
        "dirty": true,
        "stale": false
      },
      "persistent": true,
      "attachment_count": 0,
      "state": "running",
      "latest_exit": null
    }
  ]
}
```

Summary fields:

- `session_id`: stable configured session ID.
- `instance_id`: opaque identity for one process incarnation; changes when the same session ID starts a replacement.
- `command`: effective executable launched by the hub. Arguments are deliberately omitted because they can contain sensitive values.
- `cwd`: configured launch cwd, or `null` for the hub/default inherited cwd.
- `runtime_cwd`: authenticated hub observation of the PTY foreground job's Linux/WSL cwd. `state` is `current`, `deleted`, or `unavailable`; `path` is null only when unavailable. `stale` means the last successful observation is retained after a transient failure or exit. This independent additive field may be absent on legacy hubs.
- `runtime_git`: bounded hub probe of `runtime_cwd`. `state` is `pending`, `repository`, `not_repository`, or `unavailable`; repositories report either a branch or `detached: true`, plus tracked/untracked dirty state. Results are debounced, cached, limited to two Git workers, and retained as stale on transient failures or exit. This independent additive field may be absent on legacy hubs.
- `persistent`: whether the session survives its creating connection disappearing.
- `attachment_count`: number of authenticated WebSocket connections currently forwarding this session. `start` counts as one attachment; `detach` and socket disconnect decrement it.
- `state`: `running` for an active PTY or `exited` for a retained exit record.
- `latest_exit`: `null` or the latest bounded attention record `{ "attention_id": "<32-hex>", "status": 7, "reason": "process_exit" }`. A running replacement may retain an older non-null exit until acknowledgement.

The four launch/attachment fields and two lifecycle fields are emitted as atomic additive bundles within protocol v1; `instance_id`, `runtime_cwd`, and `runtime_git` are independent additive fields. Updated clients accept legacy ID-only summaries and treat absent metadata as unavailable, but reject partially populated bundles, malformed incarnation IDs, or invalid runtime cwd state/path combinations.

### Session attached

```json
{
  "type": "attached",
  "session_id": "shell-1",
  "instance_id": "<32-hex session incarnation>",
  "first_available_seq": 10,
  "replay_through_seq": 42,
  "replay_truncated": false,
  "reset_required": false
}
```

The manifest is captured atomically with the replay/live subscription:

- `first_available_seq`: oldest raw-output chunk still retained, or the next sequence when replay is empty.
- `replay_through_seq`: latest output included in the captured checkpoint.
- `replay_truncated`: the requested cursor predates retained history; replay starts at `first_available_seq` and the client must show that continuity is incomplete.
- `reset_required`: the supplied incarnation differs or its cursor is ahead; the client must reset terminal/sequence state before applying bounded replay.

`first_available_seq` must be at most `replay_through_seq + 1`; `replay_truncated` and `reset_required` are mutually exclusive. Updated clients reject malformed or contradictory manifests.

A matching cursor receives only missed chunks through `replay_through_seq`, followed by live output without a gap. This is a bounded raw-output checkpoint, **not** a canonical emulator/full-screen snapshot; replay can begin inside terminal control state and cannot exactly reconstruct arbitrary tmux/Neovim screens.

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
  "attention_id": "<32-hex attention generation>",
  "status": 0,
  "reason": "process_exit"
}
```

`status` is the process exit code when available. `reason` is `process_exit`, `wait_failed`, or `killed`. It is `null` when the child wait operation cannot provide a status. Portable-pty 0.8 does not expose portable signal fidelity, so NeonCode does not claim a signal-specific reason.

### Session killed

```json
{
  "type": "killed",
  "session_id": "shell-1"
}
```

### Attention acknowledged

```json
{
  "type": "attention_acknowledged",
  "session_id": "shell-1",
  "attention_id": "<32-hex attention generation>"
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
