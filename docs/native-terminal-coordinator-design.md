# Native Windows Terminal coordinator design sketch

## Purpose

This document sketches the next Windows terminal-host architecture for NeonCode after the successful Electron + WPF host spike.

The preferred direction is to keep Electron as the polished shell while moving the Windows terminal host closer to Windows Terminal's own native app/control layering.

Target shape:

```text
Electron shell
  ⇄ coordinator IPC
Native Windows terminal coordinator
  ├─ terminal pane 1 HWND
  ├─ terminal pane 2 HWND
  └─ terminal pane N HWND
       ⇄ Microsoft.Terminal.Control / Windows Terminal control internals
           ⇄ neoncode-hub WebSocket/session protocol
               ⇄ PTY
```

## Why a coordinator

The spike proved that child HWND hosting is viable, but the exact WPF-per-pane process model is not ideal as a product architecture.

A coordinator gives us one native Windows component that owns:

- terminal HWND creation/destruction;
- child-window parenting into Electron;
- bounds/layout application;
- focus/activation rules;
- DPI changes;
- theme/font updates;
- copy/paste/keybinding bridge;
- PTY input/output bridge;
- multi-pane lifecycle.

Electron should own product UI/layout intent. The native coordinator should own Windows terminal HWND mechanics.

## Windows Terminal source findings

### Direct native entry point: `HwndTerminal`

The strongest direct-native lead is Windows Terminal's `HwndTerminal` layer:

```text
/mnt/c/Users/13lbise/gitrepo/microsoft-terminal/src/cascadia/TerminalControl/HwndTerminal.hpp
/mnt/c/Users/13lbise/gitrepo/microsoft-terminal/src/cascadia/TerminalControl/HwndTerminal.cpp
```

Important exported functions:

```cpp
CreateTerminal(HWND parentHwnd, void** hwnd, void** terminal)
DestroyTerminal(void* terminal)
TerminalTriggerResize(void* terminal, width, height, til::size* dimensions)
TerminalTriggerResizeWithDimension(void* terminal, til::size dimensions, til::size* dimensionsInPixels)
TerminalCalculateResize(void* terminal, width, height, til::size* dimensions)
TerminalDpiChanged(void* terminal, int newDpi)
TerminalSetTheme(void* terminal, TerminalTheme theme, LPCWSTR fontFamily, til::CoordType fontSize, int newDpi)
TerminalRegisterWriteCallback(void* terminal, callback)
TerminalSendOutput(void* terminal, LPCWSTR data)
TerminalSendKeyEvent(void* terminal, WORD vkey, WORD scanCode, WORD flags, bool keyDown)
TerminalSendCharEvent(void* terminal, wchar_t ch, WORD flags, WORD scanCode)
TerminalClearSelection(void* terminal)
TerminalGetSelection(void* terminal)
TerminalIsSelectionActive(void* terminal)
TerminalSetFocus(void* terminal)
TerminalKillFocus(void* terminal)
```

This is promising because it is already a framework-independent child HWND terminal with Atlas rendering, mouse handling, selection, clipboard helpers, UI Automation, resize, DPI, and theme hooks.

The currently built pinned DLL was checked for key export names and contains:

```text
CreateTerminal
TerminalTriggerResize
TerminalSetTheme
TerminalSendKeyEvent
TerminalSetFocus
DestroyTerminal
```

This does not prove ABI/product stability, but it confirms the direct-native POC can start from the existing built `Microsoft.Terminal.Control.dll` rather than immediately compiling a separate renderer stack.

### Control and app-layer behavior to study/adapt

Relevant source areas:

```text
src/cascadia/TerminalApp/TerminalPage.cpp
src/cascadia/TerminalApp/AppActionHandlers.cpp
src/cascadia/TerminalApp/AppKeyBindings.cpp
src/cascadia/TerminalApp/Pane.cpp
src/cascadia/TerminalApp/TerminalTab.cpp
src/cascadia/TerminalControl/HwndTerminal.cpp
src/cascadia/TerminalControl/ControlInteractivity.cpp
src/cascadia/TerminalControl/ControlCore.cpp
src/cascadia/TerminalControl/TermControl.cpp
```

Patterns worth copying conceptually:

- TerminalPage owns app actions and routes them to the focused tab/pane.
- TerminalTab owns active pane state and MRU pane focus.
- Pane owns split tree, neighbor navigation, focus events, and content lifecycle.
- TermControl routes key events through keybindings first, then sends unhandled keys to the terminal.
- ControlInteractivity exposes copy/paste/focus/mouse interaction while delegating terminal state to ControlCore.
- Paste is app-layer behavior: multiline/large paste warnings are handled above the renderer/control.
- Copy with no active selection returns false so Ctrl+C can still pass through to the terminal.

## Product boundary

