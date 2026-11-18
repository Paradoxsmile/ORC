# ADR-0002: Local Rebase Merge, Artifact Archival, and Concurrency Guardrails

- Date: 2026-11-18
- Status: accepted

## Context

ORC isolates every task in its own git worktree (`<project>/.worktrees/<taskId>`) on a
dedicated branch (`task/<taskId>-<slug>`). Without explicit merge cleanup, worktrees and
task branches accumulate, and deleting a worktree deletes `<worktree>/.orc/<taskId>/`
(diff, review, test log) unless ORC archives those artifacts.

At the same time, running multiple tasks concurrently against the same repository can
corrupt shared state (`docs/board.md`, git refs, or working-tree-wide test commands), and
restarting ORC after an unexpected exit can leave worktree directories unlinked or stuck
in in-flight states.

## Decision

1. **Explicit local merge (`orc merge <taskId>` / `POST /api/tasks/:id/merge`)**:
   - ORC never pushes branches, opens PRs, or auto-merges after `done`. Merging remains
     an explicit human-triggered step.
   - Before rebasing, ORC verifies that no run is active on the project, the main
     worktree is on `baseBranch`, and neither worktree has uncommitted tracked changes
     (ignoring ORC-generated `docs/board.md`).
   - `.orc/<taskId>/` is archived to `<project>/.orc/<taskId>/` (gitignored) before
     removing `<worktree>/.orc` and running `git rebase <baseBranch>` in the task
     worktree. On conflict, ORC runs `git rebase --abort`, restores `.orc/<taskId>/`,
     records `merge.refused`, and exits cleanly without mutating `baseBranch`.
   - On clean rebase, ORC fast-forwards `baseBranch` (`git merge --ff-only`), removes the
     worktree and task branch, clears `task.worktree`, records `task.merged`, and marks
     the task `done`. `getTaskDetail` falls back to `<project>/.orc/<taskId>/` so merged
     tasks retain their diff, review, and test logs.

2. **Concurrency locks**:
   - At most one active run is permitted per project at a time (`activeTaskForProject`).
   - Global active runs are capped by `ORC_MAX_CONCURRENCY` (or `maxConcurrency` in
     `orc.config.json`, defaulting to `2`).
   - Refused launches record an explicit `run.refused` event and return HTTP `409`.

3. **Startup & doctor worktree recovery (`recoverWorktrees`)**:
   - At server startup and during `orc doctor`, ORC scans `<project>/.worktrees/` across
     registered projects to reattach missing `task.worktree` links (`worktree.recovered`),
     flag in-flight tasks left without a running process (`worktree.stale`), and report
     unrecognized directories.

## Consequences

- Merging produces linear history on `baseBranch` without silent conflict resolution or
  accidental remote pushes.
- Task artifacts remain inspectable in the dashboard even after worktrees are deleted.
- Two tasks in different projects may run concurrently up to `ORC_MAX_CONCURRENCY`, while
  two tasks in the same project never contend on git refs or test suites simultaneously.
