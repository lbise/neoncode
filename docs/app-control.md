# NeonCode desktop app-control

NeonCode exposes a local, authenticated desktop app-control endpoint while the Electron app is running. This transport is owned by Electron, not by `neoncode-hub`: Electron owns workspaces, tabs, panes, settings, command dispatch, and presentation; the hub remains the PTY/session backend.

The CLI reads the per-run descriptor from the platform config directory, or from `NEONCODE_APP_CONTROL_DESCRIPTOR` / `NEONCODE_TEST_CONFIG_DIR` in tests.

## Inspect the running app

```bash
./dev cli app status
./dev cli commands
./dev cli workspace list
./dev cli tab list
./dev cli pane list
./dev cli pane capture shell
./dev cli pane tail shell
```

`app status` prints the app version, pid, config revision, descriptor path, advertised features, and active workspace/tab/pane context. `pane capture` returns a bounded JSON snapshot for a visible pane, including lifecycle, sequence counters, and recent output. `pane tail` prints only the recent output text.

## Workspaces

```bash
./dev cli workspace open default
./dev cli workspace create scratch-ws scratch-shell default-shell Scratch "Scratch Shell"
./dev cli workspace rename scratch-ws "Scratch Workspace"
./dev cli workspace delete scratch-ws
```

Workspace deletion defaults to `kill`; pass `detach` explicitly if needed for advanced workflows:

```bash
./dev cli workspace delete scratch-ws detach
```

## Tabs and panes

Discover IDs first:

```bash
./dev cli tab list
./dev cli pane list
```

Create and switch tabs:

```bash
./dev cli tab create default scratch scratch-session default-shell Scratch
./dev cli tab open default scratch
./dev cli tab rename default scratch "Scratch Tab"
./dev cli tab close default scratch
```

Focus, split, resize, and close panes:

```bash
./dev cli pane focus shell
./dev cli pane focus-index 1
./dev cli pane split default shell scratch-pane scratch-split horizontal after default-shell Scratch
./dev cli pane resize default scratch-split 0.05
./dev cli pane close default scratch-pane
```

## Send terminal input

For dogfooding and automation, use bounded text input commands instead of synthetic GUI keystrokes:

```bash
./dev cli pane send shell "printf hello-"
./dev cli pane send-enter shell "world"
./dev cli pane send-enter shell "printf 'tests done\\n'"
./dev cli wait output shell "tests done" 30
./dev cli pane tail shell
```

`pane send` writes text without Enter. `pane send-enter` writes text followed by Enter. The app-control validator accepts bounded text and rejects control characters; use explicit higher-level verbs rather than sending raw terminal escape/control sequences. `wait output` polls the bounded recent-output capture until text appears or the timeout expires.

## Generic command execution

All externally eligible commands are discoverable:

```bash
./dev cli commands
./dev cli command pane.focusIndex '{"index":1}'
```

The CLI verifies that a command is advertised by the running app before dispatching it. Responses include a bounded command result and active app context.
