# Windows frontend POC

This is a temporary WPF/.NET 8 shell for proving the Windows GUI to `workspace-hub` protocol.

It does **not** embed Windows Terminal yet. The large text box is a placeholder so we can test:

- connecting to the WSL/Linux Rust hub;
- starting a PTY-backed bash session;
- sending input;
- receiving terminal output.

## Run

Start the hub from WSL/Linux:

```bash
cargo run -p workspace-hub
```

Then on Windows, with the .NET 8 SDK installed:

```powershell
dotnet run --project frontends\windows\WorkspaceCockpit.Windows\WorkspaceCockpit.Windows.csproj
```

Use endpoint:

```text
ws://127.0.0.1:44777/ws
```

Click:

1. `Connect`
2. `Start bash`
3. type commands in the input box and press Enter

## Next frontend step

Replace the placeholder output/input controls with a real terminal renderer adapter:

```text
TerminalView
  write(bytes)
  resize(cols, rows)
  onInput(callback)
  onResize(callback)
```

The first real candidate is the Windows Terminal `HwndTerminal` / WPF terminal control from a pinned `microsoft/terminal` revision.
