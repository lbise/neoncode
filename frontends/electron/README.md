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

The preload exposes only validated bootstrap configuration, clipboard reads, and graceful-close coordination. CSP, navigation, new-window, webview, and permission restrictions are enforced by the Electron main process.

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
./dev reset-token  # rotate token, then restart hub and app
```

## Source layout

```text
main.js              Electron main process and security policy
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
tests/               hidden-window Playwright functional tests
```

On startup, the renderer calls `list_sessions`, attaches matching stable sessions, and starts missing sessions. A normal Electron window close waits for `detached` acknowledgements so hub sessions survive and are reattached on the next launch. Attach replays up to 2 MiB of recent ordered terminal output before live output continues, so normal shell history and prompts reappear.

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

The test launches a hidden Electron window and uses structured renderer/Electron APIs, not foreground focus, global clipboard state, `SendKeys`, or log scraping. It closes/reopens the real Electron app and verifies the same shell state survives reattachment.

Manual checks inside a terminal:

```bash
ls --color=always
printf '\e[31mred\e[0m\n'
stty size
nvim
tmux
```
