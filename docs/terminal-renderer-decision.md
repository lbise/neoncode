# Terminal renderer decision

## Decision

Adopt **Electron + xterm.js** as the Windows terminal renderer for NeonCode.

The previous native Windows Terminal embedding POCs are obsolete. They proved useful facts, but they are not a fallback product path.

Supported path:

```text
Electron shell
  -> xterm.js renderer in DOM
  -> neoncode-hub WebSocket
  -> WSL/Linux PTY via portable-pty
```

## Why

The native Windows Terminal path proved that NeonCode can embed a real Windows Terminal renderer, but it carries significant product risk:

- child-HWND focus behavior is subtle;
- minimize/restore and taskbar-return focus restoration showed visible latency;
- Electron/native z-order and bounds synchronization need constant hardening;
- mixed-DPI/multi-monitor behavior is risky;
- packaging/building `Microsoft.Terminal.Control.dll` requires heavy Windows Terminal/Visual Studio tooling;
- DOM/UI automation cannot directly inspect native terminal panes.

The xterm.js path removes the biggest integration risks:

- terminal is part of the Electron DOM;
- focus/minimize/restore feels natural;
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
- no Windows Terminal source checkout/build;
- easier test automation;
- easier cross-platform story;
- easier UI composition around tabs/splits/panes.

### Costs vs Windows Terminal renderer

- not the exact native Windows Terminal renderer;
- possible differences in Unicode, emoji, CJK, ligatures, and font fallback;
- browser keyboard event quirks need validation;
- copy/paste/selection/search/hyperlink behavior is app-owned;
- performance under heavy output/large scrollback must be validated.

These costs are acceptable compared with the native child-HWND integration risk.

## Current validation

Validated xterm.js behavior:

- Electron app launches;
- two xterm panes connect to `neoncode-hub`;
- sessions start;
- shell output appears;
- scripted input produces hub output;
- normalized paste works;
- duplicate paste suppression works;
- Ctrl+Shift+V and Shift+Insert paste work;
- Ctrl+Space → NUL;
- Alt+Backspace → ESC DEL;
- resize smoke verifies latest xterm rows/cols match `stty size` from the PTY;
- Playwright smoke launches Electron, asserts DOM/test state, and verifies xterm input produces hub output;
- behavior smoke verifies basic command round-trip, Ctrl+C signal handling, and tmux/nvim availability reporting.

Validation commands:

```bash
./dev electron-xterm-smoke -PaneIndex 1
./dev electron-xterm-smoke -PaneIndex 2
./dev electron-xterm-smoke -PaneIndex 1 -PasteText 'echo xtermsmokepaste'
./dev electron-xterm-resize-smoke -PaneIndex 1
./dev electron-xterm-resize-smoke -PaneIndex 2
./dev electron-xterm-playwright-smoke
./dev electron-xterm-behavior-smoke -PaneIndex 1
./dev electron-xterm-behavior-smoke -PaneIndex 2
```

## Current commands

Default app:

```bash
./dev hub
./dev app
```

Explicit app commands:

```bash
./dev publish
./dev electron
```

## Next validation checklist

Before building much more product UX, validate:

- Ctrl+D;
- Ctrl+Z;
- broader Alt key combinations;
- copy/selection;
- Neovim interactive behavior;
- tmux interactive behavior;
- mouse mode in Neovim/tmux;
- large output throughput;
- long-session soak.
