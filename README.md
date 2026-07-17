# NeonCode

NeonCode is a workspace/session cockpit prototype for terminal-heavy development.

Supported Windows stack:

```text
Electron app + xterm.js
  -> neoncode-hub WebSocket
  -> Rust portable-pty sessions in WSL/Linux
```

Previous Windows Terminal/WPF embedding POCs are obsolete. The way forward on Windows is Electron + xterm.js + `neoncode-hub`.

## Run

From WSL/Linux repo root:

```bash
# terminal 1
./dev hub

# terminal 2
./dev app
```

The desktop supports persistent tabs plus keyboard-complete pane splitting, directional resizing, explicit detach/kill close, and detach/kill/restart lifecycle controls. Defaults are `Alt+Shift+=` for a side-by-side split, `Alt+Shift+-` for a stacked split, `Alt+Shift+Arrow` for directional border resizing, and `F6`/`Shift+F6` for depth-first pane focus. Destructive pane lifecycle actions are deliberately unbound and remain available from Commands and pane headers.

Useful commands:

```bash
./dev publish   # publish Electron app
./dev check     # JS/Rust checks
./dev status    # useful paths/status
```

## Key documents

- [Product requirements](docs/product-requirements.md)
- [Architecture](docs/architecture.md)
- [Development plan](docs/development-plan.md)
- [Desktop configuration](docs/configuration.md)
- [Hub guide](docs/hub.md)
- [Hub protocol](docs/protocol.md)
- [Testing strategy](docs/testing.md)
- [Terminal renderer decision](docs/terminal-renderer-decision.md)
- [External tool inspiration](docs/external-tool-inspiration.md)

## Agent/developer guide

Coding agents should read [AGENTS.md](AGENTS.md) for project-specific commands, validation expectations, and testing notes.
