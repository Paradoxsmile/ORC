# ORC — mission control for Claude Code + Google Antigravity

One local board for all your projects: what is ready, what is running, what needs a
human. ORC is a thin orchestrator over the official CLIs. It never calls a model API,
never stores OAuth tokens, and never pools quota. Claude keeps its login; Antigravity
keeps its login.

> Status: **v0.1 scaffold**. The board, task/spec model, worktrees, dispatch loop,
> review loop, dashboard, and a fake-CLI smoke test are implemented. The CLI adapters
> are written against the documented headless formats, but this machine does not have
> `claude` or `agy` installed yet, so the full agent loop has not been exercised against
> the real CLIs.

---

## 1. What it is

A local Node.js app with:

- a registry of projects (any local git repo),
- one SQLite task board across all of them,
- a spec file per task,
- one git worktree per task,
- a dispatch pipeline that runs Claude Code and Antigravity headlessly,
- a machine-readable review verdict,
- a test gate before `done`,
- a local dashboard at `http://127.0.0.1:4317`,
- generated `docs/board.md` per project and a root `STATUS.md`.

What it is **not**:

- not a chat client,
- not a proxy for Anthropic or Google APIs,
- not a shared model session,
- not a quota pool,
- not an IDE and not a replacement for Obsidian.

ORC coordinates **work artifacts** (specs, diffs, verdicts, test logs) and **processes**
(CLI runs, worktrees, stops). That is the whole trick: the two subscriptions never need
to share a context window.

---

## 2. The mental model

| Thing | What it is |
| --- | --- |
| Project | A local git repository registered once. |
| Task | A unit of work: `T-0001`, a title, a state, a spec, a branch name. |
| Spec | The handoff document. The agent reads this, not a giant chat history. |
| Worktree | `<project>/.worktrees/T-0001`, on branch `task/T-0001-<slug>`. |
| Run | One CLI process (implement, review, or test) with a log row. |
| Event | Append-only history shown in the dashboard. |
| Artifact | Prompt, diff, review, and test log under `<worktree>/.orc/T-0001/`. |

### What `add` means

`add` is **not** a chat message and not a prompt to a model. It creates a unit of work:

1. a row in the task board (`T-0001`),
2. a spec file in `<project>/docs/specs/YYYY-MM-DD-<slug>.md`,
3. a branch name (`task/T-0001-<slug>`),
4. an event in the history.

- Title only → task starts in **Inbox**; write the spec later.
- With `--desc` or `--accept` → task starts in **Ready** (`specced`) and can run.

Running the task is what creates the worktree and calls a CLI. A task only becomes
`done` after review and (if configured) tests.

---

## 3. Quick start

Requirements:

- Node.js **22.5+** with `node:sqlite` (tested on v26.13.0)
- git on `PATH`
- Claude Code CLI (`claude`) and/or Google Antigravity CLI (`agy`)

No `npm install` is required. There are no dependencies.

```powershell
node bin/orc.js doctor

node bin/orc.js project add C:\Users\you\code\my-app --name my-app --test "npm test"
# commit the generated scaffold once, so task worktrees inherit AGENTS.md and docs/
# cd C:\Users\you\code\my-app; git add -A; git commit -m "chore: ORC scaffold"

node bin/orc.js add my-app "Retry failed uploads once" `
  --desc "A 5xx response currently drops the upload permanently." `
  --accept "- [ ] retries once on 5xx" `
  --accept "- [ ] a test covers the retry"

node bin/orc.js run T-0001

