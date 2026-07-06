# Workspace Cockpit Architecture Notes

## Current prototype status

The repository now contains the first proof-of-concept skeleton:

```text
hub/                         Rust WSL/Linux workspace-hub POC
frontends/windows/           WPF/.NET 8 Windows frontend POC shell
docs/protocol.md             temporary WebSocket PTY protocol
```

Run the hub from WSL/Linux:

```bash
cargo run -p workspace-hub
```

Then run the Windows frontend from Windows with the .NET 8 SDK installed:

```powershell
dotnet run --project frontends\windows\WorkspaceCockpit.Windows\WorkspaceCockpit.Windows.csproj
```

The Windows frontend now attempts to host the Windows Terminal renderer through a WPF wrapper and adapts it to the hub protocol. The old textbox renderer remains as a fallback if the native control fails to load.

---

## Validated POC result

The terminal-renderer POC is considered successful and is tagged in git as:

```text
poc/windows-terminal-embedded
```

What was proven:

- a Rust WSL/Linux backend can serve PTY sessions over WebSocket;
- a Windows WPF frontend can connect to the backend and drive a shell session;
- the frontend can embed the real Windows Terminal renderer through `Microsoft.Terminal.Control.dll`;
- real TUI programs render correctly, including Neovim;
- the architecture can carry terminal input, terminal output, and resize events across the GUI/backend boundary;
- publishing the frontend to a Windows-local folder can include the required native Windows Terminal files.

Important observations:

- Windows Terminal embedding is viable, but `Microsoft.Terminal.Control.dll` is only the renderer/control layer. Windows Terminal app features such as profile loading, command palette, tab management, and settings resolution live above it.
- Reusing Windows Terminal settings is still possible by parsing `settings.json` ourselves and mapping relevant renderer fields such as font, font size, color scheme, cursor style, foreground, background, and selection colors.
- Powerline/Nerd Font glyph issues are expected until font configuration is added.
- WPF is validated as a pragmatic Windows host for this control. It should remain the near-term Windows prototype shell unless another GUI stack explicitly re-proves native HWND/control hosting.
- The current Windows Terminal dependency process is good enough for a spike, but product work needs reproducible dependency checkout, patching, build, and publish scripts.

This changes the project status from “can this work?” to “build the proper prototype/product foundation.” See `docs/poc-to-product-roadmap.md` for the next route.

---

## POC vs product assumptions

Some current choices are intentionally pragmatic proof-of-concept choices, not final product commitments.

### Windows Terminal version/tooling

For the POC, it is acceptable to use an older pinned Windows Terminal source tag if that makes the first embedding experiment easier with currently available tooling.

Current investigation tag:

```text
microsoft/terminal v1.22.11141.0
```

Reason:

- it targets VS 2022-era tooling;
- it avoids spending the first POC cycle on the newest Windows Terminal build environment;
- it lets the project validate whether `Microsoft.Terminal.Control.dll` / `HwndTerminal` is viable at all.

For the product, this should be revisited. If the embedding approach checks out, the final tool should prefer:

- the latest stable Windows Terminal source/release that can be pinned reproducibly;
- current supported Visual Studio / Windows SDK tooling;
- deliberate upgrade points instead of tracking upstream casually.

The distinction is:

```text
POC:      prove terminal embedding with the lowest practical risk
Product:  use a modern pinned dependency/toolchain once the approach is validated
```

### Frontend toolkit choice

The current WPF frontend is also a POC choice. It was selected because WPF has mature HWND hosting and the Windows Terminal repository already contains WPF-oriented wrapper code.

This does **not** permanently decide the final GUI stack.

For the product, the frontend toolkit should be reassessed after the terminal/session POCs. Candidate directions include:

- WPF / WinUI 3 native Windows frontend;
- Qt/QML cross-platform native-ish frontend;
- GTK/libadwaita Linux frontend plus separate Windows frontend;
- Electron or another web-based desktop shell.

