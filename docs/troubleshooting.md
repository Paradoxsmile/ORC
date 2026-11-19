# Troubleshooting

## 1. `Error: Cannot find module '.../bin/orc.js'` when running from another folder

You ran `node bin/orc.js serve` outside the ORC directory. Either:
1. Run `node scripts/install-skill.mjs` inside the ORC repo once so `orc` is installed globally in `~/.local/bin`, then run `orc serve` or `orc doctor` from **any** folder; or
2. `cd` into the ORC repository first, or pass the full path `node /path/to/ORC/bin/orc.js serve`.

---

## 2. `<project> is not a git repository`

ORC requires a Git repository with at least one commit on `baseBranch` (default `main`) before creating task worktrees:

```sh
cd /path/to/your/project
git init -b main
git add -A
git commit -m "chore: initial commit"
```

Then move the blocked task back to **Ready** (`specced`) and run it again.

---

## 3. Antigravity finishes with `denied headless permission` or no tracked edits

By default, ORC disables `--dangerously-skip-permissions` for safety. If `agy` tries to run a shell command or edit files without an allow-rule, headless mode auto-denies it (`denied_actions`).

**Fix (choose one):**
- **Recommended:** Add scoped `permissions.allow` rules in `~/.gemini/antigravity-cli/settings.json`.
- **Trusted local repos only:** Set `$env:ORC_AGY_YOLO = "1"` (PowerShell) or `export ORC_AGY_YOLO=1` (bash/zsh) before starting `orc serve` or `orc run`.

---

## 4. `npm` blocked on Windows PowerShell (`npm.ps1 cannot be loaded`)

Windows ExecutionPolicy sometimes blocks `npm.ps1`. Run Node scripts directly instead:

```powershell
node bin/orc.js serve
node scripts/check.mjs
node --test
node scripts/smoke.mjs
```

---

## 5. Uploading `orc-orchestrator.zip` to Claude Desktop fails with `Zip file contains path with invalid characters`

PowerShell's `Compress-Archive` encodes zip entries with backslashes (`\`), which the Claude Desktop plugin/skill uploader rejects.

**Fix:** Upload [skills/orc-orchestrator/SKILL.md](../skills/orc-orchestrator/SKILL.md) directly in the Claude Desktop dialog (it accepts `.md` files), or zip with `tar.exe -a -c -f`:

```powershell
tar.exe -a -c -f "$env:USERPROFILE\Desktop\orc-orchestrator.zip" -C skills orc-orchestrator
```

Note also that **Claude Code** reads `~/.claude/skills/<name>/SKILL.md` directly (run `node scripts/install-skill.mjs`), while **Claude Desktop Chat** uses uploaded skills via **Customize → Skills**.

---

## 6. `orc merge` refuses with `Main worktree has uncommitted changes`

`orc merge` requires a clean main worktree on `baseBranch` before rebasing and fast-forwarding (it ignores ORC-generated `docs/board.md`). Commit or stash your edits in the main repo checkout, then run `orc merge <taskId>` again.

If `git rebase` hits merge conflicts, ORC automatically runs `git rebase --abort` and keeps your worktree intact so you can resolve conflicts manually inside `.worktrees/<taskId>`.

---

## 7. `Refused to commit oversized file(s)`

`captureWork` blocks any new or modified file larger than `ORC_MAX_FILE_BYTES` (default `5242880` = 5 MiB) so binaries, build outputs, or telemetry dumps are never committed to task branches. Add generated folders/extensions to `.gitignore`, remove the file from the worktree, or raise `ORC_MAX_FILE_BYTES` if intentional.

---

## 8. `Port 4317 is already in use` or CLI status dots stay gray after installing CLIs

Another `orc serve` process is still running (possibly started before you installed `claude`/`agy`). Stop the existing process (`Ctrl+C` or close that terminal) and start a fresh `orc serve`, or pass `--port 4318`.
