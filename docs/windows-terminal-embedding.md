# Windows Terminal dependency and embedding

This document describes the Windows Terminal renderer dependency used by the Windows frontend.

The validated architecture is:

```text
WPF frontend
  ⇄ TerminalView adapter
      ⇄ Microsoft.Terminal.Control.dll / HwndTerminal
          ⇄ neoncode-hub WebSocket
              ⇄ WSL/Linux PTY
```

The POC proved this path with bash, Neovim, ANSI colors, resize, and real terminal rendering.

## Version policy

The Windows Terminal dependency is pinned in:

```text
deps/windows-terminal.json
```

Current pin:

```text
microsoft/terminal v1.22.11141.0
commit 6ffde34897e99a57a56ec52c12e1bf2730ceed71
```

Why this pin exists:

- it is the version currently proven to build in this project;
- it works with the available Visual Studio 2022 Build Tools setup;
- it successfully embeds and renders Neovim through the full frontend/backend stack;
- it avoids casually tracking Windows Terminal `main`, which can require newer unreleased Visual Studio/toolchain components.

This pin is not a permanent product decision. The product should periodically evaluate newer stable Windows Terminal tags, but upgrades must be deliberate and validated with the same end-to-end terminal tests.

## Repository-owned dependency files

```text
deps/windows-terminal.json
patches/windows-terminal/v1.22.11141.0/msvc-unused-params.patch
scripts/bootstrap-windows-terminal.ps1
scripts/build-windows-terminal-control.ps1
scripts/publish-windows-frontend.ps1
```

The patch file contains the tiny compatibility fix needed for this pinned Windows Terminal tag with the current MSVC warning-as-error behavior.

## External dependency locations

The dependency source/build outputs live outside this repository on the Windows filesystem:

```text
C:\Users\13lbise\gitrepo\microsoft-terminal
C:\Users\13lbise\gitrepo\vcpkg
```

Do not build the native Windows Terminal project from a `\\wsl.localhost\...` path. The Windows Terminal build has tools/props that expect normal Windows paths.

## Required tools

### WSL/Linux

- Rust toolchain with Cargo.

### Windows

- .NET 8 SDK.
- Git for Windows.
- Visual Studio 2022 Build Tools.
- Windows SDK 10.0.22621 or compatible.
- vcpkg, bootstrapped by the dependency script if missing.

### Why Git for Windows is required

The bootstrap script intentionally requires Windows-native Git.

Avoid using WSL Git to manage `C:\Users\...\gitrepo\microsoft-terminal`. WSL Git over `/mnt/c` is slow for a repository as large as Windows Terminal and can interact badly with Windows Defender real-time scanning, producing stalls, locks, or popups.

Install Git for Windows if `git` is not available in PowerShell:

```text
https://git-scm.com/download/win
```

The script also checks common Git for Windows install locations, so Git does not strictly need to be on `PATH` if installed normally.

## Visual Studio Build Tools requirements

The native control requires Visual Studio C++ build tools. A plain .NET SDK is not enough.

Install/modify Visual Studio Build Tools with:

```powershell
& "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vs_installer.exe" modify `
  --installPath "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools" `
  --passive `
  --norestart `
  --add Microsoft.VisualStudio.Workload.NativeDesktop `
  --add Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
  --add Microsoft.VisualStudio.Component.Windows11SDK.22621 `
  --add Microsoft.VisualStudio.Workload.UniversalBuildTools `
  --add Microsoft.VisualStudio.ComponentGroup.UWP.BuildTools `
  --add Microsoft.VisualStudio.ComponentGroup.UWP.VC.BuildTools `
  --add Microsoft.VisualStudio.ComponentGroup.UWP.VC
```

If the installer appears to do nothing, check for stale `MSBuild.exe` or Visual Studio processes. The installer may skip modifications when build processes are running. Stop stale processes or rerun with `--force` if appropriate.

The common missing-toolset failure is:

```text
MSB8020: The build tools for 'v143' application Type Windows Store
(Platform Toolset = 'v143') cannot be found.
```

The script validates the required Visual Studio components and the Windows Store v143 toolset folder before building.

## Windows Defender note

Windows Defender can slow or block the dependency workflow because Windows Terminal and vcpkg contain many files and build outputs.

Symptoms:

- Defender popups while cloning/building;
- long stalls while touching the Windows Terminal checkout;
- publish/build failures due to locked files;
- `NeonCode.Windows.exe` locking publish output while running.

Do **not** disable Defender globally. If your machine policy allows it, consider project-specific exclusions for the dependency/output folders:

```powershell
Add-MpPreference -ExclusionPath "$env:USERPROFILE\gitrepo\microsoft-terminal"
Add-MpPreference -ExclusionPath "$env:USERPROFILE\gitrepo\vcpkg"
Add-MpPreference -ExclusionPath "$env:USERPROFILE\neoncode-publish"
```

On locked-down work machines, this may require administrator rights or IT approval. If exclusions are not allowed, prefer Git for Windows and normal Windows paths; avoid WSL Git over `/mnt/c`.

## Bootstrap the dependency

From the repo root in WSL:

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\bootstrap-windows-terminal.ps1
```

The bootstrap script:

- reads `deps/windows-terminal.json`;
- verifies required Visual Studio components;
- verifies Git for Windows;
- clones or updates `C:\Users\13lbise\gitrepo\microsoft-terminal`;
- checks out the pinned tag/commit;
- applies patches from `patches/windows-terminal/<tag>`;
- clones/bootstraps vcpkg if needed.

If vcpkg is already prepared and you only want to verify source/tooling:

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\bootstrap-windows-terminal.ps1 -SkipVcpkgBootstrap
```

## Build the native control

From the repo root in WSL:

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\build-windows-terminal-control.ps1
```

The build script runs bootstrap first unless `-SkipBootstrap` is provided.

It then builds:

1. `src\host\proxy\Host.Proxy.vcxproj`
2. `src\cascadia\TerminalControl\dll\TerminalControl.vcxproj`

The proxy project is required because `TerminalControl` needs generated `ITerminalHandoff.h` headers.

Expected native output:

```text
C:\Users\13lbise\gitrepo\microsoft-terminal\bin\x64\Debug\Microsoft.Terminal.Control\Microsoft.Terminal.Control.dll
```

If the dependency has already been bootstrapped and you only want to rebuild:

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\build-windows-terminal-control.ps1 -SkipBootstrap
```

## Publish the Windows frontend

From the repo root in WSL:

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\publish-windows-frontend.ps1
```

Default publish output:

```text
C:\Users\13lbise\neoncode-publish
```

The publish script verifies that the app output contains:

```text
NeonCode.Windows.exe
Microsoft.Terminal.Control.dll
Microsoft.Terminal.Control.pri
Microsoft.Terminal.Control\
```

If the publish output is locked, close running `NeonCode.Windows.exe` instances or stop them:

```powershell
Get-Process NeonCode.Windows -ErrorAction SilentlyContinue | Stop-Process
```

## Run the app

Start the Rust hub from WSL:

```bash
cargo run -p neoncode-hub
```

Run the published Windows app:

```powershell
& "$env:USERPROFILE\neoncode-publish\NeonCode.Windows.exe"
```

Use endpoint:

```text
ws://127.0.0.1:44777/ws
```

Click:

1. `Connect`
2. `Start bash`
3. type directly in the terminal area

## WPF wrapper integration

The app currently vendors the small upstream WPF wrapper source from Windows Terminal:

```text
C:\Users\13lbise\gitrepo\microsoft-terminal\src\cascadia\WpfTerminalControl
```

into:

```text
frontends/windows/NeonCode.Windows/Vendor/WpfTerminalControl
```

Vendoring avoids restoring/building the upstream WPF wrapper project, which can be pulled into Windows Terminal's custom NuGet feed and fail in locked-down environments.

The wrapper exposes:

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

This maps to the hub protocol:

```text
TerminalOutput event       <- hub output bytes decoded as UTF-8
WriteInput(string data)    -> hub input bytes encoded as UTF-8
Resize(rows, columns)      -> hub resize message
```

## Upgrade process for newer Windows Terminal tags

Do not upgrade casually. To evaluate a newer tag:

1. identify a stable Windows Terminal tag;
2. update `deps/windows-terminal.json` in a branch;
3. clear or update `patches/windows-terminal/<tag>`;
4. run `scripts/bootstrap-windows-terminal.ps1`;
5. run `scripts/build-windows-terminal-control.ps1`;
6. publish the frontend;
7. validate terminal behavior:

```bash
ls --color=always
printf '\e[31mred\e[0m\n'
nvim
tmux
stty size
```

8. verify mouse mode, copy/paste, focus, and multiple terminal controls;
9. only then commit the version bump.

## Troubleshooting

### Git for Windows was not found

Install Git for Windows. The bootstrap script intentionally does not use WSL Git for the Windows checkout.

### Windows Store v143 toolset missing

Install the UWP/Windows Store C++ Build Tools components listed above.

### Stale Git lock after interrupted bootstrap

If an earlier clone/checkout was interrupted, bootstrap may fail with:

```text
Unable to create ...\.git\index.lock: File exists
```

First verify no Git process is still running:

```powershell
Get-Process git -ErrorAction SilentlyContinue
```

If no Git process is running, remove the stale lock:

```powershell
Remove-Item "$env:USERPROFILE\gitrepo\microsoft-terminal\.git\index.lock" -Force
```

Then rerun:

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\bootstrap-windows-terminal.ps1
```

### Build output locked during publish

Close running app windows or stop the process:

```powershell
Get-Process NeonCode.Windows -ErrorAction SilentlyContinue | Stop-Process -Force
```

### Native terminal fails to load

Check that publish output contains:

```text
Microsoft.Terminal.Control.dll
Microsoft.Terminal.Control.pri
Microsoft.Terminal.Control\
```

Then republish with:

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\publish-windows-frontend.ps1 -Clean
```

### Powerline/Nerd Font glyphs do not render

Edit:

```text
%APPDATA%\NeonCode\config.json
```

Set `terminal.fontFace` to an installed font family such as:

```json
"FiraCode Nerd Font Mono"
```

List installed matching fonts:

```powershell
Add-Type -AssemblyName PresentationCore
[System.Windows.Media.Fonts]::SystemFontFamilies |
  Where-Object { $_.Source -match 'Nerd|Casc|Fira|JetBrains|Hack|Meslo' } |
  Sort-Object Source |
  ForEach-Object Source
```
