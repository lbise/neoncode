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

## Version 1 schema

The first launch creates:

```json
{
  "schemaVersion": 1,
  "hub": {
    "endpoint": "ws://127.0.0.1:44777/ws"
  },
  "sessionPrefix": "electron-xterm-shell",
  "persistence": {
    "onWindowClose": "detach"
  },
  "launchProfiles": {
    "default-shell": {
      "type": "process",
      "command": "bash",
      "args": [],
      "cwd": null
    }
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
```

Version 1 intentionally supports one or two sessions because the current Electron layout has two static pane surfaces.

A hub session ID is:

```text
<sessionPrefix>-<sessions[].id>
```

Changing/removing a configured ID does not kill an already detached hub session with the old ID. Restart the in-memory hub if you intentionally want to clear all such sessions.

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
- `kill`: normal window close asks the hub to kill each configured session before Electron exits.

Unexpected renderer/process termination cannot perform the graceful detach/kill handshake.

## Validation and recovery

Current validation includes:

- schema and exact known keys;
- loopback endpoint `ws://127.0.0.1:<port>/ws` only;
- hub-compatible IDs and combined session-ID length;
- unique session IDs and valid launch-profile references;
- one or two sessions;
- bounded commands, arguments, working directories, titles, and file sizes;
- `detach` or `kill` close policy.

On every valid load, NeonCode updates `config.json.bak`. If `config.json` later becomes malformed, NeonCode:

1. preserves it as `config.json.invalid-<timestamp>`;
2. restores the last valid backup;
3. shows a warning in the app header.

An unsupported future schema is preserved and is not downgraded automatically. If neither the primary nor backup is usable, NeonCode opens with a visible configuration error and launches no terminal sessions.

App-owned `state.json` currently stores only content width and height. Invalid state is preserved and reset safely. Window position is deliberately not persisted yet to avoid reopening off-screen.

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
4. Change pane titles and give one profile a project `cwd`.
5. Reopen with `./dev electron`.
6. Confirm configured titles/cwd, run a command, resize the window, and close it.
7. Reopen again and confirm window size, session reattachment, and output replay.
8. Optionally switch `onWindowClose` to `kill`; after closing/reopening, the panes should start new sessions rather than attach.

Font/theme configuration, dynamic pane counts/layouts, workspace files, and a settings UI are later milestones.