Electron is worth reconsidering for the final product because it could provide:

- faster modern UI development;
- a large ecosystem of layout/tab/tree/docking components;
- one UI codebase across Windows and Linux;
- good-looking interfaces with less custom native UI work.

However, Electron also has important risks for this specific app:

- npm availability is problematic in the work environment;
- true native terminal embedding may be harder than in WPF/Win32;
- using `xterm.js` would move terminal rendering into the web stack instead of using Windows Terminal/Ghostty/VTE;
- native focus/input/window integration may be weaker;
- packaging and dependency policy may be less acceptable on locked-down machines.

So the current position is:

> Use WPF/native Windows for the terminal embedding POC. After terminal rendering, hub transport, SSH, and tmux persistence are validated, reassess the product GUI toolkit, including Electron, with real data.

---

A design document for a native desktop application that provides a single overview of machines, projects, terminal sessions, agents, browsers, and remote desktop tools across work and home environments.

The goal is **not** to build a full IDE or heavily integrated AI-agent environment. The goal is to build a **workspace/session cockpit**: a native GUI that owns layout, panes, tabs, reconnection, and launch orchestration while continuing to rely on proven tools such as SSH, WSL, tmux, Neovim, pi/opencode, browsers, and X2Go.

---

## 1. Context and target workflow

### Work environment

- Windows company laptop.
- Windows itself is locked down, but WSL is available.
- From WSL:
  - work locally on cloned Git repositories when no special hardware is required;
  - SSH to several remote Linux machines;
  - run `tmux`, `pi`/`opencode`, and Neovim on those machines;
  - run tests through a custom Andromeda build/test system, including HIL tests;
  - use X2Go when GUI apps are needed, such as logic analyzer software or Audacity.
- Corporate network is behind a strict proxy.
  - GitHub is available.
  - npm is blocked.

### Home environment

- Personal desktop/laptop running Arch Linux.
- SSH to a home server on the local network.
- Similar remote workflow:
  - tmux;
  - agent;
  - Neovim;
  - project-specific commands.

### Desired application

A native GUI application that can manage multiple workspaces. Each workspace is a collection of windows/panes/sessions, for example:

- SSH connection to a remote machine;
- terminal running Neovim;
- terminal running pi/opencode;
- terminal running tests/logs;
- browser instance/profile for a web app;
- X2Go session;
- possibly other tools later.

The GUI should show an overview of all machines/workspaces and should manage reconnection where possible.

---

## 2. Main design principle

The application should be a **session cockpit**, not the place where all work permanently lives.

Durable state should remain in existing tools:

- Git repositories;
- remote machines;
- SSH configuration;
- tmux sessions, at least initially;
- browser profiles;
- X2Go profiles;
- project config files.

The GUI provides:

- workspace overview;
- native tabs/panes/layout;
- launch orchestration;
- reconnection logic;
- terminal embedding;
- machine/session status;
- keybindings and commands.

The GUI should **not** force a VS Code-like agent integration model. Agents should initially just run as terminal commands.

---

## 3. Important correction: GUI owns tabs and panes

An early idea was to SSH to a remote machine and attach to tmux. That is still useful for persistence, but tmux must **not** be the visible layout system.

Rejected model:

```text
GUI has one terminal
  └── ssh remote
        └── tmux with tabs/panes/status/keybindings
```

Preferred model:

```text
GUI workspace
  ├── pane/tab: editor
  │     └── remote persistent terminal session
  ├── pane/tab: agent
  │     └── remote persistent terminal session
  ├── pane/tab: tests
  │     └── remote persistent terminal session
  └── pane/tab: logs
        └── remote persistent terminal session
```

The GUI owns:

- tab layout;
- pane splitting;
- focus movement;
- workspace keybindings;
- window restoration.

A remote `tmux` session may still be used internally as a compatibility/persistence layer, but it should be mostly invisible.

---

## 4. GUI strategy

The initial POC preference is for a **native Windows GUI**, not because the final product must be native forever, but because the first high-risk question is native terminal embedding.

