# External tool inspiration for NeonCode

This document collects concepts worth studying or reusing from related tools while NeonCode is still in the prototype stage.

Reviewed tools:

- `wmux`: <https://github.com/openwong2kim/wmux>
- `cmux`: <https://github.com/manaflow-ai/cmux>
- `t3code`: <https://github.com/pingdotgg/t3code>

Related NeonCode docs:

- [`README.md`](../README.md)
- [`product-requirements.md`](product-requirements.md)
- [`architecture.md`](architecture.md)
- [`development-plan.md`](development-plan.md)
- [`terminal-renderer-decision.md`](terminal-renderer-decision.md)

## NeonCode context

NeonCode is currently moving from a validated terminal-rendering POC toward a real workspace/session cockpit.

Already validated:

```text
Electron shell
  ⇄ xterm.js renderer
  ⇄ neoncode-hub WebSocket protocol
  ⇄ WSL/Linux PTY
  ⇄ bash / tmux / Neovim / agents
```

Current design intent:

- Electron is the product shell.
- xterm.js is the default terminal renderer because it avoids native child-HWND focus/polish risk.
- Native Windows Terminal/WPF paths remain fallback/reference implementations.
- The Rust `neoncode-hub` should own PTYs, session lifecycle, attach/detach/reconnect, and launch profiles.
- The GUI should own visible layout: tabs, panes, workspaces, command palette, overview.
- tmux may be used for remote persistence, but should not be the visible layout owner.
- Agent integration should initially stay terminal-centric and optional.

Therefore, this document focuses on **concepts and product primitives**, not copying another app wholesale.

---

## High-level comparison

| Tool | Strongest reference value for NeonCode | Main mismatch |
|---|---|---|
| `wmux` | Daemon-owned sessions, protocol/event model, workspace profiles, supervised panes, Fleet View, security gates | Windows-local Electron/xterm.js/ConPTY and agent-first product direction |
| `cmux` | Native terminal UX, libghostty usage, SSH remote workspaces, remote daemon/proxy design, notification/sidebar model, CLI/socket API | macOS-only Swift/AppKit/Ghostty product; GPL/commercial license; already much larger than NeonCode's prototype scope |
| `t3code` | Server/client boundary, provider abstraction, typed contracts, ordered pushes, remote environment model, connection runtime, supervised/full-access modes | Chat/agent app more than terminal cockpit; Node/Effect complexity; less focused on native terminal rendering |

---

## wmux

### What it is

`wmux` is a Windows terminal multiplexer for AI agents. It uses Electron/React, xterm.js/WebGL, ConPTY, node-pty, a background daemon, browser automation, MCP tools, agent-to-agent messaging, and channels.

### Good ideas for NeonCode

#### 1. Daemon-owned sessions

The UI can quit/reopen while sessions live in a daemon. This directly matches NeonCode's hub direction.

NeonCode adaptation:

```text
Electron/WPF frontend
  ⇄ neoncode-hub
      ⇄ PTY / SSH / tmux / command
```

The hub should become authoritative for session lifecycle, not the frontend.

#### 2. Protocol with stable identities and resync

`wmux` has useful protocol concepts:

- `workspaceId`;
- `paneId` / `ptyId`;
- metadata;
- event bus;
- sequence cursors;
- `bootId` for daemon restart detection;
- snapshot + event resync;
- optimistic concurrency for metadata.

NeonCode should adopt a simpler version soon, before workspace features grow around ad hoc frontend state.

#### 3. Workspace profiles

Per-workspace environment variables and startup commands are valuable.

NeonCode adaptation:

```yaml
workspaces:
  audio-fw:
    env:
      ANDROMEDA_TARGET: hil03
      CLAUDE_CONFIG_DIR: /home/me/.config/claude-work
    startup:
      - name: shell
        command: bash
      - name: tests
        command: ./andromeda test --hil
```

Important lesson: store paths and config references, not raw secrets.

#### 4. Supervised panes

`wmux` can keep declared panes alive with restart policy/backoff. NeonCode should eventually support this generically for tests, log tails, agents, and services.

#### 5. Fleet View

`wmux` has a cockpit view for all agents/workspaces. NeonCode should broaden this into a general workspace/machine/session overview:

- hosts online/offline;
- SSH connected/reconnecting;
- sessions running/exited;
- agents waiting/done;
- tests running/failed;
- browser/X2Go surfaces open;
- one-click reconnect/restart.

#### 6. Security and identity

Useful details:

- token-authenticated IPC;
- no auth token leakage into child env;
- PID/session identity mapping;
- namespaced metadata;
- trust gates for config-declared automation.

### What not to copy

- Do not copy the Windows-local ConPTY-first backend model. NeonCode's current terminal backend is the Rust hub in WSL/Linux, even though the renderer is now xterm.js.
- Do not make NeonCode agent-first too early.
- Do not assume Windows reboot can preserve live terminal processes; use remote/tmux persistence where needed.

---

## cmux

### What it is

`cmux` is a native macOS app built with Swift/AppKit and libghostty. It provides terminal workspaces, vertical tabs, split panes, browser panes, notifications for coding agents, SSH remote workspaces, a CLI/socket API, and a remote daemon for durable SSH PTY sessions.

It is probably the closest conceptual match to NeonCode's desired terminal/browser/workspace cockpit, but it is macOS-specific and much more mature.

License note: `cmux` is dual-licensed GPL-3.0-or-later/commercial. Treat it as a conceptual reference unless license compatibility is intentionally reviewed.

### Good ideas for NeonCode

#### 1. Native terminal renderer as a first-class product choice

`cmux` uses libghostty and reads Ghostty config for fonts/themes/colors. This validates NeonCode's own decision to care about terminal renderer quality rather than treating the terminal as a generic text widget.

NeonCode adaptation:

```text
Windows: xterm.js default; Windows Terminal control / HwndTerminal fallback
Linux:   xterm.js default for Electron path; native renderer candidates can be revisited later
macOS:   xterm.js default for Electron path; native renderer candidates can be revisited later
```

#### 2. Sidebar as operational cockpit

`cmux` sidebar shows useful per-workspace metadata:

- git branch;
- PR status/number;
- working directory;
- listening ports;
- latest notification text;
- remote status;
- agent/activity state.

NeonCode should eventually have this kind of at-a-glance workspace list. The first version can be simpler:

```text
workspace name · host · cwd · branch · session count · status
```

#### 3. Notification rings and unread workflow

`cmux` emphasizes attention management:

- panes get visual rings when they need attention;
- tabs/sidebar rows show unread state;
- notification panel lists pending items;
- shortcuts jump to latest unread.

This is very relevant for multiple agents/tests/logs. NeonCode should separate:

- raw terminal activity;
- process exit;
- explicit agent/tool notification;
- user-defined notification hooks.

#### 4. CLI and socket API as first-class surfaces

`cmux` exposes workspace, pane, browser, notification, SSH, and status commands through a CLI/socket API.

NeonCode should design a CLI early, even if tiny:

```bash
neoncode session list
neoncode session input <id> <text>
neoncode workspace list
neoncode workspace open <name>
neoncode notify --workspace audio-fw --title "HIL failed"
```

This helps scripting, debugging, and future agent integrations.

#### 5. SSH remote workspace model

`cmux ssh user@host` creates a remote-tagged workspace and can reconnect/disconnect it. This maps strongly to NeonCode's work/home SSH workflow.

Most important concepts:

- remote workspace is explicit metadata, not just a shell command;
- reconnect/disconnect are workspace actions;
- remote errors surface in sidebar/logs/notifications;
- SSH agent forwarding is explicit/opt-in;
- persisted remote PTY sessions can be listed, attached, and cleaned up.

#### 6. Remote daemon and proxy architecture

`cmux` has a detailed remote daemon design:

- local app probes remote platform;
- verifies/uploads a release-pinned remote daemon artifact;
- runs daemon over SSH stdio;
- supports persistent slots;
- remote daemon exposes session RPC;
- browser traffic can egress through the remote host via SOCKS/CONNECT over daemon stream RPC;
- remote browser panes are automatically proxied through the remote workspace;
- remote CLI relay lets commands run inside SSH sessions talk back to the local app.

This is highly relevant, but too large for NeonCode's immediate prototype.

NeonCode path:

1. Start with plain SSH launch profile.
2. Add hidden tmux persistence.
3. Add reconnect/status around SSH/tmux.
4. Later evaluate a small `neoncode-remote` daemon.
5. Much later consider remote browser proxying.

#### 7. tmux-style resize semantics for shared sessions

`cmux` uses `smallest screen wins` for multi-attachment PTY resize.

NeonCode should remember this when implementing attach/detach/reconnect:

- one session may have multiple frontend attachments;
- each attachment reports rows/cols;
- effective PTY size should be deterministic;
- when no attachments remain, keep last known size rather than resetting to `80x24`.

#### 8. Custom commands and project config

`cmux.json` supports custom actions, command palette entries, workspace layouts, environment, notification hooks, etc.

NeonCode should eventually have a project/workspace config file, but keep v1 small:

```yaml
name: audio-fw
root: /home/me/src/audio-fw
sessions:
  - id: shell
    command: bash
  - id: tests
    command: ./andromeda test --hil
browser:
  - url: http://localhost:3000
```

Add trust prompts before running project-local commands.

#### 9. Remote file upload ergonomics

`cmux` supports file drops/uploads over SSH using configurable upload commands. This is not a near-term NeonCode feature, but it is a good later UX idea for logic analyzer traces, audio files, logs, etc.

#### 10. Isolated dev builds and socket targeting

`cmux` has strong dogfooding mechanics around tagged debug builds, isolated sockets, and avoiding cross-instance confusion.

NeonCode may benefit from this if multiple prototype builds run side-by-side.

### What not to copy yet

- Do not build the full remote daemon/proxy system before basic SSH/tmux profiles work.
- Do not copy macOS-specific AppKit architecture into Windows/Linux decisions.
- Do not copy GPL code without explicit license review.
- Do not overbuild notification hooks before the session model is stable.

---

## t3code

### What it is

`t3code` is a minimal web GUI for coding agents. It runs a Node.js WebSocket server that wraps provider runtimes such as Codex/Claude/OpenCode and serves a React web app. The desktop app is Electron. It has a strong server/client boundary, typed contracts, provider abstractions, remote-environment architecture, source-control integrations, and runtime modes.

It is less terminal-cockpit-centric than `cmux`, but its architecture docs contain useful abstractions.

License note: MIT.

### Good ideas for NeonCode

#### 1. Server owns runtime; UI consumes typed events

`t3code` keeps provider/session logic on the server side and sends typed state/events to the UI.

NeonCode should do the same:

```text
Frontend owns layout and presentation.
Hub owns sessions, PTYs, launch profiles, reconnect, machine state.
```

Avoid letting the Electron renderer become the source of truth for session lifecycle.

#### 2. Typed contracts at the protocol boundary

`t3code` validates WebSocket pushes and requests at the boundary. Decode failures become structured diagnostics.

NeonCode should make `docs/protocol.md` and `hub/src/protocol.rs` the source of truth and eventually generate or share client-side types if possible.

Important protocol lessons:

- typed request/response;
- typed push channels;
- monotonically ordered pushes;
- structured protocol errors;
- startup readiness before welcoming clients.

#### 3. Ordered push bus

`t3code` sends outbound events through a single ordered push path. This reduces UI race conditions.

NeonCode should avoid each subsystem independently writing to the WebSocket. Instead, the hub should have a central event publisher.

#### 4. Queue-backed workers and runtime receipts

`t3code` uses queue-backed workers for long-running async flows and emits receipts when milestones complete.

NeonCode equivalents:

- SSH bootstrap finished;
- tmux attach succeeded;
- session reattached;
- browser launched;
- profile command completed;
- remote reconnect failed and next retry scheduled.

Receipts make tests and UI state more deterministic than polling logs.

#### 5. ExecutionEnvironment / KnownEnvironment / AccessEndpoint model

`t3code` has a clean remote model:

- `ExecutionEnvironment`: one running server/runtime;
- `KnownEnvironment`: saved client-side entry;
- `AccessEndpoint`: concrete way to reach it;
- `AdvertisedEndpoint`: server/provider-suggested reachable endpoint.

This is useful for NeonCode's machine/workspace model.

Possible NeonCode vocabulary:

