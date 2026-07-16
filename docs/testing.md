# NeonCode testing strategy

## Goals

Tests should prove behavior at the lowest practical layer and remain deterministic while the developer uses other windows.

Core rules:

- do not use global keyboard focus, `SendKeys`, clipboard state, or log scraping for core correctness;
- logs are diagnostics, not the application test API;
- use ephemeral ports and isolated session IDs;
- exercise real PTYs where hub lifecycle behavior matters;
- ensure an expected output marker does not appear literally in terminal input, because interactive shells echo commands;
- keep OS/window integration smokes small and separate from functional tests.

## Test layers

### 1. Rust hub integration tests

Location:

```text
hub/tests/
```

These tests run an in-process Axum server on an ephemeral loopback port and connect through the real WebSocket protocol to real `portable-pty` sessions.

Current coverage:

- fast command output is not lost;
- natural exit reports the process status;
- exited sessions disappear from `list_sessions` and their IDs can be reused;
- sessions still owned by a disconnected WebSocket are removed and killed;
- detached sessions survive owner disconnect;
- output produced while detached is replayed after attach;
- a matching incarnation/sequence cursor replays only missed output and stale incarnations request reset;
- 20 successive authenticated checkpoint reconnects preserve one persistent real PTY and ordered output;
- a new WebSocket can list, attach, resize, send input, receive ordered output, and kill a detached session;
- missing/foreign WebSocket origins are rejected;
- missing/incorrect capability challenge responses are rejected without sending the token;
- authenticated connections receive a versioned, per-boot hub welcome;
- persistent sessions retain PTY state across unexpected WebSocket disconnect and remain explicitly killable;
- session summaries preserve effective command/configured cwd/persistence, observe shell and foreground-child runtime cwd through bounded `/proc` traversal, probe clean/dirty/detached Git state through bounded workers, and track attachment counts across two clients, detach, and disconnect;
- natural exits expose typed reasons, retain bounded attention across ID reuse, acknowledge independently of replacements, and explicit kills create no attention;
- invalid/overlong session IDs, invalid sizes, oversized decoded input, and oversized transport messages are rejected;
- non-loopback bind addresses and excess WebSocket permits are rejected by unit tests;
- replay is bounded by both raw bytes and entry count, and an expired cursor reports truncation;
- the capability token is removed from PTY child environments.

Run:

```bash
cargo test -p neoncode-hub
```

Future hub integration coverage should include transport-level oversized frames, saturated backpressure behavior, attachment/session-limit boundaries, multiple concurrent attachments, and graceful shutdown.

For an explicit wall-clock stability run, `./dev soak [seconds]` repeatedly exercises a persistent PTY through 20 authenticated checkpoint reconnects plus shell/foreground runtime-cwd and clean/dirty/detached Git transitions. It defaults to 300 seconds and is intentionally excluded from `./dev check`; use longer durations on a dedicated worker.

### 2. Renderer unit/integration tests

The strict TypeScript build checks separate Node, DOM renderer, and test projects with `allowJs` disabled, emits generated artifacts into a clean ignored `frontends/electron/dist/`, and runs tests against generated CommonJS. This prevents source/output resolution differences and keeps runtime TypeScript tooling out of Electron.

Renderer state transitions and protocol decisions should be tested without launching Electron where possible.

Use injected/fake dependencies for:

- WebSocket transport;
- terminal surface;
- timers/reconnect backoff;
- persisted configuration.

The current `frontends/electron/tests/hub-client-auth.ts` test uses a mock WebSocket, fake clock, and Node Web Crypto to verify that the renderer sends no bearer token, accepts a valid reciprocal hub proof, rejects fake hub proofs/malformed capabilities or replay manifests, enforces authentication/welcome deadlines, ignores late traffic, and strictly normalizes session lifecycle metadata. `frontends/electron/tests/reconnect-policy.ts` uses a fake clock to prove capped backoff, single-timer suppression, cancellation/reset, and bounded attach/start fallback without wall-clock sleeps. `command-catalog.ts` exhaustively validates every stable invocation shape and rejects unknown IDs, extra fields, missing/wrong/oversized/control-character arguments, while checking metadata copy isolation and external eligibility. `command-registry.ts` proves enablement descriptions, bounded disabled results, disabled-handler suppression, successful dispatch, and unexpected handler rejection. DOM-free `command-palette.ts` tests cover multi-term/category/search-term filtering and wrapping/empty navigation; no additional DOM harness dependency is introduced for the UI class. `keybinding-router.ts` verifies `Ctrl+Shift+P`, effective labels, exact existing defaults, unclaimed Ctrl+C/D/Z/readline keys, and repeat suppression. `pane-focus-model.ts` covers focus wrap, workspace memory, and removed-pane fallback. `layout-model.ts` tests cover deterministic grid seeding, depth-first order, immutable tab/pane operations, parent collapse, cross-tab moves, ratio clamping, removed leaves, strict known shapes, UTF-8 titles, duplicate identities, and tab/pane/depth limits. `frontends/electron/tests/session-model.ts` covers incarnation/reset/truncation sequence baselines, while `reconnect-output-soak.ts` runs 100 reconnect checkpoints over 10,000 chunks with duplicate suppression and bounded recent output. `terminal-pane-fake-hub.ts` drives the real pane controller through a scripted boot-A/boot-B race, stale callbacks, cursor attach/start fallback, replacement reset, and malformed manifest close. `frontends/electron/tests/config-store.ts` covers config and state migrations, valid layout round trips, malformed/oversized/deep/duplicate/future state, aggregate limits, backup recovery, stale temporary-file cleanup, unusable missing-primary backups, and injected atomic-save failures. `./dev check` runs all of these without Electron.

