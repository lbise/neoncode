# NeonCode development plan

## Current stage

```text
Stage: Strict TypeScript migration phase 1 complete
Supported Windows app: Electron + xterm.js + neoncode-hub
Next focus: migrate renderer orchestration, then Electron main/preload and tests
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
- schema 4 supports simple column grids rather than free-form splits;
- live appearance reload, font discovery, and external workspace files remain future work;
- changing a configured ID does not automatically kill an old detached hub session.

### Milestone: dynamic configured workspaces

Status: complete and ready for manual preview.

Goal:

```text
Switch between named workspaces with dynamic pane grids while hub-owned sessions continue running and reattach on return.
```

Tasks:

- [x] Add schema-version-4 named workspaces with stable IDs, 1–8 sessions, and validated grid columns.
- [x] Migrate schema-version-3 top-level sessions without changing their hub session IDs.
- [x] Replace two static pane surfaces with dynamic xterm pane creation/disposal.
- [x] Add a visible workspace selector and serialized detach/reattach switching.
- [x] Persist and restore the active workspace in state schema 2.
- [x] Keep `kill` close scoped to workspaces visited by the current app instance.
- [x] Cover two-/three-pane switching, shell-state continuity, relaunch restoration, and kill cleanup in real Electron tests.

Acceptance criteria:

- [x] A configured three-pane workspace renders without hard-coded pane DOM.
- [x] Switching away and back reattaches the same PTYs with replay and environment continuity.
- [x] Closing on a non-default workspace restores it on relaunch.
- [x] Unrelated hub sessions are never included in close-policy cleanup.
- [x] `./dev check`, publish, audit, and authenticated `./dev electron-test` pass.

Manual preview: add a second workspace using `docs/configuration.md`, reopen NeonCode, set shell variables in both workspaces, switch between them, and confirm each workspace retains its PTY state. Close while the second workspace is active and confirm it reopens selected.

## Near-term product foundation

### 1. App architecture

- [x] Move Electron app to product path `frontends/electron`.
- [x] Introduce a small state model for panes/sessions/workspaces.
- [x] Add app-level error display for hub disconnect/session exit/protocol errors.
- [x] Add config storage under `%APPDATA%\NeonCode`.
- [x] Load validated font, cursor, and 16-color terminal appearance from schema-version-4 app config with named Windows-Terminal-style colors.

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
- [x] arrow/function/Home/End/PageUp/PageDown keys;
- [x] copy/selection behavior;
- [x] Neovim interactive insert/write/exit behavior;
- [x] tmux interactive command/detach behavior;
- [x] xterm SGR press/release mouse reporting to the Linux PTY;
- [x] application-specific mouse behavior: tmux split selection/copy-mode wheel and Neovim cursor/viewport interaction;
- [x] Initial 2,000-line heavy-output continuity test;
- [x] 20,000-line output soak under 30 seconds with no sequence gap;
- [x] Deterministic 100-reconnect/10,000-chunk renderer-state soak and 20-reconnect real WebSocket/PTY soak;
- [ ] Extended multi-minute performance soak;
- [ ] long-session stability.

### 4. Workspace model

- [x] Define versioned workspace schema with stable IDs, names, sessions, and grid columns.
- [x] Define user-level process launch profiles supporting:
  - local WSL shell;
  - project cwd shell;
  - custom command;
  - SSH shell;
  - tmux attach/create.
- [x] Persist and restore the active configured workspace.
- [x] Restore configured dynamic pane grids.
- [x] Add a workspace selector sidebar with pane counts and active state.
- [x] Show configured WSL launch-location summaries and aggregate session state in the sidebar.
- [ ] Add richer runtime workspace metadata:
  - live shell cwd;
  - git branch/dirty state;
  - retained latest notification/error.

### Milestone: workspace status sidebar

Status: complete and ready for manual preview.

- [x] Show WSL/configured launch-location summaries per workspace.
- [x] Aggregate pane lifecycles into running, connecting, reconnecting, detached, available, stopped, and error states.
- [x] Update status during workspace switching and hub reattachment.
- [x] Expose structured workspace summaries in renderer test state.
- [x] Verify idle/running/detached/available transitions across switch and relaunch in real Electron tests.

Manual preview: run two configured workspaces, switch between them, and observe the sidebar move from `running` to `detached`; close and reopen to see inactive hub sessions reported as `available` before reattachment.

### 5. Hub protocol evolution

Inspired by wmux/cmux/t3code analysis:

- [x] Add authenticated `welcome` with protocol version and hub `boot_id`.
- [x] Add ordered raw-output sequence numbers.
- [x] Add incarnation-aware bounded raw-output checkpoint/resync flow.
- [ ] Add canonical terminal-emulator snapshot/resync if later requirements justify it.
- [ ] Add attachment IDs and per-attachment resize semantics.
- [x] Add hub-owned effective command, configured cwd, persistence, and attachment-count metadata.
- [x] Add typed session exit status/reason and bounded retained attention.
- [ ] Decide backend-generated vs frontend-provided IDs.

### Milestone: hub-owned session metadata

Status: complete and ready for manual preview.

- [x] Extend additive protocol-v1 `session_list` summaries without breaking ID-only clients.
- [x] Store effective command and configured cwd in the hub session registry.
- [x] Track authenticated attachment membership across start/attach/detach/disconnect.
- [x] Expose persistence and attachment counts while omitting potentially sensitive arguments.
- [x] Validate complete and legacy summaries at the Electron protocol boundary.
- [x] Prefer hub launch metadata in restored workspace locations with configured fallback.
- [x] Cover metadata stability and two-client attachment counts with real WebSocket/PTYS.
- [x] Verify hub-authoritative cwd despite changed frontend configuration in real Electron tests.

Manual preview: start workspaces, close NeonCode with detach, alter a matching launch profile cwd, and reopen. Existing sessions continue to show the hub's original configured launch cwd; new sessions use the edited profile.

### Milestone: retained exit attention

Status: complete and ready for manual preview.

- [x] Report typed `process_exit`, `wait_failed`, and `killed` reasons without claiming unavailable signal fidelity.
- [x] Retain the latest natural exit for at most 64 session IDs in hub memory.
- [x] Allow immediate ID reuse while preserving prior attention.
- [x] Add explicit authenticated attention acknowledgement that never kills a replacement.
- [x] Prioritize workspace attention in the sidebar and show an accessible Dismiss control.
- [x] Restore attention after Electron relaunch and start a configured replacement session.
- [x] Cover exit status, retention, reuse, acknowledgement, explicit-kill suppression, and memory bounds.

Manual preview: run `exit 7` in a pane. Its workspace shows `Needs attention`; close/reopen NeonCode to see attention restored while the pane starts again, then use Dismiss.

### Milestone: deterministic reconnect policy coverage

Status: complete.

- [x] Extract capped exponential reconnect timing from xterm rendering.
- [x] Enforce a single pending reconnect timer with explicit cancel/reset semantics.
- [x] Extract bounded attach/start fallback decisions.
- [x] Add fake-clock tests for 250/500/1000…5000 ms backoff, duplicate suppression, cancellation, reset, and one-time fallback.
- [x] Run the deterministic suite under `./dev check` without wall-clock sleeps.

### Milestone: incarnation-aware replay checkpoints

Status: complete.

- [x] Assign each process incarnation a random opaque ID independent of its configured session ID.
- [x] Let attach provide an atomic incarnation/output-sequence cursor.
- [x] Replay only missed chunks when cursor continuity is valid.
- [x] Report retained replay bounds, truncation, and required renderer resets.
- [x] Preserve full bounded replay for fresh and legacy attaches.
- [x] Validate cursor pairs and checkpoint manifests at protocol boundaries.
- [x] Cover missed-only replay, stale incarnation reset, and bounded-history truncation in Rust tests.
- [x] Verify same-incarnation reconnect and close/reopen attachment in hidden Electron.

This is intentionally not described as a canonical screen snapshot. Raw terminal bytes may begin inside emulator control state and cannot exactly restore every tmux/Neovim screen.

### Milestone: deterministic timeout and reconnect soaking

Status: complete.

- [x] Add explicit renderer authentication and welcome deadlines with receiver-safe injectable timers.
- [x] Ignore late proof/welcome traffic after timeout and avoid duplicate failure callbacks.
- [x] Reject contradictory or impossible replay checkpoint manifests.
- [x] Run 100 same-incarnation reconnect cycles over 10,000 ordered/duplicate chunks with bounded renderer history.
- [x] Run 20 authenticated real WebSocket reconnects against one persistent PTY with checkpoint cursors.
- [x] Script a boot-A/boot-B renderer race to reject stale callbacks, fall back from attach to start, and reset one replacement incarnation.
- [x] Keep deterministic policy, timeout, race, and soak coverage in `./dev check`/Rust tests.

Extended multi-minute wall-clock and long-session resource stability remain separate manual/CI soak gates.

### Milestone: strict TypeScript migration

Status: phase 1 of 4 complete.

- [x] Add strict, environment-specific Node/renderer/test TypeScript projects.
- [x] Build all mixed JavaScript/TypeScript sources into an ignored clean `dist/` runtime tree.
- [x] Run unit and Electron functional tests only against generated CommonJS/browser artifacts.
- [x] Define shared protocol, replay, session summary, and renderer-state contracts.
- [x] Migrate `hub-client`, `session-model`, and `reconnect-policy` to strict TypeScript.
- [x] Preserve runtime JSON validation at configuration and WebSocket trust boundaries.
- [ ] Migrate renderer entry, app orchestration, terminal pane, and test API.
- [ ] Migrate Electron main, preload, configuration store, and token loader.
- [ ] Migrate tests and disable `allowJs` in every compiler project.

The migration intentionally does not use a runtime TypeScript loader. Windows publish output contains generated JavaScript under `dist/`, and every phase must continue passing the real hidden-Electron relaunch suite.

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
- [x] Sidebar workspace list.
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