```text
Machine           saved host/device/server identity
Endpoint          ssh alias, local WSL, direct hub URL, tunnel, LAN address
Runtime/Hub       running neoncode-hub instance
Workspace         user-facing collection of sessions/surfaces on one or more machines
Session           PTY/process/tmux/remote-daemon unit
Surface           GUI presentation of a terminal/browser/X2Go/external app
```

The key idea: do not make SSH the only remote abstraction. SSH is one access method.

#### 6. Connection runtime ownership

`t3code` separates retry ownership from UI:

- supervisor owns desired state and retry scheduling;
- broker prepares credentials/endpoints;
- one factory performs one transport attempt;
- UI derives state from supervisor state;
- cached data and live transport health are distinct.

NeonCode should eventually have a similar connection state machine for machines/hubs/SSH sessions:

```text
available / offline / connecting / connected / reconnecting / blocked / error
```

Do not infer connection health just because stale session data exists.

#### 7. Provider instances and account isolation

`t3code` supports multiple provider accounts using provider-specific config homes, shadow homes, environment variables, and server-side secrets.

For NeonCode, this becomes:

- workspace profile env;
- per-agent config directories;
- sensitive values stored in an OS/server secret store later;
- visible provider/account labels if agent integration becomes deeper.

#### 8. Runtime modes: full access vs supervised

`t3code` has modes such as:

- full access;
- supervised with approvals.

NeonCode should not implement deep approvals immediately, but the concept matters for future agent automation and project-local commands.

#### 9. Contextual keybindings

`t3code` keybindings include `when` conditions such as `terminalFocus`, `previewFocus`, etc.

NeonCode should design keybindings around focus context early:

- terminal focus;
- browser focus;
- command palette focus;
- sidebar focus;
- global app focus.

This avoids stealing keys that should pass through to terminal applications.

#### 10. Source-control provider integration

`t3code` integrates with GitHub/GitLab/Bitbucket/Azure DevOps. This is later-stage for NeonCode, but lightweight git/PR metadata in the workspace sidebar is valuable earlier.

Start with local git metadata:

- branch;
- dirty state;
- repo root;
- maybe remote URL.

Then consider PR provider integration later.

### What not to copy yet

- Do not make NeonCode a chat-first agent GUI.
- Do not wrap every provider runtime before the terminal/workspace foundation is solid.
- Do not import a large Node/Effect-style architecture into the Rust hub unless the complexity is justified.
- Do not make remote support depend on hosted services or cloud pairing for the first prototype.

---

## Cross-tool concepts NeonCode should consider reusing

### 1. Hub/session authority

All three tools validate the idea that a backend/runtime should own process/session state.

NeonCode action:

- make `neoncode-hub` authoritative for sessions;
- add list/attach/detach/reconnect;
- support frontend restart without killing sessions.

### 2. Stable IDs and state hierarchy

Use explicit IDs and relationships:

```text
workspace_id
machine_id / environment_id
session_id
attachment_id
surface_id
pane_id
```

Avoid deriving identity from UI indexes.

### 3. Snapshot + event stream

Adopt a protocol shape like:

```text
client connects
  → server.welcome { boot_id, protocol_version, snapshot }
  → events { seq, type, payload }
  → client can resync with list/snapshot
```

This combines lessons from `wmux` and `t3code`.

### 4. UI-owned layout, backend-owned lifecycle

The frontend owns panes/tabs/splits. The hub owns processes and sessions.

A terminal surface is an attachment to a session, not the session itself.

### 5. Remote SSH as a first-class workspace type

From `cmux`, model SSH workspaces explicitly:

- host/user/ssh config alias;
- connection state;
- reconnect/disconnect actions;
- remote session IDs;
- remote errors;
- optional agent forwarding;
- later remote daemon capability.

### 6. Start with tmux, design for remote daemon later

Near-term:

```text
session persistence = ssh + hidden tmux
```

Long-term:

```text
session persistence = neoncode-remote daemon with PTY attach/detach RPC
```

The protocol should not expose tmux as the permanent model.

### 7. Browser as a workspace surface

All three tools treat browsers/previews as important.

NeonCode v1:

- launch external browser profiles;
- show them as workspace surfaces/status.

Later:

- embedded browser pane;
- optional CDP/automation;
- remote browser proxying inspired by `cmux`.

