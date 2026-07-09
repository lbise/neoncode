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
                     pane/session state mirrored to test state
renderer/terminal-pane.js
                     xterm.js pane, input, resize, output handling
tests/               Playwright smoke tests
```

## Validation

With hub and app running:

```bash
./dev electron-xterm-smoke -PaneIndex 1
./dev electron-xterm-smoke -PaneIndex 2
./dev electron-xterm-resize-smoke -PaneIndex 1
./dev electron-xterm-resize-smoke -PaneIndex 2
./dev electron-xterm-playwright-smoke
./dev electron-xterm-behavior-smoke -PaneIndex 1
./dev electron-xterm-behavior-smoke -PaneIndex 2
```

Manual checks inside a terminal:

```bash
ls --color=always
printf '\e[31mred\e[0m\n'
stty size
nvim
tmux
```
