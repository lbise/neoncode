# NeonCode alpha release workflow

This document describes the Windows alpha release groundwork. It is intentionally scoped to the supported stack:

```text
Electron + xterm.js -> neoncode-hub WebSocket -> WSL/Linux PTY
```

Do not add release work to obsolete Windows Terminal embedding, WPF hosting, or child-HWND terminal paths.

## Outputs

Alpha packaging writes artifacts under:

```text
release/windows-alpha/
```

Expected files include the electron-builder Windows outputs that are feasible on the builder host:

- per-user NSIS installer (`NeonCode Alpha-<version>-alpha-x64.exe`);
- portable executable when electron-builder can produce it;
- zip archive when electron-builder can produce it;
- electron-builder sidecar metadata such as blockmaps or latest YAML when emitted;
- `SHA256SUMS` for every artifact in the directory;
- `manifest.json` with schema version, alpha channel, package version, git SHA, signing metadata, artifact sizes, hashes, and Authenticode status.

The packaged app uses `app.asar` and includes only generated Electron app files plus the bundled WSL hub resource:

```text
resources/hub/linux-x64/neoncode-hub
```

The development publish directory under `%USERPROFILE%\neoncode-electron` is not used for alpha release packaging.

## Build and package

Run from the WSL repository root:

```bash
./dev release-alpha
```

The command calls `scripts/release-windows.ps1`, which:

1. builds the Rust hub in WSL with `cargo build -p neoncode-hub --release`;
2. copies `target/release/neoncode-hub` into `frontends/electron/resources/hub/linux-x64/neoncode-hub`;
3. builds strict Electron generated artifacts with `npm --prefix frontends/electron run build`;
4. writes generated release provenance into `frontends/electron/dist/release-info.json`;
5. packages Windows alpha artifacts through `npm --prefix frontends/electron run package:alpha` and `frontends/electron/electron-builder.yml`;
6. optionally signs signable artifacts;
7. writes `SHA256SUMS` and `manifest.json`;
8. invokes `scripts/verify-release.ps1` unless `-SkipVerify` is supplied.

Useful variants:

```bash
./dev package-alpha       # reuse existing release build outputs where possible
./dev verify-release      # verify the current release/windows-alpha directory
```

PowerShell switches can be passed through, for example:

```bash
./dev release-alpha -DryRun
./dev release-alpha -RequireSigning
./dev verify-release -RequireSigning -SkipDefender
```

`-DryRun` prints the planned WSL, package, signing, and verification steps without modifying artifacts where practical.

## Local dogfood launch

For local feedback before publisher reputation is established, use the controlled portable launcher:

```bash
./dev alpha-run-portable
```

The command verifies the current alpha release, copies the portable executable to a Windows-local directory, unblocks only that copied executable with `Unblock-File`, records `dogfood.json`, and launches it through Explorer at medium integrity:

```text
%LOCALAPPDATA%\NeonCodeAlpha\NeonCodeAlpha.exe
```

This does not disable Defender and does not add exclusions. It only removes Mark-of-the-Web from the local copy you intentionally built. SmartScreen can still warn for unsigned builds; choose **More info → Run anyway** only for local artifacts whose SHA-256 matches `release/windows-alpha/SHA256SUMS`.

## Signing

Authenticode signing is optional for local dry runs but required for dogfoodable release candidates. Configure signing with environment variables visible to Windows PowerShell:

```text
SIGNING_CERT_THUMBPRINT   preferred certificate lookup by thumbprint
SIGNING_CERT_SUBJECT      fallback certificate lookup by subject substring
SIGNING_TIMESTAMP_URL     optional RFC 3161/Authenticode timestamp server URL
SIGNING_REQUIRED=1        make missing/unusable signing fail the release
```

`./dev release-alpha -RequireSigning` is equivalent to requiring signing for that invocation. If signing is required and no matching certificate is available, the script fails before publishing hashes or a manifest. If a timestamp URL is configured, signatures are timestamped; release candidates should be timestamped so signatures survive certificate expiry.

The scripts sign only signable Windows artifacts (`.exe`, `.msi`, `.msix`, `.appx`) and never place hub capability tokens on command lines.

## Verification gates

`./dev verify-release` verifies:

- every `SHA256SUMS` entry exists and matches its SHA-256 hash;
- every manifest artifact exists and matches its recorded SHA-256 hash;
- Authenticode status for signable artifacts, failing when signing is required and any signable artifact is not `Valid`;
- Microsoft Defender custom scan when `Start-MpScan` or `MpCmdRun.exe` is available.

Defender validation must run with normal Defender settings. Do not disable Defender and do not add exclusions for NeonCode build, package, release, or runtime paths. If Defender or SmartScreen flags an artifact, treat it as a release blocker: preserve the artifact, manifest, hashes, certificate identity, and detection details for false-positive/reputation submission rather than bypassing protection.

SmartScreen reputation validation is manual until CI/VM automation exists:

1. use a clean, fully updated Windows machine or VM with Defender cloud protection enabled;
2. download/copy the signed installer exactly as a user would receive it;
3. confirm the file hash matches `SHA256SUMS` and the signature is valid/timestamped;
4. launch/install without exclusions;
5. record any SmartScreen or Defender prompt/detection and block the release if reputation is unacceptable.

## App-managed hub lifecycle

The packaged Electron main process manages the default local hub endpoint:

```text
ws://127.0.0.1:44777/ws
```

Startup behavior:

1. convert the WebSocket endpoint to `http://127.0.0.1:<port>/health`;
2. if health is already OK, leave the existing hub alone;
3. if the endpoint is non-loopback or unsupported, skip app-managed startup and report diagnostics;
4. ensure the WSL token file exists securely at `${XDG_STATE_HOME:-$HOME/.local/state}/neoncode/hub-token`;
5. copy the bundled hub binary into `${XDG_DATA_HOME:-$HOME/.local/share}/neoncode/hub/neoncode-hub-<version-or-sha>`;
6. start it with `wsl.exe` and `NEONCODE_HUB_BIND`, without passing the token on the command line;
7. poll `/health` and surface warnings/errors/status through the renderer bootstrap diagnostics.

The Rust hub still honors `NEONCODE_HUB_TOKEN` for developer/manual workflows. When that environment variable is absent, it falls back to the managed WSL token file, allowing packaged `wsl.exe` launch without a token environment variable.

## Rollback

Alpha rollback is intentionally simple:

1. uninstall NeonCode Alpha from Windows Apps & Features or delete the portable/zip extraction directory;
2. stop any stray `neoncode-hub` process inside WSL if needed;
3. reinstall or unzip the previous signed alpha artifact and verify it against its saved `SHA256SUMS`/`manifest.json`;
4. keep `%APPDATA%\NeonCode\config.json` and `state.json` unless the rollback specifically targets a configuration migration problem;
5. rotate the hub token with `./dev reset-token` only if token exposure is suspected, then restart the hub/app.

Release artifacts, manifests, and signing certificate identity for the superseded build should remain archived so a user can prove exactly which build was installed.
