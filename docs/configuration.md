# NeonCode desktop configuration

NeonCode stores user-level Electron configuration and app-owned window state under:

```text
%APPDATA%\NeonCode\config.json
%APPDATA%\NeonCode\config.json.bak
%APPDATA%\NeonCode\state.json
%APPDATA%\NeonCode\state.json.bak
```

Electron main owns all filesystem access. The sandboxed renderer receives only a validated bootstrap object through the preload bridge. The hub capability token is never written to these files.

Configuration is read at startup and watched for external `config.json` edits. Valid external edits are reloaded through the same validation, backup, migration, and recovery path, then pushed to the renderer with visible diagnostics; simple settings such as workspace names, keybindings, close-confirmation toggles, and app theme colors apply without restarting active terminals. Topology changes reconcile layouts and remount only the affected active workspace. The keyboard-accessible Settings surface edits the supported General and Keyboard fields through validated main-process IPC. The workspace dialog creates, renames, and deletes durable workspace definitions without a restart. xterm terminal appearance remains restart-required in this slice. Endpoint, session prefix, and app-window close policy remain JSON-only advanced settings rather than primary UI controls.

## Version 8 schema

The first launch creates:

```json
{
  "schemaVersion": 8,
  "hub": {
    "endpoint": "ws://127.0.0.1:44777/ws"
  },
  "sessionPrefix": "electron-xterm-shell",
  "persistence": {
    "onWindowClose": "detach",
    "confirmBeforeClosingTab": false,
    "confirmBeforeClosingTerminal": false
  },
  "terminal": {
    "fontFamily": "Cascadia Mono, FiraCode Nerd Font Mono, Consolas, monospace",
    "fontSize": 14,
    "cursorBlink": true,
    "theme": {
      "name": "NeonCode Default",
      "background": "#0c0c0c",
      "foreground": "#cccccc",
      "cursorColor": "#ffffff",
      "selectionBackground": "#264f78",
      "black": "#0c0c0c",
      "red": "#c50f1f",
      "green": "#13a10e",
      "yellow": "#c19c00",
      "blue": "#0037da",
      "purple": "#881798",
      "cyan": "#3a96dd",
      "white": "#cccccc",
      "brightBlack": "#767676",
      "brightRed": "#e74856",
      "brightGreen": "#16c60c",
      "brightYellow": "#f9f1a5",
      "brightBlue": "#3b78ff",
      "brightPurple": "#b4009e",
      "brightCyan": "#61d6d6",
      "brightWhite": "#f2f2f2"
    }
  },
  "appTheme": {
    "sidebarBackground": "#0f172a",
    "appBackground": "#0b1020",
    "terminalBackground": "#0c0c0c",
    "textColor": "#d1d5db",
    "accent": "#ff4fd8",
    "secondaryAccent": "#8a2c72",
    "tertiaryAccent": "#3a173f"
  },
  "keybindings": {
    "overrides": []
  },
  "launchProfiles": {
    "default-shell": {
      "type": "process",
      "command": "bash",
      "args": [],
      "cwd": null
    }
  },
  "workspaces": [
    {
      "id": "default",
      "name": "Default",
      "path": null,
      "defaultLaunchProfile": "default-shell",
      "layout": {
        "columns": 2
      },
      "sessions": [
        {
          "id": "shell",
          "title": "Shell",
          "launchProfile": "default-shell"
        },
        {
          "id": "tasks",
          "title": "Tasks",
          "launchProfile": "default-shell"
        }
      ]
    }
  ]
}
```

Version 8 supports 1–16 named workspaces and at most 64 configured sessions in total. Each workspace has 1–8 sessions and a simple grid layout whose `columns` value is between 1 and that workspace's session count. It also stores simple app theme colors for sidebar background, app background, terminal surface background, text, primary bright-pink accent, and two secondary accents. The sidebar switches workspaces immediately: the old workspace detaches, the selected workspace starts or reattaches, and the active workspace is restored after relaunch.

