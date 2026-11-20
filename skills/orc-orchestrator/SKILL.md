---
name: orc-orchestrator
description: >-
  Decompose large engineering features into tightly scoped ORC subtasks with
  focused specs, isolated git worktrees, and cross-agent review, while keeping
  Obsidian-compatible project memory in docs/. Use when the user asks to plan,
  break down, dispatch, or monitor multi-step coding work through ORC.
---

# ORC Orchestrator Skill (Architect + Worker Pattern)

Use this skill when working interactively inside a large repository (e.g., Formula Student,
embedded/ROS, full-stack systems) where keeping each worker agent's context window focused
is critical.

## Core Pattern
- **You (this interactive session)** are the **Architect**: read the codebase and Obsidian
  memory (`docs/`), design the architecture, split work into small independent tasks,
  dispatch them to ORC, monitor status, and update memory after tasks merge.
- **ORC** (`orc` on `PATH`, or `node <path-to-orc>/bin/orc.js`) owns specs, isolated git
  worktrees, implement → review → test loops, and clean rebase merges. If `orc` is not yet
  on `PATH`, run `node scripts/install-skill.mjs` inside the ORC repository.

## Step 1 — Load Project Memory (Obsidian Vault in `docs/`)
Before breaking down work, read ONLY the relevant memory files in the target repo:
1. `AGENTS.md` — repo map, build/test commands, safety constraints, ignored heavy folders.
2. `docs/index.md` & `docs/architecture.md` — system overview and wikilinks (`[[...]]`).
3. `docs/decisions/` — relevant ADRs (`ADR-*.md`) so subtasks never contradict past choices.
4. `docs/board.md` — active, review, and blocked tasks.

## Step 1.5 — Offload Heavy Codebase Exploration with Research Mode
Before planning a complex feature in an unfamiliar area, don't burn your own interactive
context window reading 30 files. Dispatch a read-only research task instead:
```sh
orc research <project> "<focused architecture or bug-hunting question>" \
  --agents claude,agy --tier low --run
```
ORC runs the agent(s) in read-only `plan` mode (no worktree, no edits), saves full notes to
`docs/research/`, and writes a condensed ~40-line executive brief to `.orc/<T-XXXX>/brief.md`.
Read ONLY that `brief.md` before decomposing subtasks.

## Step 2 — Decompose into Focused Subtasks
Split a large goal into **small, verifiable units** (ideally 1–5 files and 1 clear check per
subtask). For each subtask, write:
- A crisp `--desc` naming the exact module/files in scope, constraints, and what is OUT of scope.
- Concrete `--accept` checklist items that a reviewer can verify from `git diff` + tests.
- Choose `--agent agy`, `--agent claude`, or `--agent codex` (the other CLI reviews automatically
  unless `reviewer` is overridden on the project).
- **Optimize plan usage with `--tier`:** Use `--tier low` for mechanical/straightforward edits
  (routes implementation to smaller models like Sonnet while keeping reviewers on `high` tier),
  `--tier med` (default) for standard features, and `--tier high` only for tricky architecture.
- **Chain dependent subtasks with `--depends-on`:** Queue downstream tasks so ORC auto-drains
  them only after upstream tasks reach `done` (and halts if upstream blocks).

Create each subtask with ORC (never dump huge chat logs into specs):
```sh
orc add <project> "<short title>" \
  --desc "Scope: <files/module>. Goal: <what changes>. Out of scope: <what not to touch>." \
  --accept "- [ ] <verifiable requirement 1>" \
  --accept "- [ ] <unit/sim test covers it>" \
  --agent agy --tier low --depends-on T-0001
```

## Step 3 — Dispatch, Queue, Monitor, and Merge
- Check registered projects and health:
  `orc doctor`
- Check the board and token/quota usage:
  `orc status` / `orc list <project>`
- Run one subtask at a time per project, or queue follow-ups behind it:
  `orc run <T-XXXX>`
  `orc queue <T-YYYY>`
- After reviewing the diff/review in the ORC dashboard (`http://127.0.0.1:4317`), merge
  cleanly onto `baseBranch` (no auto-push):
  `orc merge <T-XXXX>`

## Step 4 — Update Obsidian Brain Memory
When a milestone or architectural decision lands:
1. Write or update an ADR in `docs/decisions/ADR-XXXX-<slug>.md` with YAML frontmatter and
   `[[wikilinks]]` to related modules/specs.
2. Update `docs/architecture.md` or `docs/index.md` if module boundaries or interfaces changed.
3. Keep `AGENTS.md` under one page so every future ORC worker starts fast with minimal tokens.
