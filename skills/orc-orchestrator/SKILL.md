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
- **ORC** (`C:\Users\maxvo\Desktop\Projects\ORC\bin\orc.js`) owns specs, isolated git
  worktrees, implement → review → test loops, and clean rebase merges.

## Step 1 — Load Project Memory (Obsidian Vault in `docs/`)
Before breaking down work, read ONLY the relevant memory files in the target repo:
1. `AGENTS.md` — repo map, build/test commands, safety constraints, ignored heavy folders.
2. `docs/index.md` & `docs/architecture.md` — system overview and wikilinks (`[[...]]`).
3. `docs/decisions/` — relevant ADRs (`ADR-*.md`) so subtasks never contradict past choices.
4. `docs/board.md` — active, review, and blocked tasks.

## Step 2 — Decompose into Focused Subtasks
Split a large goal into **small, verifiable units** (ideally 1–5 files and 1 clear check per
subtask). For each subtask, write:
- A crisp `--desc` naming the exact module/files in scope, constraints, and what is OUT of scope.
- Concrete `--accept` checklist items that a reviewer can verify from `git diff` + tests.
- Choose `--agent agy` or `--agent claude` (the other CLI reviews automatically unless
  `reviewer` is overridden on the project).

Create each subtask with ORC (never dump huge chat logs into specs):
```powershell
node C:\Users\maxvo\Desktop\Projects\ORC\bin\orc.js add <project> "<short title>" `
  --desc "Scope: <files/module>. Goal: <what changes>. Out of scope: <what not to touch>." `
  --accept "- [ ] <verifiable requirement 1>" `
  --accept "- [ ] <unit/sim test covers it>" `
  --agent agy
```

## Step 3 — Dispatch, Monitor, and Merge
- Check registered projects and health:
  `node C:\Users\maxvo\Desktop\Projects\ORC\bin\orc.js doctor`
- Check the board:
  `node C:\Users\maxvo\Desktop\Projects\ORC\bin\orc.js list <project>`
- Run one subtask at a time per project (ORC enforces a per-project lock):
  `node C:\Users\maxvo\Desktop\Projects\ORC\bin\orc.js run <T-XXXX>`
- After reviewing the diff/review in the ORC dashboard (`http://127.0.0.1:4317`), merge
  cleanly onto `baseBranch` (no auto-push):
  `node C:\Users\maxvo\Desktop\Projects\ORC\bin\orc.js merge <T-XXXX>`

## Step 4 — Update Obsidian Brain Memory
When a milestone or architectural decision lands:
1. Write or update an ADR in `docs/decisions/ADR-XXXX-<slug>.md` with YAML frontmatter and
   `[[wikilinks]]` to related modules/specs.
2. Update `docs/architecture.md` or `docs/index.md` if module boundaries or interfaces changed.
3. Keep `AGENTS.md` under one page so every future ORC worker starts fast with minimal tokens.
