# Best Practices for ORC

## 1. Context Engineering in Large Repositories

Large engineering repositories (monorepos, Formula Student vehicles, embedded/ROS stacks,
simulation pipelines) fail when agents read irrelevant directories or exceed tool limits.

### Keep `AGENTS.md` Under One Page
After running `orc project add <path>` (or `orc init <project>`), customize `<repo>/AGENTS.md`
and commit it once to `main` so every worktree inherits it:
- **Repo map:** 5–10 bullet lines pointing to the key source folders.
- **Exact commands:** fast unit test command, build command, linter command.
- **Safety / domain invariants:** real-time constraints, units, bus IDs, API contracts.
- **Do-not-scan folders:** explicitly tell agents not to read `build/`, `dist/`,
  `telemetry/`, CAD binaries, or large dataset directories.

### Verify `.gitignore` Before Dispatching
ORC stages tracked/untracked worktree changes via `git add -A` (excluding `.orc/`) and blocks
files larger than `ORC_MAX_FILE_BYTES` (default 5 MiB). Always gitignore:
- Build directories (`build/`, `target/`, `dist/`, `__pycache__/`, `.venv/`)
- Telemetry, bags, notebooks outputs, and datasets (`*.bag`, `*.mat`, `*.csv`, `*.bin`)
- IDE / Obsidian workspace state (`.obsidian/workspace*.json`, `.obsidian/cache`)

### Use `setupCommand` for Worktree Bootstrapping
If a fresh git worktree needs submodules, symlinks, or generated headers before tests can
run, set `setupCommand` in Project Settings (⚙ Settings in the UI, or `--setup "..."`):
```sh
git submodule update --init --recursive
```
ORC runs `setupCommand` once when provisioning `.worktrees/<taskId>` and saves the log to
`.orc/<taskId>/setup.log`.

---

## 2. Sizing Subtasks (1–5 Files, 1 Clear Test)

- **Bad task:** *"Refactor the entire vehicle state estimator and telemetry logger."*
- **Good task:** *"Add CAN timeout fallback to wheel-speed estimator (`src/est/wheel.cpp`)"*
  with 2–4 concrete acceptance checkboxes (`- [ ] ...`) and a fast `--test` command.
- Keep `testCommand` fast (unit/sim suite rather than a full hardware/Docker release build).

---

## 3. The Architect + Worker Workflow (`orc-orchestrator` Skill)

Pair an interactive Antigravity or Claude Code chat session with ORC:

1. Install the bundled skill and global `orc` launcher once:
   ```sh
   node scripts/install-skill.mjs
   ```
2. Work normally in your interactive **Architect** session: read the repo, discuss trade-offs,
   and let the `orc-orchestrator` skill split the feature into small `orc add` subtasks.
3. Let ORC run each subtask in an isolated worktree (`orc run T-0001`), so each implementer
   and reviewer sees only the focused spec, `AGENTS.md`, and relevant files.
4. Review the colorized diff and `review.md` in the ORC dashboard (`http://127.0.0.1:4317`),
   then click **Merge** (or run `orc merge T-0001`).

---

## 4. Obsidian as Project Brain Memory

Every registered project scaffolds an Obsidian-friendly documentation layout under `<repo>/docs/`:

```text
<repo>/docs/
  index.md            # Project home & links
  architecture.md     # One-page system boundary map
  board.md            # Auto-generated live ORC task board
  specs/              # Per-task handoff specs (YYYY-MM-DD-<slug>.md)
  decisions/          # ADRs (ADR-0001-...)
  reviews/            # Optional human design reviews
  _templates/         # Spec & ADR templates
```

Open `<repo>/docs/` directly as an **Obsidian Vault** (or link it into an existing vault):
- Use `[[wikilinks]]` between `architecture.md`, `decisions/ADR-*.md`, and `specs/`.
- Update `architecture.md` and write a short ADR whenever a significant task merges.
- Because specs and ADRs live inside Git, every new task worktree starts with up-to-date memory
  without re-explaining project history in chat.

---

## 5. Quota & Rate-Limit Management

Each implement → review → fix pipeline triggers at least 2 headless CLI sessions (and up to
6 sessions if it uses both fix loops):
- **Watch quota signals:** ORC captures Claude `rate_limit_event` frames as `agent.rate_limit`
  events and shows an amber warning banner in the task drawer.
- **Balance quotas across vendors:** Use `--agent agy` when Claude quota is tight (Antigravity
  implements, Claude runs read-only review), or `--agent claude` to invert.
- **Single-CLI fallback:** Set `Reviewer policy` to `Auto` or `Same` in Project Settings (or
  `ORC_REVIEWER=auto`) to run an isolated fresh `plan`-mode review on the available CLI when
  one vendor hits a weekly or 5-hour limit.
- **Pin cost/reasoning per project:** Set `Implementer model` (e.g., an orchestrator or fast
  coding model) and `Reviewer model` (e.g., a high-reasoning model) per project in ⚙ Settings.