Session IDs are currently unique across the complete configuration. A hub session ID is:

```text
<sessionPrefix>-<workspaces[].sessions[].id>
```

Changing/removing a configured ID does not kill an already detached hub session with the old ID. Restart the in-memory hub if you intentionally want to clear all such sessions.

## Settings and keybindings

Open Settings with the title-bar cog or run **Open Settings** from the command palette; no Settings shortcut is required. Settings appears as an app-owned workspace tab in the active workspace rather than a full-window modal. The General section edits optional tab/terminal close confirmations, terminal font family/size, cursor blink, xterm terminal background/foreground colors, and simple app theme colors. Close-confirmation toggles, app theme colors, and keybindings apply immediately after Save; xterm terminal appearance takes effect after restart. Endpoint, session prefix, and app-window close policy are advanced JSON settings preserved by Settings saves but not exposed in the primary UI. Environment overrides remain process-local and are never copied into `config.json` by a Settings save.

`keybindings.overrides` contains at most 64 entries. Default user-facing workspace and pane shortcuts target stable numeric slots (`workspace.openIndex`, `pane.focusIndex`) so bindings survive workspace/session renames. Per-ID commands remain available for explicit advanced targets. Each entry identifies one exact typed command invocation and either supplies one physical `KeyboardEvent.code` combination with exact `altKey`, `ctrlKey`, `metaKey`, and `shiftKey` booleans, or uses `null` to unbind it:

```json
{
  "command": { "id": "workspace.open", "args": { "workspaceId": "review" } },
  "binding": {
    "code": "KeyR",
    "altKey": true,
    "ctrlKey": false,
    "metaKey": false,
    "shiftKey": true
  }
}
```

```json
{
  "command": { "id": "pane.next" },
  "binding": null
}
```

An override replaces or unbinds the default for that exact command invocation. Defaults are `Ctrl+Shift+P` for Commands, `Alt+1` through `Alt+0` for workspace slots 1–10, `Alt+Shift+1` through `Alt+Shift+8` for active-tab pane slots 1–8, `Ctrl+Shift+T` for a new default-profile tab, `Ctrl+PageDown`/`Ctrl+PageUp` for tab traversal, `Alt+Shift+=` for a side-by-side (`horizontal`) split, `Alt+Shift+-` for a stacked (`vertical`) split, `Alt+Shift+Arrow` for directional border resize, and `F6`/`Shift+F6` for depth-first traversal within the active tab. Pane close, kill, and restart have no default binding. The Keyboard section shows current and default values and provides Record, Unbind, and Reset controls. Save validates the complete effective map and applies it live; Cancel or Escape discards the draft.

Bindings reject unknown fields/codes/commands, malformed concrete workspace/pane arguments, duplicate command overrides, duplicate active combinations, modifier-only and unsafe bare printable global keys, Ctrl+Alt/AltGraph semantics, and protected terminal conventions including Ctrl+C/D/Z/Space/L/R/A/E/K/U/W, Ctrl+Shift+C/V, and Shift+Insert. A syntactically valid override whose workspace or pane was removed no longer invalidates the whole configuration: it is ignored by the effective router. Workspace deletion transactionally removes overrides that target the deleted workspace or its configured panes.

## Workspaces and layout

A second workspace can reuse global launch profiles but must use distinct session IDs:

```json
{
  "id": "review",
  "name": "Review",
  "path": "/home/me/src/project",
  "defaultLaunchProfile": "project-shell",
  "layout": { "columns": 2 },
  "sessions": [
    { "id": "review-shell", "title": "Shell", "launchProfile": "project-shell" },
    { "id": "review-tests", "title": "Tests", "launchProfile": "project-command" },
    { "id": "review-remote", "title": "Remote", "launchProfile": "remote-shell" }
  ]
}
```

