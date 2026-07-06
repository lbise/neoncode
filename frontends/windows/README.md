# Windows frontend POC

This is a temporary WPF/.NET 8 shell for proving the Windows GUI to `workspace-hub` protocol.

The app now tries to host the Windows Terminal renderer through a vendored WPF wrapper around `Microsoft.Terminal.Control.dll`. If the native control cannot load, it falls back to the original textbox terminal shim.

## Native terminal dependency

Build the native Windows Terminal control first:

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\build-windows-terminal-control.ps1
```

Expected native output:

```text
C:\Users\13lbise\gitrepo\microsoft-terminal\bin\x64\Debug\Microsoft.Terminal.Control\Microsoft.Terminal.Control.dll
```

The frontend project copies the native files into its own output directory during `dotnet build`.

## Run

Start the hub from WSL/Linux:

```bash
cargo run -p workspace-hub
```

Then either run from the project path:

```powershell
dotnet run --project frontends\windows\WorkspaceCockpit.Windows\WorkspaceCockpit.Windows.csproj
```

or publish to a Windows-local folder and run the EXE from there:

```bash
powershell.exe -NoProfile -Command 'dotnet publish frontends\\windows\\WorkspaceCockpit.Windows\\WorkspaceCockpit.Windows.csproj -c Debug -o "$env:USERPROFILE\\workspace-cockpit-publish"'
```

```powershell
$env:USERPROFILE\workspace-cockpit-publish\WorkspaceCockpit.Windows.exe
```

Publishing is preferred for testing the native Windows Terminal control because all managed and native runtime files are placed together on the Windows filesystem.

Use endpoint:

```text
ws://127.0.0.1:44777/ws
```

Click:

1. `Connect`
2. `Start bash`
3. type directly in the terminal area

If the app falls back to the textbox renderer, use the bottom input box and press Enter.

## Validation commands

```bash
ls --color=always
printf '\e[31mred\e[0m\n'
nvim
tmux
stty size
```
