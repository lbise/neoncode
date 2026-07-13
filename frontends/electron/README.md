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
```

## Source layout

```text
main.js              Electron main process
renderer.js          renderer bootstrap entrypoint
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

On startup, the renderer calls `list_sessions` to discover existing hub sessions before starting pane sessions.

Default panes use stable frontend session keys instead of deriving session identity from UI indexes:

```text
Pane key: shell  -> session id: <NEONCODE_SESSION_PREFIX>-shell
Pane key: tasks  -> session id: <NEONCODE_SESSION_PREFIX>-tasks
```

## Validation

With the hub running:

```bash
./dev electron-test
```

The test launches a hidden Electron window and uses structured renderer/Electron APIs, not foreground focus, global clipboard state, `SendKeys`, or log scraping.

Manual checks inside a terminal:

```bash
ls --color=always
printf '\e[31mred\e[0m\n'
stty size
nvim
tmux
```