With no saved layout, three sessions and two columns deterministically seed one visible tab containing the equivalent two-column/two-row split tree. On later launches, surviving tab/tree state is retained, removed configured sessions are pruned, and newly configured sessions are added as one-pane tabs. `path` is either a non-empty, control-free WSL/Linux path of at most 4096 UTF-8 bytes or `null`; when set, it overrides every selected launch profile's `cwd` for that workspace. The path is sent as a structured process-start field and is never shell-interpolated. `defaultLaunchProfile` must reference a configured profile and is used by the app-created initial Shell session.

Use the visible **+ Workspace** button or **Create Workspace…** in Commands to create a workspace. The same palette provides rename and delete dialogs. Delete requires an explicit Detach or Kill choice, cannot remove the last workspace, and switches an active deleted workspace to its deterministic neighbor. Detach never kills its hub sessions.

The visible **+ Tab** action and `Ctrl+Shift+T` immediately create a durable session definition using the workspace default launch profile, then persist a one-pane active tab. Commands also provides next/previous, rename, and close actions. Closing a tab kills its terminal sessions, removes the tab's durable session definitions, and cannot remove the last tab. If `persistence.confirmBeforeClosingTab` is true, the visible close affordance first opens a keyboard-trapped confirmation dialog.

The active pane can be split side by side or stacked from its compact header controls, Commands, or the default split shortcuts. A split transaction creates stable session/split IDs, derives the new pane ID from the session ID, saves the durable definition, persists the tree, and focuses the new pane. A workspace `path` overrides the selected profile cwd for newly created tabs and panes. Directional resize moves the nearest border on that side in 0.05 steps, clamps ratios to `0.1`–`0.9`, persists state, and refits existing terminals without restarting PTYs. Accessible separators expose their split ID, orientation, and current ratio.

A pane cannot be closed when it is the sole pane in its tab; use tab close instead. Pane close kills the terminal session, then removes the durable definition, target overrides, and leaf while collapsing its parent split and focusing the deterministic sibling. If `persistence.confirmBeforeClosingTerminal` is true, the visible close affordance first opens a keyboard-trapped confirmation dialog. If catalog persistence fails after lifecycle acknowledgement, NeonCode keeps the definition/tree, restores the pane where possible, and shows a warning. Detach, Kill, and Restart lifecycle actions in Commands or the pane **More** menu leave the definition/tree in place; Restart attaches a still-running hub session or starts a replacement. Explicit pane operations currently target only panes rendered in the active tab and report a bounded disabled reason for inactive targets.

Switching a workspace or tab serially detaches the old visible panes so their PTYs continue running. Inactive tabs have no xterm attachment; opening one attaches or starts its leaves and requests replay. Window close still follows `persistence.onWindowClose`; `kill` also cleans up previously visited inactive workspaces.

## Launch profiles

A `process` profile sends an executable, argument vector, and optional working directory directly to the WSL/Linux PTY. NeonCode does not implicitly invoke a shell or interpolate command text.

Project shell:

```json
"project-shell": {
  "type": "process",
  "command": "bash",
  "args": [],
  "cwd": "/home/me/src/project"
}
```

Explicit shell command:

```json
"project-command": {
  "type": "process",
  "command": "bash",
  "args": ["-lc", "npm test; exec bash"],
  "cwd": "/home/me/src/project"
}
```

SSH:

```json
"remote-shell": {
  "type": "process",
  "command": "ssh",
  "args": ["dev@example.com"],
  "cwd": null
}
```

tmux attach/create:

```json
"durable-shell": {
  "type": "process",
  "command": "tmux",
  "args": ["new-session", "-A", "-s", "neoncode"],
  "cwd": "/home/me/src/project"
}
```

Reference a profile from a pane:

```json
{
  "id": "shell",
  "title": "Project shell",
  "launchProfile": "project-shell"
}
```

User-level launch profiles are trusted configuration. Project-local configuration and workspace trust prompts are not implemented yet.

## Close policy

