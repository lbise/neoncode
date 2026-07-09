# NeonCode Hub POC Protocol

This is the temporary WebSocket protocol for `neoncode-hub`.
It is intentionally simple and optimized for getting native frontends talking to WSL/Linux PTYs quickly.

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

For the POC, all WebSocket messages are JSON text frames.
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

### Terminal output

```json
{
  "type": "output",
  "session_id": "shell-1",
  "data_b64": "..."
}
```

### Session exited

```json
{
  "type": "exit",
  "session_id": "shell-1",
  "status": null
}
```

`status` is currently usually `null`; exit-code tracking will be improved later.

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

`session_id` may be `null` for connection-level/protocol errors.

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