This layer should verify state transitions such as:

```text
disconnected -> connecting -> listing -> attaching/starting -> running -> exited/error
```

It should also cover attach-vs-start decisions, detach-on-close policy, retry behavior, and protocol errors.

### 3. Electron Playwright tests

Playwright should launch Electron and interact through Electron/renderer APIs rather than Windows-global automation.

Preferred mechanisms:

- DOM locators for ordinary UI controls;
- `page.evaluate` for structured renderer state;
- `electronApp.evaluate` for Electron main-process operations such as controlled window bounds;
- a narrow test API enabled only by `NEONCODE_TEST_MODE=1` for deterministic terminal input and lifecycle actions.

The test-only renderer API currently exposes:

```js
window.neoncodeTest.getState()
window.neoncodeTest.executeCommand(commandId, args?) // completed or bounded disabled result
window.neoncodeTest.listCommands()                  // shared catalog metadata
window.neoncodeTest.sendText(paneId, text)
window.neoncodeTest.pasteText(paneId, text)
window.neoncodeTest.killPane(paneId)
```

Production code should use the same underlying methods; the test API should not duplicate behavior.

Most Electron tests should not require the app window to be foreground. Keep a small number of Playwright keyboard tests against xterm's focused textarea for actual key mapping. The hidden Electron suite checks F6/Shift+F6 pane focus and Alt+1/2 workspace focus against authoritative renderer state, active DOM/ARIA state, and the focused xterm. It also checks the visible Commands button, `Ctrl+Shift+P`, initial palette focus, keyboard filtering/arrow selection/Enter, Escape focus restoration, catalog-backed Dismiss metadata, and an unclaimed terminal control key after the palette closes. These keyboard checks do not replace hub/session lifecycle assertions through the structured API.

### 4. Windows OS integration smoke

PowerShell/Win32 automation is appropriate only for behavior that inherently belongs to the Windows desktop boundary, such as:

- the published app launches;
- a visible top-level window exists;
- window resize reaches Electron/xterm;
- installer, shortcut, taskbar, DPI, and multi-monitor behavior.

These tests may require a dedicated interactive desktop or CI worker. They should not be the primary proof of command execution, Ctrl+C, session persistence, or reconnect behavior.

## Output marker design

Interactive terminals echo command input, so this is unsafe:

```text
type:  printf 'result-token\n'
wait:  output contains result-token
```

The assertion can pass before the shell executes the command.

Instead, construct output so the final marker is absent from the typed command:

```sh
printf 'result-%s\n' 'token'
```

Then assert `result-token`. Other options are base64-decoding a random token in the shell or disabling echo for a tightly controlled test. Assertions should also distinguish command completion from output receipt.

## Electron test migration status

- [x] Add the test-only structured renderer API behind `NEONCODE_TEST_MODE=1`.
- [x] Run functional Playwright tests in a hidden Electron window.
- [x] Assert context isolation, renderer sandboxing, absent Node globals, exact preload API surface, denied new windows, and denied permissions.
- [x] Rewrite command, paste, Ctrl+C, tool, and resize assertions in Playwright.
- [x] Replace literal echoed markers with markers constructed only by executed commands.
- [x] Remove core functional dependencies on `%TEMP%\NeonCode\electron-app-main.log`, global clipboard state, and `SendKeys`.
- [x] Remove the old focus-sensitive PowerShell functional smoke scripts.
- [x] Add close/reopen/reattach coverage using a stable session prefix and a real test hub.
- [x] Verify pre-close output is replayed with contiguous output sequence numbers after reattach.
- [x] Verify forced same-incarnation reconnect uses missed-only replay without resetting renderer sequence state.
- [x] Use an isolated desktop config directory for every Electron test run.
- [x] Verify configured pane titles and process cwd, real xterm Ctrl+D/Ctrl+Z/navigation/function-key byte paths, selection/clipboard copy, first-use shortcut/DOM paste-race deduplication in both panes, interactive tmux/Neovim workflows, SGR mouse press/release reports, tmux split selection and wheel-activated copy mode, Neovim click positioning and wheel scrolling, Unicode and 20,000-line output with a completion bound and no sequence gap, hub-authoritative session metadata, retained status-7 workspace attention/acknowledgement across relaunch, dynamic two-/three-pane workspace switching with idle/running/detached/available sidebar status transitions, detach/reattach continuity, active-workspace restoration, detach/kill close policies across visited workspaces, forced-socket reconnect with PTY-state continuity, single-instance storage ownership, atomic window/workspace-state restoration, malformed-config backup recovery, and visible unrecoverable-config errors.
- [x] Add mock-WebSocket/fake-clock coverage for authentication/welcome timeouts and malformed checkpoint manifests.
- [x] Add a scripted fake-hub pane test for restart races, stale callback rejection, cursor fallback, and replacement reset.
- [x] Add strict catalog/registry plus pure palette-filter/navigation/keybinding/focus tests and narrow hidden-Electron checks for the keyboard-first defaults and terminal pass-through.
- [x] Add accessible hidden-Electron palette checks for the visible button, shortcut, initial focus, keyboard selection, Escape restoration, and Dismiss command metadata.
- [x] Add exhaustive pure tab/split layout-model and persisted state schema 3 tests; runtime GUI layout checks remain pending.
- [ ] Extend scripted fake-hub coverage to backpressure and malformed output payloads.
- [ ] Add a narrow PowerShell window-launch/desktop compatibility smoke when installer/DPI/multi-monitor work begins.