### Electron owns

- product shell UI;
- tabs/panes layout model;
- command palette;
- workspace/sidebar/settings UI;
- user-facing session actions;
- deciding which terminal pane is active;
- sending native host desired bounds.

### Native coordinator owns

- Windows child HWND creation and destruction;
- terminal control handles;
- mapping Electron pane IDs to native terminal IDs;
- applying bounds and DPI;
- native focus/activation sequence;
- native copy/paste/selection operations;
- native key event handling where required;
- translating terminal output/input to the hub protocol;
- cleanup on parent close/crash.

### Rust `neoncode-hub` owns

- PTY process lifecycle;
- session IDs;
- input/output/resize protocol;
- attach/detach/reconnect semantics;
- launch profiles eventually.

## IPC model

Use a simple line-delimited JSON protocol initially. It is easy to debug and mirrors the existing WebSocket protocol style.

Electron starts the coordinator process and communicates over stdin/stdout or named pipes.

Prefer named pipes for product, but stdio is acceptable for an initial coordinator POC.

### Request envelope

```json
{
  "id": 1,
  "type": "create_terminal",
  "terminal_id": "pane-1",
  "payload": {}
}
```

### Response envelope

```json
{
  "id": 1,
  "type": "ok",
  "terminal_id": "pane-1",
  "payload": {}
}
```

### Event envelope

```json
{
  "type": "terminal_output",
  "terminal_id": "pane-1",
  "payload": {
    "data_b64": "..."
  }
}
```

## Proposed coordinator commands

### `hello`

Coordinator announces capabilities/version.

```json
{
  "type": "hello",
  "payload": {
    "protocol_version": 1,
    "capabilities": [
      "hwnd_terminal",
      "multiple_terminals",
      "set_bounds",
      "focus",
      "theme",
      "selection",
      "paste"
    ]
  }
}
```

### `set_parent`

Tell the coordinator which Electron `BrowserWindow` HWND to parent into.

```json
{
  "id": 1,
  "type": "set_parent",
  "payload": {
    "parent_hwnd": "123456"
  }
}
```

### `create_terminal`

Create a terminal child HWND and hub session.

```json
{
  "id": 2,
  "type": "create_terminal",
  "terminal_id": "pane-1",
  "payload": {
    "session_id": "session-1",
    "endpoint": "ws://127.0.0.1:44777/ws",
    "command": "bash",
    "cwd": null,
    "rows": 30,
    "cols": 120
  }
}
```

Coordinator work:

1. call `CreateTerminal(parentHwnd, &hwnd, &terminal)`;
2. register write callback;
3. connect/start `neoncode-hub` session;
4. send terminal output through `TerminalSendOutput`;
5. forward terminal input callback to hub `input`;
6. report actual HWND and initial dimensions.

Response:

```json
{
  "id": 2,
  "type": "ok",
  "terminal_id": "pane-1",
  "payload": {
    "hwnd": "987654",
    "cols": 120,
    "rows": 30
  }
}
```

### `set_bounds`

Apply Electron-owned pane geometry in physical or logical pixels.

```json
{
  "id": 3,
  "type": "set_bounds",
  "terminal_id": "pane-1",
  "payload": {
    "x": 0,
    "y": 52,
    "width": 596,
    "height": 748,
    "dpi": 96
  }
}
```

Coordinator work:

1. `SetWindowPos(hwnd, ...)`;
2. `TerminalDpiChanged(terminal, dpi)` if DPI changed;
3. `TerminalTriggerResize(terminal, width, height, &dimensions)`;
4. send hub `resize` if rows/cols changed.

### `focus_terminal`

Focus one terminal, unfocus others.

```json
{
  "id": 4,
  "type": "focus_terminal",
  "terminal_id": "pane-1",
  "payload": {
    "reason": "pointer|keyboard|activation|restore"
  }
}
```

Coordinator work:

1. verify parent Electron HWND is foreground before stealing focus;
2. call `TerminalKillFocus` on previous active terminal;
3. bring chosen child HWND to top among siblings if needed;
4. `SetFocus(childHwnd)`;
5. call `TerminalSetFocus(terminal)`;
6. record active terminal.

### `blur_all`

Tell native host the Electron window lost foreground.

```json
{
  "id": 5,
  "type": "blur_all",
  "payload": {}
}
```

Coordinator work:

- call `TerminalKillFocus` on active terminal;
- do not attempt to regain focus.

### `close_terminal`

```json
{
  "id": 6,
  "type": "close_terminal",
  "terminal_id": "pane-1",
  "payload": {
    "kill_session": true
  }
}
```

Coordinator work:

1. optionally send hub `kill`;
2. disconnect WebSocket;
3. call `DestroyTerminal(terminal)`;
4. remove from terminal map.

### `set_theme`

