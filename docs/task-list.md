# NeonCode task list

This is the working checklist for moving from the validated Windows Terminal embedding POC to a usable prototype and eventually a product.

Validated POC snapshot:

```text
poc/windows-terminal-embedded
```

## Current stage

```text
Stage: Phase 1/3 — shared session/protocol foundation
Next task: choose between starting the direct native coordinator POC or continuing Rust protocol/session refactor
```

## Phase 0 — preserve the spike

Goal: preserve the known-good proof that the architecture is viable.

- [x] Build Rust WSL/Linux PTY backend POC.
- [x] Add `/health` endpoint.
- [x] Add `/ws` WebSocket endpoint.
- [x] Implement PTY start/input/output/resize/kill path.
- [x] Build WPF/.NET 8 Windows frontend shell.
- [x] Validate frontend connects to backend.
- [x] Validate WSL bash can be launched and controlled.
- [x] Add terminal abstraction with `ITerminalView`.
- [x] Build `Microsoft.Terminal.Control.dll` from pinned Windows Terminal source.
- [x] Vendor/use Windows Terminal WPF wrapper.
- [x] Implement `WindowsTerminalView` behind `ITerminalView`.
- [x] Validate real rendering with Neovim.
- [x] Keep textbox fallback renderer.
- [x] Commit POC state.
- [x] Tag POC state as `poc/windows-terminal-embedded`.
- [x] Document POC result and lessons learned.

## Phase 1 — clean prototype foundation

Goal: convert the spike into a maintainable prototype without changing the validated architecture.

- [x] Add `scripts/publish-windows-frontend.ps1`.
- [x] Publish script verifies the native Windows Terminal files are present.
- [x] Publish script emits a clear run command/path after success.
- [x] Add repo-root `./dev` command wrapper for common build/run flows.
- [x] Add Windows Terminal dependency bootstrap script or documented reproducible bootstrap flow.
- [x] Move Windows Terminal compatibility edits into explicit patch files or deterministic script steps.
- [x] Add script validation for required Visual Studio/UWP Build Tools components.
- [x] Add a first app config file for local frontend settings.
- [x] Document UI toolkit decision and Electron spike criteria.
- [ ] Add app-level error reporting for native terminal load failure.
- [ ] Add app-level error reporting for backend disconnect.
- [ ] Add app-level error reporting for session exit and protocol errors.
- [ ] Reorganize Rust hub around explicit session management modules.
- [ ] Define protocol message structs/enums cleanly in Rust.
- [ ] Keep `docs/protocol.md` synchronized with protocol types.
- [ ] Add structured tracing/logging to the hub.

## Phase 2 — terminal correctness and usability

Goal: make the terminal experience trustworthy for daily terminal/TUI use.

- [ ] Confirm resize propagation with `stty size`.
- [ ] Verify Ctrl+C.
- [ ] Verify Ctrl+D.
- [ ] Verify Ctrl+Z.
- [ ] Verify Alt key combinations.
- [ ] Verify arrow keys.
- [ ] Verify function keys.
- [ ] Verify Home/End.
- [ ] Verify Page Up/Page Down.
- [ ] Verify mouse mode in Neovim.
- [ ] Verify mouse mode in tmux.
- [ ] Implement or document copy behavior.
- [ ] Implement or document paste behavior.
- [ ] Add clean session kill/restart behavior.
- [ ] Document scrollback behavior and limitations.
- [x] Load terminal font from app config.
- [x] Load terminal font size from app config.
- [x] Load terminal color theme from app config.
- [ ] Optionally import font/color settings from Windows Terminal `settings.json`.

Validation commands:

```bash
ls --color=always
printf '\e[31mred\e[0m\n'
nvim
tmux
stty size
```

## Phase 3 — session model

Goal: evolve from one hardcoded shell session to real session orchestration.

- [ ] Support multiple backend sessions.
- [ ] Replace hardcoded frontend session ID.
- [ ] Decide whether session IDs are frontend-provided or backend-generated.
- [ ] Add protocol message to list active sessions.
- [ ] Add attach behavior.
- [ ] Add detach behavior.
- [ ] Add reconnect without killing PTY.
- [ ] Report session exit status/reason.
- [ ] Add local WSL shell launch profile.
- [ ] Add project-directory shell launch profile.
- [ ] Add SSH launch profile.
- [ ] Add tmux attach/create launch profile.
- [ ] Add custom command launch profile.
- [ ] Persist recent sessions.
- [ ] Persist recent workspaces.

## Phase 4 — workspace cockpit features

Goal: build the actual workspace/session cockpit value proposition.

- [ ] Define workspace file/schema.
- [ ] Add GUI-owned tabs.
- [ ] Add GUI-owned panes/splits.
- [ ] Save layout.
- [ ] Restore layout.
- [ ] Add project overview.
- [ ] Add machine/host overview.
- [ ] Add quick launch commands.
- [ ] Integrate SSH profiles/config.
- [ ] Integrate tmux profile conventions.
- [ ] Add session/host status indicators.
- [ ] Add browser launch/profile hooks.
- [ ] Add X2Go or external remote desktop launch hooks.
- [ ] Add keyboard command palette or equivalent launcher.

Design rule:

- [ ] Keep tmux as optional remote persistence, not the visible layout owner.

## Phase 5 — dependency/toolchain hardening

Goal: make the Windows Terminal dependency sustainable.

