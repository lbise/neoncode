# Electron native terminal architecture options

## Context

The Electron spike proved that NeonCode can combine:

```text
Electron shell
  ⇄ native Windows terminal host
      ⇄ Windows Terminal renderer/control
          ⇄ neoncode-hub
              ⇄ PTY
```

Validated in the spike:

- real Windows Terminal rendering inside an Electron window;
- bash, Neovim, tmux;
- paste and Ctrl+Space handling;
- resize/snap;
- two side-by-side native terminal regions;
- clean native-host process shutdown.

Known remaining issues:

- occasional focus/paint flicker;
- rare taskbar-return refocus race;
- multi-monitor/mixed-DPI still untested;
- current split layout is prototype-only command-line geometry;
- WPF host is useful but may not be the ideal long-term native terminal layer.

## Goals for product architecture

The product architecture should:

- keep Electron available as the polished/cross-platform shell;
- keep the real Windows Terminal renderer on Windows;
- avoid fragile ad hoc focus/z-order hacks;
- stay close to Windows Terminal app-layer behavior where practical;
- support multiple terminal panes/tabs;
- expose explicit lifecycle, bounds, focus, theme, and keybinding semantics;
- keep terminal/session model independent from the GUI toolkit.

## Option 1 — Current spike: Electron + separate WPF terminal host process per pane

```text
Electron BrowserWindow
  └─ child WPF host HWND per terminal pane
       └─ Windows Terminal WPF wrapper
            └─ Microsoft.Terminal.Control.dll
```

### Pros

- Already working.
- Fastest way to validate native Windows Terminal rendering under Electron.
- Reuses the existing WPF prototype code.
- Good reference implementation and fallback.

### Cons

- One process per terminal pane is probably not ideal.
- Focus/flicker behavior is partly ad hoc.
- Electron layout currently maps to native geometry through command-line split options.
- WPF adds an extra layer that may differ from Windows Terminal proper.

### Role

Keep as validated spike/reference. Do not treat this exact shape as the final product architecture.

## Option 2 — Direct native Windows Terminal-style host/coordinator

Preferred long-term Windows direction.

```text
Electron shell
  ⇄ IPC
Native Windows terminal coordinator
  ├─ terminal pane 1
  ├─ terminal pane 2
  └─ terminal pane N
       using Windows Terminal control/app-layer patterns directly
```

The coordinator would be a Windows-native process, likely C++/WinRT or C++/Win32, that owns terminal HWNDs and terminal-control lifecycle. Electron would send explicit commands such as:

```text
create_terminal
close_terminal
set_bounds
focus_terminal
resize_terminal
set_theme
paste
copy
set_keybindings
```

### Why this is attractive

- Closest to how Windows Terminal itself works.
- Better chance of matching Windows Terminal focus, paste, copy, keybinding, selection, warning, and context-menu behavior.
- Cleaner ownership of HWND parenting, z-order, DPI, and activation than scattered Electron/WPF fixes.
- One native coordinator can manage many terminal panes.
- WPF can be removed from the hot path if it proves limiting.

### Relevant Windows Terminal source areas

Initial areas to study/adapt:

```text
src/cascadia/TerminalApp/TerminalPage.cpp
src/cascadia/TerminalApp/AppKeyBindings.cpp
src/cascadia/TerminalApp/AppActionHandlers.cpp
src/cascadia/TerminalApp/Pane.cpp
src/cascadia/TerminalApp/TerminalTab.cpp
src/cascadia/TerminalControl/HwndTerminal.cpp
src/cascadia/TerminalControl/HwndTerminal.hpp
src/cascadia/TerminalControl/ControlInteractivity.cpp
src/cascadia/TerminalControl/TermControl.cpp
```

Important behaviors to understand before implementation:

- focus and activation flow;
- pane/tab focus ownership;
- paste/copy path;
- keybinding routing;
- multiline/large paste warnings;
- selection and mouse handling;
- resize and DPI handling;
- renderer/control creation and teardown;
- app settings mapped into control settings.

### Risks

- More C++/WinRT complexity.
- Higher maintenance burden against Windows Terminal internals.
- More native build/toolchain work.
- Needs careful API boundary so Electron does not become tied to Windows-only implementation details.

### Role

This is the preferred product-shaped Windows terminal-host architecture to investigate next, after documenting the spike result. The current WPF host remains the working fallback while this is researched.

A first concrete API/design sketch is in [`native-terminal-coordinator-design.md`](native-terminal-coordinator-design.md).

## Option 3 — Native coordinator process that still uses WPF internally

```text
Electron shell
  ⇄ IPC
Native WPF coordinator process
  ├─ WPF terminal host 1
  ├─ WPF terminal host 2
  └─ WPF terminal host N
```

### Pros

- Evolution of the proven spike.
- Explicit IPC/bounds/focus protocol without immediately rewriting the host in C++.
- One process can own multiple terminal panes.
- Could reduce process-management and focus hacks.

### Cons

- Still has WPF in the terminal host layer.
- May not fully match Windows Terminal app-layer behavior.
- Could become throwaway if Option 2 becomes viable.

### Role

A pragmatic intermediate step if Option 2 is too large to attempt immediately.

## Option 4 — Electron + native Node addon

```text
Electron main process
  └─ native Node addon
       └─ Windows Terminal HWND/control integration
```

### Pros

- Direct API calls from Electron.
- No separate process IPC.
- Potentially tighter lifecycle integration.

### Cons

- Native crashes can take down Electron.
- Node ABI/build/packaging complexity.
- Still requires Windows Terminal native dependency management.
- Less isolation than a helper/coordinator process.

### Role

Not preferred initially. Reconsider only if process IPC becomes a major limitation.

## Option 5 — Electron + xterm.js

```text
Electron shell
  └─ xterm.js
       ⇄ neoncode-hub
           ⇄ PTY
```

### Pros

- Pure web UI.
- Cleanest Electron layout/docking story.
- Cross-platform terminal renderer.
- Avoids child HWND focus/z-order/DPI issues.

### Cons

- Not the real Windows Terminal renderer.
- Requires a separate fidelity/performance POC.
- Must revalidate Neovim, tmux, mouse mode, keyboard fidelity, colors, scrollback, and performance.

### Role

Possible fallback or non-Windows strategy, but not the preferred Windows direction now that native Windows Terminal embedding has shown promise.

## Option 6 — Separate native floating terminal windows aligned with Electron

```text
Electron shell window
Native terminal windows positioned nearby/over it
```

### Pros

- Avoids child HWND embedding.
- Simpler in some low-level ways.

### Cons

- Bad product feel.
- Z-order and Alt+Tab problems.
- Harder multi-monitor/DPI behavior.
- Terminal can appear to escape the app.

### Role

Avoid unless all embedded/coordinator approaches fail.

## Current recommendation

Use this staged path:

1. Keep the current WPF/Electron spike as the working proof and fallback.
2. Research Windows Terminal app-layer/control architecture in detail.
3. Design a native terminal coordinator API between Electron and the Windows host.
4. Prefer a direct Windows Terminal-style native coordinator if feasible.
5. Use a WPF-based coordinator only as an intermediate path if direct C++/WinRT is too expensive immediately.
6. Continue UI-independent hub/session/protocol work in parallel, because it benefits every frontend.

The product target should be:

```text
Electron shell
  ⇄ platform terminal host/coordinator
      Windows: real Windows Terminal renderer, close to Windows Terminal app-layer behavior
      Linux/macOS: future native renderer or xterm.js strategy TBD
  ⇄ neoncode-hub session protocol
```
