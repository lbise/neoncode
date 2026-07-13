# NeonCode architecture

## Overview

Supported Windows architecture:

```text
Electron app
  -> xterm.js terminal panes
  -> WebSocket JSON protocol
  -> neoncode-hub (Rust, WSL/Linux)
  -> portable-pty
  -> shell/process/tmux/nvim/agents
```

The frontend owns presentation and layout. The hub owns session lifecycle and PTY/process state.

Previous Windows Terminal/WPF embedding POCs are obsolete and are not part of the supported product direction.

## Components

### Electron app

Source:

```text
frontends/electron/
```

Current role:

- default Windows app path;
- renders terminals with xterm.js;
- loads validated user configuration and app-owned state from `%APPDATA%\\NeonCode`;
- performs startup session discovery with `list_sessions`;
- opens one WebSocket per configured pane/session for the current prototype;
- attaches known sessions and starts missing sessions;
- sends `input`, `resize`, and acknowledgement-based `detach` before normal app close;
- provides smoke-test state for Playwright and PowerShell validation.

Run:

```bash
./dev app
```

Explicit commands:

```bash
./dev electron-publish
./dev electron
```

### neoncode-hub

Source:

```text
hub/
```

Current role:

- Rust backend process;
- runs in WSL/Linux today;
- exposes unauthenticated `/health` and authenticated `/ws` on loopback only;
- validates Electron `file://` origin and a per-user capability token;
- bounds WebSocket/session queues and session/process resources;
- starts PTYs through `portable-pty`;
- owns session registry;
- supports start/list/attach/detach/input/resize/kill;
- streams output through session-owned event broadcasters.

Run:

```bash
./dev hub
```

Detailed docs:

- [hub.md](hub.md)
- [protocol.md](protocol.md)

### Protocol

Current protocol is authenticated JSON over WebSocket with base64 terminal bytes. An authenticated `welcome` supplies protocol version 1 and a per-process hub `boot_id` before session operations begin.

Important current messages:

```text
Client: start, list_sessions, attach, detach, input, resize, kill
Server: started, session_list, attached, detached, output, exit, killed, error
```

This protocol is intentionally simple. Product work should evolve it toward:

- richer welcome/capability negotiation beyond the current version and boot ID;
- stable session/workspace/machine IDs;
- ordered events with sequence numbers;
- snapshot + event resync;
- attach/detach/reconnect semantics;
- better exit/error reporting;
- launch profiles.

## Source layout

```text
hub/src/main.rs                    hub process setup, logging, shutdown
hub/src/lib.rs                     reusable Axum application/router
hub/src/protocol.rs                JSON protocol types
hub/src/session.rs                 PTY lifecycle, IO, session events
hub/src/state.rs                   app state and session registry
hub/src/ws.rs                      WebSocket handling and protocol dispatch
hub/tests/                         real WebSocket and PTY integration tests

frontends/electron/main.js          Electron main process, lifecycle, and state persistence
frontends/electron/config-store.js  versioned config/state validation, migration, recovery, atomic IO
frontends/electron/preload.js       narrow context-isolated desktop bridge
frontends/electron/renderer.js      browser-bundle bootstrap entrypoint
frontends/electron/renderer/        renderer modules:
  app.js                            app/bootstrap and pane grid wiring
  hub-client.js                     WebSocket protocol client helpers
  session-model.js                  pane/session state and bounded output view
  terminal-pane.js                  xterm.js pane, input, resize, output handling
  test-api.js                       test-mode structured renderer API
frontends/electron/tests/           Node config/auth tests and hidden-window Playwright tests
scripts/electron-app.ps1            npm ci, renderer build, Windows publish/start
scripts/electron-test.ps1           Windows wrapper for Playwright tests
```

## Electron security boundary

The Electron renderer runs with:

```text
contextIsolation: true
nodeIntegration: false
sandbox: true
```

The browser-world renderer is bundled with `esbuild-wasm` and receives only a narrow preload API for validated bootstrap configuration (including the local hub capability), clipboard reads, and graceful-close coordination. The app applies a restrictive CSP and denies unexpected navigation, new windows, webviews, and permission requests.

Playwright asserts the effective BrowserWindow preferences, absence of renderer `process`/`require`, exact preload API keys, deeply frozen bootstrap configuration, denied window creation, and denied notification permission.

## Desktop configuration and state

