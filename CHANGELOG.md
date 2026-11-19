# Changelog

All notable changes to ORC are documented in this file.

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