Reasons native is attractive for the POC:

- better access to native windows and input handling;
- better odds of hosting the Windows Terminal control directly;
- fewer layers while debugging focus, DPI, keyboard, mouse, and resize behavior;
- no dependency on npm-heavy frontend tooling during the first feasibility work;
- better fit for testing platform terminal rendering backends.

The product GUI strategy remains open. Electron, Qt/QML, WinUI 3, WPF, GTK/libadwaita, or separate native frontends should be compared after the terminal/session POCs have produced evidence.

Possible approaches:

### Option A: shared core plus separate native frontends

```text
shared core / workspace daemon
  ├── session model
  ├── workspace model
  ├── SSH/process management
  ├── config handling
  └── terminal session protocol

Windows frontend
  └── WPF / WinUI 3 / native Windows stack

Linux frontend
  └── GTK4/libadwaita or Qt

macOS frontend, later
  └── SwiftUI/AppKit or Qt
```

This gives the best native integration but costs more work.

### Option B: Qt/QML frontend

Qt could provide a serious cross-platform native-ish desktop UI with one codebase. However, terminal embedding may still require platform-specific native widgets.

### Option C: Electron frontend

Electron could provide the fastest path to a polished, modern, cross-platform UI. It would make dashboard views, docking layouts, command palettes, settings pages, and visual polish easier to build and share between Windows and Linux.

The key question is terminal rendering:

- Electron plus `xterm.js` gives a proven web terminal renderer, but moves away from platform-native terminal controls.
- Electron plus native terminal embedding may be possible but could reintroduce HWND/focus/input complexity through another layer.
- The work environment's npm restrictions could make dependency management and builds painful unless dependencies are vendored or mirrored.

Current leaning for the POC:

> Keep the POC architecture split so the terminal renderer is platform-specific and directly testable. Do not assume one UI toolkit will solve terminal embedding everywhere.

Product decision later:

> Reassess Electron seriously after validating terminal rendering and session transport. If `xterm.js` is good enough for Neovim/tmux/agents and packaging can be solved, Electron may be a strong product candidate because of cross-platform UI reuse.

---

## 5. Backend strategy

### Windows: WSL backend

On Windows, the local backend should probably run inside WSL.

Rationale:

- SSH config already lives there.
- Linux shell tooling already lives there.
- Corporate proxy/workarounds are already configured there.
- Project repositories may already be in WSL.
- Remote workflows already start from WSL.
- It avoids reimplementing Linux-oriented workflow logic in native Windows code.

The Windows GUI would start/connect to the WSL backend, for example:

```powershell
wsl.exe -- workspace-hub serve
```

The GUI then communicates with it over localhost TCP/WebSocket/named pipe/stdio.

### Linux/macOS: local backend

On Linux and macOS, the same backend can run locally as a normal daemon/process.

```text
Windows GUI ── localhost ── WSL workspace-hub
Linux GUI   ── localhost ── local workspace-hub
macOS GUI   ── localhost ── local workspace-hub
```

---

## 6. Terminal architecture

Terminal handling should be split into two halves:

```text
PTY/session side:
  shell, WSL, SSH, tmux, remote command, agent, test command

Terminal UI side:
  VT parser, terminal grid, fonts, shaping, rendering, input, selection, clipboard
```

The WSL backend helps with the **PTY/session side**, but the native GUI still needs a native terminal renderer.

### Platform terminal renderers

```text
Windows:
  renderer: Windows Terminal control / HwndTerminal / Microsoft.Terminal.Control.dll
  session backend: WSL workspace-hub

Linux:
  renderer: libghostty if viable, or VTE/fallback
  session backend: local workspace-hub

macOS:
  renderer: libghostty if viable, or native/fallback
  session backend: local workspace-hub
```

Terminal renderer should be treated as a pluggable adapter:

```text
TerminalView interface:
  write(bytes)
  resize(cols, rows)
  onInput(callback)
  onResize(callback)
  onTitleChanged(callback)
  onExit(callback)
```

