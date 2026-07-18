# Native Linux development

NeonCode's supported alpha release target is still Windows, but the active application stack is portable enough to run directly on Linux:

```text
Electron shell -> xterm.js -> neoncode-hub WebSocket -> Linux PTY
```

This path is intended for local development on native Linux hosts without WSL/PowerShell.

## Prerequisites

- Node.js/npm matching the repository lockfile expectations;
- Rust toolchain with `cargo` for the hub and packaged builds;
- Electron's Linux runtime from `npm ci` in `frontends/electron`;
- Electron's `chrome-sandbox` helper configured as root-owned mode `4755`;
- a graphical session, or `xvfb-run` for hidden Electron tests on headless machines.

## Daily native loop

From the repository root:

```bash
npm --prefix frontends/electron ci
./dev electron-sandbox-fix

# terminal 1
./dev hub

# terminal 2
./dev app
```

`./dev` creates/loads the shared hub capability token at:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/neoncode/hub-token
```

The Electron app and hub both use the same token file. If you bypass `./dev`, either export `NEONCODE_HUB_TOKEN` or ensure the managed token file exists before starting both processes.

## Native commands

```bash
./dev publish        # strict Electron TypeScript/browser build into frontends/electron/dist
./dev electron       # start Electron directly from frontends/electron
./dev app            # build, then start Electron
./dev electron-test  # build, then run headless-safe Playwright Electron tests for SSH/Xvfb
./dev electron-test-headless # same as electron-test on native Linux
./dev electron-test-gui # full GUI suite, including tmux/nvim mouse checks
./dev electron-sandbox-fix # configure Electron's Linux chrome-sandbox helper after npm ci
./dev package-linux  # build release hub and Linux alpha AppImage/tar.gz artifacts
```

`./dev electron-test` expects a hub to be listening at `ws://127.0.0.1:44777/ws`. Start it with `./dev hub` first. If no graphical display is available and `xvfb-run` is installed, the test command automatically uses it.

Native Linux has two Electron suites:

- `./dev electron-test` / `./dev electron-test-headless`: SSH/Xvfb-safe coverage for launch, auth, terminal input/output, persistence, reconnect, keybindings, layout, and heavy output continuity. It skips fragile real GUI mouse checks inside full-screen terminal applications.
- `./dev electron-test-gui`: full GUI coverage, including tmux and Neovim mouse behavior. Run this from a real graphical desktop or GUI CI worker, not a plain headless SSH session.

If Electron reports that `chrome-sandbox` is not configured correctly, run:

```bash
./dev electron-sandbox-fix
```

This performs the equivalent of:

```bash
sudo chown root:root frontends/electron/node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 frontends/electron/node_modules/electron/dist/chrome-sandbox
```

Repeat this after `npm ci` or any Electron dependency refresh recreates `node_modules/electron`.

Linux package output is written to:

```text
release/linux-alpha
```

## Current limitations

- Windows release signing, Defender/SmartScreen gates, and clean-VM validation remain Windows-only release work.
- Native Linux packaging is a development artifact path, not yet a supported production distribution channel.
- App-managed bundled hub startup is supported for Linux packages; during source development, running `./dev hub` explicitly remains the recommended loop.
