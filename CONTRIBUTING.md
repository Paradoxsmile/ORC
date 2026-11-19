# Contributing to ORC

Thank you for your interest in contributing to ORC.

## Architectural Rules

Please read [AGENTS.md](AGENTS.md) and [docs/decisions/](docs/decisions/) before opening a
pull request:

1. **Zero npm dependencies.** Use Node.js built-ins only (`node:sqlite`, `node:http`,
   `node:test`, `node:child_process`, `node:fs`).
2. **Never call model APIs or store OAuth tokens.** ORC spawns the official `claude` and
   `agy` CLIs headlessly and parses their output.
3. **Vanilla JS dashboard.** No React, TypeScript, bundler, or frontend build step.
4. **Loopback-only server.** Keep `server.listen(port, "127.0.0.1")`.
5. **One task = one branch = one worktree = one active run per project.**
6. **No auto-push or PR creation.** Merging (`orc merge`) stays strictly local.

## Verification Checklist

Run all checks before submitting a pull request:

```sh
node scripts/check.mjs   # syntax, required paths, privacy check
node --test              # offline unit tests
node scripts/smoke.mjs   # fake-CLI + real git + HTTP smoke test
```

If you change CLI flags, stream parsing, config keys, or state machine behavior:
- Update [README.md](README.md) (and [docs/best-practices.md](docs/best-practices.md) if relevant).
- Add unit tests in [test/orc.test.mjs](test/orc.test.mjs).
- Add an ADR under `docs/decisions/` for significant architectural changes.
