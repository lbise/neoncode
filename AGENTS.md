# NeonCode agent guide

This file documents the project-specific tools, commands, and validation workflow for coding agents working in this repository.

## Current product direction

Default app path:

```text
Electron shell
  -> xterm.js renderer in the DOM
  -> neoncode-hub WebSocket
  -> WSL/Linux PTY
```

Fallback/reference/comparison paths:

```text
Electron shell -> direct native Windows Terminal HwndTerminal coordinator -> neoncode-hub
Electron shell -> WPF native terminal host -> neoncode-hub
WPF reference app -> Windows Terminal WPF wrapper -> neoncode-hub
```

Product direction is moving to Electron + xterm.js because it avoids child-HWND focus/polish risk and is much easier to automate. Keep native Windows Terminal embedding paths working as fallback/comparison, but do not build new product UX on them unless explicitly requested.

## Important paths

```text
hub/                                                        Rust neoncode-hub backend
spikes/electron-native-terminal/electron/                  Electron shell
spikes/electron-native-terminal/native/NeonCode.NativeTerminalCoordinator/
                                                            Direct HwndTerminal coordinator
spikes/electron-native-terminal/native/NeonCode.ElectronTerminalHost/
                                                            WPF native host fallback
spikes/electron-xterm/                                     Electron xterm.js renderer spike
frontends/windows/NeonCode.Windows/                        WPF reference app
docs/hub.md                                                Hub usage/lifecycle docs
docs/protocol.md                                           Hub WebSocket protocol docs
spikes/electron-native-terminal/README.md                  Electron/native coordinator docs
```

Windows-local publish outputs:

```text
%USERPROFILE%\neoncode-electron-spike        Electron app/native-host staging
%USERPROFILE%\neoncode-electron-xterm-spike  Electron xterm.js spike staging
%USERPROFILE%\neoncode-publish               WPF reference app staging
```

Debug logs:

```text
%TEMP%\NeonCode\electron-native-spike-main.log
%TEMP%\NeonCode\direct-coordinator-<pid>-pane-<n>.log
```

## Daily commands

Run from WSL repo root unless noted.

