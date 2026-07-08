# Electron native terminal embedding spike

Goal: answer one question:

```text
Can Electron host/integrate the real Windows Terminal renderer well enough for NeonCode?
```

This spike intentionally does **not** test polished UI, tabs, settings, packaging, or workspace behavior.

## Architecture

```text
Electron BrowserWindow
  ├─ web header / shell UI
  └─ child native WPF window, reparented with SetParent
       └─ Windows Terminal WPF wrapper
            └─ Microsoft.Terminal.Control.dll
                 ⇄ neoncode-hub WebSocket
                     ⇄ WSL/Linux PTY
```

The native terminal host is a tiny WPF executable:

```text
spikes/electron-native-terminal/native/NeonCode.ElectronTerminalHost
```

It reuses the existing NeonCode terminal/config code and vendors the same Windows Terminal runtime files as the main WPF prototype.

The Electron shell lives in:

```text
spikes/electron-native-terminal/electron
```

## Current findings

Observed so far:

- Electron shell launches from a Windows-local staged folder.
- Native Windows Terminal renderer appears inside the Electron window.
- Basic shell rendering works.
- Neovim renders correctly.
- tmux resize works.
- Removing the default Electron menu fixed the initial header/gap issue enough for the spike.
- Ctrl+Space did not reach tmux in either Electron or the WPF app; this is not Electron-specific. The shared terminal adapter now maps Ctrl+Space to NUL (`0x00`) explicitly.
- Ctrl+Shift+V / Shift+Insert paste also did not work through the embedded control by default. The shared terminal adapter now reads Windows clipboard text, normalizes CRLF to LF, and sends it to the PTY.
- Minimize/restore initially froze the native terminal region. The spike now restores/repositions/redraws the child HWND and gates native focus on the Electron parent actually being foreground.
- Alt+Tab back to the Electron window, click-away/return via taskbar, repeated taskbar minimize/restore, and snap/unsnap now work in current testing.
- A slight terminal-region flicker can still be visible during activation/restore because the Electron shell and native child HWND repaint on different timelines. The spike minimizes this with a solid terminal-colored placeholder and Win32 child clipping styles; further polish can use a deliberate loading/ready overlay or a native window coordinator.
- Alt+Backspace still appears to be intercepted before it reaches the embedded terminal path and triggers a Windows chime. Windows Terminal itself uses this chord for window fullscreen behavior, so this is not currently a blocker.

## Current important limitation

Electron gives us a native HWND for the whole `BrowserWindow`, not for an arbitrary DOM element.

This spike reparents the native WPF terminal host into the Electron `BrowserWindow` and positions it below a fixed-height web header. This tests whether a hybrid web-shell/native-terminal approach is plausible, but it is not yet a complete docking/layout solution.

Things to watch carefully:

- focus behavior;
- keyboard input;
- resize behavior;
- whether the native child window overlays web UI incorrectly;
- z-order issues;
- DPI behavior;
- shutdown/lifecycle behavior.

## Prerequisites

Required:

- Windows Terminal native dependency already built with `./dev wt-build`;
- Rust hub runnable with `./dev hub`;
- .NET 8 SDK on Windows;
- Node.js/npm for **Windows**, not only WSL;
- Electron installed through npm in this spike folder.

Check Windows Node/npm from Windows PowerShell:

```powershell
node --version
npm.cmd --version
```

Use `npm.cmd`, not `npm`, because PowerShell execution policy may block the `npm.ps1` shim.

If Windows Node was installed after the current WSL session started, `powershell.exe` launched from WSL may not see `node`/`npm.cmd` on PATH until WSL is restarted. The repo helper `scripts/electron-spike.ps1` handles this by falling back to `C:\Program Files\nodejs\npm.cmd`.

Also note: `npm.cmd` is a batch file, and `cmd.exe` cannot use `\\wsl.localhost\...` as its current directory directly. The helper uses `cmd /c pushd` so npm can run from the WSL repo path.

## Build native host

From repo root in WSL:

```bash
powershell.exe -NoProfile -Command "dotnet build spikes\\electron-native-terminal\\native\\NeonCode.ElectronTerminalHost\\NeonCode.ElectronTerminalHost.csproj -v:minimal"
```

