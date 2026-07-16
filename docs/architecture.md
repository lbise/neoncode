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
- routes workspace and pane-focus actions through a typed central command registry with enumerable palette-ready metadata;
- owns the active pane in a DOM-free focus model, remembers one pane per workspace, and restores xterm focus after workspace changes;
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

`session_list` includes additive hub-owned effective-command, configured-cwd, observed runtime-cwd, runtime Git state, persistence, attachment-count, incarnation, lifecycle, retained latest-exit, and latest notification/error metadata while remaining protocol v1 compatible with ID-only clients. `welcome.capabilities` advertises these additive features. Runtime cwd comes from bounded `/proc` inspection of the PTY foreground process group/same-session descendants rather than terminal parsing or shell injection. A two-worker hub cache probes that cwd with direct, timeout/output-bounded, environment-sanitized Git commands and exposes branch/detached/dirty state without blocking WebSocket listing. Attach supports incarnation-aware output cursors and returns an atomic bounded-replay checkpoint manifest.

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

frontends/electron/main.ts          Electron main process, lifecycle, and state persistence
frontends/electron/config-store.ts  versioned config/state validation, migration, recovery, atomic IO
frontends/electron/token-loader.ts  validated environment/WSL hub capability loading
frontends/electron/preload.ts       narrow context-isolated desktop bridge
frontends/electron/renderer.ts      typed browser-bundle bootstrap entrypoint
frontends/electron/renderer/        strict TypeScript renderer modules:
  app.ts                            typed app/bootstrap and pane grid orchestration
  command-registry.ts               stable command IDs, handlers, and enumerable metadata
  keybinding-router.ts              pure exact-match default shortcut resolver
  layout-model.ts                   pure validated frontend tab/split tree and operations
  pane-focus-model.ts               DOM-free ordered pane focus/memory model
  hub-client.ts                     typed WebSocket protocol client and validators
  session-model.ts                  typed pane/session state and bounded output view
  terminal-pane.ts                  typed xterm.js pane, input, resize, and output handling
  reconnect-policy.ts               typed reconnect timing and activation fallback
  test-api.ts                       typed test-mode structured renderer API
  globals.d.ts                      context-isolated desktop, public-state, and test globals
frontends/electron/shared/types.ts  shared protocol and renderer-state contracts
frontends/electron/tsconfig.*.json  strict Node, renderer, and test compiler boundaries
frontends/electron/dist/            ignored generated CommonJS and renderer bundle
frontends/electron/tests/           strict TypeScript unit/fake-hub and Playwright tests
scripts/electron-app.ps1            npm ci, strict build, Windows publish/start
scripts/electron-test.ps1           Windows wrapper for Playwright tests
```

The Electron frontend uses strict TypeScript throughout without a runtime TypeScript loader. Separate Node, DOM renderer, and test compiler projects all disable `allowJs`; generated CommonJS and the esbuild browser bundle live only under ignored `dist/`. Electron and every test execute generated artifacts rather than source files.

## Renderer command and focus boundary

Current cockpit commands have stable IDs: `workspace.open`, `workspace.next`, `workspace.previous`, `pane.focus`, `pane.next`, and `pane.previous`. Sidebar clicks, pane pointer/focus changes, keyboard shortcuts, and the typed test API all invoke the same registry handlers. Registry metadata supplies titles, categories, and contexts for a future command palette.

One document capture-phase `keydown` listener delegates to a DOM-free exact-match resolver. The only defaults are `Alt+Digit1..9` for the first nine configured workspaces, `F6` for the next pane, and `Shift+F6` for the previous pane. Already-prevented, Ctrl+Alt/AltGraph, extra-modifier, and unclaimed events are untouched. Claimed repeats are consumed without dispatching again. xterm's custom handler remains responsible for terminal copy/paste and special-key behavior.

The focus model owns ordered panes, wrapping, active workspace/pane identity, per-workspace pane memory, and deterministic first-pane fallback after removal. The DOM mirrors that state through active data/ARIA attributes and CSS; it does not infer focus ownership. `workspace.activePaneId` is part of structured renderer state.

## Frontend layout-state boundary

`renderer/layout-model.ts` now defines the DOM-free frontend layout vocabulary: a workspace has ordered tabs, each tab has one binary pane/split tree, and each pane leaf references a session key without becoming the backend session identity. IDs are caller-supplied rather than generated inside the model. Pure immutable operations validate add/rename/reorder/activate/close tab, focus/split/move/close pane, and clamped split-resize transitions; pane ordering is first-child/second-child depth-first. A deterministic helper converts a schema 4 configured session grid to one initial tab while retaining configured session keys.

App-owned state schema 3 stores validated layouts under `workspaceLayouts`, separately from configuration schema 4 and hub lifecycle state. The state boundary allows at most 16 workspace entries, 64 leaves total, 8 tabs and 8 panes per workspace, tree depth 8, and a 64 KiB state file. Electron main accepts layout saves only for a workspace in the current validated config, validates before merge, and persists through the existing backup plus atomic-rename path.

This commit is model and persistence groundwork only. The renderer still constructs and displays the existing configured grid, does not seed/restore `workspaceLayouts` at runtime, and does not call `saveWorkspaceLayout` yet. Tabs, free-form split DOM, and layout commands remain unchecked GUI work.

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

Bootstrap the stable Windows runtime once, or whenever the dependency lock changes:

```bash
./dev electron-bootstrap
./dev electron-runtime-status
```

Ordinary baseline iterations do not reinstall executable dependencies:

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
- exact command shortcut routing, active-pane wrap/focus, and Alt+Digit workspace selection;
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

The current Electron sidebar switches these configured workspaces, restores the active choice, and derives status from hub-owned effective command/configured launch cwd/attachment metadata plus frontend-observed pane lifecycle. It falls back to configured launch locations before a session exists. This is not yet live shell cwd/git metadata because configured launch cwd does not track later shell changes. The visible renderer layout is still the configured column grid. A persisted pure tab/split model now exists as unwired groundwork; free-form split DOM and external workspace files remain future work.

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