node bin/orc.js serve
# open http://127.0.0.1:4317
```

If PowerShell blocks `npm.ps1`, use the Node entry point directly:

```powershell
node scripts/check.mjs
node bin/orc.js serve
```

---

## 4. Commands

```
node bin/orc.js serve [--port 4317]
node bin/orc.js doctor
node bin/orc.js project add <path> [--name "..."] [--base main] [--test "npm test"]
node bin/orc.js project list
node bin/orc.js init <project|path>
node bin/orc.js add <project> "<title>" [--desc "..."] [--accept "- ..."] [--agent claude|agy]
node bin/orc.js list [project]
node bin/orc.js run <taskId>
node bin/orc.js stop <taskId>
node bin/orc.js state <taskId> <state>
node bin/orc.js done <taskId> [--note "..."]
node bin/orc.js block <taskId> [--note "..."]
node bin/orc.js status
node bin/orc.js open [task|project] [--spec] [--project]
node scripts/check.mjs
node --test
node scripts/smoke.mjs
```

`project add` registers the repo and writes the docs scaffold:

```
AGENTS.md
docs/index.md
docs/architecture.md
docs/specs/
docs/decisions/
docs/reviews/
docs/_templates/spec.md
docs/_templates/adr.md
.gitignore entries for .worktrees/ and .orc/
```

Existing files are never overwritten.

---

## 5. States and pipeline

```
inbox ──write spec──> specced
specced ──implement──> working ──diff──> review
review ──approve──> verify ──tests pass──> done
review ──request changes──> fixing ──implement──> review
verify ──tests fail──> fixing (bounded)
any failure / too many loops ──> blocked
```

- **One task, one worktree, one agent at a time.** Different tasks can run in parallel.
- Claude implements by default; Antigravity reviews. Choose `--agent agy` to swap the
  implementer (then Claude reviews).
- Review requires the exact final line `VERDICT: APPROVE` or
  `VERDICT: REQUEST CHANGES`.
- Maximum **2 review/fix loops**, then the task is blocked for a human.
- The implementation agent is told not to commit. ORC commits as a local `ORC`
  identity, captures `git diff <base>...HEAD`, and saves it as `diff.patch`.
- If the project has a `testCommand`, it runs in the worktree before `done`.
- Stopping kills the process tree and leaves the task blocked with an event trail.
- Merging the branch back is deliberately manual. ORC does not push or merge.

Artifacts:

```
<project>/.worktrees/T-0001/.orc/T-0001/
  spec.md
  task.json
  prompt-implement.md
  prompt-review.md
  diff.patch
  review.md
  test.log
```

Run logs are also kept in `data/logs/<task>-<run>.jsonl`.

---

## 6. Models (important)

ORC does **not** choose a model by default; the CLIs use their own defaults. You can pin
models with environment variables:

| Variable | Used for |
| --- | --- |
| `ORC_CLAUDE_MODEL` | default Claude model |
| `ORC_CLAUDE_IMPL_MODEL` / `ORC_CLAUDE_REVIEW_MODEL` | role-specific Claude model |
| `ORC_AGY_MODEL` | default Antigravity model |
| `ORC_AGY_IMPL_MODEL` / `ORC_AGY_REVIEW_MODEL` | role-specific Antigravity model |
| `ORC_AGY_EFFORT` | `low`, `medium`, `high`, `xhigh`, `max` (ignored for Orchestrator) |
| `ORC_AGY_YOLO` | `1` to opt into `--dangerously-skip-permissions` on Antigravity implementation (off by default) |

Antigravity model slugs come from `agy models`. As of November 2026, relevant ones are:

- `gemini-pro-orchestrator-argon` — **Orchestrator (Argon)**: Gemini 4 Argon plans and
  reviews, Gemini 4 Hydrogen executes. Available on paid Google AI Pro. Fixed effort.
- `gemini-4-argon-high` — standalone Gemini 4 Argon, high reasoning. Best for
  architecture, concurrency, state machines, and strict review.
- `gemini-4-hydrogen-xhigh` — fast standalone implementation model.
- `gemini-pro-orchestrator` — Orchestrator (Carbon); Google AI Ultra only.
- Claude Sonnet 5.5 / Opus 5.5 are also selectable in Antigravity on separate quotas.

Suggested ORC setup for a paid Google AI Pro account:

```powershell
# Antigravity as reviewer (the default pipeline: Claude implements)
$env:ORC_AGY_REVIEW_MODEL = "gemini-4-argon-high"

# Antigravity as implementer (task created with --agent agy)
$env:ORC_AGY_IMPL_MODEL = "gemini-pro-orchestrator-argon"
```

A task has exactly one implementer and one reviewer. Claude implements and
Antigravity reviews by default; `--agent agy` swaps the roles. The two roles never
run on the same CLI.

Pick the reasoning tier in the slug (`-high`, `-xhigh`) and leave `ORC_AGY_EFFORT`
unset unless the pinned model accepts an override. ORC omits `--effort` for
Orchestrator slugs because Orchestrator has no thinking-level setting.

For **building ORC itself** in Antigravity, Orchestrator (Argon) is the best default.
Switch to standalone `gemini-4-argon-high` for the dispatch/state-machine/concurrency
work, and use Hydrogen or Sonnet for mechanical UI edits.

---

## 7. Configuration

`orc.config.json`:

```json
{
  "port": 4317,
  "projects": [
    {
      "id": "my-app",
      "name": "my-app",
      "path": "C:\\Users\\you\\code\\my-app",
      "baseBranch": "main",
      "testCommand": "npm test"
    }
  ]
}
```

- `data/orc.db` — SQLite (WAL) with tasks, events, runs.
- `data/logs/` — raw JSONL from each CLI run.
- `STATUS.md` — generated root summary (gitignored).
- `<project>/docs/board.md` — generated project board.

For tests or a second instance, override `ORC_CONFIG` and `ORC_DATA_DIR`.

The server binds `127.0.0.1` only. There is no authentication. Do not expose the port.

---

## 8. HTTP API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/state` | projects, tasks, health, running ids |
| GET | `/api/tasks/:id` | spec, review, diff, test log, events, runs |
| POST | `/api/tasks` | create task |
| POST | `/api/tasks/:id/run` | start pipeline (202) |
| POST | `/api/tasks/:id/stop` | kill active process |
| POST | `/api/tasks/:id/state` | manual state move |
| POST | `/api/tasks/:id/block` | mark blocked with note |
| POST | `/api/tasks/:id/spec` | save spec (Inbox → Ready) |
| POST | `/api/tasks/:id/open` | open worktree/spec/project |
| POST | `/api/projects` | register + scaffold project |
| GET | `/api/events` | SSE: `task-event`, `refresh`, `hello` |

