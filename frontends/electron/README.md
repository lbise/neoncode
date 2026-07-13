# NeonCode Electron app

This is the default Windows app for NeonCode.

Architecture:

```text
Electron
  -> xterm.js terminal panes
  -> neoncode-hub WebSocket
  -> WSL/Linux PTY
```

It intentionally does not use native Windows Terminal embedding or `node-pty`.

Pinned test/runtime tooling:

```text
Electron 43.1.0
Playwright 1.61.1
```

Electron 43 uses an explicit `install-electron` executable rather than a package lifecycle script. The publish helper runs that exact installer after `npm ci`, then bundles the browser-world renderer with `esbuild-wasm`.

Renderer security defaults:

```text
contextIsolation: true
nodeIntegration: false
sandbox: true
```

The preload exposes only validated bootstrap configuration, bounded clipboard reads/writes, and graceful-close coordination. CSP, navigation, new-window, webview, and permission restrictions are enforced by the Electron main process.

The WSL wrapper launches the visible app through Windows Explorer so Electron runs at medium integrity rather than inheriting an elevated WSL PowerShell token. Electron reads the mode-0600 hub token through `wsl.exe`; the token is not placed on the launch command line.

Hub WebSockets require `Origin: file://` plus a per-user mutual HMAC challenge-response. `./dev` creates the 256-bit token in a mode-0600 WSL state file and propagates it to both processes without copying it into publish output or sending the raw token over the socket.

## Run

From repo root:

```bash
./dev hub
./dev app
```

Explicit commands:

```bash
./dev publish
./dev electron
./dev electron-stop  # force-stop only the published NeonCode Electron runtime
./dev reset-token    # rotate token, then restart hub and app
```

## Source layout

```text
main.js              Electron main process, security policy, and window-state lifecycle
config-store.js      versioned config/state validation, migration, recovery, and atomic IO
preload.js           narrow context-isolated desktop bridge
renderer.js          browser-bundle bootstrap entrypoint
renderer/app.js      app/bootstrap and pane grid wiring
renderer/hub-client.js
                     WebSocket protocol client helpers
renderer/session-model.js
                     pane/session state and bounded output view
renderer/terminal-pane.js
                     xterm.js pane, input, resize, output handling
renderer/test-api.js
                     structured API enabled only in test mode
tests/               Node config/auth tests and hidden-window Playwright functional tests
```

On startup, Electron main loads `%APPDATA%\\NeonCode\\config.json`, validates configured sessions/process profiles, and sends a deeply frozen bootstrap object to the renderer. The renderer calls `list_sessions`, attaches matching stable sessions, and starts missing sessions with configured command/args/cwd. The close policy waits for `detached` or `killed` acknowledgements. Attach replays up to 2 MiB of recent ordered terminal output before live output continues, so normal shell history and prompts reappear.

Schema version 2 applies validated font family/size, cursor blink, core theme colors, and a 16-color ANSI table to every xterm pane. Window content size is stored atomically in `%APPDATA%\\NeonCode\\state.json`. Valid backups and visible recovery diagnostics protect malformed configuration. See [`docs/configuration.md`](../../docs/configuration.md) for the schema, launch-profile examples, and manual preview workflow.

After authenticated protocol-version/boot-ID negotiation, panes start persistent hub sessions. Unexpected socket loss shows `Reconnecting` with capped exponential backoff, then attaches the same PTY and replay stream. If the hub rebooted, attach falls back once to a fresh persistent session. Graceful window close still follows the configured detach/kill policy.

Default panes use stable frontend session keys instead of deriving session identity from UI indexes:

```text
Pane key: shell  -> session id: <NEONCODE_SESSION_PREFIX>-shell
Pane key: tasks  -> session id: <NEONCODE_SESSION_PREFIX>-tasks
```

Dependency audit:

```bash
./dev electron-audit
```

## Validation

With the hub running:

```bash
./dev electron-test
```

The test launches a hidden Electron window and uses structured renderer/Electron APIs, restoring clipboard state after copy checks rather than relying on it for terminal/session correctness. It does not use foreground-window automation, `SendKeys`, or log scraping. It closes/reopens the real Electron app and verifies the same shell state survives reattachment.

Automated terminal coverage includes navigation/function keys, Ctrl+C/D/Z, selection copy and paste-race handling, interactive tmux/Neovim workflows, SGR mouse reports, Unicode, and a 20,000-line output soak.

Manual checks inside a terminal:

```bash
ls --color=always
printf '\e[31mred\e[0m\n'
stty size
nvim
tmux
```
