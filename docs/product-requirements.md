# NeonCode product requirements

## Product summary

NeonCode is a workspace/session cockpit for developers who live in terminals, remote machines, tmux, SSH, test loops, logs, editors, and coding agents.

The product should make it easy to launch, organize, reconnect to, and monitor development sessions across local WSL/Linux and later remote machines.

## Current product bet

Default Windows app stack:

```text
Electron shell
  -> xterm.js renderer
  -> neoncode-hub WebSocket
  -> Rust portable-pty sessions in WSL/Linux
```

The hub owns sessions and process lifecycle. The frontend owns visible layout and presentation.

## Target users

Initial target user:

- works primarily from Windows but uses WSL/Linux heavily;
- keeps many terminal sessions, tmux sessions, logs, and editors open;
- connects to home/work/remote machines through SSH;
- may run coding agents, tests, build loops, or monitoring commands in parallel;
- wants workspace-level continuity rather than disposable terminal windows.

## Core product goals

1. **Session continuity**
   - Terminal sessions should survive frontend reloads/restarts when explicitly detached or persisted.
   - Reconnect should be a first-class behavior, not an accident.

2. **Workspace cockpit**
   - Show active workspaces, sessions, machines, status, and attention items in one place.
   - Let the user jump to the session/surface that needs attention.

3. **Terminal-first workflow**
   - Shell, tmux, Neovim, logs, and tests should feel trustworthy.
   - xterm.js is the default renderer because it integrates cleanly with Electron and avoids child-HWND focus risk.

4. **Backend-owned runtime**
   - `neoncode-hub` owns PTYs, sessions, launch profiles, attach/detach/reconnect, and eventually machine/remote state.
   - The UI should not be the authoritative source of session lifecycle.

5. **Extensible surfaces**
   - Start with terminals.
   - Later add browser surfaces, SSH remotes, X2Go/external app hooks, notifications, and agent-aware workflows.

## Product principles

- UI layout is not session identity.
- Stable IDs beat UI indexes.
- Snapshot + ordered events beat ad hoc frontend state.
- tmux is useful for remote persistence but should not be the visible layout owner.
- SSH is one access method, not the whole remote model.
- Project-local automation needs trust prompts.
- Secrets should not live in plaintext workspace files.
- Agents should initially run in terminals; deeper agent/provider integration can come later.

## Core concepts

Suggested vocabulary:

```text
Workspace       User-facing collection of sessions/surfaces for a project/task
Machine         Saved host/device/server identity
Endpoint        Way to reach a machine/runtime: local WSL, SSH alias, tunnel, hub URL
Hub/Runtime     Running neoncode-hub or future remote daemon
Session         PTY/process/tmux/command unit owned by hub/runtime
Attachment      Frontend connection to a session
Surface         UI presentation: terminal pane, browser pane, external app, X2Go, etc.
Pane/Tab        Pure frontend layout containers
Notification    Attention item associated with workspace/session/machine
```

## Near-term requirements

### R1 — Terminal app baseline

- Electron app with xterm.js terminal panes.
- Connect to `neoncode-hub` over WebSocket.
- Start WSL/Linux shell sessions.
- Support input/output/resize.
- Support paste and common terminal shortcuts.
- Validate tmux/Neovim basics.

### R2 — Session lifecycle

- Hub session registry is authoritative.
- Support `list_sessions`, `attach`, `detach`, `kill`.
- Frontend can restart and reattach to known sessions.
- Exit/error states are visible to the user.

### R3 — Launch profiles

Initial launch profiles:

- local WSL shell;
- project-directory shell;
- custom command;
- SSH shell;
- tmux attach/create.

### R4 — Workspace model

Minimal workspace config should support:

```yaml
name: audio-fw
root: /home/me/src/audio-fw
sessions:
  - id: shell
    command: bash
  - id: tests
    command: ./andromeda test --hil
```

Later add browser/external surfaces.

### R5 — Status and attention

Show useful metadata:

- workspace name;
- host/machine;
- cwd;
- git branch/dirty state;
- session count/status;
- latest exit/error/attention item.

### R6 — CLI/API surface

A small CLI/API should eventually support:

```bash
neoncode session list
neoncode session input <id> <text>
neoncode workspace list
neoncode workspace open <name>
neoncode notify --workspace audio-fw --title "HIL failed"
```

This helps automation, tests, dogfooding, and future agent integrations.

## Later requirements

### Remote workspaces

Inspired by cmux/wmux/t3code:

1. plain SSH launch profile;
2. hidden tmux persistence;
3. reconnect/status around SSH/tmux;
4. optional future `neoncode-remote` daemon for persistent remote PTYs;
5. optional browser proxying through remote workspaces.

### Notifications

Distinguish:

- raw terminal activity;
- process exit;
- explicit agent/tool notification;
- user-defined notification hooks;
- errors/reconnect failures.

### Supervised sessions

Support declared panes/processes that restart with policy/backoff:

- test runners;
- log tails;
- local services;
- agents.

### Browser and external surfaces

Start simple:

- launch external browser/profile;
- track surface in workspace status.

Later:

- embedded browser pane;
- CDP automation;
- remote browser proxying.

### Agent workflows

Start terminal-centric:

- run agents in regular sessions;
- detect completion/attention states;
- surface notifications.

Deeper provider abstractions and supervised/full-access modes can come later.

## Security and trust requirements

- Bind local hub to loopback by default.
- Do not leak auth/control tokens into child process environment.
- Project-local commands require trust/approval.
- Show command/env/cwd before trusting workspace automation.
- Keep obvious secrets (`*_TOKEN`, `*_SECRET`, `*_KEY`) out of plaintext workspace files until a real secret store exists.
- SSH agent forwarding should be explicit/opt-in.

## Non-goals for the current prototype

- Chat-first coding agent GUI.
- Full remote daemon/proxy system.
- Source-control provider integrations beyond lightweight local git metadata.
- Cloud pairing/hosted services.
- Perfect native Windows Terminal renderer parity.
- Reimplementing all of tmux visually.
- Deep browser automation before terminal/workspace basics are solid.

## Inspiration summary

From `wmux`:

- daemon-owned sessions;
- stable identities;
- snapshot/event resync;
- workspace profiles;
- supervised panes;
- fleet/overview concepts;
- security gates.

From `cmux`:

- workspace cockpit/sidebar;
- notification rings/unread workflow;
- CLI/socket API;
- SSH workspace model;
- remote daemon as later architecture;
- tmux-style resize semantics for shared sessions;
- project config and trust prompts.

From `t3code`:

- server owns runtime;
- typed contracts;
- ordered push bus;
- queue-backed long-running workers;
- execution environment / endpoint model;
- connection supervisor state;
- contextual keybindings.

See [external-tool-inspiration.md](external-tool-inspiration.md) for the full analysis.
