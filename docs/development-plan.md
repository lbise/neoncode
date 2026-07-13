# NeonCode development plan

## Current stage

```text
Stage: Protocol identity and resilient pane reconnect ready for manual preview
Supported Windows app: Electron + xterm.js + neoncode-hub
Next focus: evaluate crash/reconnect continuity, then terminal interaction correctness
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
- [x] Upgraded and pinned Electron 43.1.0 and Playwright 1.61.1; locked dependencies audit with zero known vulnerabilities.
- [x] Made Windows-local publishing reproducible with `npm ci` plus Electron 43's explicit pinned binary installer.

### Hub/session foundation

- [x] Split hub into protocol/session/state/ws modules.
- [x] Added shared in-process session registry.
- [x] Decoupled PTY output from creating WebSocket via session event broadcaster.
- [x] Added `list_sessions`, `attach`, and `detach` protocol messages.
- [x] Documented hub and protocol.

### Testing foundation

- [x] Added hub integration tests using an in-process server, ephemeral port, real WebSocket protocol, and real PTYs.
- [x] Covered fast output/exit, exit cleanup and ID reuse, disconnect cleanup, detach/list/reattach, resize, input/output, and kill.
- [x] Documented a layered testing strategy that moves Electron functional tests away from global focus, `SendKeys`, clipboard, and log scraping.

### xterm.js validation

- [x] Added Electron xterm app.
- [x] Made `./dev app` and `./dev publish` target the Electron app.
- [x] Added functional coverage for hub start/input/output in both panes.
- [x] Added paste handling and common special keys:
  - Ctrl+Shift+V;
  - Shift+Insert;
  - Ctrl+Space → NUL;
  - Alt+Backspace → ESC DEL.
- [x] Added hidden-window Playwright resize validation verifying xterm rows/cols match `stty size`.
- [x] Added structured Playwright coverage for DOM/state/input without foreground-window automation.
- [x] Added deterministic command round-trip, Ctrl+C, and tmux/nvim availability coverage.

### Documentation cleanup

- [x] Minimal README.
- [x] Product requirements doc.
- [x] Architecture doc.
- [x] Terminal renderer decision doc.
- [x] External tool inspiration retained as source analysis.

## Immediate next milestone

### Milestone: session persistence baseline

Status: complete and ready for manual preview.

Goal:

```text
Close/reopen the Electron app and reattach to existing hub sessions instead of always starting fresh sessions.
```

Why this matters:

- moves NeonCode from terminal proxy to session cockpit;
- exercises hub `list_sessions`/`attach`/`detach` in the supported app;
- creates the foundation for workspaces, layouts, and reconnect.

Tasks:

- [x] Refactor `frontends/electron/renderer.js` into modules:
  - hub client;
  - terminal pane;
  - session model;
  - app/bootstrap.
- [x] Introduce stable frontend session IDs independent of pane indexes.
- [x] On startup, call `list_sessions`.
- [x] Add a structured Playwright renderer test API and remove echo/log/`SendKeys` assertions from core Electron functional tests.
- [x] Attach to known sessions when present.
- [x] Start missing sessions when not present.
- [x] Detach sessions before app close when persistence is desired.
- [x] Add UI/status for attached/started/error/exited states.
- [x] Add functional test for close/reopen/reattach.

Acceptance criteria:

- [x] Start app, type in pane 1, close app, reopen app, same backend session responds.
- [x] `./dev electron-test` passes.
- [x] protocol/docs updated for session lifecycle behavior.

### Milestone: bounded terminal replay

Status: complete and ready for manual preview.

Goal:

```text
Reopening Electron restores recent terminal output and the latest shell prompt before live output continues.
```

Tasks:

- [x] Add a bounded 2 MiB output replay buffer per hub session.
- [x] Add monotonic sequence numbers to terminal output messages.
- [x] Atomically capture replay plus a live subscription without gaps or duplicates.
- [x] Replay buffered output after `attached` and before queued live output.
- [x] Ignore duplicate output and expose sequence gaps in frontend state.
- [x] Verify detached output replay with a real WebSocket/PTY integration test.
- [x] Verify close/reopen restores pre-close terminal output in Playwright.

Acceptance criteria:

- [x] Reopened shell shows recent output rather than a blank terminal.
- [x] New shell commands continue after replay.
- [x] Replay transitions to live output with no detected sequence gap.
- [x] Replay memory is bounded per session.

Limitations:

- replay is bounded raw terminal output, not a canonical terminal-screen snapshot;
- very old output beyond the 2 MiB window is discarded;
- exact restoration of arbitrary full-screen applications still needs snapshot/resync semantics.

### Milestone: persisted desktop configuration

Status: complete and ready for manual preview.

Goal:

```text
Let users configure the local hub endpoint, stable sessions, launch commands/cwd, and close policy while NeonCode safely restores app-owned window state.
```

Tasks:

- [x] Add versioned `config.json` and `state.json` under `%APPDATA%\\NeonCode`.
- [x] Keep filesystem access in Electron main and deeply freeze validated preload bootstrap data.
- [x] Add strict schema/resource/loopback validation and version-0 migration.
- [x] Add atomic writes, valid backups, malformed-file preservation, recovery warnings, and future-schema protection.
- [x] Add one/two-pane process launch profiles with explicit command/args/cwd.
- [x] Add configurable pane IDs/titles and detach/kill close policy.
- [x] Persist and restore window content size.
- [x] Add isolated Node and Windows Electron tests for profiles, cwd, state, recovery, invalid config, and both close policies.
- [x] Document manual configuration and limitations in `docs/configuration.md`.

Acceptance criteria:

- [x] First launch creates safe defaults without persisting the hub token.
- [x] Configured titles and cwd are applied on Windows.
- [x] Detach policy preserves/reattaches sessions and kill policy starts fresh sessions.
- [x] Malformed configuration recovers from backup with a visible warning; unrecoverable configuration starts no sessions.
- [x] Resized window content dimensions survive close/reopen.
- [x] `./dev check`, publish, and authenticated `./dev electron-test` pass.

Limitations:

- configuration is user-edited JSON with restart-to-apply; no settings UI/live reload yet;
- version 1 exposes at most two static panes;
- font/theme and workspace/layout persistence remain future schema work;
- changing a configured ID does not automatically kill an old detached hub session.

## Near-term product foundation

### 1. App architecture

- [x] Move Electron app to product path `frontends/electron`.
- [ ] Introduce a small state model for panes/sessions/workspaces.
- [x] Add app-level error display for hub disconnect/session exit/protocol errors.
- [x] Add config storage under `%APPDATA%\NeonCode`.
- [ ] Load terminal font/theme from app config.

### 2. Security hardening

Release-blocking baseline:

- [x] Pin current Electron/Playwright versions and require a zero-high-severity dependency audit.
- [x] Enable Electron context isolation, disable renderer Node integration, and run the renderer sandboxed.
- [x] Move privileged clipboard/config/close coordination behind a narrow preload bridge.
- [x] Bundle renderer code so browser-world code does not depend on Node `require`.
- [x] Add a restrictive Content Security Policy.
- [x] Deny unexpected navigation, new windows, and renderer permission requests.
- [x] Define a local hub threat model and authentication/capability-token lifecycle.
- [x] Require the Electron `file://` WebSocket origin and a per-user 256-bit mutual nonce/HMAC capability challenge (the token is never transmitted).
- [x] Refuse non-loopback hub binding; no remote mode is supported yet.
- [x] Add bounded WebSocket/session event queues plus frame, input, session, attachment, process, ID, and terminal-size limits.
- [x] Add security integration tests for unauthorized origins/capabilities and invalid/oversized inputs.
- [x] Re-run the Electron functional suite with capability authentication after restoring the official Electron runtime.
- [x] Launch the Windows app through Explorer at medium integrity even when the invoking WSL development shell is elevated.

