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
- a new WebSocket can list, attach, resize, send input, receive ordered output, and kill a detached session;
- missing/foreign WebSocket origins are rejected;
- missing/incorrect capability challenge responses are rejected without sending the token;
- authenticated connections receive a versioned, per-boot hub welcome;
- persistent sessions retain PTY state across unexpected WebSocket disconnect and remain explicitly killable;
- invalid/overlong session IDs, invalid sizes, oversized decoded input, and oversized transport messages are rejected;
- non-loopback bind addresses and excess WebSocket permits are rejected by unit tests;
- replay is bounded by both raw bytes and entry count;
- the capability token is removed from PTY child environments.

Run:

```bash
cargo test -p neoncode-hub
```

Future hub integration coverage should include transport-level oversized frames, saturated backpressure behavior, attachment/session-limit boundaries, multiple concurrent attachments, and graceful shutdown.

### 2. Renderer unit/integration tests

Renderer state transitions and protocol decisions should be tested without launching Electron where possible.

Use injected/fake dependencies for:

- WebSocket transport;
- terminal surface;
- timers/reconnect backoff;
- persisted configuration.

The current `frontends/electron/tests/hub-client-auth.js` test uses a mock WebSocket plus Node Web Crypto to verify that the renderer sends no bearer token, accepts a valid reciprocal hub proof, and rejects a fake hub proof. `frontends/electron/tests/config-store.js` covers first-run defaults, environment precedence, migration, strict validation, backup recovery, future schemas, state clamping/persistence, stale temporary-file cleanup, unusable missing-primary backups, and injected backup-write failures. `./dev check` runs both without Electron.

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
window.neoncodeTest.sendText(paneId, text)
window.neoncodeTest.pasteText(paneId, text)
window.neoncodeTest.killPane(paneId)
```

Production code should use the same underlying methods; the test API should not duplicate behavior.

Most Electron tests should not require the app window to be foreground. Keep a small number of Playwright keyboard tests against xterm's focused textarea for actual key mapping, but do not use them to validate hub/session lifecycle.

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
- [x] Use an isolated desktop config directory for every Electron test run.
- [x] Verify configured pane titles and process cwd, real xterm Ctrl+D/Ctrl+Z/navigation/function-key byte paths, selection/clipboard copy, first-use shortcut/DOM paste-race deduplication in both panes, interactive tmux/Neovim workflows, Unicode and 2,000-line output, detach/kill close policies, forced-socket reconnect with PTY-state continuity, single-instance storage ownership, atomic window-size restoration, malformed-config backup recovery, and visible unrecoverable-config errors.
- [ ] Add renderer tests with a fake hub for errors, timeouts, and reconnect state transitions.
- [ ] Add a narrow PowerShell window-launch/desktop compatibility smoke when installer/DPI/multi-monitor work begins.
