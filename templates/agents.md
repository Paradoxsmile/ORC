# {{PROJECT_NAME}}

One sentence: what this is, who it's for.

## Stack
- Language/framework:
- Package manager:
- Database:
- Deploy:

## Commands
- Install: `...`
- Dev: `...`
- Test: `...`
- Single test: `...`
- Lint/format: `...`
- Build: `...`

## Map
- `src/` — application code
- `docs/` — knowledge base; start at `docs/index.md`
- `scripts/` — repo automation

## Rules
- Never edit generated files: ...
- Never commit secrets; add new vars to `.env.example`.
- Behavior change = test change.
- One branch/worktree per task; no direct commits to `main`.
- Read the relevant ADR before changing an architectural boundary.

## Context protocol
1. Read this file, then `docs/index.md`.
2. Open only the spec/ADR/area note linked for the task.
3. Search before asking; don't scan the repo blindly.
4. If a decision isn't written down, write an ADR before coding.
5. Keep the spec updated as you go — it is the handoff.

## Definition of done
- Acceptance criteria met, tests pass, lint passes.
- Spec status set to `review`, then `done` after merge.
- Review findings addressed.