```json
"persistence": {
  "onWindowClose": "detach",
  "confirmBeforeClosingTab": false,
  "confirmBeforeClosingTerminal": false
}
```

- `detach`: normal window close detaches each pane; hub-owned sessions survive and reattach on the next launch.
- `kill`: normal window close asks the hub to kill sessions from every workspace visited by this app instance before Electron exits. Unvisited and unrelated hub sessions are not touched.

Unexpected renderer/process termination cannot perform the graceful detach/kill handshake.

## Validation and recovery

Current validation includes:

- schema and exact known keys;
- loopback endpoint `ws://127.0.0.1:<port>/ws` only;
- hub-compatible IDs and combined session-ID length;
- unique workspace IDs, globally unique session IDs, valid per-session/default launch-profile references, and exact workspace keys;
- control-free workspace paths of at most 4096 UTF-8 bytes;
- 1–16 workspaces, 1–8 sessions per workspace, at most 64 sessions total, and valid grid column counts;
- bounded commands, arguments, working directories, titles, and file sizes;
- `detach` or `kill` app-window close policy plus boolean tab/terminal close-confirmation toggles;
- seven bounded app theme colors, applied through named CSS custom properties;
- at most 64 strict keybinding overrides, validated command invocations, physical key codes, safe modifiers, terminal-reserved combinations, and conflict-free effective bindings.

On every valid load, NeonCode updates `config.json.bak`. If `config.json` later becomes malformed, NeonCode:

1. preserves it as `config.json.invalid-<timestamp>`;
2. restores the last valid backup;
3. shows a warning in the app header.

The same recovery behavior runs while the app is open. An invalid external edit is preserved/restored when possible and reported in the header; if recovery is impossible, already-running terminals are left alone while the renderer reports the configuration error and blocks new configuration-dependent operations.

An unsupported future schema is preserved and is not downgraded automatically. If neither the primary nor backup is usable, NeonCode opens with a visible configuration error and launches no terminal sessions.

Known pre-schema NeonCode files containing only a `terminal` object are preserved as `config.json.pre-migration-<timestamp>` and their compatible font, cursor, and color-table settings are imported into the current schema. Schema versions 0 through 7 are migrated automatically; schema 4 gains an empty keybinding override list. Schema 5 preserves workspace/session IDs, names, layouts, and profile references, derives `defaultLaunchProfile` from each workspace's first session, and derives `path` only when all referenced profiles have the same non-null `cwd`; otherwise `path` is `null`. Schema 6 adds close-confirmation booleans defaulting to false; schema 7 adds default app theme colors. Version 2 positional `ansi` arrays are converted losslessly to named colors; version 3 top-level sessions become the `default` workspace without changing their IDs. When a preserved terminal-only file is available, schema 1 imports its appearance while retaining current pane/profile edits; otherwise it receives the default appearance.

App-owned state schema 3 stores content width/height, the active workspace ID, and a `workspaceLayouts` record. Each record value is a strict frontend-owned tab/split tree: tabs have a stable ID/title/focused pane, split branches have a stable ID/direction/ratio/two children, and pane leaves have a stable pane ID plus session key. Layout state is separate from configuration and does not redefine hub session identity.

State validation permits at most 16 known-shape workspace entries, 8 tabs and 8 pane leaves per workspace, 64 leaves across the file, tree depth 8, unique IDs and session keys within a workspace, split ratios from `0.1` through `0.9`, and tab titles no larger than 64 UTF-8 bytes. The complete pretty-printed state file is limited to 64 KiB. Schema 1 migrates directly to schema 3 with a null active workspace and empty layouts; schema 2 preserves its window and active-workspace fields while adding empty layouts. Invalid, oversized, and unsupported future state is preserved and recovered from backup or reset safely. Window position is deliberately not persisted yet to avoid reopening off-screen.

At startup the renderer validates and restores each configured workspace layout or deterministically seeds one from the configured grid. Seeded/reconciled layouts are saved asynchronously. Tab order/title/activation, focused-pane, split/close, and ratio changes are persisted through serialized layout saves; a save failure is reported and the next launch reconciles from the durable session catalog.

