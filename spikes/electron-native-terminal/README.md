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
- there are no obvious z-order or flicker problems;
- the approach looks productizable without excessive Win32 hacks.

## Failure criteria

The spike is not promising if:

- the terminal floats separately or escapes the Electron window;
- focus/keyboard behavior is unreliable;
- resize/z-order/DPI are visibly broken;
- native hosting would dominate product development;
- the web UI cannot coexist cleanly with native terminal regions.

## If this succeeds

Electron becomes a serious candidate for the product shell, with platform-specific native terminal host integration.

## If this fails

Keep WPF for the Windows prototype and evaluate either:

- WPF/WinUI native Windows frontend plus separate Linux frontend;
- Electron with `xterm.js` as a separate terminal-rendering POC;
- other platform-specific UI strategies sharing `neoncode-hub`.