The workspace/session model should not care whether rendering is done by Ghostty, Windows Terminal components, VTE, or another backend.

---

## 7. Windows terminal rendering investigation

The Windows Terminal repository contains reusable pieces, though not currently as a clean public SDK equivalent to `libghostty`.

Relevant repository areas:

```text
microsoft/terminal

src/cascadia/TerminalControl/
  TermControl.*
  HwndTerminal.*
  dll/TerminalControl.*

src/cascadia/WpfTerminalControl/
  TerminalControl.xaml.cs
  TerminalContainer.cs
  ITerminalConnection.cs

samples/ConPTY/
  ConPTY examples and sample apps
```

The most promising part is the HWND-based terminal control.

It exposes a flat C ABI from `HwndTerminal.hpp` / `Microsoft.Terminal.Control.dll`, including functions conceptually like:

```cpp
CreateTerminal(parentHwnd, &hwnd, &terminal)
TerminalSendOutput(terminal, data)
TerminalRegisterWriteCallback(terminal, callback)
TerminalTriggerResize(...)
TerminalTriggerResizeWithDimension(...)
TerminalCalculateResize(...)
TerminalSetTheme(...)
TerminalGetSelection(...)
TerminalIsSelectionActive(...)
TerminalSendKeyEvent(...)
TerminalSendCharEvent(...)
TerminalSetFocused(...)
DestroyTerminal(...)
```

The repository also contains a WPF wrapper with a useful connection interface:

```csharp
public interface ITerminalConnection
{
    event EventHandler<TerminalOutputEventArgs> TerminalOutput;
    void Start();
    void WriteInput(string data);
    void Resize(uint rows, uint columns);
    void Close();
}
```

This maps very naturally to the desired architecture:

```text
WPF/Windows terminal control
  ⇄ ITerminalConnection implementation
      ⇄ localhost transport
          ⇄ WSL workspace-hub
              ⇄ Linux PTY / ssh / tmux / command
```

### Important caveat

Windows Terminal's terminal control does **not** appear to be a stable public library distributed as a supported NuGet package.

Therefore, if this route is chosen:

- vendor/pin `microsoft/terminal` as a submodule or vendored dependency;
- build `Microsoft.Terminal.Control.dll` from a known commit;
- wrap only the minimal ABI needed;
- avoid tracking upstream casually;
- treat upgrades as deliberate maintenance events.

Do **not** embed or reparent the installed `wt.exe` application. That would likely be fragile due to focus, DPI, key handling, lifecycle, and lack of stable embedding API.

---

## 8. SSH and persistence strategy

Plain SSH alone is not enough for resilient remote sessions. If the connection dies, foreground processes may die too.

Possible persistence options:

### Option A: no persistence

```text
GUI tab ── ssh remote command
```

Pros:

- simplest;
- no remote dependency besides SSH.

Cons:

- poor reconnect behavior;
- remote foreground process often dies on disconnect;
- not suitable for agents/tests/editors that should survive network drops.

### Option B: hidden tmux sessions

```text
GUI tab ── ssh remote 'tmux attach -t workspace-session'
```

Each GUI terminal tab maps to a separate tmux session or window. Tmux is used only as a persistence backend, not as the user-visible layout system.

Pros:

- robust;
- available on most machines;
- no custom remote daemon required;
- simple to prototype.

Cons:

- tmux can interfere with key handling;
- scrollback/state semantics are tmux's;
- feels less clean than a true remote PTY server.

Tmux should be made visually minimal, possibly using a dedicated config:

```bash
tmux -f ~/.config/workspace-cockpit/tmux.conf attach -t session-name
```

With settings such as:

```tmux
set -g status off
```

### Option C: custom remote session daemon

Long-term clean model:

```text
GUI terminal tab
  ⇄ local workspace-hub
      ⇄ SSH tunnel / transport
          ⇄ remote workspace daemon
              ⇄ persistent PTY session
```

