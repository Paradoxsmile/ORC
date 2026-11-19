# Security Policy

## Threat Model & Boundaries

ORC is designed strictly as a **single-user, local-only** orchestrator:

- **Loopback-only HTTP server:** `orc serve` binds exclusively to `127.0.0.1`. There is
  no authentication, session cookie, or multi-tenant isolation. **Never** expose the ORC
  port to a public interface, LAN, or reverse proxy without adding external authentication.
- **Zero credential handling:** ORC never stores API keys, OAuth tokens, or cookies, and
  never proxies model traffic. All authentication belongs to the official `claude` and
  `agy` CLIs.
- **Worktrees isolate files, not shells:** Each task executes inside an isolated Git
  worktree (`.worktrees/<taskId>`), but spawned CLI agents and `testCommand` /
  `setupCommand` hooks run with your OS user permissions. Only run ORC against
  repositories and specs you trust.
- **Antigravity headless permissions (`ORC_AGY_YOLO`):** By default, ORC invokes `agy`
  with `--mode accept-edits` and **without** `--dangerously-skip-permissions`. Configure
  scoped `permissions.allow` rules in `~/.gemini/antigravity-cli/settings.json` instead
  of enabling `ORC_AGY_YOLO=1`. Only set `ORC_AGY_YOLO=1` in trusted local repositories.

## Reporting a Vulnerability

If you discover a security issue in ORC (for example, path traversal in static asset
serving, command injection in CLI/git wrappers, or unintended network exposure), please
open a **GitHub Security Advisory** (private vulnerability report) rather than filing a
public issue with exploit details.
