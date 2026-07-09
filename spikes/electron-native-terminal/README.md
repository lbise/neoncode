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
  └─ one or more child native WPF windows, reparented with SetParent
       └─ Windows Terminal WPF wrapper
            └─ Microsoft.Terminal.Control.dll
                 ⇄ neoncode-hub WebSocket
                     ⇄ WSL/Linux PTY
```

The default native terminal host is a tiny WPF executable:

```text
spikes/electron-native-terminal/native/NeonCode.ElectronTerminalHost
```

It reuses the existing NeonCode terminal/config code and vendors the same Windows Terminal runtime files as the main WPF prototype.

There is also a direct-native coordinator POC:

```text
spikes/electron-native-terminal/native/NeonCode.NativeTerminalCoordinator
```

It bypasses WPF and calls the `HwndTerminal` exports from `Microsoft.Terminal.Control.dll` directly. This mode currently proves direct child-HWND creation/rendering/input plumbing only; it intentionally echoes keyboard input locally and does not yet connect to `neoncode-hub`/PTY.

The Electron shell lives in:

```text
spikes/electron-native-terminal/electron
```

## Current findings

Observed so far:

- Electron shell launches from a Windows-local staged folder.
- Native Windows Terminal renderer appears inside the Electron window.
- The spike now defaults to two side-by-side native terminal hosts to validate multi-region HWND layout. Set `NEONCODE_TERMINAL_COUNT=1` to return to the original single-terminal mode.
- Two WPF terminal hosts work independently in current testing, including separate shell input and clean native-host shutdown when Electron exits.
- A minimal direct-native `HwndTerminal` coordinator POC now builds/publishes and can be launched under Electron with `NEONCODE_TERMINAL_HOST_KIND=coordinator`. It renders through `Microsoft.Terminal.Control.dll` without WPF; hub/PTY integration is not wired yet.
- Direct-native coordinator visual validation succeeded: terminal regions appear under Electron. However, focus flicker and taskbar minimize/restore stress can still lose terminal focus, which suggests the remaining issue is a general Electron + child HWND activation/focus coordination problem rather than a WPF-specific problem.
- Electron now sends explicit native-host line commands for `bounds`, `focus`, and `blur`; the direct coordinator applies those instead of relying solely on parent polling/split startup geometry. This needs stress validation.
- Resize and Windows snap/unsnap keep both terminal regions aligned in current testing.
- Basic shell rendering works.
- Neovim renders correctly.
- Neovim in one pane while tmux runs in the other works in current testing.
- tmux resize works.
- Removing the default Electron menu fixed the initial header/gap issue enough for the spike.
- Ctrl+Space did not reach tmux in either Electron or the WPF app; this is not Electron-specific. The shared terminal adapter now maps Ctrl+Space to NUL (`0x00`) explicitly.
- Ctrl+Shift+V / Shift+Insert paste also did not work through the embedded control by default. The shared terminal adapter now reads Windows clipboard text, normalizes CRLF to LF, and sends it to the PTY.
- Minimize/restore initially froze the native terminal region. The spike now restores/repositions/redraws the child HWND and gates native focus on the Electron parent actually being foreground.
- Alt+Tab back to the Electron window, click-away/return via taskbar, repeated taskbar minimize/restore, and snap/unsnap now generally work in current testing.
- There may still be a rare taskbar-return refocus race where the Electron window returns but terminal input focus is not immediately restored. This is recorded as a deferred focus polish item rather than a current viability blocker unless it becomes frequent.
- A slight terminal/focus flicker can still be visible during activation/restore/focus changes because the Electron shell and native child HWNDs repaint/focus on different timelines. The spike minimizes this with a solid terminal-colored placeholder and Win32 child clipping styles; further polish can use a deliberate loading/ready overlay or a native window coordinator.
- Alt+Backspace still appears to be intercepted before it reaches the embedded terminal path and triggers a Windows chime. Windows Terminal itself uses this chord for window fullscreen behavior, so this is not currently a blocker.

## Current conclusion

The Electron spike is successful enough to continue treating Electron as the likely polished product shell, with a native Windows Terminal host/coordinator subsystem on Windows.

The remaining known issues are deferred validation or polish items rather than current blockers:

- occasional terminal/focus flicker during activation/focus changes;
- rare/stress-induced taskbar-return refocus race; direct-native testing suggests this is not WPF-specific;
- longer 30–60 minute session stability test;
- multi-monitor/mixed-DPI test when hardware is available;
- replacing split-column command-line geometry and ad hoc focus nudges with explicit Electron-to-native-host bounds/focus IPC.

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
- builds and copies the direct-native `HwndTerminal` coordinator to `native-host`;
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

Direct-native coordinator mode, from WSL repo root:

```bash
./dev electron-spike-direct
```

The helper passes `-HostKind coordinator` to `scripts/electron-spike.ps1`, which sets `NEONCODE_TERMINAL_HOST_KIND=coordinator` for the Electron process. The startup console and Electron log should show `kind: "coordinator"`.

The direct-native mode should show the `HwndTerminal` renderer and locally echo typed input. It is not expected to start bash yet.

The direct-native coordinator currently accepts these simple line commands from Electron:

```text
bounds <x> <y> <width> <height> <dpi>
focus <reason>
blur <reason>
```

These are a spike precursor to the planned JSON coordinator IPC.

## Debug logs

The Electron/direct-native coordinator path writes debug logs to:

```text
%TEMP%\NeonCode\electron-native-spike-main.log
%TEMP%\NeonCode\direct-coordinator-<pid>-pane-<n>.log
```

Useful PowerShell commands after a bad focus/flicker run:

```powershell
Get-ChildItem $env:TEMP\NeonCode\*.log | Sort-Object LastWriteTime
Get-Content $env:TEMP\NeonCode\electron-native-spike-main.log -Tail 200
Get-Content $env:TEMP\NeonCode\direct-coordinator-*.log -Tail 200
```

A basic automation harness can stress an already-running Electron spike window:

```bash
./dev electron-spike-focus-test -Cycles 10
```

It minimizes/restores the Electron window and sends test keystrokes. Direct coordinator logs include `WM_CHAR` entries, which help verify whether typed characters reached the terminal child HWND.

The logs include Electron window focus/blur/resize/move/restore events, commands sent to native hosts, native bounds application, native focus decisions, and relevant terminal HWND focus messages.

Direct coordinator caveats:

- Until it emits focus-change events back to Electron, Electron only restores focus to pane 1. This avoids the earlier focus fight where both native panes were asked to focus at the same time.
- Electron skips bounds updates while minimized or when content size is invalid; this avoids the earlier `1x1` terminal resize during taskbar minimize.

Manual Windows PowerShell equivalent:

```powershell
cd $env:USERPROFILE\neoncode-electron-spike\electron
npm.cmd start
```

Expected result:

- Electron window opens;
- a web header remains visible at the top;
- two native Windows Terminal renderer regions appear below it by default;
- each region starts its own bash session through `neoncode-hub`;
- typing in each terminal works after clicking/focusing it.

Optional single-terminal mode:

```powershell
$env:NEONCODE_TERMINAL_COUNT = '1'
npm.cmd start
```

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

- focus after clicking the header and then each terminal;
- typing independently in both terminals;
- resizing the Electron window and confirming both terminals resize;
- tmux/nvim in one or both terminals;
- copy/paste;
- Ctrl+C / Ctrl+D;
- Alt keys if possible;
- closing the Electron window and confirming both native host processes exit.

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

- Investigate the rare taskbar-return refocus race if it becomes reproducible or frequent.
- Replace timer polling with explicit bounds/focus messages from Electron to the native host.
- Investigate whether a native Node addon or small Win32 coordinator process should own HWND parenting, positioning, activation, and DPI handling.
- Test multi-monitor and mixed-DPI behavior.
- Run a longer 30–60 minute two-terminal session with nvim/tmux when convenient.
- Test multi-monitor and mixed-DPI behavior when hardware is available.
- Continue testing the two-terminal mode for less-common z-order, focus, resize, DPI, and visual polish issues.
- Extend the native host protocol so Electron owns explicit bounds/focus/close messages instead of split-column command-line options.
- Investigate terminal/focus flicker with a proper native window coordinator if it remains visually distracting.

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