Remote daemon responsibilities:

- create session;
- attach/detach;
- resize PTY;
- send input;
- stream output;
- kill/restart session;
- report status;
- keep sessions alive across GUI disconnects.

Pros:

- cleanest architecture;
- GUI fully owns layout;
- no tmux weirdness;
- better metadata and lifecycle control.

Cons:

- requires installing a daemon on every remote machine;
- may be difficult on locked-down work machines;
- much more code.

Recommended path:

> Start with hidden tmux as the compatibility persistence backend, but design a `PersistenceProvider` abstraction so a remote daemon can replace it later.

---

## 9. Workspace model

A workspace should describe GUI layout plus sessions. Example sketch:

```yaml
workspace: audio-fw

layout:
  root:
    split: horizontal
    children:
      - tabset:
          tabs:
            - id: editor
              title: editor
              session: audio-editor
            - id: agent
              title: pi
              session: audio-pi
      - tabset:
          tabs:
            - id: tests
              title: HIL tests
              session: audio-tests
            - id: logs
              title: logs
              session: audio-logs

sessions:
  audio-editor:
    kind: terminal
    host: work-dev-01
    cwd: /home/me/src/audio-fw
    persistence: tmux
    command: nvim

  audio-pi:
    kind: terminal
    host: work-dev-01
    cwd: /home/me/src/audio-fw
    persistence: tmux
    command: pi

  audio-tests:
    kind: terminal
    host: work-hil-03
    cwd: /home/me/src/audio-fw
    persistence: tmux
    command: ./andromeda test --hil

  audio-logs:
    kind: terminal
    host: work-hil-03
    cwd: /home/me/src/audio-fw
    persistence: tmux
    command: journalctl -f
```

Machine definitions could be separate:

```yaml
machines:
  work-dev-01:
    kind: ssh
    host: dev01.company.net
    user: me
    proxy_jump: bastion.company.net

  home-server:
    kind: ssh
    host: homeserver.local
    user: me

  local-wsl:
    kind: wsl
    distro: Arch
```

---

## 10. Browser and X2Go integration

### Browser

Initial approach: launch external browser windows with isolated profiles.

Example:

```bash
chromium \
  --user-data-dir ~/.workspace-cockpit/browser-profiles/audio-fw \
  --new-window http://localhost:3000
```

Workspace item:

```yaml
- kind: browser
  name: local web app
  url: http://localhost:3000
  profile: audio-fw
```

Do not initially embed a browser or integrate deeply with DevTools protocol. Launching and tracking process/profile is enough.

### X2Go

Initial approach: treat X2Go as an external managed process/profile.

```yaml
- kind: x2go
  name: logic analyzer
  profile: work-logic
```

The backend launches the appropriate X2Go client/profile and tracks whether it is running.

Do not attempt to embed X2Go windows initially.

---

## 11. Agent integration

Keep agent integration intentionally simple at first.

Agents are terminal commands:

```yaml
agents:
  pi:
    command: pi
  opencode:
    command: opencode
```

Workspace session:

```yaml
- kind: terminal
  title: pi agent
  host: home-server
  cwd: /home/me/src/project
  persistence: tmux
  command: pi
```

Avoid building a specialized AI-agent UI early. Later niceties can include:

- detect if pi/opencode is running;
- show git branch;
- show dirty state;
- parse logs/status;
- optional integration with agent APIs if available.

---

## 12. Proposed component architecture

```text
Native GUI frontend
  ├── workspace dashboard
  ├── machine/session status
  ├── tabs/panes/layout/keybindings
  ├── terminal widgets
  ├── browser/X2Go launch controls
  └── communicates with local workspace-hub

Local workspace-hub
  ├── runs in WSL on Windows
  ├── runs locally on Linux/macOS
  ├── reads workspace config
  ├── manages session lifecycle
  ├── owns local PTYs
  ├── runs ssh/tmux/commands
  ├── handles reconnect/backoff
  └── exposes API to frontend

Persistence providers
  ├── none
  ├── tmux
  └── future remote daemon

Remote machines
  ├── ssh server
  ├── tmux initially
  ├── project repos
  ├── agents/editors/tests
  └── optional future workspace-remote daemon
```