Map NeonCode config into Windows Terminal theme/font values.

```json
{
  "id": 7,
  "type": "set_theme",
  "terminal_id": "pane-1",
  "payload": {
    "font_face": "FiraCode Nerd Font Mono",
    "font_size": 14,
    "background": "#0c0c0c",
    "foreground": "#cccccc",
    "selection_background": "#264f78",
    "cursor_style": "bar",
    "color_table": ["#000000", "#cd3131"]
  }
}
```

Coordinator work:

- convert to `TerminalTheme`;
- call `TerminalSetTheme`.

### `paste_text`

Electron or native coordinator asks terminal to paste text.

```json
{
  "id": 8,
  "type": "paste_text",
  "terminal_id": "pane-1",
  "payload": {
    "text": "echo hello\n",
    "source": "clipboard|programmatic"
  }
}
```

Initial implementation can send text as hub input. Longer term, mirror Windows Terminal app-layer paste behavior:

- bracketed paste awareness;
- multiline paste warning;
- large paste warning;
- CRLF normalization;
- broadcast paste option.

### `copy_selection`

```json
{
  "id": 9,
  "type": "copy_selection",
  "terminal_id": "pane-1",
  "payload": {
    "single_line": false,
    "clear_selection": false
  }
}
```

Coordinator work:

- check `TerminalIsSelectionActive`;
- read `TerminalGetSelection`;
- write to clipboard or return text;
- if no selection, return `copied=false` so Electron/keybinding layer can let Ctrl+C pass through.

### `send_key_event` / `send_char_event`

Only needed if Electron/native coordinator owns key capture. If the native child HWND receives keyboard naturally, prefer letting the terminal HWND process keys directly.

```json
{
  "type": "send_key_event",
  "terminal_id": "pane-1",
  "payload": {
    "vkey": 67,
    "scan_code": 46,
    "flags": 0,
    "key_down": true
  }
}
```

Coordinator can call:

```cpp
TerminalSendKeyEvent(terminal, vkey, scanCode, flags, keyDown)
TerminalSendCharEvent(terminal, ch, flags, scanCode)
```

## Events from coordinator to Electron

### `terminal_created`

```json
{
  "type": "terminal_created",
  "terminal_id": "pane-1",
  "payload": {
    "hwnd": "987654",
    "cols": 120,
    "rows": 30
  }
}
```

### `terminal_resized`

```json
{
  "type": "terminal_resized",
  "terminal_id": "pane-1",
  "payload": {
    "cols": 99,
    "rows": 32
  }
}
```

### `terminal_exited`

```json
{
  "type": "terminal_exited",
  "terminal_id": "pane-1",
  "payload": {
    "exit_code": 0,
    "reason": "session_exit|closed|error"
  }
}
```

### `focus_changed`

```json
{
  "type": "focus_changed",
  "terminal_id": "pane-1",
  "payload": {
    "focused": true
  }
}
```

### `error`

```json
{
  "type": "error",
  "terminal_id": "pane-1",
  "payload": {
    "message": "TerminalTriggerResize failed",
    "code": "0x80004005"
  }
}
```

## Focus model

The coordinator should copy Windows Terminal's conceptual model:

```text
Shell active pane ID
  ⇄ coordinator active terminal ID
      ⇄ one focused terminal HWND/control
```

Rules:

- Electron tells coordinator which terminal should be active.
- Coordinator refuses to focus a child terminal if the Electron parent is not foreground.
- On Electron blur, coordinator kills terminal focus state and stops pending focus work.
- On Electron activation/restore, Electron sends one explicit `focus_terminal` for the previously active pane.
- No native delayed focus loops that can outlive Electron focus state.
- If a terminal HWND gains focus by pointer click, coordinator reports `focus_changed` so Electron updates active pane state.

This should replace the current ad hoc focus nudges in the spike.

## Layout model

The current spike passes split-column geometry through command-line args. Product coordinator should not do that.

Electron layout should emit explicit bounds:

```text
on BrowserWindow resize/move/DPI/layout change:
  for each terminal pane:
    set_bounds(paneId, x, y, width, height, dpi)
```

Coordinator applies the bounds exactly. It should not know product layout semantics like tabs/splits, only terminal rectangles.

## Hub/session model interaction

Initial coordinator POC can continue owning hub WebSocket connections per terminal.

Longer-term choice:

### Option A — Coordinator talks to hub

```text
Electron ⇄ coordinator ⇄ hub
```

Pros:

- terminal input/output stays native-side;
- Electron is not in the high-volume output path;
- closer to current WPF/native host path.

Cons:

- session state split between Electron and coordinator;
- coordinator needs hub protocol implementation.

### Option B — Electron talks to hub, coordinator only renders

```text
Electron ⇄ hub
Electron ⇄ coordinator renderer
```

