---
description: Pick the next NeonCode task and complete implement/validate/check-off cycle
argument-hint: "[task override]"
---

You are working in the NeonCode repository.

Your job is to run one complete implementation cycle:

```text
select task -> implement -> validate with tests/checks -> update docs/progress -> commit
```

Optional task override from the user:

```text
$ARGUMENTS
```

If the override is non-empty, use it as the requested task unless it conflicts with the project direction. If it is empty, choose the next highest-value task from the current development plan.

## Required context to read first

Read these before selecting/implementing:

1. `README.md`
2. `docs/development-plan.md`
3. `docs/architecture.md`
4. `docs/product-requirements.md`
5. Any directly relevant doc linked from those files, especially:
   - `docs/protocol.md` for protocol changes;
   - `docs/hub.md` for hub changes;
   - `docs/terminal-renderer-decision.md` for renderer/app decisions;
   - `docs/external-tool-inspiration.md` when working on product/session/workspace concepts.

## Product direction constraints

The supported Windows product path is:

```text
Electron + xterm.js + neoncode-hub + WSL/Linux PTY
```

Do **not** build new product work on old Windows Terminal/WPF/native embedding POCs. Those were intentionally removed/retired from main.

## Task selection rules

If no explicit task override was provided:

1. Use `docs/development-plan.md` as the source of truth.
2. Pick a task from the current stage / immediate next milestone.
3. Prefer tasks that unlock product behavior over cosmetic polish.
4. Prefer tasks that can be completed and validated in one focused pass.
5. If multiple tasks are plausible, choose the one with the clearest validation path.

Before implementing, briefly state:

- selected task;
- why it is next;
- expected validation.

## STOP conditions

Stop and ask the user before implementing if:

- the task requires a product decision not answered by the docs;
- the docs are contradictory;
- the selected task would reintroduce obsolete native/WPF/Windows Terminal product work;
- validation would require manual behavior that cannot be reasonably automated and no acceptance criteria are clear;
- you need to delete/rename large areas not already implied by the docs.

## Implementation rules

- Keep changes focused on one task.
- Prefer small modules over growing a large file.
- Keep `neoncode-hub` as the owner of sessions/lifecycle.
- Keep Electron/xterm frontend as the supported app.
- Keep protocol docs synchronized with `hub/src/protocol.rs` when protocol changes.
- Add or update smoke tests/helpers when behavior changes.
- Update `docs/development-plan.md` checkboxes/progress after validation, not before.

## Validation rules

Always run the minimum relevant checks from `AGENTS.md`.

For Electron app changes, normally run:

```bash
bash -n dev
find frontends/electron -path 'frontends/electron/node_modules' -prune -o -name '*.js' -print0 | xargs -0 -n1 node --check
./dev publish
```

If terminal hub/input behavior is affected, also run against a live hub:

```bash
./dev electron-test
```

For hub/Rust changes, normally run:

```bash
cargo fmt --check
cargo check
cargo test
cargo clippy --all-targets -- -D warnings
```

For docs-only changes, run:

```bash
git diff --check
```

If a check fails:

1. diagnose;
2. fix;
3. rerun the relevant check;
4. do not check off the task until validated.

## Completion rules

When validation passes:

1. Update `docs/development-plan.md` to mark the completed task/checklist item.
2. Update related docs if behavior/architecture changed.
3. Commit the completed work with a concise commit message.
4. Do **not** push unless explicitly asked.
5. Report:
   - selected task;
   - files changed;
   - validation run/results;
   - commit hash;
   - recommended next task.