### 8. Notifications and attention routing

Add a simple event model early:

```text
session.output_activity
session.exited
session.awaiting_input
session.error
workspace.notification
```

UI can later render rings, badges, unread panels, and jump-to-latest-unread.

### 9. CLI/API as product surface

Even a small CLI will help:

- dogfooding;
- tests;
- automation;
- agent hooks;
- integration with shell scripts.

### 10. Workspace profiles and secrets

Support environment and startup commands, but keep secrets out of plaintext workspace files.

Initial rule:

- allow config path variables;
- warn/drop obvious `*_TOKEN`, `*_SECRET`, `*_KEY` values unless a proper secret store exists.

### 11. Custom actions with trust prompts

Project-local commands are powerful and dangerous.

Adopt the `cmux`/`wmux` lesson:

- global commands are trusted by user config;
- project-local commands require trust/approval;
- show exactly what command/env/cwd will run.

### 12. Metadata sidebars

Good first metadata:

- cwd;
- git branch;
- dirty state;
- host;
- session status;
- latest notification;
- running command.

Later metadata:

- ports;
- PR/MR;
- test status;
- agent status;
- resource usage.

### 13. Resource management

Potential later features:

- hibernate idle agent sessions;
- cap active terminal renderers;
- detach background sessions;
- restart supervised processes with backoff;
- surface resource usage.

This should wait until session attach/detach semantics are reliable.

### 14. Context-aware keybindings

Design keybindings with `when` clauses or equivalent focus contexts, especially because terminals must receive many shortcuts unchanged.

### 15. Observability and diagnostics

Useful diagnostics to add early:

- hub logs with session IDs;
- protocol errors;
- session lifecycle events;
- frontend native-host logs;
- connection/reconnect reason;
- `neoncode doctor` eventually.

---

## Recommended prototype priorities

### Immediate: protocol/session foundation

Highest leverage for NeonCode's current stage:

1. `server.welcome` with protocol version and hub `boot_id`.
2. `session.list` snapshot.
3. `session.attach` / `session.detach`.
4. `session.resize` per attachment.
5. `session.exit` with status/reason.
6. Central ordered event stream with `seq`.
7. Frontend resync after reconnect.

This is the shared foundation behind almost every feature from `wmux`, `cmux`, and `t3code`.

### Next: launch profiles and workspace config

Add minimal launch profiles:

- local WSL shell;
- project cwd shell;
- SSH shell;
- tmux attach/create;
- custom command.

Then define a minimal workspace file/schema.

### Next: CLI and status metadata

Add a small CLI or local API surface for:

- list sessions;
- send input;
- open workspace;
- notify workspace/session;
- show hub status.

Add sidebar/status metadata incrementally.

### Later: remote daemon

Do not start with a full `cmux`-style remote daemon. But design the session protocol so it can eventually support:

```text
local hub
  ⇄ ssh transport
      ⇄ neoncode-remote daemon
          ⇄ persistent PTY sessions
```

### Later: browser/proxy automation

Start with external browser profiles. Revisit embedded browser/CDP/remote proxy once terminal workspaces are useful.

### Later: deeper agent model

Start by running agents in terminal sessions. Add detection/notifications before adding full provider abstractions or A2A coordination.

---

## Anti-goals for now

Do not spend prototype time on:

- fully replacing tmux with a remote daemon before SSH/tmux profiles work;
- building a chat-first provider GUI;
- reproducing all of `wmux` MCP/A2A/channels;
- reproducing all of `cmux` remote browser proxying;
- implementing source-control provider integrations before basic git metadata;
- over-polishing Electron UI before session protocol/lifecycle are solid;
- copying GPL-licensed implementation code without license review.

---

## Short conclusion

The common lesson from `wmux`, `cmux`, and `t3code` is:

> Build a small, explicit runtime substrate first: stable IDs, session ownership, typed protocol, reconnect/resync, metadata, and CLI/API access. Then layer terminal UI, workspace cockpit features, notifications, browser surfaces, SSH remotes, and agents on top.

For NeonCode, the best immediate move is not more UI polish. It is making `neoncode-hub` a real session/workspace substrate that the Electron/WPF frontends can attach to reliably.
