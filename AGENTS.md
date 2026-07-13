# NeonCode agent guide

## Product direction

Supported Windows app stack:

```text
Electron shell
  -> xterm.js renderer in the DOM
  -> neoncode-hub WebSocket
  -> WSL/Linux PTY
```

Previous Windows Terminal/WPF embedding POCs are obsolete. Do not build new work on native Windows Terminal embedding, WPF hosting, or child-HWND terminal coordination.

## Important paths

```text
hub/                              Rust neoncode-hub backend
frontends/electron/               Electron + xterm.js app
docs/product-requirements.md      Product requirements / PRD
docs/architecture.md              Current technical architecture
docs/development-plan.md          Roadmap and progress tracker
docs/hub.md                       Hub usage/lifecycle docs
docs/protocol.md                  Hub WebSocket protocol docs
docs/terminal-renderer-decision.md Renderer decision record
docs/external-tool-inspiration.md cmux/wmux/t3code analysis
```

Windows-local publish output:

```text
%USERPROFILE%\neoncode-electron
```

Debug log:

```text
%TEMP%\NeonCode\electron-app-main.log
```

## Daily commands

Run from WSL repo root unless noted.

```bash
./dev hub       # run Rust hub on 127.0.0.1:44777
./dev app       # publish/start Electron app, two xterm panes
./dev publish   # publish Electron app only
./dev check     # JS syntax + Rust fmt/check/clippy
```

The app expects the hub at:

```text
ws://127.0.0.1:44777/ws
```

Typical manual loop:

```bash
# terminal 1
./dev hub

# terminal 2
./dev app
```

## Electron app commands

```bash
./dev electron-publish              # publish Electron app
./dev electron                      # start published Electron app
./dev electron-install              # npm install in source app directory
./dev electron-xterm-smoke          # validate running app hub input/output
./dev electron-xterm-resize-smoke   # validate resize propagation with stty size
./dev electron-xterm-playwright-smoke # validate DOM/state/input with Playwright
./dev electron-xterm-behavior-smoke # validate command/Ctrl+C/tool availability
```

This path uses:

```text
xterm.js in Electron DOM -> WebSocket -> Rust neoncode-hub -> portable-pty -> WSL/Linux PTY
```

It intentionally does not use `node-pty`. `node-pty` would be relevant for a VS Code-like local Electron terminal backend, especially Windows-local PowerShell/cmd or Windows-side `wsl.exe`, but NeonCode's current backend model remains Rust hub over WebSocket.

## Rust hub checks

```bash
cargo fmt --check
cargo check
cargo test
cargo clippy --all-targets -- -D warnings
```

Hub-only quick checks:

```bash
cargo check -p neoncode-hub
cargo test -p neoncode-hub
cargo clippy -p neoncode-hub --all-targets -- -D warnings
```

Hub docs/protocol:

```text
docs/hub.md
docs/protocol.md
```

Keep these synchronized when changing hub behavior or protocol messages.

## Playwright tooling

A project skill exists for Playwright CLI usage:

```text
.agents/skills/playwright-cli/SKILL.md
```

Repo config:

```text
.playwright/cli.config.json
```

Playwright is useful for the Electron/web shell layer:

- verifying the Electron header/web UI renders;
- inspecting DOM snapshots;
- clicking future web UI controls;
- testing command palette/settings UI once added;
- collecting console/network/tracing info;
- coordinating higher-level smoke workflows.

Testing strategy and automation-layer guidance:

```text
docs/testing.md
```

For the Electron app, also use the app-level Playwright smoke:

```bash
./dev electron-xterm-playwright-smoke
```

## Useful log commands

Windows PowerShell:

```powershell
Get-ChildItem $env:TEMP\NeonCode\*.log | Sort-Object LastWriteTime
Get-Content $env:TEMP\NeonCode\electron-app-main.log -Tail 200
Select-String -Path $env:TEMP\NeonCode\electron-app-main.log -Pattern "hub_connected|hub_started|hub_output|terminal_input|terminal_resize"
```

From WSL:

```bash
powershell.exe -NoProfile -Command 'Get-Content $env:TEMP\NeonCode\electron-app-main.log -Tail 200'
```

## Validation expectations before committing

For Rust-only changes:

```bash
cargo fmt --check
cargo check
cargo test
cargo clippy --all-targets -- -D warnings
```

For Electron app changes:

```bash
bash -n dev
find frontends/electron -path 'frontends/electron/node_modules' -prune -o -name '*.js' -print0 | xargs -0 -n1 node --check
./dev publish
```

If the task affects terminal hub/input behavior, also run against a live app/hub:

```bash
./dev electron-xterm-smoke -PaneIndex 1
./dev electron-xterm-smoke -PaneIndex 2
./dev electron-xterm-resize-smoke -PaneIndex 1
./dev electron-xterm-resize-smoke -PaneIndex 2
./dev electron-xterm-playwright-smoke
./dev electron-xterm-behavior-smoke -PaneIndex 1
./dev electron-xterm-behavior-smoke -PaneIndex 2
```

For docs-only changes, at minimum run:

```bash
git diff --check
```

## Process hygiene

Before publish/run tests, stop stale Electron processes when needed:

```powershell
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force
```
