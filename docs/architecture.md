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
- manages the default loopback WSL hub lifecycle for packaged alpha builds when `/health` is not already healthy;
- performs startup session discovery with `list_sessions`;
- restores and reconciles a separately persisted tab/split layout for every configured workspace;
- renders only the active tab's 1–8 pane leaves and opens one WebSocket per visible pane/session;
- switches workspaces and tabs by serially detaching old visible panes, then attaching/starting the selected leaves with replay;
- restores the active workspace, active tab, and authoritative focused pane from app-owned state;
- routes workspace, tab, pane split/resize/close/lifecycle/focus, palette, Settings, and attention-dismissal actions through a typed central command registry;
- renders an accessible command palette for catalog operations and concrete configured workspace/current-pane targets, including live effective shortcut labels and disabled reasons;
- renders keyboard-accessible Settings, reusable workspace/tab/pane dialogs, compact pane-header controls, and accessible split separators;
- persists app-created durable workspace/session definitions through revisioned catalog IPC before mutating renderer catalog state;
- keeps explicit pane targets limited to the visible active-tab attachment slice; unavailable inactive targets return a bounded disabled result;
- applies each workspace's optional literal path as the effective process-profile cwd;
- owns the active pane in a DOM-free mutable focus model, remembers one pane per workspace, and restores xterm focus after workspace/catalog changes;
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

### Release packaging

Alpha Windows packaging is documented in [release.md](release.md). The release path uses electron-builder configuration in `frontends/electron/electron-builder.yml`, outputs artifacts under `release/windows-alpha`, includes the WSL hub binary as `resources/hub/linux-x64/neoncode-hub`, writes `SHA256SUMS` plus `manifest.json`, optionally Authenticode-signs signable artifacts, and verifies hashes/signatures plus Microsoft Defender scanning when the host exposes Defender tooling. This release path is separate from the `%USERPROFILE%\\neoncode-electron` development publish directory.

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

frontends/electron/main.ts          Electron main process, lifecycle, app-managed hub startup, and state persistence
frontends/electron/config-store.ts  versioned config/state validation, migration, recovery, atomic IO
frontends/electron/hub-manager.ts   packaged Windows WSL hub health/copy/start lifecycle manager
frontends/electron/token-loader.ts  validated environment/WSL hub capability loading/creation
frontends/electron/preload.ts       narrow context-isolated desktop bridge
frontends/electron/renderer.ts      typed browser-bundle bootstrap entrypoint
frontends/electron/renderer/        strict TypeScript renderer modules:
  app.ts                            typed app/bootstrap, dispatch, and pane grid orchestration
  command-palette.ts                accessible catalog search/navigation/execution DOM UI
  command-registry.ts               renderer handlers, enablement, and bounded operation results
  keybinding-router.ts              pure exact-match effective shortcut resolver and labels
  settings-view.ts                  accessible General/Keyboard editor and shortcut recorder
  workspace-dialog.ts               accessible create/rename/delete workspace modal
  tab-dialog.ts                     reusable rename/close tab modal
  pane-dialog.ts                    reusable detach/kill pane-close modal
  pane-focus-model.ts               DOM-free ordered pane focus/memory model
  hub-client.ts                     typed WebSocket protocol client and validators
  session-model.ts                  typed pane/session state and bounded output view
  terminal-pane.ts                  typed xterm.js pane, input, resize, and output handling
  reconnect-policy.ts               typed reconnect timing and activation fallback
  test-api.ts                       typed test-mode structured renderer API
  globals.d.ts                      context-isolated desktop, public-state, and test globals
