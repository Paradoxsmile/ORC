# ADR-0001: Orchestrate official CLIs; never proxy model APIs

- Date: 2026-11-18
- Status: accepted

## Context

We use Claude Code and Google Antigravity through separate consumer subscriptions
(Claude Pro, Google AI Pro). Both keep their own login, quota, and terms. A custom
client that called model APIs would centralize auth and likely violate those terms,
while a shared model session would blur the two products and force us to maintain a
model integration we do not control.

We still need one place to see all projects, define work, hand it to either agent,
review the result, and decide what needs a human.

## Decision

ORC is a **meta-orchestrator over work artifacts and processes**, not a model client.

- It spawns the official `claude` and `agy` CLIs in headless mode.
- It never calls a model API, never stores OAuth tokens, and never proxies traffic.
- It owns the task board, spec files, git worktrees, prompts, diff capture, review
  verdicts, test logs, and process lifecycle.
- Each CLI keeps its own auth and quota. Either side can be swapped without changing
  the board.
- Work is isolated: one task, one branch, one worktree, one agent at a time.
- The implementation agent is told not to commit; ORC commits to the task branch,
  captures a cumulative diff, and asks the other CLI to review that diff.
- The review is machine-readable: `VERDICT: APPROVE` or
  `VERDICT: REQUEST CHANGES`, with a maximum of two fix loops before a human decides.

## Consequences

Easier:

- No vendor API integration, token storage, or quota pooling.
- Each vendor's auth, model selector, and terms remain intact.
- The board survives model changes and CLI upgrades.
- Specs and review artifacts stay useful even without either CLI.
- Swapping implementer/reviewer is a task flag, not a rewrite.

Harder:

- We depend on headless CLI flags and stream formats, which can change.
- The two CLIs do not share context; the spec and diff are the interface.
- Headless permissions need explicit configuration, especially for Antigravity.
- We cannot programmatically guarantee quota availability; start-up failures become
  blocked tasks.
- ORC must handle stale worktrees, interrupted runs, and partial commits.

Explicitly not doing:

- No model API proxy.
- No OAuth token store.
- No shared conversation between Claude and Antigravity.
- No automatic merge, push, or PR creation.
- No multi-agent parallel execution inside one task.