Pros:

- Electron owns session lifecycle directly;
- native coordinator is renderer-only.

Cons:

- high-volume terminal output crosses Electron IPC twice;
- more JS involvement in terminal hot path.

Current recommendation: **Option A for Windows native coordinator**, with the Rust hub retaining authoritative session lifecycle semantics.

## Staged implementation plan

### Stage 1 — Research/design only

- Read Windows Terminal source areas listed above.
- Confirm `HwndTerminal` exports remain available in the pinned version.
- Identify what the current built `Microsoft.Terminal.Control.dll` exports.
- Decide whether the first coordinator POC links to the existing DLL exports or builds against source directly.

### Stage 2 — Minimal C++ coordinator POC

Status: scaffolded, built, and visually validated under Electron.

Implemented in:

```text
spikes/electron-native-terminal/native/NeonCode.NativeTerminalCoordinator
```

Current behavior:

- writes debug logs to `%TEMP%\\NeonCode\\direct-coordinator-<pid>-pane-<n>.log`;
- accepts `--parent-hwnd` and split-column geometry arguments as fallback startup geometry;
- loads `Microsoft.Terminal.Control.dll` dynamically;
- creates an `HwndTerminal` child via `CreateTerminal`;
- terminal regions appear under Electron without WPF;
- subclasses the terminal HWND to route key/char messages to `TerminalSendKeyEvent` / `TerminalSendCharEvent`;
- registers the write callback and locally echoes input through `TerminalSendOutput`;
- supports explicit stdin line commands from Electron:
  - `bounds x y width height dpi`
  - `focus reason`
  - `blur reason`
- applies explicit bounds with `SetWindowPos`, `TerminalDpiChanged`, and `TerminalTriggerResize`;
- logs focus decisions, foreground HWND, applied bounds, DPI changes, resize results, and terminal focus window messages;
- keeps light parent polling only as fallback/parent-death/minimized-state detection;
- destroys terminal cleanly on process exit.

Not implemented yet:

- JSON IPC envelope; current coordinator uses simple line commands for the spike;
- hub/WebSocket/PTTY integration;
- real session start/input/output/resize;
- production-grade focus/layout protocol.

Direct-native validation also showed that focus flicker and taskbar minimize/restore stress focus loss can still happen without WPF. Logs showed one concrete direct-mode bug: Electron was broadcasting `focus` to both native panes, causing the two child HWNDs to fight for focus. The spike now focuses only one active pane in direct-coordinator mode. Longer term, the coordinator should emit focus-change events so Electron can track the active pane accurately.

No hub connection yet.

### Stage 3 — Hub bridge

- Add hub WebSocket client to coordinator or bridge from existing C# first.
- Start session by `session_id` and launch profile.
- Forward terminal input callback to hub `input`.
- Forward hub `output` to `TerminalSendOutput`.
- Forward terminal cell resize to hub `resize`.

### Stage 4 — Electron integration

- Replace WPF host process in the Electron spike with the native coordinator POC.
- Electron sends `set_parent`, `create_terminal`, `set_bounds`, `focus_terminal`, `close_terminal`.
- Validate one pane.
- Validate two panes.

### Stage 5 — Windows Terminal app-layer behavior

- Add copy/paste/keybinding behavior modeled after TerminalPage/AppKeyBindings/ControlInteractivity.
- Add multiline/large paste warnings at Electron or coordinator layer.
- Add selection/copy behavior that lets Ctrl+C pass through when no selection exists.
- Add context menu behavior if needed.

### Stage 6 — Hardening

- DPI/multi-monitor.
- Crash cleanup.
- Parent-window death detection.
- Release/packaging.
- Versioned IPC schema.
- Metrics/logging.

## Open questions

- Should the first native coordinator be C++/Win32 using `HwndTerminal` exports, or C++/WinRT linking more deeply into TerminalControl?
- Are the `HwndTerminal` exports stable enough for our pinned dependency strategy?
- Does `HwndTerminal` alone provide enough key input fidelity, or do we need more of `TermControl`/`ControlInteractivity`?
- Where should app keybindings live: Electron, coordinator, or shared config compiled into both?
- Should paste warnings be Electron UI dialogs with coordinator-provided bracketed-paste state, or native coordinator dialogs?
- How should non-Windows terminal rendering work long term: xterm.js, another native renderer, or separate strategy?

## Near-term recommendation

Do not replace the working WPF spike immediately.

Next concrete work:

1. inspect exports and build linkage around `Microsoft.Terminal.Control.dll` / `HwndTerminal`;
2. create a tiny C++ coordinator POC that can create one `HwndTerminal` child under an Electron HWND;
3. only after that succeeds, move hub/session integration into the coordinator;
4. in parallel, continue Rust hub protocol/session cleanup because it benefits every frontend.
