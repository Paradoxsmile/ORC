# Changelog

All notable changes to ORC are documented in this file.

## [0.4.0] - 2026-11-20

### Added
- **Smart diff filtering & tail-trimmed fix loops (#6):** `captureWork` excludes lockfiles and minified assets (`diffIgnore`, defaulting to `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `*.lock`, `*.min.js`, `*.min.css`) from `diff.patch` while prepending `git diff --stat` and still committing tracked changes. Fix-loop prompts now preserve `review.md` and take the **tail** of `test.log` so assertion failures are never truncated away.
- **Tiered model routing & compact agent-to-agent handoffs:** Tasks support `--tier low|med|high` (`ORC_<AGENT>_<TIER>_MODEL` + `orc.config.json` `tiers` table, with a built-in `claude`/`low` → `sonnet` plan-saver while reviewers default to `high` tier). Agent-to-agent prompts and review output schemas use terse structured notation (`FILE:LINE|SEV|ISSUE|FIX`, `CHANGED:`, `RAN:`) by default (`ORC_COMPACT_HANDOFF=0` to disable).
- **Token/cost telemetry & quota guardrails (#4):** SQLite `runs` schema migrates cleanly to record `model`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `thinking_tokens`, and `cost_usd` per run; surfaced in the dashboard task drawer, cards, and `orc status`. Optional `ORC_PAUSE_ON_UTILIZATION` pauses new/queued runs when a vendor's utilization reaches the threshold.
- **Per-project task queue & `--depends-on` (#5):** Added `queued` state, `orc queue <taskId>` / `POST /api/tasks/:id/queue`, and `--depends-on T-XXXX` task chaining with automatic queue drain on `done` and `queue.halted` stops when an upstream dependency blocks.
- **Read-only Research Mode (#2):** Added `orc research <project> "<question>" [--agents claude,agy]` (and Research type in the dashboard) running read-only in `plan` mode with no worktrees or git commits, saving Obsidian notes under `docs/research/` and a condensed executive `brief.md`.
- **Optional OpenAI Codex CLI adapter (#3):** Added `codex` detection, `codex exec --json` argument builder (`--sandbox read-only` for plan/review, `--sandbox workspace-write --full-auto` for impl, `ORC_CODEX_YOLO=1` opt-in), JSONL stream parser + fixture (`test/fixtures/codex-stream.jsonl`), and `--agent codex` / `reviewer: codex` support.
- **Verify-before-review pipeline (#1):** Test gate runs immediately after implementation so broken tests enter fix loops without burning reviewer tokens.

## [0.3.0] - 2026-11-19

### Added
- **Dashboard UI upgrades:** colorized unified diff viewer with summary stats (`Colorized`/`Raw` toggle), rendered Markdown viewer for specs and reviews with highlighted `VERDICT` pills (`Preview`/`Edit` & `Rendered`/`Raw` toggles), clickable CLI health/setup modal, active runtime model/reviewer display, and `agent.rate_limit` warning banners.
- **Project settings & cleanup:** live per-project settings UI and `POST /api/projects/:id` for `baseBranch`, `testCommand`, `setupCommand`, `reviewer`, `implModel`, and `reviewModel`; `orc project remove` (`POST /api/projects/:id/remove`) and `orc delete <taskId> [--clean]` (`POST /api/tasks/:id/delete`).
- **Large-repo guardrails:** per-project `setupCommand` hook when creating a new worktree (saved to `.orc/<taskId>/setup.log`), plus a configurable staged-file size guard (`ORC_MAX_FILE_BYTES`, default 5 MiB) in `captureWork`.
- **Portable skill & global CLI installer:** `skills/orc-orchestrator/SKILL.md` for pairing interactive Architect sessions + Obsidian `docs/` memory with ORC, plus `node scripts/install-skill.mjs` (`orc install`) to install global `orc` / `orc.cmd` launchers and skills.
- **Open-source readiness:** MIT `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`, GitHub Actions CI matrix (Ubuntu, Windows, macOS), `docs/best-practices.md`, `docs/troubleshooting.md`, and gitignored local `orc.config.json` with tracked `orc.config.example.json`.

## [0.2.0] - 2026-11-18

### Added
- Hardened Antigravity permissions (`ORC_AGY_YOLO=1` opt-in instead of unconditional `--dangerously-skip-permissions`).
- `orc merge <taskId>` and `POST /api/tasks/:id/merge` with dirty-tree checks, conflict-safe rebase abort, `.orc/<taskId>/` archival, and worktree/branch cleanup.
- Per-project active-run locks, `ORC_MAX_CONCURRENCY`, and startup/`orc doctor` stale worktree recovery (`recoverWorktrees`).
- Real-CLI headless probe tool (`scripts/probe.mjs`), verified against `claude` (`2.1.327`) and `agy` (`1.5.11`).
- Offline `node:test` suite (`test/orc.test.mjs`) with JSONL fixtures, short pointer prompts for Windows `cmd.exe` limits, PID-aware run reaping, event coalescing, and `ORC_REVIEWER` overrides.

## [0.1.0] - 2026-11-18

### Added
- Initial ORC mission-control scaffold: SQLite task/event/run board, git worktree dispatch pipeline, Claude Code + Google Antigravity adapters, vanilla JS dashboard with SSE, and fake-CLI smoke test.
