# NeonCode

NeonCode is a workspace/session cockpit prototype for terminal-heavy development.

Supported Windows stack:

```text
Electron app + xterm.js
  -> neoncode-hub WebSocket
  -> Rust portable-pty sessions in WSL/Linux
```

Previous Windows Terminal/WPF embedding POCs are obsolete. The way forward on Windows is Electron + xterm.js + `neoncode-hub`.

## Native Linux development setup

On Ubuntu 24.04, install the native toolchain and Electron runtime dependencies:

```bash
sudo apt-get update
sudo apt-get install -y \
  git build-essential pkg-config curl ca-certificates xvfb \
  libgtk-3-0t64 libnss3 libasound2t64 libxss1 libxtst6 libxrandr2 libxdamage1 \
  libxcomposite1 libxcursor1 libxi6 libcups2t64 libdrm2 libgbm1 libxkbcommon0 \
  libpango-1.0-0 libcairo2 libatk-bridge2.0-0t64 libatspi2.0-0t64 libdbus-1-3 \
  libfuse2t64

# If cargo/rustup is not already installed:
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
. "$HOME/.cargo/env"
rustup default stable

# Use the repo's Node/npm environment, then install locked Electron dependencies:
npm --prefix frontends/electron ci

# Configure Electron's Linux sandbox helper after npm ci downloads/refreshes Electron:
./dev electron-sandbox-fix
```

Notes:

- `cargo` is required for `./dev hub`, `./dev check`, and `./dev package-linux`.
- `xvfb` lets `./dev electron-test` run on headless machines.
- `libfuse2t64` is useful for running generated AppImage artifacts.
- Electron on Linux requires `frontends/electron/node_modules/electron/dist/chrome-sandbox` to be owned by root with mode `4755`; `./dev electron-sandbox-fix` runs the required `sudo chown`/`chmod`.
- This repository is currently exercised with Node.js 24 from `nvm`; if `node -v` is old or missing, install/use Node 24 before running `npm ci`.

On older Debian/Ubuntu releases, package names may be slightly different: `libasound2`, `libfuse2`, `libgtk-3-0`, `libcups2`, `libatk-bridge2.0-0`, and `libatspi2.0-0` may replace the `t64` names above.

On Arch Linux, the equivalent package set is roughly:

```bash
sudo pacman -S --needed \
  git base-devel pkgconf rustup nodejs npm \
  gtk3 nss alsa-lib xorg-server-xvfb libxss \
  libx11 libxcb libxcomposite libxcursor libxdamage libxext libxi libxrandr libxtst \
  cups libdrm mesa libxkbcommon pango cairo at-spi2-core expat dbus glib2 fuse2
```

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
./dev publish       # build Electron app artifacts for local development
./dev electron-test # headless-safe Electron/Playwright tests for SSH/Xvfb
./dev electron-test-gui # full GUI Electron tests including tmux/nvim mouse checks
./dev electron-sandbox-fix # fix Electron's Linux chrome-sandbox helper after npm ci
./dev check         # TypeScript + Rust fmt/check/test/clippy
./dev package-linux # native Linux alpha AppImage/tar.gz development artifacts
./dev release-alpha # Windows build/package/sign(optional)/verify alpha artifacts
./dev status        # useful paths/status
```

## Key documents

- [Product requirements](docs/product-requirements.md)
- [Architecture](docs/architecture.md)
- [Development plan](docs/development-plan.md)
- [Desktop configuration](docs/configuration.md)
- [Native Linux development](docs/linux-development.md)
- [Hub guide](docs/hub.md)
- [Hub protocol](docs/protocol.md)
- [Testing strategy](docs/testing.md)
- [Alpha release workflow](docs/release.md)
- [Terminal renderer decision](docs/terminal-renderer-decision.md)
- [External tool inspiration](docs/external-tool-inspiration.md)

## Agent/developer guide

Coding agents should read [AGENTS.md](AGENTS.md) for project-specific commands, validation expectations, and testing notes.
