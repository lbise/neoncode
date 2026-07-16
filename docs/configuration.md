# NeonCode desktop configuration

NeonCode stores user-level Electron configuration and app-owned window state under:

```text
%APPDATA%\NeonCode\config.json
%APPDATA%\NeonCode\config.json.bak
%APPDATA%\NeonCode\state.json
%APPDATA%\NeonCode\state.json.bak
```

Electron main owns all filesystem access. The sandboxed renderer receives only a validated bootstrap object through the preload bridge. The hub capability token is never written to these files.

Configuration is read at startup. There is no settings UI or live reload yet; close and reopen NeonCode after editing `config.json`.

## Version 4 schema

The first launch creates:

```json
{
  "schemaVersion": 4,
  "hub": {
    "endpoint": "ws://127.0.0.1:44777/ws"
  },
  "sessionPrefix": "electron-xterm-shell",
  "persistence": {
    "onWindowClose": "detach"
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

Version 4 supports 1–16 named workspaces and at most 64 configured sessions in total. Each workspace has 1–8 sessions and a simple grid layout whose `columns` value is between 1 and that workspace's session count. The sidebar switches workspaces immediately: the old workspace detaches, the selected workspace starts or reattaches, and the active workspace is restored after relaunch.

Session IDs are currently unique across the complete configuration. A hub session ID is:

```text
<sessionPrefix>-<workspaces[].sessions[].id>
```

Changing/removing a configured ID does not kill an already detached hub session with the old ID. Restart the in-memory hub if you intentionally want to clear all such sessions.

## Workspaces and layout

A second workspace can reuse global launch profiles but must use distinct session IDs:

```json
{
  "id": "review",
  "name": "Review",
  "layout": { "columns": 2 },
  "sessions": [
    { "id": "review-shell", "title": "Shell", "launchProfile": "project-shell" },
    { "id": "review-tests", "title": "Tests", "launchProfile": "project-command" },
    { "id": "review-remote", "title": "Remote", "launchProfile": "remote-shell" }
  ]
}
```

With three sessions and two columns, NeonCode renders a two-column/two-row grid. Switching always detaches the old workspace so its PTYs continue running. Window close still follows `persistence.onWindowClose`; `kill` also cleans up previously visited inactive workspaces.

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
  "onWindowClose": "detach"
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
- unique workspace IDs, globally unique session IDs, and valid launch-profile references;
- 1–16 workspaces, 1–8 sessions per workspace, at most 64 sessions total, and valid grid column counts;
- bounded commands, arguments, working directories, titles, and file sizes;
- `detach` or `kill` close policy.

On every valid load, NeonCode updates `config.json.bak`. If `config.json` later becomes malformed, NeonCode:

1. preserves it as `config.json.invalid-<timestamp>`;
2. restores the last valid backup;
3. shows a warning in the app header.

An unsupported future schema is preserved and is not downgraded automatically. If neither the primary nor backup is usable, NeonCode opens with a visible configuration error and launches no terminal sessions.

Known pre-schema NeonCode files containing only a `terminal` object are preserved as `config.json.pre-migration-<timestamp>` and their compatible font, cursor, and color-table settings are imported into version 4. Schema versions 0, 1, 2, and 3 are migrated automatically. Version 2 positional `ansi` arrays are converted losslessly to named colors; version 3 top-level sessions become the `default` workspace without changing their IDs. When a preserved terminal-only file is available, schema 1 imports its appearance while retaining current pane/profile edits; otherwise it receives the default appearance.

App-owned state schema 3 stores content width/height, the active workspace ID, and a `workspaceLayouts` record. Each record value is a strict frontend-owned tab/split tree: tabs have a stable ID/title/focused pane, split branches have a stable ID/direction/ratio/two children, and pane leaves have a stable pane ID plus session key. Layout state is separate from configuration and does not redefine hub session identity.

State validation permits at most 16 known-shape workspace entries, 8 tabs and 8 pane leaves per workspace, 64 leaves across the file, tree depth 8, unique IDs and session keys within a workspace, split ratios from `0.1` through `0.9`, and tab titles no larger than 64 UTF-8 bytes. The complete pretty-printed state file is limited to 64 KiB. Schema 1 migrates directly to schema 3 with a null active workspace and empty layouts; schema 2 preserves its window and active-workspace fields while adding empty layouts. Invalid, oversized, and unsupported future state is preserved and recovered from backup or reset safely. Window position is deliberately not persisted yet to avoid reopening off-screen.

The preload bridge exposes a typed `saveWorkspaceLayout(workspaceId, layout)` call. Electron main accepts it only for a workspace in the current validated config and validates the complete merged state before writing. The renderer does not call this API or render the tab/split tree yet; the existing grid remains unchanged.

Writes use same-directory temporary files, flush, and atomic rename. Electron also uses a single-instance lock to avoid competing state writers.

## Environment overrides

Developer/test environment variables override validated disk configuration for that process only and are not written back:

```text
NEONCODE_HUB_ENDPOINT
NEONCODE_SESSION_PREFIX
NEONCODE_TERMINAL_COUNT
NEONCODE_PERSIST_SESSIONS
```

`NEONCODE_HUB_TOKEN` remains environment-only. `NEONCODE_TEST_CONFIG_DIR` is accepted only with `NEONCODE_TEST_MODE=1`.

## Manual preview

1. Run `./dev hub` and `./dev app` once.
2. Close NeonCode normally.
3. Open `%APPDATA%\NeonCode\config.json`.
4. Add a second workspace, change pane titles, and give one profile a project `cwd`.
5. Reopen with `./dev electron`.
6. Switch between workspaces in the sidebar and confirm configured pane counts/titles/cwd.
7. Set shell state in both workspaces, switch away and back, and confirm reattachment/output replay.
8. Resize and close while the second workspace is active.
9. Reopen and confirm window size and active workspace restoration.
10. Optionally switch `onWindowClose` to `kill`; after closing/reopening, previously visited workspace sessions should start fresh.

External workspace files, visible free-form split layout controls, live appearance reload, font discovery, and a settings UI are later milestones.
