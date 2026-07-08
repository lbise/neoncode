# UI toolkit decision

## Status

Current decision:

```text
Electron is viable enough to continue as the likely polished product shell.
Keep WPF as the proven Windows Terminal host/reference implementation while building UI-independent session/protocol foundations.
```

This is not a final product GUI commitment, but the focused Electron spike has answered the biggest native-terminal embedding risk positively enough to continue.

## Context

NeonCode is intended to become a polished workspace/session cockpit for terminals, projects, machines, SSH/tmux sessions, agents, browsers, and related tools.

The validated POC proved:

```text
WPF Windows frontend
  ⇄ embedded Windows Terminal renderer
  ⇄ WebSocket protocol
  ⇄ Rust neoncode-hub
  ⇄ Linux/WSL PTY
  ⇄ bash / Neovim / tmux
```

The most important technical result is that `Microsoft.Terminal.Control.dll` can be embedded and driven from our app successfully.

## Toolkits considered

We are currently considering only:

- WPF
- WinUI 3
- Electron

Rejected for now:

- Tauri: if we use a web UI shell, Electron is more mature and complete for this type of desktop app.
- Avalonia: cross-platform .NET is not a goal; if we want cross-platform UI reuse, Electron is more attractive.
- Qt/QML: licensing/distribution concerns are enough to avoid it for this project.

## WPF

### Pros

- Already proven in this repository.
- Can host the Windows Terminal renderer.
- Good Win32/HWND interop story.
- Simple .NET/WPF build and publish flow now exists.
- Lets the project continue validating terminal/session behavior immediately.

### Cons

- Windows-only.
- Default UI style is dated.
- Polished modern UI requires custom work or third-party styling.
- If the product later moves to Electron, WPF-specific layout/UI work may be thrown away.

### Current role

WPF is the proven Windows terminal host and remains the safest prototype shell.

## WinUI 3

### Pros

- Modern Windows-native UI toolkit.
- Better visual baseline than WPF.
- Potentially good if NeonCode becomes Windows-first/native.

### Cons

- Windows-only.
- Native interop/control hosting is not yet proven for this project.
- Windows Terminal wrapper path used by the POC is WPF-oriented.
- Adds tooling/packaging uncertainty without solving cross-platform UI reuse.

### Current role

WinUI 3 is not the next step. It is only worth reconsidering if NeonCode deliberately becomes a Windows-native product and WPF becomes too limiting.

## Electron

### Pros

- Strongest candidate for polished cross-platform UI.
- Large ecosystem for tabs, panes, command palettes, docking/layout, theming, settings screens, and general app polish.
- Good fit for a workspace cockpit shell.
- Can likely share most UI code between Windows and Linux.
- npm availability is not a blocker for the intended development/deployment model because NeonCode can run on a machine with full development access and connect to locked-down machines over SSH.

### Cons

- Hosting the real Windows Terminal renderer inside Electron is unproven.
- Native child HWND/control embedding can have focus, keyboard, resize, z-order, DPI, and lifecycle issues.
- If Electron cannot host Windows Terminal well, the product must choose between:
  - Electron + `xterm.js`;
  - native Windows frontend with Windows Terminal and separate Linux frontend;
  - hybrid Electron shell plus native terminal host processes/windows.
- Electron + `xterm.js` is viable, but it is a different terminal-rendering POC from the one already validated.

### Current role

Electron is now the leading candidate for a polished cross-platform product shell. The focused native-terminal spike validated real Windows Terminal rendering, Neovim/tmux, resize/snap, two side-by-side native terminal regions, and clean native-host shutdown.

Known remaining Electron/native-host work is polish and hardening:

- occasional terminal/focus flicker;
- rare taskbar-return refocus race if it becomes reproducible/frequent;
- longer session soak testing;
- multi-monitor/mixed-DPI testing;
- replacing split-column command-line geometry with explicit Electron-to-native-host bounds/focus IPC or a native window coordinator.

See [`electron-native-terminal-architecture.md`](electron-native-terminal-architecture.md) for the native terminal host options. The preferred long-term Windows direction is a native coordinator that stays as close as practical to Windows Terminal's own app/control layering.

## Duplicate work concern

There is a real risk of duplicate work if we build too much WPF-specific UI before deciding whether Electron can host the terminal.

High-risk WPF work to avoid before the Electron spike:

- complex docking/split-pane UI;
- polished styling/theme system;
- command palette;
- workspace browser/sidebar;
- settings UI;
- large tab/session management UI;
- custom WPF control library work.

