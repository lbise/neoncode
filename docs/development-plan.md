# NeonCode development plan

## Current stage

```text
Stage: product foundation after Windows stack decision
Supported Windows app: Electron + xterm.js + neoncode-hub
Next focus: app/session model and reconnect/attach behavior
```

The Windows tech stack is now:

```text
Electron shell
xterm.js terminal renderer
Rust neoncode-hub
portable-pty in WSL/Linux
Playwright + PowerShell smoke validation
```

Previous Windows Terminal/WPF embedding POCs are obsolete and are not a product path.

## Recently completed

### Renderer/platform foundation

- [x] Built Rust `neoncode-hub` POC with `/health` and `/ws`.
- [x] Implemented PTY start/input/output/resize/kill.
- [x] Tested WPF/Windows Terminal and Electron/native Windows Terminal POCs.
- [x] Rejected native child-HWND terminal embedding as the product path due to focus/polish/automation risk.
- [x] Adopted Electron + xterm.js as the supported Windows app stack.
- [x] Moved the Electron app to `frontends/electron`.

### Hub/session foundation

- [x] Split hub into protocol/session/state/ws modules.
- [x] Added shared in-process session registry.
- [x] Decoupled PTY output from creating WebSocket via session event broadcaster.
- [x] Added `list_sessions`, `attach`, and `detach` protocol messages.
- [x] Documented hub and protocol.

### xterm.js validation

- [x] Added Electron xterm app.
- [x] Made `./dev app` and `./dev publish` target the Electron app.
- [x] Added smoke for hub start/input/output.
- [x] Added paste handling and common special keys:
  - Ctrl+Shift+V;
  - Shift+Insert;
  - Ctrl+Space → NUL;
  - Alt+Backspace → ESC DEL.
- [x] Added resize smoke verifying xterm rows/cols match `stty size`.
- [x] Added Playwright smoke for DOM/state/input.
- [x] Added behavior smoke for command round-trip, Ctrl+C, tmux/nvim availability.

### Documentation cleanup

- [x] Minimal README.
- [x] Product requirements doc.
- [x] Architecture doc.
- [x] Terminal renderer decision doc.
- [x] External tool inspiration retained as source analysis.

## Immediate next milestone

### Milestone: session persistence baseline

Goal:

```text
Close/reopen the Electron app and reattach to existing hub sessions instead of always starting fresh sessions.
```

Why this matters:

- moves NeonCode from terminal proxy to session cockpit;
- exercises hub `list_sessions`/`attach`/`detach` in the supported app;
- creates the foundation for workspaces, layouts, and reconnect.

Tasks:

- [ ] Refactor `frontends/electron/renderer.js` into modules:
  - hub client;
  - terminal pane;
  - session model;
  - app/bootstrap.
- [ ] Introduce stable frontend session IDs independent of pane indexes.
- [ ] On startup, call `list_sessions`.
- [ ] Attach to known sessions when present.
- [ ] Start missing sessions when not present.
- [ ] Detach sessions before app close when persistence is desired.
- [ ] Add UI/status for attached/started/error/exited states.
- [ ] Add smoke test for close/reopen/reattach.

Acceptance criteria:

- [ ] Start app, type in pane 1, close app, reopen app, same backend session responds.
- [ ] `./dev electron-xterm-smoke` still passes.
- [ ] `./dev electron-xterm-playwright-smoke` still passes.
- [ ] protocol/docs updated if behavior changes.

## Near-term product foundation

### 1. App architecture

- [x] Move Electron app to product path `frontends/electron`.
- [ ] Introduce a small state model for panes/sessions/workspaces.
- [ ] Add app-level error display for hub disconnect/session exit/protocol errors.
- [ ] Add config storage under `%APPDATA%\NeonCode`.
- [ ] Load terminal font/theme from app config.

### 2. Terminal correctness

Already validated:

- [x] start/output/input;
- [x] paste;
- [x] resize with `stty size`;
- [x] Ctrl+C;
- [x] tmux/nvim availability.

Still needed:

- [ ] Ctrl+D;
- [ ] Ctrl+Z;
- [ ] arrow/function/Home/End/PageUp/PageDown keys;
- [ ] copy/selection behavior;
- [ ] Neovim interactive behavior;
- [ ] tmux interactive behavior;
- [ ] mouse mode in Neovim/tmux;
- [ ] heavy output/performance soak;
- [ ] long-session stability.

### 3. Workspace model

- [ ] Define workspace schema.
- [ ] Define launch profiles:
  - local WSL shell;
  - project cwd shell;
  - custom command;
  - SSH shell;
  - tmux attach/create.
- [ ] Persist recent workspaces.
- [ ] Restore layout.
- [ ] Add workspace sidebar/status metadata:
  - cwd;
  - host;
  - git branch;
  - session status;
  - latest notification/error.

### 4. Hub protocol evolution

Inspired by wmux/cmux/t3code analysis:

- [ ] Add `server.welcome` with protocol version and hub `boot_id`.
- [ ] Add ordered event sequence numbers.
- [ ] Add snapshot/resync flow.
- [ ] Add attachment IDs and per-attachment resize semantics.
- [ ] Add session metadata/status.
- [ ] Add session exit status/reason.
- [ ] Decide backend-generated vs frontend-provided IDs.

### 5. CLI/API

- [ ] Add minimal `neoncode` CLI or local API client.
- [ ] Support session list/status.
- [ ] Support workspace list/open.
- [ ] Support notification injection for scripts/agents.

## Later milestones

### Remote workspaces

- [ ] Plain SSH launch profile.
- [ ] SSH reconnect/error state.
- [ ] tmux attach/create profile for remote persistence.
- [ ] Hidden tmux convention for durable remote sessions.
- [ ] Evaluate future `neoncode-remote` daemon.

### Workspace cockpit UI

- [ ] Tabs/panes/splits.
- [ ] Sidebar workspace list.
- [ ] Command palette.
- [ ] Status/attention indicators.
- [ ] Notifications panel.
- [ ] Browser/external surface launch hooks.

### Agent-aware workflows

- [ ] Run agents as normal terminal sessions first.
- [ ] Detect session output/exit/attention states.
- [ ] Notify when agent/test/log needs attention.
- [ ] Consider supervised/full-access modes later.

## Obsolete POCs

The following were useful to de-risk the project but are no longer part of the active Windows product path:

- WPF Windows Terminal embedding;
- Electron + direct native Windows Terminal coordinator;
- Electron + WPF native terminal host;
- Windows Terminal source/build dependency.

Do not add new product work to these paths.

## Validation commands

Default checks:

```bash
./dev check
./dev publish
```

With hub/app running:

```bash
./dev electron-xterm-smoke -PaneIndex 1
./dev electron-xterm-smoke -PaneIndex 2
./dev electron-xterm-resize-smoke -PaneIndex 1
./dev electron-xterm-resize-smoke -PaneIndex 2
./dev electron-xterm-playwright-smoke
./dev electron-xterm-behavior-smoke -PaneIndex 1
./dev electron-xterm-behavior-smoke -PaneIndex 2
```
