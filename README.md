# NeonCode

NeonCode is a workspace/session cockpit prototype for terminal-heavy development.

Current default stack:

```text
Electron app + xterm.js
  -> neoncode-hub WebSocket
  -> Rust portable-pty sessions in WSL/Linux
```

Native Windows Terminal embedding was validated, but is now kept as a fallback/comparison path rather than the default renderer.

## Run

From WSL/Linux repo root:

```bash
# terminal 1
./dev hub

# terminal 2
./dev app
```

Useful commands:

```bash
./dev publish   # publish Electron xterm.js app
./dev check     # JS/.NET/Rust checks
./dev status    # useful paths/status
```

Fallback/reference commands:

```bash
./dev electron-native      # Electron + direct Windows Terminal coordinator fallback
./dev electron-native-wpf  # Electron + WPF terminal host fallback
./dev wpf-app              # standalone WPF reference app
```

## Key documents

- [Product requirements](docs/product-requirements.md)
- [Architecture](docs/architecture.md)
- [Development plan](docs/development-plan.md)
- [Hub guide](docs/hub.md)
- [Hub protocol](docs/protocol.md)
- [Terminal renderer decision](docs/terminal-renderer-decision.md)
- [External tool inspiration](docs/external-tool-inspiration.md)
- [Native Windows Terminal fallback tooling](docs/windows-terminal-embedding.md)

## Agent/developer guide

Coding agents should read [AGENTS.md](AGENTS.md) for project-specific commands, validation expectations, and testing notes.
