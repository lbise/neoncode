# NeonCode hub protocol

This is the current WebSocket protocol for `neoncode-hub`.
It is intentionally simple and optimized for getting Electron/xterm frontends talking to WSL/Linux PTYs quickly.

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

Override with:

```bash
NEONCODE_HUB_BIND=127.0.0.1:44777 cargo run -p neoncode-hub
```

## Framing

For the current prototype, all WebSocket messages are JSON text frames.
Terminal bytes are base64-encoded in `data_b64` fields.

This is not the final high-performance protocol. Later we can move terminal output/input to binary frames while keeping JSON for control messages.

The Rust protocol types live in:

```text
hub/src/protocol.rs
```

## Client messages

### Start a PTY session

```json
{
  "type": "start",
  "session_id": "shell-1",
  "command": "bash",
  "args": [],
  "cwd": "/home/me/src/project",
  "rows": 30,
  "cols": 120
}
```

Fields:

- `session_id`: frontend-owned ID, unique among active hub sessions for the current POC.
- `command`: executable to spawn. Defaults to `$SHELL`, then `bash`.
- `args`: optional argument list.
- `cwd`: optional working directory.
- `rows`, `cols`: optional terminal size. Defaults to `24x80`.

### List active sessions

```json
{
  "type": "list_sessions"
}
```

Returns `session_list` with active session IDs.

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
      "session_id": "shell-1"
    }
  ]
}
```

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

Equivalent direct command:

```bash
cargo run -p neoncode-hub
```

In another shell, if `websocat` is available:

```bash
websocat ws://127.0.0.1:44777/ws
```

Then send:

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