The preload bridge exposes typed `saveWorkspaceLayout(workspaceId, layout)`, `getSettings()`, revision-checked `saveSettings({revision, settings})`, and narrow `getWorkspaceCatalog()`/`saveWorkspaceCatalog({revision, workspaces})` calls. Settings and workspace catalog writes share one monotonic revision. Electron main accepts Settings IPC only from the current BrowserWindow, validates every field, rejects stale revisions, and merges only allowed Settings fields into a freshly read disk config. Settings writes preserve launch profiles and workspaces. Catalog writes replace only validated workspace definitions while preserving settings and launch profiles, including when process-local environment overrides are active. There is no arbitrary file or command bridge. The renderer recursively renders the active persisted tab tree and exposes registry-backed keyboard/header split, resize, close, and lifecycle controls. Externally eligible explicit commands are contract groundwork only; there is no CLI app-control transport yet.

Settings and workspace-catalog writes first atomically preserve the previous valid config as `config.json.bak`, then atomically replace `config.json`. Other writes use the same same-directory temporary-file, flush, and atomic-rename discipline. Electron also uses a single-instance lock to avoid competing state writers.

## Environment overrides

Developer/test environment variables override validated disk configuration for that process only and are not written back:

```text
NEONCODE_HUB_ENDPOINT
NEONCODE_SESSION_PREFIX
NEONCODE_TERMINAL_COUNT
NEONCODE_PERSIST_SESSIONS
```

`NEONCODE_HUB_TOKEN` remains environment-only for developer overrides. In the Windows desktop runtime, Electron can create/read the managed WSL token file at `${XDG_STATE_HOME:-$HOME/.local/state}/neoncode/hub-token` when the environment variable is absent; the token is still never stored in `%APPDATA%\\NeonCode` and is never placed on a command line. The Rust hub also falls back to that managed file when `NEONCODE_HUB_TOKEN` is absent. `NEONCODE_TEST_CONFIG_DIR` is accepted only with `NEONCODE_TEST_MODE=1`.

## Manual preview

For development, `./dev hub` and `./dev app` still exercise the explicit two-process loop. Packaged alpha builds manage the default loopback WSL hub automatically: if `ws://127.0.0.1:<port>/ws` is unhealthy, Electron copies the bundled WSL hub into `~/.local/share/neoncode/hub/`, ensures the managed token file exists, starts the hub with `wsl.exe`, and surfaces diagnostics in the app header/status. Non-loopback or unsupported endpoints are never started automatically.

1. Run `./dev hub` and `./dev app` once.
2. Open Settings from the header and edit General values; verify each restart-required label before saving.
3. Use **+ Workspace** entirely from the keyboard to create a workspace with a path/profile, then verify its Shell starts in that path.
4. Rename it from Commands, close/reopen NeonCode, and confirm the name and active workspace survive.
5. Delete it once with Detach and once with Kill; verify the last-workspace guard.
6. Open Keyboard, record a safe shortcut for a concrete command, save, and verify it executes immediately.
7. Create a tab with `Ctrl+Shift+T`, rename it from Commands, switch tabs with `Ctrl+PageUp/PageDown`, and verify it and its focused pane restore after relaunch.
8. Split with both default shortcuts, verify the new pane starts in the workspace path, resize each available border with `Alt+Shift+Arrow`, and confirm the ratio survives relaunch.
9. Exercise pane Detach then Restart continuity, Kill then Restart replacement, and close once with each disposition; verify the sole-pane guard and sibling focus.
10. Close the created tab once with Detach and once with Kill; verify the last-tab guard.
11. Reopen Settings and exercise Unbind, Reset, conflict feedback, recorder Escape, and dialog Escape focus restoration.

External workspace files, live application of xterm terminal appearance, font discovery, and CLI app-control transport are later milestones.
