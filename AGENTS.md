# ORC — mission control

Local orchestrator for Claude Code and Google Antigravity. It owns the task board,
spec files, git worktrees, and the review loop. It never calls model APIs; it drives
the official CLIs in headless mode, so each vendor keeps its own auth and quota.

## Commands
- `node bin/orc.js serve` — dashboard at http://127.0.0.1:4317
- `node bin/orc.js doctor` — check CLIs, git, and registered projects
- `node bin/orc.js add <project> "<title>" --desc "..." --accept "- ..."`
- `node bin/orc.js run <taskId>`
- `npm run check` — syntax check every JS file

## Map
- `src/cli.js` — commands
- `src/server.js` — local HTTP API, SSE, static UI
- `src/board.js` — tasks, specs, state, generated board
- `src/dispatch.js` — state machine, worktrees, prompts, verification
- `src/agents.js` — Claude/Antigravity CLI adapters and event normalization
- `public/` — dashboard, vanilla JS, no build step
- `templates/` — files copied into managed projects by `orc init`

## Rules
- Never proxy model APIs or store OAuth tokens. Each CLI owns its own auth.
- Work happens in git worktrees; one agent per worktree.
- Bind the server to 127.0.0.1 only. There is no auth.
- `node:sqlite` is the only persistence. No ORM.
- The UI is vanilla JS. Do not add a build step without a strong reason.
