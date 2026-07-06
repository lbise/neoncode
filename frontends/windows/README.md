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
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\publish-windows-frontend.ps1
```

The script verifies that the published app includes the required Windows Terminal native files, then prints the exact run command. By default, the app is published to:

```text
%USERPROFILE%\workspace-cockpit-publish
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

## Configuration

On first run, the Windows app creates:

```text
%APPDATA%\WorkspaceCockpit\config.json
```

Initial settings include terminal font, size, colors, cursor style, and the 16-color table. To use a Powerline/Nerd Font, edit for example:

```json
{
  "terminal": {
    "fontFace": "CaskaydiaCove Nerd Font",
    "fontSize": 14,
    "background": "#0C0C0C",
    "foreground": "#CCCCCC",
    "selectionBackground": "#666666",
    "cursorStyle": "BlinkingBlock"
  }
}
```

Restart the app after editing the config. If the configured font is not installed, the native terminal view falls back to `Cascadia Mono` or `Consolas`.

## Validation commands

```bash
ls --color=always
printf '\e[31mred\e[0m\n'
nvim
tmux
stty size
```