Or via the repo helper:

```bash
./dev electron-spike-native
```

## Publish the spike to a Windows-local folder

Running Electron directly from `\\wsl.localhost\...` is not representative of a final product and can trigger Chromium/GPU/process issues. Prefer publishing the spike to a Windows-local folder first.

From WSL repo root:

```bash
./dev electron-spike-publish
```

Default output:

```text
%USERPROFILE%\neoncode-electron-spike
```

The publish step:

- publishes the native WPF terminal host to `native-host`;
- copies the Electron shell to `electron`;
- runs `npm.cmd install` in the Windows-local Electron folder;
- verifies Electron and the native host exist.

## Run

Terminal 1, from WSL repo root:

```bash
./dev hub
```

Terminal 2, from WSL repo root:

```bash
./dev electron-spike
```

Manual Windows PowerShell equivalent:

```powershell
cd $env:USERPROFILE\neoncode-electron-spike\electron
npm.cmd start
```

Expected result:

- Electron window opens;
- a web header remains visible at the top;
- the native Windows Terminal renderer appears below it;
- bash starts through `neoncode-hub`;
- typing in the terminal works.

## Validation commands

Inside the embedded terminal:

```bash
ls --color=always
printf '\e[31mred\e[0m\n'
nvim
tmux
stty size
```

Also test:

- focus after clicking the header and then the terminal;
- resizing the Electron window;
- copy/paste;
- Ctrl+C / Ctrl+D;
- Alt keys if possible;
- closing the Electron window.

## Success criteria

The spike is promising if:

- the native terminal stays visually inside the intended region;
- keyboard/focus work well enough for shell and Neovim;
- resize follows Electron window resize;
- shutdown is clean;
- there are no obvious z-order problems, and any activation flicker is minor/polishable;
- the approach looks productizable without excessive Win32 hacks.

## Failure criteria

The spike is not promising if:

- the terminal floats separately or escapes the Electron window;
- focus/keyboard behavior is unreliable;
- resize/z-order/DPI are visibly broken;
- native hosting would dominate product development;
- the web UI cannot coexist cleanly with native terminal regions.

## Future improvements to investigate

Startup/polish improvements:

- Start the native terminal host before showing the Electron window.
- Add a ready/attached signal from native host to Electron.
- Show a deliberate loading/skeleton state instead of exposing startup flicker.
- Publish the native host in Release/ReadyToRun mode.
- Investigate keeping one native host process warm and creating terminal regions on demand.
- Package/run Electron as a real app instead of through `npm start`.

Focus/windowing improvements:

- Fix Alt+Tab return focus so the terminal is ready for input without an extra click.
- Replace timer polling with explicit bounds/focus messages from Electron to the native host.
- Investigate whether a native Node addon or small Win32 coordinator process should own HWND parenting, positioning, activation, and DPI handling.
- Test multi-monitor and mixed-DPI behavior.
- Test multiple native terminal regions in one Electron window.

Terminal behavior improvements:

- Study Windows Terminal's app-layer code and mirror relevant behavior instead of inventing ad hoc fixes.
- Import/adapt handling patterns for paste, copy, key bindings, command routing, focus, context menus, and warnings for large/multiline paste.
- Decide whether keybinding handling belongs in Electron, the native host, or a shared config/protocol layer.

Relevant Windows Terminal source areas already identified:

```text
src/cascadia/TerminalApp/TerminalPage.cpp
src/cascadia/TerminalApp/AppKeyBindings.cpp
src/cascadia/TerminalApp/AppActionHandlers.cpp
src/cascadia/TerminalControl/ControlInteractivity.cpp
src/cascadia/TerminalControl/TermControl.cpp
```

## If this succeeds

Electron becomes a serious candidate for the product shell, with platform-specific native terminal host integration.

## If this fails

Keep WPF for the Windows prototype and evaluate either:

- WPF/WinUI native Windows frontend plus separate Linux frontend;
- Electron with `xterm.js` as a separate terminal-rendering POC;
- other platform-specific UI strategies sharing `neoncode-hub`.
