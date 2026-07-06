# Workspace Cockpit task list

This is the working checklist for moving from the validated Windows Terminal embedding POC to a usable prototype and eventually a product.

Validated POC snapshot:

```text
poc/windows-terminal-embedded
```

## Current stage

```text
Stage: Phase 1 — clean prototype foundation
Next task: Add scripts/publish-windows-frontend.ps1
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

- [ ] Add `scripts/publish-windows-frontend.ps1`.
- [ ] Publish script verifies the native Windows Terminal files are present.
- [ ] Publish script emits a clear run command/path after success.
- [ ] Add Windows Terminal dependency bootstrap script or documented reproducible bootstrap flow.
- [ ] Move Windows Terminal compatibility edits into explicit patch files or deterministic script steps.
- [ ] Add script validation for required Visual Studio/UWP Build Tools components.
- [ ] Add a first app config file for local frontend settings.
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
- [ ] Load terminal font from app config.
- [ ] Load terminal font size from app config.
- [ ] Load terminal color theme from app config.
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
- [ ] Keep Windows Terminal dependency pinned.
- [ ] Store local patches in this repo.
- [ ] Validate Visual Studio component requirements in scripts.
- [ ] Avoid UNC paths for Windows-native builds.
- [ ] Decide whether vendoring the upstream WPF wrapper remains acceptable.
- [ ] Evaluate maintaining a smaller first-party `HwndTerminal` wrapper.

## Phase 6 — GUI toolkit reassessment

Goal: make a product GUI decision using real data, not speculation.

- [ ] Reassess WPF after multi-session prototype exists.
- [ ] Evaluate WinUI 3 native Windows shell.
- [ ] Evaluate Qt/QML.
- [ ] Evaluate Avalonia.
- [ ] Evaluate Electron/web UI feasibility in locked-down environment.
- [ ] For each candidate, verify native terminal hosting feasibility.
- [ ] For each candidate, verify keyboard/input fidelity.
- [ ] For each candidate, verify docking/tabs/layout support.
- [ ] For each candidate, verify dependency and packaging risk.
- [ ] Decide final near-product GUI direction.

## Next task detail — `scripts/publish-windows-frontend.ps1`

This should be the first implementation task because it locks in the validated workflow and gives every future test a reliable launch path.

### Why this first

- The POC is already proven; now we need repeatability.
- Manual publish commands are easy to mistype from WSL/PowerShell quoting.
- Native Windows Terminal files must be present beside the app or the real renderer will not load.
- Future tests should start from a known Windows-local publish directory, not from build artifacts under WSL/UNC paths.

### Proposed behavior

The script should:

- accept `Configuration`, `ProjectPath`, and `OutputPath` parameters;
- default to `Debug` configuration;
- default output to `%USERPROFILE%\workspace-cockpit-publish`;
- run `dotnet publish` for the Windows frontend;
- verify `WorkspaceCockpit.Windows.exe` exists;
- verify `Microsoft.Terminal.Control.dll` exists;
- verify `Microsoft.Terminal.Control.pri` exists;
- verify the `Microsoft.Terminal.Control` resource directory exists;
- print a clear success summary;
- print the exact command/path to run the published app;
- fail loudly with actionable errors if prerequisites are missing.

### Suggested command

From WSL repo root:

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\publish-windows-frontend.ps1
```

Optional custom output:

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\\publish-windows-frontend.ps1 \
  -OutputPath 'C:\Users\13lbise\workspace-cockpit-publish'
```

### Acceptance criteria

- [ ] Script works when launched from WSL using `powershell.exe`.
- [ ] Script works when launched from Windows PowerShell.
- [ ] Script publishes to a Windows-local path by default.
- [ ] Script verifies managed app executable exists.
- [ ] Script verifies native Windows Terminal runtime files exist.
- [ ] Script exits non-zero on failure.
- [ ] `dotnet build` still passes.
- [ ] `cargo check` still passes.
- [ ] `cargo clippy --all-targets -- -D warnings` still passes.
- [ ] README or `frontends/windows/README.md` documents the script.