```bash
./dev hub       # run Rust hub on 127.0.0.1:44777
./dev app       # publish/start Electron xterm.js app, two panes
./dev publish   # publish Electron xterm.js app only
./dev check     # JS syntax + WPF builds + Rust fmt/check/clippy
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

## Electron/xterm.js commands

```bash
./dev electron-xterm-publish # publish xterm.js renderer app/spike
./dev electron-xterm         # start published xterm.js renderer app/spike
./dev electron-xterm-install # npm install in source spike directory
./dev electron-xterm-smoke          # validate running xterm app hub input/output
./dev electron-xterm-resize-smoke   # validate xterm resize propagation with stty size
```

This is now the default app path used by `./dev app` and `./dev publish`.

This path uses:

```text
xterm.js in Electron DOM -> WebSocket -> Rust neoncode-hub -> portable-pty -> WSL/Linux PTY
```

It intentionally does not use `node-pty`. `node-pty` would be relevant for a VS Code-like local Electron terminal backend, especially Windows-local PowerShell/cmd or Windows-side `wsl.exe`, but NeonCode's current backend model remains Rust hub over WebSocket.

## Electron/native Windows Terminal fallback commands

```bash
./dev electron-native                 # start published Electron app with direct coordinator
./dev electron-native-wpf             # start published Electron app with WPF native host fallback
./dev electron-native-publish         # publish Electron app/native hosts
./dev electron-spike                  # legacy alias for electron-native
./dev electron-spike-wpf              # legacy alias for electron-native-wpf
./dev electron-spike-publish          # legacy alias for electron-native-publish
./dev electron-spike-native           # build WPF host + direct coordinator
./dev electron-spike-coordinator      # build only direct coordinator
./dev electron-spike-direct-hub-smoke # validate direct coordinator hub IO against running app
./dev electron-spike-focus-test       # minimize/restore/focus stress for running app
```

Direct coordinator hub smoke examples:

```bash
./dev electron-spike-direct-hub-smoke -PaneIndex 1
./dev electron-spike-direct-hub-smoke -PaneIndex 2
```

The smoke helper verifies:

- selected pane connected to hub;
- session started;
- terminal HWND was found;
- posted `WM_CHAR` input reached the coordinator;
- hub output arrived after input.

Focus stress example:

```bash
./dev electron-spike-focus-test -Cycles 10
```

Known focus issue: taskbar/minimize/restore can still show a visible refocus delay. Treat this as deferred polish unless the task is specifically about focus hardening.

## WPF reference/fallback commands

```bash
./dev wpf-app      # publish/start WPF reference app
./dev wpf-publish  # publish WPF reference app
./dev wpf-run      # run already-published WPF reference app
./dev wpf-stop     # stop WPF reference app
```

Do not remove or break WPF paths casually; they are the proven fallback/reference for Windows Terminal hosting and hub protocol behavior.

## Rust hub checks

```bash
cargo fmt --check
cargo check
cargo clippy --all-targets -- -D warnings
```

Hub-only quick checks:

```bash
cargo check -p neoncode-hub
cargo clippy -p neoncode-hub --all-targets -- -D warnings
```

Hub docs/protocol:

```text
docs/hub.md
docs/protocol.md
```

Keep these synchronized when changing hub behavior or protocol messages.

## Windows Terminal dependency commands

```bash
./dev wt-bootstrap
./dev wt-build
./dev full
```

Pinned dependency details live in:

```text
deps/windows-terminal.json
patches/windows-terminal/
scripts/bootstrap-windows-terminal.ps1
scripts/build-windows-terminal-control.ps1
docs/windows-terminal-embedding.md
```

Important: use Git for Windows for the Windows Terminal checkout. Avoid WSL Git over `/mnt/c` for that dependency.

## Playwright tooling

A project skill exists and should be used for browser automation tasks:

```text
.agents/skills/playwright-cli/SKILL.md
```

Available CLI style from the skill:

```bash
playwright-cli open
playwright-cli snapshot
playwright-cli click <ref>
playwright-cli type "text"
playwright-cli press Enter
playwright-cli close
```

Fallback if global `playwright-cli` is unavailable:

```bash
npx --no-install playwright-cli --version
npx playwright-cli <command>
```

Repo config:

```text
.playwright/cli.config.json
```

### What Playwright can test well here

Playwright is useful for the Electron/web shell layer:

- verifying the Electron header/web UI renders;
- inspecting DOM snapshots;
- clicking future web UI controls;
- testing command palette/settings UI once added;
- collecting console/network/tracing info;
- coordinating higher-level smoke workflows.

### What Playwright cannot test alone

The terminal panes are native child HWNDs, not DOM elements. Playwright cannot deeply inspect the Windows Terminal renderer contents or native HWND focus by itself.

For native terminal validation, combine Playwright with:

- PowerShell/Win32 helpers;
- coordinator stdout events in Electron logs;
- `%TEMP%\NeonCode\direct-coordinator-*.log`;
- `./dev electron-spike-direct-hub-smoke`;
- screenshot/image checks if visual layout needs verification.

Recommended future test shape:

```text
Playwright: launch/inspect Electron shell and UI
PowerShell/Win32: locate native HWNDs, send input, check process/window state
Coordinator logs/events: assert hub_connected/hub_started/hub_output/focus_changed
```

## Manual terminal validation commands

Inside an embedded terminal:

```bash
ls --color=always
printf '\e[31mred\e[0m\n'
nvim
tmux
stty size
```

Also test when relevant:

- click/focus each pane;
- type independently in both panes;
- resize/snap/unsnap Electron window;
- minimize/restore;
- copy/paste;
- Ctrl+C / Ctrl+D / Ctrl+Z;
- Alt key combinations;
- closing Electron cleans up native host processes.

## Useful log commands

Windows PowerShell:

```powershell
Get-ChildItem $env:TEMP\NeonCode\*.log | Sort-Object LastWriteTime
Get-Content $env:TEMP\NeonCode\electron-native-spike-main.log -Tail 200
Get-Content $env:TEMP\NeonCode\direct-coordinator-*.log -Tail 200
Select-String -Path $env:TEMP\NeonCode\electron-native-spike-main.log -Pattern "hub_connected|hub_started|hub_output|focus_changed|host.command.bounds"
```

From WSL:

```bash
powershell.exe -NoProfile -Command 'Get-Content $env:TEMP\NeonCode\electron-native-spike-main.log -Tail 200'
```

## Validation expectations before committing

For Rust-only changes:

```bash
cargo fmt --check
cargo check
cargo clippy --all-targets -- -D warnings
```

For Electron/native coordinator changes:

```bash
bash -n dev
node --check spikes/electron-native-terminal/electron/main.js
./dev electron-spike-coordinator
./dev check
./dev publish
```

For Electron/xterm.js spike changes:

```bash
bash -n dev
node --check spikes/electron-xterm/main.js
node --check spikes/electron-xterm/renderer.js
./dev electron-xterm-publish
```

If the task affects xterm hub/input behavior, also run against a live app/hub:

```bash
./dev electron-xterm-smoke -PaneIndex 1
./dev electron-xterm-smoke -PaneIndex 2
./dev electron-xterm-resize-smoke -PaneIndex 1
./dev electron-xterm-resize-smoke -PaneIndex 2
```

If the task affects direct coordinator hub behavior, also run against a live app/hub:

```bash
./dev electron-spike-direct-hub-smoke -PaneIndex 1
./dev electron-spike-direct-hub-smoke -PaneIndex 2
```

For docs-only changes, at minimum run:

```bash
git diff --check
```

## Process hygiene

Before publish/run tests, stop stale Windows processes when needed:

```powershell
Get-Process electron,NeonCode.NativeTerminalCoordinator,NeonCode.ElectronTerminalHost,NeonCode.Windows -ErrorAction SilentlyContinue | Stop-Process -Force
```

Common transient issue: MSBuild may fail with `LNK1104` on `NeonCode.NativeTerminalCoordinator.exe` if a stale coordinator process still holds the file. Stop processes and retry.

## Current known deferred issues

- visible restore/refocus delay after minimize/restore;
- multi-monitor/mixed-DPI validation still needs real hardware coverage;
- direct coordinator protocol is still line-based for Electron->native bounds/focus commands;
- automatic reconnect/list/attach flow has not been added to the direct coordinator yet;
- native terminal visual/layout testing needs deeper automation beyond DOM-only Playwright.