- [ ] Re-evaluate Windows Terminal version after scripts are reproducible.
- [ ] Try a newer stable Windows Terminal tag.
- [x] Keep Windows Terminal dependency pinned.
- [x] Store local patches in this repo.
- [x] Validate Visual Studio component requirements in scripts.
- [x] Avoid UNC paths for Windows-native builds.
- [ ] Decide whether vendoring the upstream WPF wrapper remains acceptable.
- [ ] Evaluate maintaining a smaller first-party `HwndTerminal` wrapper.

## Phase 6 — GUI toolkit reassessment

Goal: make a product GUI decision using real data, not speculation.

- [x] Discard Tauri for now.
- [x] Discard Avalonia for now.
- [x] Discard Qt/QML for now due to licensing/distribution concerns.
- [x] Document WPF vs WinUI 3 vs Electron decision criteria.
- [x] Scaffold focused Electron native Windows Terminal embedding spike.
- [x] Install/verify Windows Node/npm for the Electron spike.
- [x] Add Windows-local publish flow for Electron spike.
- [x] Run focused Electron native Windows Terminal embedding spike.
- [x] Document Electron spike pass/fail conclusion.
- [x] Fix/investigate Alt+Tab native terminal refocus in Electron spike.
- [ ] Track intermittent taskbar-return refocus race in Electron spike; direct-native testing suggests this is a general child-HWND activation issue, not WPF-specific.
- [x] Record startup polish plan for Electron/native host attach.
- [x] Record Electron/native terminal host architecture options.
- [x] Explore Windows Terminal app-layer source for paste/copy/keybindings/focus behavior to adapt.
- [x] Sketch native Windows terminal coordinator API for Electron integration.
- [x] Build minimal direct-native `HwndTerminal` coordinator POC under Electron.
- [x] Validate direct-native `HwndTerminal` coordinator visually under Electron.
- [x] Add initial explicit bounds/focus/blur IPC to direct-native coordinator before deeper hub integration.
- [x] Add debug file logging for Electron/direct-native coordinator focus and bounds events.
- [x] Add basic automated Electron focus/minimize/restore stress harness.
- [ ] Validate direct-native coordinator explicit bounds/focus/blur IPC under Electron stress tests using debug logs.
- [ ] Add hub/WebSocket/PTTY bridge to direct-native coordinator if direct-native focus/layout remains acceptable.
- [ ] Reassess WPF after Electron spike.
- [ ] Evaluate WinUI 3 only if a Windows-native product direction becomes likely.
- [ ] Verify native terminal hosting feasibility for the chosen product shell.
- [ ] Verify keyboard/input fidelity for the chosen product shell.
- [ ] Verify copy/paste and keybinding behavior against Windows Terminal expectations.
- [x] Validate Electron two-terminal split spike for independent input and process cleanup.
- [x] Validate Electron two-terminal split resize/snap and Neovim+tmux behavior.
- [ ] Continue Electron two-terminal split validation for less-common z-order, DPI, long-session stability, and visual polish.
- [ ] Track Electron/native terminal focus flicker as a deferred polish/coordinator issue.
- [ ] Verify docking/tabs/layout support for the chosen product shell.
- [ ] Verify dependency and packaging risk for the chosen product shell.
- [x] Decide current near-product GUI direction: Electron is viable enough to continue as likely shell; WPF remains reference/fallback.

## Next task detail — Windows Terminal dependency bootstrap/build

This is the current foundation task because Windows Terminal is a core dependency of the project. The bootstrap/build flow should be reproducible before more frontend/session features are added.

### Why this now

- The POC proved the renderer works; now the dependency must be repeatable.
- Windows Terminal is large and sensitive to toolchain/path differences.
- WSL Git over `/mnt/c` plus Windows Defender can stall or lock the dependency checkout.
- The pinned version, patches, bootstrap, build, and publish flow must be explicit before adding more app features.

### Proposed behavior

The dependency flow should:

- keep the Windows Terminal version pinned in `deps/windows-terminal.json`;
- require Git for Windows for the Windows checkout;
- verify required Visual Studio/UWP Build Tools components;
- clone/check out the pinned Windows Terminal tag/commit;
- apply repository-owned patch files;
- clone/bootstrap vcpkg if needed;
- build `Host.Proxy.vcxproj` before `TerminalControl.vcxproj`;
- verify `Microsoft.Terminal.Control.dll` exists;
- document Defender/path/toolchain troubleshooting.

### Suggested commands

From WSL repo root:

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\bootstrap-windows-terminal.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\build-windows-terminal-control.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\publish-windows-frontend.ps1
```

### Acceptance criteria

- [x] Bootstrap script exists.
- [x] Windows Terminal version is pinned in `deps/windows-terminal.json`.
- [x] Compatibility patch is stored in `patches/windows-terminal/...`.
- [x] Bootstrap fails fast when Git for Windows is missing.
- [x] Bootstrap validates Visual Studio/UWP Build Tools requirements.
- [x] Build script runs bootstrap by default.
- [x] Build script can skip bootstrap with `-SkipBootstrap`.
- [x] Documentation explains required dependencies and Defender considerations.
- [x] Bootstrap succeeds after Git for Windows is installed.
- [x] Native control build succeeds through the full new bootstrap/build flow.
- [x] Native control build succeeds with `scripts/build-windows-terminal-control.ps1 -SkipBootstrap` against the already-prepared checkout.
- [x] Published frontend still includes native Windows Terminal files.
- [x] `dotnet build` still passes.
- [x] `cargo check` still passes.
- [x] `cargo clippy --all-targets -- -D warnings` still passes.
