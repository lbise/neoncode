# Terminal renderer decision

## Decision

Adopt **Electron + xterm.js** as the default NeonCode app terminal renderer.

Keep the native Windows Terminal embedding work as a fallback/reference/comparison path, not the default product path.

Default path:

```text
Electron shell
  -> xterm.js renderer in DOM
  -> neoncode-hub WebSocket
  -> WSL/Linux PTY via portable-pty
```

Fallback/reference path:

```text
Electron shell
  -> direct native HwndTerminal coordinator
  -> Microsoft.Terminal.Control.dll
  -> neoncode-hub WebSocket
  -> WSL/Linux PTY via portable-pty
```

## Why

The native Windows Terminal path proved that NeonCode can embed a real Windows Terminal renderer, but it carries significant product risk:

- child-HWND focus behavior is subtle;
- minimize/restore and taskbar-return focus restoration still show visible latency;
- Electron/native z-order and bounds synchronization need constant hardening;
- mixed-DPI/multi-monitor behavior remains risky;
- packaging/building `Microsoft.Terminal.Control.dll` requires heavy Windows Terminal/Visual Studio tooling;
- DOM/UI automation cannot directly inspect native terminal panes.

The xterm.js path removes the biggest integration risks:

- terminal is part of the Electron DOM;
- focus/minimize/restore feels much more natural;
- panes/splits/tabs are regular web layout;
- Playwright can inspect and automate much more of the app;
- packaging is simpler;
- the path is more cross-platform;
- the Rust hub/session model remains unchanged.

## What we keep

The Rust backend remains the session owner:

```text
neoncode-hub -> portable-pty -> WSL/Linux shell
```

This means switching renderers does not remove WSL support. `xterm.js` renders terminal bytes; it does not decide where the shell runs.

## node-pty comparison

VS Code uses a shape like:

```text
xterm.js renderer
  -> VS Code terminal service
  -> node-pty
  -> local OS shell/PTY
```

NeonCode currently uses:

```text
xterm.js renderer
  -> WebSocket
  -> Rust neoncode-hub
  -> portable-pty
  -> WSL/Linux shell/PTY
```

So `node-pty` is not required for WSL terminals as long as `neoncode-hub` runs in WSL/Linux.

`node-pty` may still be useful later for a Windows-local terminal mode, such as PowerShell/cmd or direct Windows-side `wsl.exe`, but it is not needed for the current product direction.

## Tradeoffs

### Gains with xterm.js

- simpler Electron integration;
- better focus behavior;
- no native child-window layout/focus fight;
- no Windows Terminal source checkout/build for default app;
- easier test automation;
- easier cross-platform story;
- easier UI composition around tabs/splits/panes.

### Losses vs Windows Terminal renderer

- not the exact native Windows Terminal renderer;
- possible differences in Unicode, emoji, CJK, ligatures, and font fallback;
- browser keyboard event quirks need validation;
- copy/paste/selection/search/hyperlink behavior is app-owned;
- performance under heavy output/large scrollback must be validated.

## Current validation

Initial xterm.js validation:

- Electron xterm app launches;
- two xterm panes connect to `neoncode-hub`;
- sessions start;
- shell output appears;
- manual focus after minimize/restore feels better than native child HWND path;
- xterm smoke helper verifies scripted input produces hub output;
- xterm path handles normalized paste, Ctrl+Shift+V, Shift+Insert, Ctrl+Space → NUL, and Alt+Backspace → ESC DEL;
- xterm resize smoke verifies latest xterm rows/cols match `stty size` from the PTY;
- Playwright smoke launches Electron, asserts DOM/test state, and verifies xterm input produces hub output.

Validation command:

```bash
./dev electron-xterm-smoke -PaneIndex 1
./dev electron-xterm-smoke -PaneIndex 2
./dev electron-xterm-smoke -PaneIndex 1 -PasteText 'echo xtermsmokepaste'
./dev electron-xterm-resize-smoke -PaneIndex 1
./dev electron-xterm-resize-smoke -PaneIndex 2
./dev electron-xterm-playwright-smoke
```

## Current commands

Default app:

```bash
./dev hub
./dev app
```

Explicit xterm app:

```bash
./dev electron-xterm-publish
./dev electron-xterm
```

Native fallback:

```bash
./dev electron-native-publish
./dev electron-native
```

## Next validation checklist

Before building more product UX on xterm.js, validate:

- `stty size` after resize;
- Ctrl+C;
- Ctrl+D;
- Ctrl+Z;
- Ctrl+Space;
- Alt key combinations;
- paste;
- copy/selection;
- Neovim;
- tmux;
- mouse mode in Neovim/tmux;
- large output throughput;
- long-session soak;
- Playwright coverage for Electron shell and xterm DOM state.