Possible API between GUI and hub:

```text
GET  /machines
GET  /workspaces
POST /workspaces/{id}/open
POST /sessions/{id}/start
POST /sessions/{id}/reconnect
POST /sessions/{id}/resize
POST /sessions/{id}/input
GET  /sessions/{id}/status
WS   /sessions/{id}/stream
```

The exact protocol can be adjusted, but the important point is that terminal sessions are byte streams plus metadata.

---

## 13. Important proof-of-concepts

These should be proven before committing to a large implementation.

### P0: embed Windows Terminal renderer in a custom app

Goal: verify that `Microsoft.Terminal.Control.dll` / `HwndTerminal` can be hosted reliably.

Questions to answer:

- Can the Windows Terminal control be built from source reproducibly?
- Can it be hosted in a small WPF app?
- Can it be hosted in a non-WPF native app, such as Win32/Qt/WinUI?
- Does focus work correctly?
- Does copy/paste work?
- Does selection work?
- Does mouse reporting work in Neovim/tmux?
- Does DPI scaling work?
- Does font rendering look like Windows Terminal?
- Can multiple instances exist in tabs/panes?
- Can it be packaged without installing a custom Windows Terminal build?

Deliverable:

```text
windows-terminal-embed-poc
  ├── one native window
  ├── two terminal panes
  ├── terminal output injection
  ├── input callback
  └── resize support
```

### P0: connect Windows terminal control to WSL backend

Goal: render an actual WSL shell through the embedded terminal.

Architecture:

```text
WPF/native app
  ⇄ terminal control
  ⇄ localhost transport
  ⇄ WSL workspace-hub
  ⇄ forkpty bash
```

Questions:

- Does latency feel acceptable?
- Are special keys correct?
- Does Neovim work?
- Does mouse mode work?
- Does terminal resize propagate correctly?
- Does Unicode/emoji/nerd-font output render correctly?

### P0: remote SSH session through WSL backend

Goal: from the Windows GUI, open a remote shell via WSL SSH.

```text
Windows GUI terminal
  ⇄ WSL backend
      ⇄ ssh remote
```

Questions:

- Does SSH config from WSL work naturally?
- Does ProxyJump work?
- Does agent forwarding/key auth work?
- Does reconnect detection work?

### P0: hidden tmux persistence

Goal: prove that each GUI tab can map to an independent persistent tmux-backed session.

Example:

```bash
ssh host 'tmux new-session -Ad -s ws-audio-pi -c /repo pi; tmux attach -t ws-audio-pi'
```

Questions:

- Can tmux be made visually invisible enough?
- Does Ctrl-based key handling interfere with Neovim or agents?
- Does reconnect restore the session cleanly?
- What happens if the command exits?
- How should session restart be handled?

### P0/P1: Linux terminal embedding with libghostty

Goal: determine whether `libghostty` is actually usable as an embeddable terminal component for a native Linux GUI.

Questions:

- Is the embedding API stable/public enough?
- Which UI toolkits can host it?
- Does it expose the necessary input/output/resize hooks?
- Is packaging realistic on Arch and other Linux distributions?
- Can it coexist with custom GUI tabs/panes?

Fallback to investigate: VTE.

### P1: workspace-hub minimal protocol

Goal: build a tiny backend that can create a PTY, stream output, accept input, and resize.

Questions:

- Best transport: WebSocket, TCP, named pipe, stdio?
- Should terminal streams be raw bytes or framed messages?
- How are session IDs assigned?
- How does the frontend recover after reconnecting to the hub?

### P1: multi-pane GUI layout

Goal: prove the application can own layout independently of tmux.

Features:

- tabs;
- splits;
- focus movement;
- keybindings;
- persistent layout file;
- multiple terminal instances.

### P1: browser and X2Go launch management

Goal: validate external app orchestration.

Questions:

- Can the app launch browser profiles reliably on Windows/Linux?
- Can X2Go profiles be launched/tracked from the backend?
- How should external windows be represented in the workspace dashboard?

### P2: remote daemon alternative

Goal: evaluate whether replacing hidden tmux with a custom remote PTY daemon is worth it.

Questions:

- Can the daemon be installed on work machines?
- Can it run without opening blocked network ports, e.g. over SSH stdio/tunnel?
- Does it provide enough benefit over tmux?

---

## 14. Suggested implementation phases

### Phase 1: terminal feasibility

- Windows Terminal control embedding POC.
- WSL backend PTY POC.
- SSH through WSL POC.
- Hidden tmux persistence POC.

This phase decides whether the most important technical assumptions are valid.

### Phase 2: minimal workspace launcher

- Workspace config file.
- Machine definitions.
- Launch terminal sessions.
- Launch browser profiles.
- Launch X2Go profiles.
- Simple status dashboard.

No advanced layout yet.

### Phase 3: native layout shell

- Tabs and splits owned by the GUI.
- Per-pane terminal sessions.
- Workspace save/restore.
- Keyboard navigation.

### Phase 4: reconnection and lifecycle

- Detect disconnected sessions.
- Reconnect SSH/tmux-backed sessions.
- Restart exited commands.
- Session status indicators.
- Logs/diagnostics.

### Phase 5: Linux frontend

- Native Linux GUI.
- libghostty or VTE terminal backend.
- Reuse same workspace-hub/session model.

### Phase 6: deeper integrations

- Agent status awareness.
- Git status.
- Andromeda/test status.
- Optional remote workspace daemon.
- Optional richer browser/X2Go handling.

---

## 15. Current recommended first prototype

The first serious prototype should be Windows-focused because it carries the largest risk.

Recommended stack for first POC:

```text
Windows app:
  WPF / .NET 8

Terminal renderer:
  vendored Microsoft Terminal WpfTerminalControl or HwndTerminal

Backend:
  tiny WSL workspace-hub

Transport:
  localhost TCP or WebSocket

Session:
  WSL forkpty running bash, then ssh, then hidden tmux
```

If this works, the rest of the architecture becomes much more credible.

If it does not work, reassess before building the whole app.

---

## 16. Key risks

- Windows Terminal control may be difficult to build/package outside the upstream repository.
- The control is not a stable public SDK.
- Focus/input handling with embedded HWNDs can be painful.
- DPI and font rendering need careful testing.
- WSL-to-Windows localhost communication may have edge cases.
- Corporate restrictions may make installation/building difficult.
- Hidden tmux may interfere with some keybindings or terminal behavior.
- `libghostty` may not yet be mature as an embeddable library.
- Building separate native frontends could become a lot of work.

---

## 17. Non-goals for early versions

- Do not build a full IDE.
- Do not deeply integrate pi/opencode initially.
- Do not replace tmux immediately with a custom multiplexer.
- Do not embed X2Go windows initially.
- Do not rely on npm-heavy frontend tooling.
- Do not reparent `wt.exe` windows.
- Do not make remote daemon installation mandatory.

---

## 18. Summary

The desired application should be a native, terminal-centric workspace cockpit.

The central architectural choices are:

- native GUI frontends;
- GUI-owned tabs/panes/layout;
- WSL backend on Windows;
- local backend on Linux/macOS;
- platform-specific terminal renderers;
- Windows Terminal control as the likely Windows renderer;
- libghostty or VTE as likely Linux/macOS renderer candidates;
- hidden tmux as the initial remote persistence layer;
- optional custom remote daemon later;
- simple terminal-based agent integration initially.

The most important next step is to prove terminal embedding on Windows. If that works cleanly, the rest of the project can be built incrementally around a stable workspace/session protocol.