SSE is the live channel; the UI also polls every 30 seconds as a safety net.

---

## 9. Repository map

```
bin/orc.js          entry point
src/cli.js          commands and doctor
src/config.js       project registry, config, scaffolding
src/db.js           node:sqlite schema
src/board.js        tasks, states, specs, generated board/status
src/agents.js       Claude + Antigravity CLI adapters, stream parsing
src/dispatch.js     state machine, worktrees, prompts, diff, review, tests
src/server.js       HTTP API, SSE, static UI
src/open.js         Explorer/file reveal
public/             dashboard (vanilla JS, no build)
templates/          files copied into managed projects
scripts/check.mjs   syntax + required-file check
test/               unit tests (`node --test`) and stream fixtures
docs/decisions/     ADRs for ORC itself
```

---

## 10. Testing

```powershell
node scripts/check.mjs   # syntax + required files
node --test              # offline unit tests (verdict, states, git, stream parsers)
node scripts/smoke.mjs   # fake CLIs, real git, real HTTP/SSE plumbing
```

The unit suite (`node --test`) runs offline with no network and no vendor CLIs, using
temporary `ORC_CONFIG` and `ORC_DATA_DIR` paths. The smoke test creates a temporary git
repo and fake `claude`/`agy` binaries on `PATH`. It runs a full task through implementation,
diff capture, review, tests, and `done`, then checks the branch, worktree, artifacts, and
API. On success it prints a temp path that is safe to delete.

## 11. Auth and terms
- Install Claude Code, run `claude` once, complete login. ORC reuses the cached login.
- Install Antigravity CLI, run `agy` once, complete login. Headless runs use cached
  credentials; without them `agy` exits with an authentication error.
- Each vendor enforces its own quota and terms. ORC does not circumvent either.
- Antigravity implementation defaults to `--mode accept-edits` **without**
  `--dangerously-skip-permissions`. Prefer scoped `permissions.allow` rules in
  `~/.gemini/antigravity-cli/settings.json`. Only set `ORC_AGY_YOLO=1` in trusted
  repositories if headless tool approval stalls. Remember the worktree limits file scope,
  not shell scope.
- Claude headless implements with `--permission-mode acceptEdits` and
  `--allowedTools "Read,Edit,Write,Bash"`. Reviews run with `--permission-mode plan`
  and read-only tools (`Read,Grep,Glob,Bash`).

---

## 12. Known gaps

- End-to-end agent execution is **untested with the real CLIs**: neither `claude` nor
  `agy` is installed on this machine. Unit tests and the fake-CLI smoke test pass.
- Antigravity `stream-json` parsing covers `init` / `step_update` / `result` envelopes,
  but has not been exercised against a real `agy`.
- No merge, push, or pull-request automation. Branches stay for manual review.
- No authentication; localhost only.
- One process per task, but no global concurrency limit.
- The dashboard shows raw markdown; it does not render it.
- Review verdicts are parsed from text; a missing verdict blocks the task.
- Windows-first process killing (`taskkill /T /F`); POSIX uses process groups.
- Model defaults come from the CLIs unless the environment variables above are set.

---

## 13. Next steps

1. Install `claude` and `agy`, authenticate, run `node bin/orc.js doctor`.
2. Run one throwaway task in a scratch git repo and verify the real stream formats and scoped `agy` permissions.
3. Add a merge command (`orc merge`) that rebases the task branch and removes the worktree.
4. Add a global concurrency limit, per-project lock, and stale worktree recovery.
5. Add model selection to the UI (per project and per role).
