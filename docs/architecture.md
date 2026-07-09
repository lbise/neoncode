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
- opens one WebSocket per pane/session for the current prototype;
- sends `start`, `input`, `resize`, and later attach/detach messages;
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
- exposes `/health` and `/ws`;
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

Current protocol is JSON over WebSocket with base64 terminal bytes.

Important current messages:

```text
Client: start, list_sessions, attach, detach, input, resize, kill
Server: started, session_list, attached, detached, output, exit, killed, error
```

This protocol is intentionally simple. Product work should evolve it toward:

- server welcome with protocol version and hub boot ID;
- stable session/workspace/machine IDs;
- ordered events with sequence numbers;
- snapshot + event resync;
- attach/detach/reconnect semantics;
- better exit/error reporting;
- launch profiles.

## Source layout

```text
hub/src/main.rs                    hub process setup, routes, logging, shutdown
hub/src/protocol.rs                JSON protocol types
hub/src/session.rs                 PTY lifecycle, IO, session events
hub/src/state.rs                   app state and session registry
hub/src/ws.rs                      WebSocket handling and protocol dispatch

frontends/electron/main.js          Electron main process
frontends/electron/renderer.js      renderer bootstrap entrypoint
frontends/electron/renderer/        renderer modules:
  app.js                            app/bootstrap and pane grid wiring
  hub-client.js                     WebSocket protocol client helpers
  session-model.js                  pane/session state mirrored to test state
  terminal-pane.js                  xterm.js pane, input, resize, output handling
frontends/electron/tests/           Playwright smoke tests
scripts/electron-app.ps1            Windows-local publish/start helper
scripts/electron-xterm-*-smoke.ps1 smoke/validation helpers
```

## Validation commands

Baseline:

```bash
./dev check
./dev publish
```

With `./dev hub` and a running app:

```bash
./dev electron-xterm-smoke -PaneIndex 1
./dev electron-xterm-smoke -PaneIndex 2
./dev electron-xterm-resize-smoke -PaneIndex 1
./dev electron-xterm-resize-smoke -PaneIndex 2
./dev electron-xterm-playwright-smoke
./dev electron-xterm-behavior-smoke -PaneIndex 1
./dev electron-xterm-behavior-smoke -PaneIndex 2
```

Currently validated:

- two panes;
- hub connect/start/output;
- typed input;
- paste input;
- duplicate paste suppression;
- resize propagation matching `stty size`;
- Playwright DOM/state/input smoke;
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
- detached sessions can survive a WebSocket closing;
- attach receives future output only, not replayed scrollback;
- reconnect is explicit, not automatic.

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
