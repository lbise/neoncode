# wmux Review

Repository reviewed: <https://github.com/openwong2kim/wmux>

Date: 2026-07-03

## Summary

`wmux` is an Electron/React Windows terminal multiplexer designed around AI coding agents. It provides split panes, workspaces, ConPTY-backed terminals, xterm.js rendering, browser automation through Chrome/CDP, MCP tools, agent-to-agent messaging, channels, notifications, and a daemon that keeps PTY sessions alive after the UI exits.

It overlaps with the desired project in the area of **workspace/pane/session orchestration**, but it is not a direct fit for the target architecture.

The biggest mismatch is that `wmux` is intentionally a **Windows-native, no-WSL, Electron/xterm.js, local-ConPTY agent terminal**, whereas the desired tool is a **native GUI cockpit spanning Windows+WSL, Linux, remote SSH machines, X2Go, browsers, and platform-specific terminal renderers**.

## Could wmux cover the target needs?

Probably not directly.

### Good fit areas

`wmux` already has:

- terminal panes and splits;
- workspace model;
- session daemon;
- persistent scrollback;
- process supervision;
- agent detection;
- Fleet View / cockpit-like overview;
- browser/CDP integration;
- MCP/CLI automation surfaces;
- multi-agent coordination primitives.

These are conceptually close to parts of the desired app.

### Mismatches

| Requirement / preference | wmux situation |
|---|---|
| Native GUI | Electron + React + xterm.js, not native Windows UI |
| Avoid npm dependency pain | heavy npm stack; work proxy may block npm |
| Windows should use WSL as backend | wmux explicitly says "No WSL" and uses Windows ConPTY/node-pty locally |
| Cross-platform native Linux later | project is Windows-first; package config has makers for other OSes, but architecture and marketing are Windows/ConPTY-centric |
| Platform terminal renderers | uses xterm.js/WebGL, not Windows Terminal control / libghostty / VTE |
| Remote SSH workspace cockpit | can probably run `ssh` in a pane, but remote SSH lifecycle/reconnect/X2Go orchestration is not the core model |
| Keep agent integration light | wmux is strongly AI-agent/MCP/A2A/browser-automation oriented |
| Use existing remote workflows | wmux is more of a local terminal substrate for agents than a remote-machine cockpit |

## Architectural ideas worth taking

### 1. Daemon-owned sessions

`wmux` has a background daemon that owns PTYs and lets the UI detach/reattach. This matches the desired model:

```text
GUI frontend
  ⇄ local session daemon
      ⇄ PTY / SSH / command
```

For our project, the daemon would usually run:

- inside WSL on Windows;
- locally on Linux/macOS.

The core idea to copy is **UI is disposable, sessions are not**.

### 2. Explicit session/pane protocol

`wmux` documents a substrate protocol with:

- pane metadata;
- workspace metadata;
- event bus;
- stable IDs;
- optimistic concurrency;
- boot IDs;
- resync behavior.

This is a strong idea. Our app should similarly define an internal protocol between GUI and backend rather than tightly coupling UI state to process state.

Useful concepts:

- `workspaceId`;
- `paneId` / `sessionId`;
- event sequence cursor;
- `bootId` to detect daemon restart;
- snapshot + event reconciliation;
- metadata namespaces.

### 3. Pull-based event bus

`wmux` uses a pollable event bus rather than assuming all clients can receive push notifications. This is useful for MCP/CLI/external clients.

For our app, WebSockets may still be fine for the GUI, but a pollable event API is useful for:

- CLI tools;
- scripts;
- agents;
- dashboards;
- recovery after reconnect.

### 4. Workspace profiles

`wmux` workspace profiles set environment variables and startup commands per workspace.

This maps well to our needs:

- work vs home environment;
- different SSH configs;
- different agent config directories;
- project-specific env;
- Andromeda/HIL test env;
- browser profile association.

Important wmux lesson: store paths/config references, not raw secrets.

### 5. Supervised panes

`wmux` supports declared panes in `wmux.json` with restart policies/backoff.

This is worth copying for workspaces:

```yaml
sessions:
  tests:
    command: ./andromeda test --hil
    restart: on-failure
    backoff: 5s
```

For our app this should be generic, not agent-specific.

### 6. Fleet View

`wmux` has a Fleet View showing all agents/workspaces and surfacing blocked panes.

Our equivalent should be broader:

- machines online/offline;
- SSH sessions connected/disconnected;
- tests running/failed;
- agents waiting/finished;
- X2Go/browser windows open;
- reconnect/restart actions.

### 7. Browser automation as optional layer

`wmux` has deep Chrome/CDP integration. For our initial app, we should not embed this deeply, but the idea of treating browsers as workspace surfaces is useful.

Initial version:

- launch external browser profile;
- track it in workspace dashboard.

Future version:

- optional CDP integration;
- screenshots/status;
- app reload buttons;
- maybe agent browser access.

### 8. Security and identity details

`wmux` puts effort into:

- token-authenticated IPC;
- PID-based pane identity;
- avoiding leaking auth tokens into child process env;
- namespaced metadata;
- explicit trust gates for workspace-declared automation.

These are worth carrying over early, especially if agents or scripts can control panes.

## Ideas not to copy directly

### 1. Electron/xterm.js as the main UI/terminal stack

This conflicts with the desired native frontend and platform-renderer direction.

Our preferred direction remains:

```text
Windows: Windows Terminal control / HwndTerminal
Linux:   libghostty or VTE
macOS:   libghostty or native option
```

### 2. Windows-local ConPTY as the core backend

For this project, Windows should likely use WSL as the backend because the real workflow starts from WSL and SSH config/tooling live there.

### 3. Heavy agent-first product model

`wmux` is very agent-centric: MCP, A2A, channels, agent delegation, browser control, approvals.

Our app should start as a general workspace cockpit. Agent awareness can be added later.

### 4. Reboot persistence expectations

`wmux` has useful daemon/session persistence, but Windows cannot preserve live ConPTY processes across reboot. It restores scrollback and restarts/resumes where possible.

For our remote-first workflow, live process survival should come from remote persistence mechanisms:

- hidden tmux initially;
- future remote PTY/session daemon.

## Bottom line

`wmux` is a valuable reference, but not a direct base.

Use it as inspiration for:

- daemon/session architecture;
- protocol design;
- pane metadata;
- event bus/reconciliation;
- session supervision;
- workspace profiles;
- Fleet View;
- security/trust gates.

Do not adopt it wholesale if the goal remains:

- native GUI;
- WSL backend on Windows;
- remote SSH-centric workflow;
- platform-native terminal rendering;
- light initial agent integration;
- Linux/macOS support later.

## Follow-up POCs influenced by wmux

Add these to the POC list:

1. Define a minimal GUI↔hub event protocol with `bootId`, `sessionId`, event cursor, and snapshot resync.
2. Prototype workspace profiles with env + startup command + secret filtering.
3. Prototype supervised sessions with restart policy/backoff.
4. Prototype Fleet View using mock session states before building all integrations.
5. Prototype daemon detach/reattach semantics independently from terminal rendering.