frontends/electron/shared/command-catalog.ts stable command IDs, metadata, argument/result maps, and runtime validation
frontends/electron/shared/keybindings.ts     shared physical-key persistence, merge, format, conflict, and validation contract
frontends/electron/shared/layout-model.ts pure validated frontend tab/split tree and operations
frontends/electron/shared/types.ts  shared protocol and renderer-state contracts
frontends/electron/tsconfig.*.json  strict Node, renderer, and test compiler boundaries
frontends/electron/dist/            ignored generated CommonJS and renderer bundle
frontends/electron/tests/           strict TypeScript unit/fake-hub and Playwright tests
scripts/electron-app.ps1            npm ci, strict build, Windows publish/start
scripts/electron-test.ps1           Windows wrapper for Playwright tests
```

The Electron frontend uses strict TypeScript throughout without a runtime TypeScript loader. Separate Node, DOM renderer, and test compiler projects all disable `allowJs`; generated CommonJS and the esbuild browser bundle live only under ignored `dist/`. Electron and every test execute generated artifacts rather than source files.

## Renderer command, palette, and focus boundary

`shared/command-catalog.ts` is the stable contract for palette/settings, strict workspace create/rename/delete operations and their UI-only dialog launchers, workspace open/traversal/attention operations, explicit tab create/open/rename/move/close operations and contextual tab actions, explicit pane split/close/detach/kill/restart and split-resize operations, plus contextual split/resize/close-dialog and pane focus/traversal actions. It maps each ID to exact argument/result types and records title, category, context, search terms, owning layer, and future external-invocation eligibility. Runtime validation rejects unknown IDs, extra fields, missing arguments, and invalid target identifiers. The external marker is descriptive only; this commit adds no app-control listener or transport.

`renderer/command-registry.ts` remains the implementation boundary. It checks contextual enablement before invoking handlers, reports a bounded typed disabled reason for expected unavailable operations, and otherwise returns a completed result. Handler exceptions may reject inside the registry; app dispatch logs and converts them to a typed failed result so DOM event paths do not create unhandled rejections. Sidebar workspace buttons, pane pointer/focus changes, the Commands/Settings/palette controls, Dismiss attention, keyboard shortcuts, and the typed test API all reach these handlers.

One document capture-phase `keydown` listener gives an open pane/tab/workspace dialog first claim, then Settings, then an open palette first claim on Escape, arrows, Enter, and Tab. While overlays are closed, a DOM-free exact-match router uses effective defaults plus persisted overrides. Defaults are `Ctrl+Shift+P`, `Alt+Digit1..9` for configured workspaces, `Ctrl+Shift+T`, `Ctrl+PageUp/PageDown`, `Alt+Shift+=`/`Alt+Shift+-` for side-by-side/stacked splits, `Alt+Shift+Arrow` for directional border resize, `F6`, and `Shift+F6`. Pane close/detach/kill/restart remain deliberately unbound. Already-prevented, Ctrl+Alt/AltGraph, extra-modifier, repeat execution, and unclaimed events are untouched, so xterm remains responsible for terminal input, copy/paste, and special keys. A successful Settings save safely replaces the router and updates palette/header labels without restarting.

The palette is an accessible modal DOM surface with initial search focus, catalog/dynamic-target filtering, categories, current shortcut labels, disabled reasons, wrapping arrow selection, one-shot Enter dispatch, Escape close, and a two-control Tab focus loop. Closing restores the element focused before opening when it still exists; otherwise the authoritative active pane is focused.

Settings is a separate accessible modal with General and Keyboard sections, trapped Tab movement, exact physical-key recording, inline validation/storage errors, one save in flight, Escape recording cancellation/close, and active-pane focus restoration. General fields are restart-required in this slice; only keybindings apply live. The reusable workspace modal traps focus and provides explicit create, rename, and detach-or-kill delete flows with one catalog save in flight.

The active tab's persisted `focusedPaneId` is authoritative. Its depth-first pane order is projected into the mutable focus model for wrapping F6 traversal, while inactive tabs have no xterm or WebSocket attachment. The DOM mirrors focus through active data/ARIA attributes and CSS; it does not infer ownership. `workspace.activePaneId` is part of structured renderer state.

## Frontend layout-state boundary

`shared/layout-model.ts` now defines the DOM-free frontend layout vocabulary: a workspace has ordered tabs, each tab has one binary pane/split tree, and each pane leaf references a session key without becoming the backend session identity. IDs are caller-supplied rather than generated inside the model. Pure immutable operations validate add/rename/reorder/activate/close tab, focus/split/move/close pane, and clamped split-resize transitions; pane ordering is first-child/second-child depth-first. Pure ancestor-path helpers identify split IDs and select the nearest directional border with a safely clamped ratio delta. A deterministic helper converts a schema 6 configured session grid to one initial tab while retaining configured session keys. Reconciliation prunes removed configured sessions, retains surviving tabs/trees/focus, and adds newly configured sessions without resetting the rest of the layout.

App-owned state schema 3 stores validated layouts under `workspaceLayouts`, separately from configuration schema 8 and hub lifecycle state. The state boundary allows at most 16 workspace entries, 64 leaves total, 8 tabs and 8 panes per workspace, tree depth 8, and a 64 KiB state file. Electron main accepts layout saves only for a workspace in the current validated config, validates before merge, and persists through the existing backup plus atomic-rename path.

The renderer owns a runtime `Map<workspaceId, WorkspaceLayoutState>` separate from durable session definitions. It asynchronously persists seeded/reconciled layouts, renders an accessible tab strip plus the active tree recursively, and saves tab/focus/ratio mutations. Tab and pane split creation write the durable session catalog before layout state, derive the pane leaf from the stable session ID, apply the workspace path cwd override, and then force-render the active tab. Resize updates matching DOM flex ratios in place and refits xterm without restarting PTYs. Pane close first receives the requested visible detach/kill acknowledgement, then removes the durable definition and collapses the tree; a catalog failure leaves definition/layout intact, reconstructs the visible pane where possible, and emits a warning. Pane lifecycle detach/kill keeps the definition/tree visible, while restart reconstructs only that pane and attaches a running session or starts a replacement.

## Electron security boundary

The Electron renderer runs with:

```text
contextIsolation: true
nodeIntegration: false
sandbox: true
```

The browser-world renderer is bundled with `esbuild-wasm` and receives only a narrow preload API for validated bootstrap configuration (including the local hub capability), revisioned Settings and workspace-catalog get/save, bounded clipboard reads/writes, layout/state saves, and graceful-close coordination. Settings and catalog IPC accept only the current BrowserWindow sender and share one monotonic revision. Main rereads disk config, validates the complete request, preserves fields outside the requested boundary, and atomically writes the backup and replacement without persisting process-local environment overrides. The sandbox preload stays self-contained and exposes no arbitrary filesystem or command primitive. The app applies a restrictive CSP and denies unexpected navigation, new windows, webviews, and permission requests.

Playwright asserts the effective BrowserWindow preferences, absence of renderer `process`/`require`, exact preload API keys, deeply frozen bootstrap configuration, denied window creation, and denied notification permission.

## Desktop configuration and state

Electron main exclusively owns `%APPDATA%\\NeonCode\\config.json` and `state.json`. Versioned strict validation produces a narrow bootstrap object containing the loopback endpoint, configured session IDs/titles, resolved process launch profiles, close policy, and diagnostics. The capability token remains environment-only.

Configuration schema 8 supports 1–16 named workspaces, optional bounded literal workspace paths, a default launch-profile reference, 1–8 sessions per workspace (64 total), simple validated grid columns, named terminal appearance, app theme colors, explicit process profiles (`command`, `args`, `cwd`), optional tab/terminal close confirmations, and at most 64 strict per-command keybinding overrides with explicit unbinding. Schema 5 derives the workspace fields without changing workspace/session identity; schema 7 gains default app theme colors. The accessible Settings UI persists supported General values, app theme colors, and keybindings while preserving JSON-only advanced fields such as endpoint, session prefix, and app-window close policy; the workspace dialog persists catalog changes live. Syntactically valid stale target overrides are retained at load but omitted from the effective router, and deletion removes matching target overrides transactionally. State schema 3 stores window content size, the active workspace, and validated layout groundwork. Normal close either detaches active panes or kills sessions visited by this app instance according to policy; runtime workspace switching always detaches. Hub sessions remain authoritative backend state. Writes use same-directory temporary files and atomic rename, and valid backups support visible recovery from malformed JSON.

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

Configuration schema 5 describes desired sessions independently of UI runtime state:

```yaml
name: audio-fw
root: /home/me/src/audio-fw
sessions:
  - id: shell
    command: bash
  - id: tests
    command: ./andromeda test --hil
```

The current Electron sidebar switches these configured workspaces, restores the active choice, and derives status from hub-owned effective command/configured launch cwd/attachment metadata plus frontend-observed pane lifecycle. It falls back to configured launch locations before a session exists. Runtime cwd/git metadata is now additive where the hub can resolve it. The visible renderer restores/reconciles persisted tabs, recursively renders the active split tree, and provides keyboard/header controls for durable splits, directional resize, explicit pane close, and session detach/kill/restart. External workspace files remain future work.

The hub should eventually own:

- launch profiles;
- session metadata;
- session status;
- attach/detach/reconnect;
- exit/error reporting;
- machine/remote runtime state.

The frontend should own:

- tabs/panes/splits;
- command catalog, registry, and palette;
- sidebar/status presentation;
- notifications/attention UI;
- browser/external surfaces;
- a future authenticated local app-control transport for externally eligible CLI commands. The shared command contract is ready for that transport, but this slice does not add one.

The PTY hub remains layout-agnostic. CLI control of app-owned workspaces/tabs/splits must use the future desktop app-control transport rather than extending the hub with frontend layout state.

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
