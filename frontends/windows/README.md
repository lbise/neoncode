# Windows frontend POC

This is a temporary WPF/.NET 8 shell for proving the Windows GUI to `workspace-hub` protocol.

The app now tries to host the Windows Terminal renderer through a vendored WPF wrapper around `Microsoft.Terminal.Control.dll`. If the native control cannot load, it falls back to the original textbox terminal shim.

## Native terminal dependency

Build the native Windows Terminal control first:

```bash
./dev wt-build
```

Equivalent manual command:

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
./dev hub
```

Then publish and start the Windows app from another WSL terminal:

```bash
./dev app
```

`./dev app` stops any running `WorkspaceCockpit.Windows` process, publishes to a Windows-local folder, verifies the native Windows Terminal files, and starts the EXE. `./dev publish` does the same stop-and-publish step without launching the app.

Manual publish equivalent:

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\publish-windows-frontend.ps1
```

By default, the app is published to:

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

Initial settings include terminal font, size, colors, cursor style, and the 16-color table. To use a Powerline/Nerd Font, set `fontFace` to an installed Windows font family name. On this machine, for example:

```json
{
  "terminal": {
    "fontFace": "FiraCode Nerd Font Mono",
    "fontSize": 14,
    "background": "#0C0C0C",
    "foreground": "#CCCCCC",
    "selectionBackground": "#666666",
    "cursorStyle": "BlinkingBlock"
  }
}
```

Restart the app after editing the config. If the configured font is not installed, the native terminal view falls back to `Cascadia Mono` or `Consolas` and reports that fallback in the status bar.

To list installed matching font family names:

```powershell
Add-Type -AssemblyName PresentationCore
[System.Windows.Media.Fonts]::SystemFontFamilies |
  Where-Object { $_.Source -match 'Nerd|Casc|Fira|JetBrains|Hack|Meslo' } |
  Sort-Object Source |
  ForEach-Object Source
```

## Validation commands

```bash
ls --color=always
printf '\e[31mred\e[0m\n'
nvim
tmux
stty size
```
