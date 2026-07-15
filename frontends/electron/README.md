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
renderer.js          browser-bundle bootstrap entrypoint (migration pending)
renderer/app.js      app/bootstrap and pane grid wiring (migration pending)
renderer/hub-client.ts
                     typed WebSocket protocol client and validators
renderer/session-model.ts
                     typed pane/session state and bounded output view
renderer/terminal-pane.js
                     xterm.js pane/input/resize/output handling (migration pending)
renderer/reconnect-policy.ts
                     typed reconnect timing and attach/start fallback policy
renderer/test-api.js
                     structured test API (migration pending)
shared/types.ts      shared protocol and renderer-state contracts
tsconfig.*.json      strict Node, renderer, and test compiler boundaries
dist/                ignored generated CommonJS and renderer bundle
tests/               Node config/auth tests and hidden-window Playwright functional tests
```

`npm run check` performs strict type-checking, creates a clean `dist/`, bundles the browser renderer, and runs unit tests from generated CommonJS. Published Electron also executes only `dist/` artifacts; no runtime TypeScript loader is used. The migration remains intentionally incremental, with unconverted JavaScript copied through the same compiler pipeline.

On startup, Electron main loads `%APPDATA%\\NeonCode\\config.json`, validates configured workspaces/sessions/process profiles, and sends a deeply frozen bootstrap object to the renderer. The renderer calls `list_sessions`, restores the active workspace, attaches matching stable sessions, and starts missing sessions with configured command/args/cwd. The sidebar switches workspaces through detach/reattach and shows hub-owned configured launch cwd when available (with frontend-config fallback) plus aggregate running/reconnecting/detached/available/in-use/error state and retained exit attention with explicit dismissal. The close policy waits for `detached` or `killed` acknowledgements. Attach replays up to 2 MiB of recent ordered terminal output before live output continues, so normal shell history and prompts reappear.

Schema version 4 supports 1–16 named workspaces with 1–8 dynamically rendered panes and simple grid columns, while applying validated font family/size, cursor blink, core theme colors, and a named 16-color ANSI scheme to every xterm pane. Window content size and active workspace are stored atomically in `%APPDATA%\\NeonCode\\state.json`. Valid backups and visible recovery diagnostics protect malformed configuration. See [`docs/configuration.md`](../../docs/configuration.md) for the schema, launch-profile examples, and manual preview workflow.

After authenticated protocol-version/boot-ID negotiation, panes start persistent hub sessions. Unexpected socket loss shows `Reconnecting` with capped exponential backoff, then attaches the same PTY and replay stream. If the hub rebooted, attach falls back once to a fresh persistent session. Graceful window close still follows the configured detach/kill policy.

Configured panes use stable frontend session keys instead of deriving session identity from UI indexes:

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

The test launches a hidden Electron window and uses structured renderer/Electron APIs, restoring clipboard state after copy checks rather than relying on it for terminal/session correctness. It does not use foreground-window automation, `SendKeys`, or log scraping. It switches between two- and three-pane workspaces, verifies hub session metadata, retained status-7 exit attention/acknowledgement, sidebar lifecycle transitions, detach/reattach state continuity, and closes/reopens the real Electron app to verify active-workspace restoration.

Automated terminal coverage includes navigation/function keys, Ctrl+C/D/Z, selection copy and paste-race handling, interactive tmux/Neovim workflows, SGR mouse reports, tmux split/copy-mode mouse handling, Neovim click/wheel handling, Unicode, and a 20,000-line output soak.

Manual checks inside a terminal:

```bash
ls --color=always
printf '\e[31mred\e[0m\n'
stty size
nvim
tmux
```
