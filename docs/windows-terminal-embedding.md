# Windows Terminal embedding POC

This note tracks the first real terminal-renderer proof of concept for the Windows frontend.

## Goal

Replace the current placeholder WPF text box with an embedded Windows Terminal renderer:

```text
WPF frontend
  ⇄ TerminalView adapter
      ⇄ Microsoft.Terminal.Control.dll / HwndTerminal
          ⇄ workspace-hub WebSocket
              ⇄ WSL/Linux PTY
```

This is the make-or-break POC for proper ANSI rendering, focus, special keys, resize, mouse input, selection, copy/paste, Neovim, and tmux.

## Current app prep

The app now has a frontend abstraction plus two implementations:

```text
frontends/windows/WorkspaceCockpit.Windows/Terminal/ITerminalView.cs
frontends/windows/WorkspaceCockpit.Windows/Terminal/TextBoxTerminalView.cs
frontends/windows/WorkspaceCockpit.Windows/Terminal/WindowsTerminalView.cs
```

`WindowsTerminalView` is the primary path. It hosts the Windows Terminal WPF wrapper behind `ITerminalView` and forwards input/output/resize through the existing hub WebSocket protocol. `TextBoxTerminalView` remains as a fallback if the native control cannot load.

## Source checkout

The Windows Terminal source is cloned outside this repo:

```text
~/gitrepo/microsoft-terminal
```

Pinned tag currently used for investigation:

```text
v1.22.11141.0
```

Reason: current `main` requires VS 2026-era tooling, while this tag is compatible with VS 2022-era tooling.

Clone/check out manually if needed:

```bash
cd ~/gitrepo
git clone --filter=blob:none https://github.com/microsoft/terminal.git microsoft-terminal
cd microsoft-terminal
git fetch --depth 1 origin tag v1.22.11141.0
git checkout v1.22.11141.0
```

## Required Windows build tools

The native control requires Visual Studio C++ build tools. A plain .NET SDK is not enough.

Known requirements found during the POC:

- `Microsoft.VisualStudio.Workload.NativeDesktop`
- `Microsoft.VisualStudio.Component.VC.Tools.x86.x64`
- `Microsoft.VisualStudio.Component.Windows11SDK.22621` or newer
- `Microsoft.VisualStudio.Workload.Universal`
- `Microsoft.VisualStudio.ComponentGroup.UWP.VC`

The Windows Terminal repo includes a `.vsconfig` with its full component list.

The missing UWP/Windows Store C++ v143 build tools were fixed with the Build Tools-specific component IDs below. If this error appears again:

```text
MSB8020: The build tools for 'v143' application Type Windows Store
(Platform Toolset = 'v143') cannot be found.
```

install/modify Visual Studio Build Tools with:

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

If the installer appears to do nothing, check for stale `MSBuild.exe` processes. The installer may skip modifications when Visual Studio/MSBuild processes are running. Stop stale MSBuild processes or add `--force`.

## Native control build command

Build the Windows Terminal dependency from normal Windows paths, not from `\\wsl.localhost\...`. Some Windows Terminal build scripts do not handle UNC paths correctly.

Current external dependency locations:

```text
C:\Users\13lbise\gitrepo\microsoft-terminal
C:\Users\13lbise\gitrepo\vcpkg
```

The helper script is:

```text
scripts/build-windows-terminal-control.ps1
```

Run it from WSL:

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\build-windows-terminal-control.ps1
```

The script passes explicit `SolutionDir`, `OpenConsoleDir`, `VcpkgRoot`, and Windows SDK properties. It also builds `Host.Proxy.vcxproj` first because `TerminalConnection` needs generated `ITerminalHandoff.h` headers from that project.

For the POC, the script applies two tiny local compatibility patches to `microsoft/terminal v1.22.11141.0` to satisfy newer MSVC warning-as-error checks for unused parameters.

Current status: this successfully builds the native control.

Expected native output:

```text
C:\Users\13lbise\gitrepo\microsoft-terminal\bin\x64\Debug\Microsoft.Terminal.Control\Microsoft.Terminal.Control.dll
```

NuGet package restore uses the Windows Terminal repo's custom feed:

```text
C:\Users\13lbise\gitrepo\microsoft-terminal\NuGet.Config
```

## WPF wrapper integration

The app vendors the small upstream WPF wrapper source from:

```text
C:\Users\13lbise\gitrepo\microsoft-terminal\src\cascadia\WpfTerminalControl
```

into:

```text
frontends/windows/WorkspaceCockpit.Windows/Vendor/WpfTerminalControl
```

Vendoring avoids restoring/building the upstream WPF wrapper project, which can be pulled into Windows Terminal's custom NuGet feed and fail in locked-down environments. The app project copies the native `Microsoft.Terminal.Control` build output into its own output directory after build.

The upstream WPF wrapper exposes:

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

This maps naturally to our hub connection:

```text
TerminalOutput event       <- hub output bytes decoded as UTF-8
WriteInput(string data)    -> hub input bytes encoded as UTF-8
Resize(rows, columns)      -> hub resize message
```

Build the frontend after the native control exists:

```bash
powershell.exe -NoProfile -Command "dotnet build frontends\\windows\\WorkspaceCockpit.Windows\\WorkspaceCockpit.Windows.csproj"
```

Expected copied runtime files include:

```text
frontends/windows/WorkspaceCockpit.Windows/bin/Debug/net8.0-windows/Microsoft.Terminal.Control.dll
frontends/windows/WorkspaceCockpit.Windows/bin/Debug/net8.0-windows/Microsoft.Terminal.Control.pri
frontends/windows/WorkspaceCockpit.Windows/bin/Debug/net8.0-windows/Microsoft.Terminal.Control/
```

## Validation checklist

Once the embedded terminal renders the WSL PTY, test:

- `ls --color=always`
- `printf '\e[31mred\e[0m\n'`
- `nvim`
- `tmux`
- mouse mode in Neovim/tmux
- resize propagation with `stty size`
- copy/paste
- focus switching
- multiple terminal controls in one window