Electron main exclusively owns `%APPDATA%\\NeonCode\\config.json` and `state.json`. Versioned strict validation produces a narrow bootstrap object containing the loopback endpoint, configured session IDs/titles, resolved process launch profiles, close policy, and diagnostics. The capability token remains environment-only.

Version 1 supports one/two static panes and explicit process profiles (`command`, `args`, `cwd`). Normal close either detaches or kills configured sessions according to policy. Window content size is app-owned state; hub sessions remain authoritative backend state. Writes use same-directory temporary files and atomic rename, and valid backups support visible recovery from malformed JSON.

See [configuration.md](configuration.md) for the schema and manual workflow.

## Hub security boundary

`./dev` manages a per-user 256-bit token in a mode-0600 WSL state file and passes it to the hub and Electron through process environments without copying it into publish output. The hub strips the token from PTY child environments. Electron WebSockets offer only `neoncode.v1`; the hub and renderer then exchange independent nonces and verify domain-separated HMAC-SHA256 proofs within five seconds. The token never crosses the socket, so an impostor cannot capture a reusable bearer, although the plaintext channel does not resist an active local relay. The hub also requires `Origin: file://`, caps WebSocket connections, and rejects non-loopback bind addresses.

This boundary protects against browser cross-origin access, accidental LAN exposure, and clients that cannot complete the capability exchange. Hostile native local processes/accounts capable of binding and relaying loopback traffic are out of scope. Hostile multi-user or remote access will require pinned TLS, OS-protected IPC, or per-message authenticated encryption.

## Validation commands

Baseline:

```bash
./dev check
./dev publish
```

With `./dev hub` running:

```bash
./dev electron-test
```

Currently validated:

- two panes;
- hub connect/start/output;
- typed input;
- paste input;
- duplicate paste suppression;
- resize propagation matching `stty size`;
- hidden-window Playwright DOM and structured renderer state;
- command execution in both panes without shell-echo false positives;
- paste normalization without global clipboard state;
- resize propagation matching `stty size` without foreground-window automation;
- Ctrl+C;
- tmux/nvim availability.

Still needs validation/hardening:

- deeper tmux behavior;
- deeper Neovim behavior;
- mouse mode;
- Ctrl+D / Ctrl+Z;
- copy/selection behavior;
- long output/performance soak;
- reconnect/attach frontend behavior.

## Session model direction

Current prototype has working but incomplete session lifecycle:

- session IDs are frontend-provided;
- the Electron app uses stable default frontend session keys (`shell`, `tasks`) instead of deriving session identity from pane indexes;
- sessions live in an in-process hub registry;
- detached sessions survive normal Electron app close and can be reattached on the next launch;
- attach replays up to 2 MiB of ordered raw terminal output before live output continues;
- startup reattach is automatic for stable configured session IDs and restores recent terminal output;
- panes automatically reconnect with bounded exponential backoff, attach persistent sessions first, and start a replacement after a hub reboot when attach reports the session missing.

Target direction:

```text
frontend starts
  -> connect to hub
  -> receive server.welcome { protocol_version, boot_id, snapshot }
  -> restore workspace layout
  -> list/attach existing sessions
  -> start missing launch-profile sessions
  -> consume ordered events
```

A terminal pane should be an attachment/surface for a session, not the session identity itself.

## Workspace direction

A future workspace should describe desired sessions/surfaces independently of UI runtime state:

```yaml
name: audio-fw
root: /home/me/src/audio-fw
sessions:
  - id: shell
    command: bash
  - id: tests
    command: ./andromeda test --hil
```

The hub should eventually own:

- launch profiles;
- session metadata;
- session status;
- attach/detach/reconnect;
- exit/error reporting;
- machine/remote runtime state.

The frontend should own:

- tabs/panes/splits;
- command palette;
- sidebar/status presentation;
- notifications/attention UI;
- browser/external surfaces.

## Remote direction

Near-term remote path:

```text
SSH launch profile + optional hidden tmux persistence
```

Long-term possible path:

```text
local neoncode-hub
  -> SSH transport
  -> neoncode-remote daemon
  -> persistent remote PTYs
```

Do not build the remote daemon before local/session/workspace semantics are solid.

## Design rules

- Do not use UI indexes as stable identities.
- Electron + xterm.js is the Windows product path.
- Prefer typed protocol events and explicit state over log scraping.
- Add trust prompts before running project-local commands.
- Do not store secrets in workspace files.
- Keep tmux optional and mostly hidden from the visible layout model.
