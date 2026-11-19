# ORC — Local Mission Control for Coding Agents

[![CI](https://img.shields.io/github/actions/workflow/status/paradoxsmile/ORC/ci.yml?branch=main&label=CI)](https://github.com/paradoxsmile/ORC/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.5-green.svg)](https://nodejs.org/)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)

**ORC** is a local-first orchestrator that gives you **one task board across all your local Git repositories** and drives the official **Claude Code (`claude`)** and **Google Antigravity (`agy`)** CLIs headlessly in isolated Git worktrees.

It owns **artifacts and processes** — specs, worktrees, diffs, review verdicts, test logs, and clean local merges — never model APIs or tokens.

> [!IMPORTANT]
> **Please read the [Disclaimers, Rate Limits & Security](#disclaimers-rate-limits--security) section before running automated agent loops against your subscriptions.**

---

## Why ORC?

- **Separate subscriptions, zero API proxying:** `claude` keeps its login and quota; `agy` keeps its login and quota. ORC spawns the official CLIs headlessly and never stores OAuth tokens or proxies vendor traffic.
- **Focused context per subtask:** Instead of dumping a 100k-token chat history into one session, each task gets a concise spec file (`docs/specs/YYYY-MM-DD-<slug>.md`) and runs in its own isolated Git worktree (`.worktrees/T-0001`).
- **Cross-agent verification:** One CLI implements (`acceptEdits` / `accept-edits`), your test gate runs first, and once green the other CLI reviews in read-only `plan` mode, returning a machine-readable `VERDICT: APPROVE` or `VERDICT: REQUEST CHANGES` (bounded to 2 fix loops).
- **Zero-dependency stack:** Pure Node.js ESM (`>=22.5`, `node:sqlite`), vanilla HTML/CSS/JS dashboard with Server-Sent Events (SSE), no npm packages, no build step.
- **Obsidian-ready memory:** Every registered repo scaffolds `AGENTS.md`, `docs/index.md`, `docs/architecture.md`, `docs/decisions/`, `docs/specs/`, and an auto-updated `docs/board.md`.

---

## Architecture & Pipeline

```mermaid
flowchart LR
    U["You / Architect Skill"] -->|"orc add / UI"| S["Spec File\ndocs/specs/*.md"]
    S -->|"Ready"| I["Implement Step\nWorktree .worktrees/T-XXXX"]
    I -->|"ORC commits & captures diff"| V["Test Gate\ntestCommand"]
    V -->|"Pass / none"| R["Review Step\nRead-only plan mode"]
    V -->|"Fail (<2 loops)"| F["Fix Loop (max 2)"]
    R -->|"VERDICT: APPROVE"| D["Done (Worktree ready)"]
    R -->|"VERDICT: REQUEST CHANGES"| F
    F --> I
    D -->|"Manual orc merge"| M["Rebase + ff-only merge\nArchive .orc/ + Clean worktree"]
    V & R -->|"Limit reached / error"| B["Blocked (Human decision)"]
```

- **One active run per project** (`run.refused` on conflict) and a configurable global cap (`ORC_MAX_CONCURRENCY`, default `2`).
- **Artifacts preserved after merge:** Before `orc merge` deletes `.worktrees/T-XXXX`, ORC archives `spec.md`, `diff.patch`, `review.md`, `test.log`, and prompts into gitignored `<project>/.orc/T-XXXX/` so history stays inspectable in the dashboard.

---

## Quick Start

### 1. Prerequisites
- **Node.js 22.5+** (uses built-in `node:sqlite`)
- **Git** on `PATH`
- **Claude Code (`claude`)** and/or **Google Antigravity (`agy`)** installed and signed in interactively once:
  - Claude Code (PowerShell): `irm https://claude.ai/install.ps1 | iex` (or `winget install Anthropic.ClaudeCode`) → run `claude` once to log in.
  - Antigravity CLI (PowerShell): `irm https://antigravity.google/cli/install.ps1 | iex` → run `agy` once to log in.

### 2. Clone & Install Global Launcher + Skill

```sh
git clone https://github.com/paradoxsmile/ORC.git
cd ORC
node scripts/install-skill.mjs
```

`install-skill.mjs` creates a global `orc` / `orc.cmd` launcher in `~/.local/bin` (so you can run `orc serve`, `orc doctor`, etc. from any folder) and installs the portable `orc-orchestrator` skill for both Antigravity (`~/.gemini/config/skills/`) and Claude Code (`~/.claude/skills/`).

Verify everything is detected:

```sh
orc doctor
node scripts/probe.mjs
```

### 3. Run Your First Task

```sh
# 1. Register an existing Git repository (commit the scaffold once so worktrees inherit AGENTS.md & docs/)
orc project add /path/to/your/repo --name my-app --test "npm test"

# 2. Create a scoped task (starts in Ready because --desc / --accept are provided)
orc add my-app "Retry failed uploads once" \
  --desc "A 5xx response drops the upload permanently. Update src/upload.js only." \
  --accept "- [ ] Retries once on 5xx" \
  --accept "- [ ] Unit test covers the retry" \
  --agent agy

# 3. Start the dashboard OR run directly from the CLI
orc serve          # Dashboard at http://127.0.0.1:4317
orc run T-0001     # Run implement → verify → review loop

# 4. Inspect diff/review in the dashboard, then merge locally when satisfied
orc merge T-0001
```

> **Windows PowerShell note:** If PowerShell blocks `npm.ps1`, run Node scripts directly (`node scripts/check.mjs`, `node --test`, `node scripts/smoke.mjs`, or `orc ...` after running `install-skill.mjs`).

---

## Dashboard Features

Open **`http://127.0.0.1:4317`** after running `orc serve`:

- **Multi-project Kanban board:** Lanes for `Inbox`, `Ready`, `Working` (implementing/fixing), `Review` (reviewing/verifying), `Blocked`, and `Done`, updated live over SSE.
- **Task Drawer:**
  - **Spec tab:** Edit Markdown directly with `Preview` / `Edit` toggle and `Save spec` (moves `Inbox` tasks to `Ready`).
  - **Review tab:** Rendered Markdown with highlighted green/red `VERDICT` badges (`Rendered` / `Raw` toggle).
  - **Diff tab:** Colorized unified diff with file count and `+/-` stats (`Colorized` / `Raw` toggle).
  - **Tests & Events tabs:** Full `test.log`, run history, tool activity, and amber **Rate Limit Notice** banners when `agent.rate_limit` events fire.
  - **Actions:** `Run`, `Stop`, `Merge`, `Open folder`, `Spec file`, `Mark done`, `Block`, `Delete`, and manual state dropdown.
- **Project Settings (⚙ Settings):** Edit `baseBranch`, `testCommand`, `setupCommand`, `reviewer` policy (`default`, `auto`, `same`, `claude`, `agy`), `implModel`, and `reviewModel` live without restarting `orc serve`, or unregister the project.
- **CLI Health Modal:** Click the `Claude · Antigravity · Git` indicators in the top bar to view binary paths and setup commands.

---

## CLI Reference

| Command | Purpose |
| :--- | :--- |
| `orc serve [--port 4317]` | Start the local dashboard and REST/SSE API on `127.0.0.1` |
| `orc doctor` | Check Node, Git, `claude`, `agy`, registered repos, and stale worktrees |
| `orc project add <path> [flags]` | Register & scaffold a repo (`--name`, `--base`, `--test`, `--setup`, `--reviewer`, `--impl-model`, `--review-model`) |
| `orc project list` | List registered projects and task counts |
| `orc project remove <id\|name>` | Unregister a project from `orc.config.json` (leaves files on disk untouched) |
| `orc init <project\|path>` | Write `AGENTS.md`, `docs/`, and `.gitignore` scaffold only |
| `orc add <project> "<title>" [flags]` | Create task (`T-XXXX`), spec file, and branch name (`--desc`, `--accept`, `--agent claude\|agy`) |
| `orc list [project]` | List tasks across all or one project |
| `orc run <taskId>` | Run the implement → verify → review pipeline |
| `orc stop <taskId>` | Stop the active run (works across terminals via SQLite PID) |
| `orc merge <taskId>` | Rebase task branch onto `baseBranch`, fast-forward, archive `.orc/`, remove worktree & branch, mark `done` |
| `orc delete <taskId> [--clean]` | Delete task from board (`--clean` also removes its worktree & `.orc/` artifacts) |
| `orc state <taskId> <state>` | Manually move a task (`inbox\|specced\|working\|review\|fixing\|verify\|done\|blocked`) |
| `orc done <taskId>` / `orc block <taskId>` | Mark done or blocked with `--note "..."` |
| `orc status` | Regenerate `STATUS.md` and `docs/board.md` and print board summary |
| `orc open [task\|project]` | Open worktree, `--spec`, or `--project` in the OS file explorer |
| `orc install` | Install global `orc` / `orc.cmd` launcher and `orc-orchestrator` skill |

---

## Configuration & Environment Variables

`orc.config.json` is gitignored so your local project registry stays private (see [orc.config.example.json](orc.config.example.json)). Runtime SQLite data (`data/orc.db`), run logs (`data/logs/`), probe traces (`data/probes/`), and `STATUS.md` are also gitignored.

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `ORC_CONFIG` | `./orc.config.json` | Override path to config file |
| `ORC_DATA_DIR` | `./data` | Override SQLite & logs directory |
| `ORC_MAX_CONCURRENCY` | `2` | Global limit of concurrent runs across different projects |
| `ORC_MAX_FILE_BYTES` | `5242880` (5 MiB) | Block staging/committing oversized files or binaries in `captureWork` |
| `ORC_REVIEWER` | opposite CLI | `claude`, `agy`, `same`, or `auto` (falls back to implementer if other CLI missing) |
| `ORC_CLAUDE_MODEL` | CLI default | Default Claude model (`ORC_CLAUDE_IMPL_MODEL` / `ORC_CLAUDE_REVIEW_MODEL` override per role) |
| `ORC_AGY_MODEL` | CLI default | Default Antigravity model (`ORC_AGY_IMPL_MODEL` / `ORC_AGY_REVIEW_MODEL` override per role) |
| `ORC_AGY_EFFORT` | unset | Reasoning effort (`low\|medium\|high\|xhigh\|max`; automatically omitted for Orchestrator slugs) |
| `ORC_AGY_YOLO` | unset (off) | Set to `1` to pass `--dangerously-skip-permissions` to Antigravity implementation runs |

Per-project settings configured in **⚙ Settings** (`implModel`, `reviewModel`, `reviewer`, `setupCommand`, `testCommand`, `baseBranch`) override global env defaults for that project.

---

## Best Practices & Obsidian Integration

See **[docs/best-practices.md](docs/best-practices.md)** for full workflows on:
- **Large repositories (e.g., Formula Student, embedded, monorepos):** writing a crisp 1-page `AGENTS.md`, excluding heavy build/telemetry folders, and using `setupCommand` for submodules/venvs.
- **Architect + Worker pattern:** using [skills/orc-orchestrator/SKILL.md](skills/orc-orchestrator/SKILL.md) inside an interactive Antigravity or Claude Code chat to decompose features into tightly scoped ORC subtasks.
- **Obsidian brain memory:** opening `<project>/docs/` as an Obsidian vault so `index.md`, `architecture.md`, `decisions/ADR-*.md`, `specs/`, and `board.md` stay synchronized across you and your agents.

---

## Testing & Verification

```sh
node scripts/check.mjs   # Syntax check all JS, validate JSON, verify required files & privacy
node --test              # Offline unit tests (verdict, flags, state machine, git capture, merge, concurrency, parsers)
node scripts/probe.mjs   # Probe installed claude / agy CLIs and save JSONL traces to data/probes/
node scripts/smoke.mjs   # End-to-end test using fake CLIs, real Git worktrees, merge, and HTTP/SSE API
```

---

## Disclaimers, Rate Limits & Security

> [!WARNING]
> **Read carefully before running unattended agent loops:**

1. **No Affiliation:** ORC is an independent open-source project and is not affiliated with, endorsed by, or sponsored by Anthropic or Google.
2. **Terms of Service & Authentication:** ORC executes the official `claude` and `agy` binaries in headless mode. It **never** calls vendor REST APIs directly, **never** stores or proxies OAuth credentials, and **never** pools or shares accounts. You are solely responsible for complying with Anthropic's and Google's terms of service and acceptable use policies.
3. **Subscription Quotas & Rate Limits:** Each task executes at least one implementation run and one review run, and up to two fix-and-re-review cycles (up to 6 CLI invocations per task). Repeated runs on large codebases can rapidly consume 5-hour or 7-day subscription limits or API credits. Monitor the dashboard (`agent.rate_limit` warnings), write tight specs, use `Stop` whenever a run goes off-track, and check your vendor usage dashboards regularly.
4. **Headless Permissions & Shell Risk:**
   - Git worktrees isolate **tracked workspace files**, **not** your operating system, network, or shell environment.
   - Claude Code runs with `--permission-mode acceptEdits` (`Read,Edit,Write,Bash`) during implementation and `--permission-mode plan` (`Read,Grep,Glob,Bash`) during review.
   - Antigravity defaults to `--mode accept-edits` **without** `--dangerously-skip-permissions`. Prefer scoped `permissions.allow` rules in `~/.gemini/antigravity-cli/settings.json`; only enable `ORC_AGY_YOLO=1` in repositories and environments you fully trust.
5. **Localhost-Only Server (`127.0.0.1`):** The HTTP server binds strictly to `127.0.0.1` with **no authentication**. Never forward or expose the port to a network. See [SECURITY.md](SECURITY.md) for the full threat model.
6. **No Warranty:** Provided "AS IS" under the [MIT License](LICENSE). Always review `diff.patch`, `review.md`, and `test.log` before running `orc merge` — ORC intentionally never pushes or creates PRs automatically.

---

## Troubleshooting & Contributing

- Stuck on setup, permissions, or Git worktrees? Read **[docs/troubleshooting.md](docs/troubleshooting.md)**.
- Want to contribute? Read **[CONTRIBUTING.md](CONTRIBUTING.md)** and **[AGENTS.md](AGENTS.md)**.
- Release history: **[CHANGELOG.md](CHANGELOG.md)**.