Lower-risk work that remains useful regardless of GUI toolkit:

- Rust hub/session model;
- WebSocket protocol cleanup;
- protocol documentation;
- terminal lifecycle semantics;
- PTY/session attach/detach/reconnect behavior;
- launch profiles and workspace schema;
- config file schema;
- Windows Terminal dependency tooling;
- terminal correctness testing;
- small WPF host changes needed to keep the validated prototype usable.

Therefore, the project should avoid major WPF UI investment until the Electron embedding question has been answered.

## Decision

Use Electron as the likely product shell direction, but do not immediately build a large polished UI. First build the UI-independent foundations that either Electron or WPF would need: session model, protocol cleanup, launch profiles, attach/detach/reconnect, and terminal lifecycle semantics.

Keep WPF as the proven Windows-native reference host and fallback path.

## Electron spike result

The spike succeeded enough to proceed with Electron as the likely shell direction.

Validated:

- Electron app starts from a Windows-local staged folder.
- Real Windows Terminal renderer is hosted under the Electron shell.
- Bash, Neovim, tmux, paste, Ctrl+Space, resize, snap/unsnap, and two native terminal regions work in current testing.
- Closing Electron cleans up native host processes.

Deferred:

- long-session stability testing;
- multi-monitor/mixed-DPI testing;
- rare focus race/flicker polish;
- proper native host bounds/focus IPC/coordinator.

## Original Electron spike scope

The spike was intentionally small.

Required behavior:

- Electron app starts.
- Shows a simple shell UI with one terminal region.
- Hosts the real Windows Terminal renderer, not `xterm.js`, if feasible.
- Connects to the existing `neoncode-hub` WebSocket endpoint.
- Runs bash.
- Runs Neovim.
- Handles keyboard input correctly enough for basic editing.
- Handles resize.
- Can close/restart cleanly.

Out of scope for the spike:

- polished UI;
- multiple tabs;
- workspace persistence;
- command palette;
- settings UI;
- packaging polish.

## Electron spike acceptance criteria

The spike is considered successful if:

- the Windows Terminal control can be embedded inside or convincingly integrated with the Electron window;
- focus and keyboard input work for shell and Neovim;
- resize works;
- copy/paste path appears feasible;
- the approach does not require fragile hacks that are likely to break normal app usage;
- the implementation path is understandable enough to productize.

The spike is considered unsuccessful if:

- the terminal must be a separate unmanaged floating window;
- focus/keyboard behavior is unreliable;
- z-order/resize behavior is visibly broken;
- embedding requires brittle Win32 hacks that would dominate development;
- native Windows Terminal embedding is less practical than using WPF/WinUI.

## Possible outcomes after the Electron spike

### Outcome A: Electron native terminal embedding works

Use Electron as the likely product shell.

Architecture:

```text
Electron shell
  ⇄ native Windows terminal host/control integration
  ⇄ Rust neoncode-hub
```

WPF remains a successful spike/reference implementation.

### Outcome B: Electron embedding fails, but Electron + xterm.js looks acceptable

Run a separate terminal-renderer POC with `xterm.js`.

This must re-test:

- Neovim;
- tmux;
- colors;
- mouse mode;
- keyboard fidelity;
- performance;
- scrollback;
- font/glyph handling.

### Outcome C: Electron embedding fails and xterm.js is not desired

Continue with WPF for Windows prototype.

Later decide between:

- WPF Windows frontend + separate Linux frontend;
- WinUI 3 Windows frontend;
- platform-specific native frontends sharing the Rust hub/session protocol.

## Near-term recommendation

Next tasks should be:

1. keep WPF prototype working;
2. avoid large WPF-specific UI features;
3. perform the Electron native Windows Terminal embedding spike;
4. investigate remaining Electron/native host issues, especially Alt+Tab refocus and startup polish;
5. study Windows Terminal's app-layer source for paste/copy/keybinding/focus behavior before adding more ad hoc terminal fixes;
6. then decide product shell direction;
7. continue UI-independent work in the Rust hub/session/protocol layers.

## Current practical stance

WPF is not the final product bet. WPF is the proven control-hosting baseline.

Electron is the strongest product UI candidate, but only if it can host or integrate the native terminal renderer without unacceptable fragility. Current spike results are promising, but Alt+Tab refocus and future multi-terminal/native-child lifecycle behavior still need validation.
