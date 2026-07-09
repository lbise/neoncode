# Electron xterm.js spike

Goal: make the default Electron terminal path use a pure web terminal renderer instead of native Windows Terminal child-HWND embedding.

This app intentionally reuses `neoncode-hub` so the renderer can change without changing backend/session architecture.

## Architecture

```text
Electron BrowserWindow
  -> xterm.js terminals in DOM
  -> WebSocket ws://127.0.0.1:44777/ws
  -> neoncode-hub
  -> portable-pty
  -> WSL/Linux shell
```

This does **not** use `node-pty`.

## Why no node-pty for this spike?

VS Code uses roughly:

```text
xterm.js renderer
  -> VS Code terminal service
  -> node-pty
  -> local OS shell/PTY
```

That works well when the terminal backend lives inside the Electron/Node app.

NeonCode currently uses:

```text
xterm.js renderer
  -> WebSocket
  -> Rust neoncode-hub
  -> portable-pty
  -> WSL/Linux shell/PTY
```

So `node-pty` is not required to open a WSL terminal as long as `neoncode-hub` runs in WSL/Linux and can spawn the PTY.

`node-pty` may still be useful later for a Windows-local backend mode, for example:

- Windows PowerShell/cmd without the Rust hub;
- Windows-side `wsl.exe` launch from Electron;
- a VS Code-like local-only terminal implementation.

But using `node-pty` would add native Node module packaging/rebuild concerns. For NeonCode's session cockpit model, keeping terminal sessions in the Rust hub is still the cleaner backend direction.

## Expected gains vs native Windows Terminal embedding

Potential gains:

- no child HWND embedding;
- no Windows Terminal source build;
- no `Microsoft.Terminal.Control.dll` dependency;
- simpler Electron layout/splits/tabs;
- easier focus/minimize/restore behavior;
- much easier Playwright/DOM testing;
- more cross-platform product path;
- simpler packaging.

Potential losses:

- not the exact Windows Terminal renderer;
- different font shaping/emoji/CJK/ligature behavior;
- different selection/copy/paste feel;
- browser/Electron keyboard event quirks;
- we own more terminal UX polish ourselves;
- need performance validation under heavy output/large scrollback.

## Run

Terminal 1:

```bash
./dev hub
```

Terminal 2:

```bash
./dev app
```

Equivalent explicit xterm commands:

```bash
./dev electron-xterm-publish
./dev electron-xterm
```

Optional one-pane mode:

```bash
./dev electron-xterm -TerminalCount 1
```

Default publish output:

```text
%USERPROFILE%\neoncode-electron-xterm-spike
```

## Validation checklist

Inside each xterm terminal:

```bash
ls --color=always
printf '\e[31mred\e[0m\n'
stty size
nvim
tmux
```

Automated smoke helpers:

```bash
./dev electron-xterm-smoke -PaneIndex 1
./dev electron-xterm-smoke -PaneIndex 2
./dev electron-xterm-smoke -PaneIndex 1 -PasteText 'echo xtermsmokepaste'
./dev electron-xterm-resize-smoke -PaneIndex 1
./dev electron-xterm-resize-smoke -PaneIndex 2
./dev electron-xterm-playwright-smoke
```

Also test:

- resize Electron window and confirm `stty size` changes; automated by `./dev electron-xterm-resize-smoke`;
- two independent panes;
- copy/paste;
- Ctrl+C / Ctrl+D / Ctrl+Z;
- Ctrl+Space;
- Alt+Backspace and other Alt key combinations;
- mouse mode in Neovim/tmux;
- large output flood, e.g. `find /usr -maxdepth 4`;
- minimize/restore refocus behavior;
- Playwright inspection of the DOM shell; automated by `./dev electron-xterm-playwright-smoke`.

## Current status

Adopted as the default `./dev app` path after quick manual validation showed better focus/minimize/restore behavior and simpler visual integration than native Windows Terminal embedding.

The direct native Windows Terminal coordinator remains available as a fallback/comparison path through `./dev electron-native`.

Current input handling includes normalized paste, Ctrl+Shift+V, Shift+Insert, Ctrl+Space → NUL, and Alt+Backspace → ESC DEL.