Before treating hostile native local accounts/processes as in-scope or enabling remote access:

- [ ] Add a non-relayable authenticated/encrypted transport (pinned TLS, OS-protected IPC, or per-message authenticated encryption).

### Milestone: protocol identity and resilient reconnect

Status: complete and ready for manual preview.

- [x] Require authenticated `welcome` with protocol version and per-boot hub identity.
- [x] Add backward-compatible persistent session starts for Electron panes.
- [x] Add visible capped exponential pane reconnect.
- [x] Reattach persistent sessions after unexpected socket loss, preserving PTY state and replay sequence continuity.
- [x] Fall back from attach to persistent start when a hub reboot removes the old session.
- [x] Suppress reconnect during graceful detach/kill close.
- [x] Cover welcome, persistent disconnect, and real Electron forced-socket continuity.

Manual preview: set shell state, force-close Electron rather than closing its window, reopen, and confirm the same PTY state remains. Start Electron with the hub stopped, then start the hub and observe panes recover. A hub restart intentionally creates fresh sessions after reconnect.

### 3. Terminal correctness

Already validated:

- [x] start/output/input;
- [x] paste;
- [x] resize with `stty size`;
- [x] Ctrl+C;
- [x] tmux/nvim availability.

Still needed:

- [x] Ctrl+D;
- [x] Ctrl+Z;
- [ ] arrow/function/Home/End/PageUp/PageDown keys;
- [ ] copy/selection behavior;
- [ ] Neovim interactive behavior;
- [ ] tmux interactive behavior;
- [ ] mouse mode in Neovim/tmux;
- [x] Initial 2,000-line heavy-output continuity test;
- [ ] Extended heavy-output/performance soak;
- [ ] long-session stability.

### 4. Workspace model

- [ ] Define workspace schema.
- [x] Define user-level process launch profiles supporting:
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

### 5. Hub protocol evolution

Inspired by wmux/cmux/t3code analysis:

- [x] Add authenticated `welcome` with protocol version and hub `boot_id`.
- [ ] Add ordered event sequence numbers.
- [ ] Add snapshot/resync flow.
- [ ] Add attachment IDs and per-attachment resize semantics.
- [ ] Add session metadata/status.
- [ ] Add session exit status/reason.
- [ ] Decide backend-generated vs frontend-provided IDs.

### 6. CLI/API

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

With the hub running:

```bash
./dev electron-test
```
