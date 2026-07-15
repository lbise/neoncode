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
- renders 1–8 panes for the active configured workspace and opens one WebSocket per pane/session;
- switches named workspaces by detaching the old panes and attaching/starting the selected panes;
- restores the active workspace from app-owned state;
- summarizes hub-owned WSL launch metadata and aggregate pane lifecycle in the workspace sidebar, falling back to configured locations for sessions not yet created;
- displays and explicitly acknowledges retained exit attention without conflating it with a replacement session's running state;
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

`session_list` includes additive hub-owned effective-command, configured-cwd, persistence, attachment-count, incarnation, lifecycle, and retained latest-exit metadata while remaining protocol v1 compatible with ID-only clients. `welcome.capabilities` advertises these additive features. Attach supports incarnation-aware output cursors and returns an atomic bounded-replay checkpoint manifest.

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
frontends/electron/renderer.ts      typed browser-bundle bootstrap entrypoint
frontends/electron/renderer/        strict TypeScript renderer modules:
  app.ts                            typed app/bootstrap and pane grid orchestration
  hub-client.ts                     typed WebSocket protocol client and validators
  session-model.ts                  typed pane/session state and bounded output view
  terminal-pane.ts                  typed xterm.js pane, input, resize, and output handling
  reconnect-policy.ts               typed reconnect timing and activation fallback
  test-api.ts                       typed test-mode structured renderer API
  globals.d.ts                      context-isolated desktop, public-state, and test globals
frontends/electron/shared/types.ts  shared protocol and renderer-state contracts
frontends/electron/tsconfig.*.json  strict Node, renderer, and test compiler boundaries
frontends/electron/dist/            ignored generated CommonJS and renderer bundle
frontends/electron/tests/           Node config/auth tests and hidden-window Playwright tests
scripts/electron-app.ps1            npm ci, strict build, Windows publish/start
scripts/electron-test.ps1           Windows wrapper for Playwright tests
```

The Electron frontend is migrating incrementally to strict TypeScript without introducing a runtime TypeScript loader. Phase 2 completed the browser renderer migration and disabled `allowJs` for its strict DOM project. `tsc` still type-checks separate Node, renderer, and test projects; generated CommonJS and the esbuild browser bundle live only under ignored `dist/`. Remaining Node/preload/configuration and test JavaScript is copied through the applicable build projects so published Electron and all tests execute generated artifacts rather than a mixture of source and output files.

## Electron security boundary

The Electron renderer runs with:

```text
contextIsolation: true
nodeIntegration: false
sandbox: true
```

The browser-world renderer is bundled with `esbuild-wasm` and receives only a narrow preload API for validated bootstrap configuration (including the local hub capability), bounded clipboard reads/writes, and graceful-close coordination. The app applies a restrictive CSP and denies unexpected navigation, new windows, webviews, and permission requests.

Playwright asserts the effective BrowserWindow preferences, absence of renderer `process`/`require`, exact preload API keys, deeply frozen bootstrap configuration, denied window creation, and denied notification permission.

## Desktop configuration and state

Electron main exclusively owns `%APPDATA%\\NeonCode\\config.json` and `state.json`. Versioned strict validation produces a narrow bootstrap object containing the loopback endpoint, configured session IDs/titles, resolved process launch profiles, close policy, and diagnostics. The capability token remains environment-only.

Configuration schema 4 supports 1–16 named workspaces, 1–8 sessions per workspace (64 total), simple validated grid columns, named terminal appearance, and explicit process profiles (`command`, `args`, `cwd`). State schema 2 stores window content size and the active workspace. Normal close either detaches active panes or kills sessions visited by this app instance according to policy; runtime workspace switching always detaches. Hub sessions remain authoritative backend state. Writes use same-directory temporary files and atomic rename, and valid backups support visible recovery from malformed JSON.

See [configuration.md](configuration.md) for the schema and manual workflow.

## Hub security boundary

`./dev` manages a per-user 256-bit token in a mode-0600 WSL state file and passes it to the hub and Electron through process environments without copying it into publish output. The hub strips the token from PTY child environments. Electron WebSockets offer only `neoncode.v1`; the hub and renderer then exchange independent nonces and verify domain-separated HMAC-SHA256 proofs within five seconds. Renderer authentication/welcome deadlines close silent or half-authenticated transports, and late handshake traffic is connection guarded. The token never crosses the socket, so an impostor cannot capture a reusable bearer, although the plaintext channel does not resist an active local relay. The hub also requires `Origin: file://`, caps WebSocket connections, and rejects non-loopback bind addresses.

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
- Ctrl+C/D/Z and navigation/function keys;
- selection/copy and paste deduplication;
- interactive tmux and Neovim workflows;
- SGR mouse reporting plus tmux split/copy-mode and Neovim cursor/viewport mouse behavior;
- bounded heavy-output and reconnect/attach continuity.

Still needs validation/hardening:

- extended multi-minute output/performance soaking;
- long-session and repeated reconnect/replay stability;
- broader fake-hub timeout, protocol-error, and reconnect race coverage.

## Session model direction

Current prototype has working but incomplete session lifecycle:

- session IDs are frontend-provided;
- configured workspaces and sessions use stable frontend IDs instead of deriving identity from pane indexes;
- sessions live in an in-process hub registry;
- detached sessions survive normal Electron app close and can be reattached on the next launch;
- attach replays up to 2 MiB of ordered raw terminal output before live output continues; same-surface reconnect supplies its incarnation/sequence cursor and transfers only missed chunks;
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

A terminal pane should be an attachment/surface for a session, not the session identity itself. The checkpoint protocol makes incarnation changes and replay truncation explicit, but does not serialize xterm emulator state; canonical full-screen snapshotting remains future work.

## Workspace model

Configuration schema 4 describes desired sessions independently of UI runtime state:

```yaml
name: audio-fw
root: /home/me/src/audio-fw
sessions:
  - id: shell
    command: bash
  - id: tests
    command: ./andromeda test --hil
```

The current Electron sidebar switches these configured workspaces, restores the active choice, and derives status from hub-owned effective command/configured launch cwd/attachment metadata plus frontend-observed pane lifecycle. It falls back to configured launch locations before a session exists. This is not yet live shell cwd/git metadata because configured launch cwd does not track later shell changes. Layout is currently a simple column count; free-form splits and external workspace files remain future work.

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
