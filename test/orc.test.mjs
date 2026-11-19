import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const FIXTURES_DIR = path.join(ROOT, "test", "fixtures");
const STATUS_PATH = path.join(ROOT, "STATUS.md");
const PREVIOUS_STATUS = existsSync(STATUS_PATH) ? readFileSync(STATUS_PATH, "utf8") : null;

const tempDir = mkdtempSync(path.join(os.tmpdir(), "orc-unit-"));
process.env.ORC_CONFIG = path.join(tempDir, "orc.config.json");
process.env.ORC_DATA_DIR = path.join(tempDir, "data");

const { buildArgs, consumeLine, createStreamState, quoteCmd } = await import("../src/agents.js");
const { addProject, updateProject } = await import("../src/config.js");
const { db, isPidAlive, reapDeadRuns } = await import("../src/db.js");
const { createTask, failTask, getTask, getTaskDetail, saveSpec, setState, updateTask } =
  await import("../src/board.js");
const {
  captureWork,
  checkConcurrency,
  createEventCoalescer,
  effortFor,
  maxTrackedFileBytes,
  mergeTask,
  modelFor,
  parseVerdict,
  recoverWorktrees,
  removeTask,
  reviewerFor,
  taskRuntimeInfo,
  unregisterProject,
  yoloFor,
} = await import("../src/dispatch.js");
const { installOrc } = await import("../scripts/install-skill.mjs");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

function withEnv(overrides, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined;
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

after(() => {
  try {
    db.close();
  } catch {
    // Ignore if already closed.
  }
  if (PREVIOUS_STATUS !== null) {
    writeFileSync(STATUS_PATH, PREVIOUS_STATUS, "utf8");
  } else if (existsSync(STATUS_PATH)) {
    rmSync(STATUS_PATH, { force: true });
  }
  rmSync(tempDir, { recursive: true, force: true });
});

describe("parseVerdict", () => {
  it("parses plain VERDICT lines", () => {
    assert.equal(parseVerdict("Looks great.\n\nVERDICT: APPROVE\n"), "approve");
    assert.equal(parseVerdict("Missing tests.\n\nVERDICT: REQUEST CHANGES"), "request_changes");
  });

  it("tolerates markdown emphasis and code wrappers on the verdict line", () => {
    assert.equal(parseVerdict("**VERDICT: APPROVE**"), "approve");
    assert.equal(parseVerdict("`VERDICT: REQUEST CHANGES`."), "request_changes");
  });

  it("ignores inline prose mentions and uses the final verdict line", () => {
    assert.equal(parseVerdict("Cannot give VERDICT: APPROVE while failing."), null);
    assert.equal(
      parseVerdict("Not VERDICT: APPROVE\nFound a regression.\nVERDICT: REQUEST CHANGES"),
      "request_changes",
    );
  });

  it("returns null when no verdict is present", () => {
    assert.equal(parseVerdict(""), null);
    assert.equal(parseVerdict(null), null);
    assert.equal(parseVerdict("Review complete with no verdict line."), null);
  });
});

describe("adapter permissions, effort, and CLI args", () => {
  it("omits --dangerously-skip-permissions by default for Antigravity implementation", () => {
    withEnv({ ORC_AGY_YOLO: undefined }, () => {
      assert.equal(yoloFor("agy", "impl"), false);
      const args = buildArgs("agy", "Implement task", {
        mode: "accept-edits",
        yolo: yoloFor("agy", "impl"),
      });
      assert.ok(args.includes("--mode"));
      assert.equal(args[args.indexOf("--mode") + 1], "accept-edits");
      assert.ok(!args.includes("--dangerously-skip-permissions"));
    });
  });

  it("passes --dangerously-skip-permissions only when ORC_AGY_YOLO=1 on agy impl", () => {
    withEnv({ ORC_AGY_YOLO: "1" }, () => {
      assert.equal(yoloFor("agy", "impl"), true);
      assert.equal(yoloFor("agy", "review"), false);
      assert.equal(yoloFor("claude", "impl"), false);
      const args = buildArgs("agy", "Implement task", {
        mode: "accept-edits",
        yolo: yoloFor("agy", "impl"),
      });
      assert.ok(args.includes("--dangerously-skip-permissions"));
    });
  });

  it("omits effort for Orchestrator slugs and honors ORC_AGY_EFFORT for standalone slugs", () => {
    withEnv(
      {
        ORC_AGY_MODEL: undefined,
        ORC_AGY_IMPL_MODEL: "gemini-pro-orchestrator-argon",
        ORC_AGY_EFFORT: "high",
      },
      () => {
        assert.equal(effortFor("agy", "impl"), null);
      },
    );

    withEnv(
      {
        ORC_AGY_MODEL: undefined,
        ORC_AGY_IMPL_MODEL: "gemini-4-argon-high",
        ORC_AGY_EFFORT: "high",
      },
      () => {
        assert.equal(effortFor("agy", "impl"), "high");
      },
    );
  });

  it("builds scoped Claude flags for implement and review", () => {
    const implArgs = buildArgs("claude", "Implement", { mode: null });
    assert.equal(implArgs[implArgs.indexOf("--permission-mode") + 1], "acceptEdits");
    assert.equal(implArgs[implArgs.indexOf("--allowedTools") + 1], "Read,Edit,Write,Bash");

    const reviewArgs = buildArgs("claude", "Review", { mode: "plan" });
    assert.equal(reviewArgs[reviewArgs.indexOf("--permission-mode") + 1], "plan");
    assert.equal(reviewArgs[reviewArgs.indexOf("--allowedTools") + 1], "Read,Grep,Glob,Bash");
  });
});

describe("board and task state transitions", () => {
  it("routes inbox vs specced creation, saveSpec, setState, and failTask", () => {
    const projectDir = path.join(tempDir, "board-repo");
    mkdirSync(projectDir, { recursive: true });
    const project = addProject({ name: "board-repo", projectPath: projectDir });

    const inboxTask = createTask({ projectId: project.id, title: "Title only task" });
    assert.equal(inboxTask.state, "inbox");
    assert.match(readFileSync(inboxTask.spec_path, "utf8"), /^status:\s*draft$/m);

    const speccedTask = createTask({
      projectId: project.id,
      title: "Specced task",
      description: "Needs implementation",
      acceptance: "- [ ] works",
    });
    assert.equal(speccedTask.state, "specced");
    assert.match(readFileSync(speccedTask.spec_path, "utf8"), /^status:\s*active$/m);

    const updatedDetail = saveSpec(inboxTask.id, "# Updated spec\n\nReady now.\n");
    assert.equal(updatedDetail.task.state, "specced");

    const sameDetail = saveSpec(speccedTask.id, "# Refined spec\n");
    assert.equal(sameDetail.task.state, "specced");

    const pathStates = ["working", "review", "fixing", "working", "review", "verify", "done"];
    for (const next of pathStates) {
      const moved = setState(speccedTask.id, next, { note: `to ${next}` });
      assert.equal(moved.state, next);
    }

    const detail = getTaskDetail(speccedTask.id);
    const stateEvents = detail.events.filter((event) => event.type === "state");
    assert.equal(stateEvents.length, pathStates.length);

    assert.throws(() => setState(speccedTask.id, "nonexistent"), /Unknown state/);

    const blocked = failTask(inboxTask.id, "Verifier timed out");
    assert.equal(blocked.state, "blocked");
    assert.equal(getTask(inboxTask.id).last_error, "Verifier timed out");
  });
});

describe("captureWork artifact exclusion", () => {
  it("commits tracked changes while excluding .orc/ artifacts and skipping no-op artifact edits", async () => {
    const worktree = path.join(tempDir, "capture-repo");
    mkdirSync(path.join(worktree, "src"), { recursive: true });
    writeFileSync(path.join(worktree, "README.md"), "# capture repo\n", "utf8");
    git(worktree, ["init", "-b", "main"]);
    git(worktree, ["config", "user.name", "Test User"]);
    git(worktree, ["config", "user.email", "test@example.invalid"]);
    git(worktree, ["add", "-A"]);
    git(worktree, ["commit", "-m", "initial"]);

    git(worktree, ["checkout", "-b", "task/T-0001-capture"]);
    const before = git(worktree, ["rev-parse", "HEAD"]);

    writeFileSync(path.join(worktree, "src", "feature.js"), "export const feature = 1;\n", "utf8");
    mkdirSync(path.join(worktree, ".orc", "T-0001"), { recursive: true });
    writeFileSync(path.join(worktree, ".orc", "T-0001", "spec.md"), "# Spec\n", "utf8");
    writeFileSync(path.join(worktree, ".orc", "T-0001", "prompt-implement.md"), "# Prompt\n", "utf8");

    const task = { id: "T-0001", title: "Capture feature" };
    const project = { baseBranch: "main" };

    const first = await captureWork(worktree, task, project, "implementation", before);
    assert.notEqual(first.head, before);
    assert.match(first.patch, /src\/feature\.js/);
    assert.doesNotMatch(first.patch, /\.orc\//);

    const committedFiles = git(worktree, ["ls-tree", "-r", "HEAD", "--name-only"]);
    assert.match(committedFiles, /src\/feature\.js/);
    assert.doesNotMatch(committedFiles, /\.orc\//);

    writeFileSync(path.join(worktree, ".orc", "T-0001", "review.md"), "VERDICT: APPROVE\n", "utf8");
    const second = await captureWork(worktree, task, project, "fix", first.head);
    assert.equal(second.head, first.head);
  });
});

describe("stream-json parsers", () => {
  it("parses Claude stream-json fixture and error results", () => {
    const lines = readFileSync(path.join(FIXTURES_DIR, "claude-stream.jsonl"), "utf8")
      .trim()
      .split(/\r?\n/);
    const state = createStreamState();
    const events = [];

    for (const line of lines) {
      consumeLine("claude", line, state, (event) => events.push(event));
    }

    assert.equal(state.sessionId, "claude-sess-42");
    assert.deepEqual(
      events.map((event) => event.kind),
      ["init", "text", "tool", "tool_result", "text", "result"],
    );
    assert.equal(state.text, "Inspecting repository...\nApplied fix.\n");
    assert.equal(state.lastError, null);

    consumeLine(
      "claude",
      JSON.stringify({ type: "result", subtype: "error", is_error: true, error: "Quota exceeded" }),
      state,
      (event) => events.push(event),
    );
    assert.equal(state.lastError, "Quota exceeded");
    assert.equal(events.at(-1).kind, "stderr");

    consumeLine(
      "claude",
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.95 },
      }),
      state,
      (event) => events.push(event),
    );
    assert.equal(events.at(-1).kind, "rate_limit");
    assert.equal(events.at(-1).text, "allowed_warning · seven_day · 95%");
  });

  it("parses Antigravity stream-json fixture with suffix-diff deduplication and error results", () => {
    const lines = readFileSync(path.join(FIXTURES_DIR, "agy-stream.jsonl"), "utf8")
      .trim()
      .split(/\r?\n/);
    const state = createStreamState();
    const events = [];

    for (const line of lines) {
      consumeLine("agy", line, state, (event) => events.push(event));
    }

    assert.equal(state.sessionId, "agy-conv-99");

    const streamedText = events
      .filter((event) => event.kind === "text")
      .map((event) => event.text)
      .join("");
    assert.equal(streamedText, "Checking acceptance criteria.\nAll criteria met.\n\nVERDICT: APPROVE\n");

    const toolEvent = events.find((event) => event.kind === "tool");
    const toolResultEvent = events.find((event) => event.kind === "tool_result");
    assert.equal(toolEvent?.text, "read_file");
    assert.equal(toolResultEvent?.text, "export const ok = true;");

    assert.equal(state.text, "Checking acceptance criteria.\nAll criteria met.\n\nVERDICT: APPROVE\n");
    assert.equal(state.lastError, null);

    consumeLine(
      "agy",
      JSON.stringify({
        event: "result",
        result: { status: "FAILED", error: "Unknown model slug" },
      }),
      state,
      (event) => events.push(event),
    );
    assert.equal(state.lastError, "Unknown model slug");
    assert.equal(events.at(-1).kind, "stderr");

    const deniedState = createStreamState();
    const deniedEvents = [];
    consumeLine(
      "agy",
      JSON.stringify({
        event: "result",
        result: {
          status: "SUCCESS",
          response: "",
          denied_actions: [{ action: "command", display_name: "Bash" }],
        },
      }),
      deniedState,
      (event) => deniedEvents.push(event),
    );
    assert.match(deniedState.lastError, /denied headless permission \(Bash\)/);
    assert.equal(deniedEvents.at(-1).kind, "stderr");
  });
});

describe("mergeTask", () => {
  it("refuses dirty main or rebase conflicts and cleanly rebases, merges, archives, and cleans up", async () => {
    const mergeRepo = path.join(tempDir, "merge-repo");
    mkdirSync(mergeRepo, { recursive: true });
    writeFileSync(path.join(mergeRepo, ".gitignore"), ".worktrees/\n.orc/\n", "utf8");
    writeFileSync(path.join(mergeRepo, "README.md"), "# merge repo\n", "utf8");
    writeFileSync(path.join(mergeRepo, "shared.txt"), "base\n", "utf8");
    git(mergeRepo, ["init", "-b", "main"]);
    git(mergeRepo, ["config", "user.name", "Test User"]);
    git(mergeRepo, ["config", "user.email", "test@example.invalid"]);
    git(mergeRepo, ["add", "-A"]);
    git(mergeRepo, ["commit", "-m", "initial"]);

    const project = addProject({ name: "merge-repo", projectPath: mergeRepo, baseBranch: "main" });

    // Task 1: dirty main + rebase conflict paths
    const task1 = createTask({
      projectId: project.id,
      title: "Conflicting task",
      description: "Changes shared.txt",
      acceptance: "- [ ] updated",
    });
    const wt1 = path.join(mergeRepo, ".worktrees", task1.id);
    git(mergeRepo, ["worktree", "add", "-b", task1.branch, wt1, "main"]);
    writeFileSync(path.join(wt1, "shared.txt"), "task1 change\n", "utf8");
    git(wt1, ["add", "shared.txt"]);
    git(wt1, ["commit", "-m", "task1 commit"]);
    mkdirSync(path.join(wt1, ".orc", task1.id), { recursive: true });
    writeFileSync(path.join(wt1, ".orc", task1.id, "review.md"), "VERDICT: APPROVE\n", "utf8");
    updateTask(task1.id, { worktree: wt1 });
    setState(task1.id, "done");

    // 1) Dirty main refusal
    writeFileSync(path.join(mergeRepo, "README.md"), "# dirty\n", "utf8");
    await assert.rejects(() => mergeTask(task1.id), /Main worktree has uncommitted changes/);
    git(mergeRepo, ["checkout", "--", "README.md"]);
    assert.ok(getTaskDetail(task1.id).events.some((event) => event.type === "merge.refused"));

    // 2) Rebase conflict refusal + clean abort
    writeFileSync(path.join(mergeRepo, "shared.txt"), "main conflict\n", "utf8");
    git(mergeRepo, ["add", "shared.txt"]);
    git(mergeRepo, ["commit", "-m", "conflicting main commit"]);

    await assert.rejects(() => mergeTask(task1.id), /failed with conflicts/);
    assert.equal(git(wt1, ["status", "--porcelain", "--untracked-files=no"]), "");
    assert.ok(existsSync(path.join(wt1, ".orc", task1.id, "review.md")));

    // 3) Successful rebase onto advanced main + fast-forward + cleanup + artifact archive
    const task2 = createTask({
      projectId: project.id,
      title: "Clean feature",
      description: "Adds extra.js",
      acceptance: "- [ ] extra.js exists",
    });
    const wt2 = path.join(mergeRepo, ".worktrees", task2.id);
    git(mergeRepo, ["worktree", "add", "-b", task2.branch, wt2, "main"]);
    writeFileSync(path.join(wt2, "extra.js"), "export const extra = true;\n", "utf8");
    git(wt2, ["add", "extra.js"]);
    git(wt2, ["commit", "-m", "task2 commit"]);
    mkdirSync(path.join(wt2, ".orc", task2.id), { recursive: true });
    writeFileSync(path.join(wt2, ".orc", task2.id, "review.md"), "VERDICT: APPROVE\n", "utf8");
    writeFileSync(path.join(wt2, ".orc", task2.id, "diff.patch"), "diff --git a/extra.js\n", "utf8");
    updateTask(task2.id, { worktree: wt2 });
    setState(task2.id, "verify");

    // Advance main with a non-conflicting commit so rebase is actually exercised
    writeFileSync(path.join(mergeRepo, "other.txt"), "ahead on main\n", "utf8");
    git(mergeRepo, ["add", "other.txt"]);
    git(mergeRepo, ["commit", "-m", "advance main"]);

    const merged = await mergeTask(task2.id);
    assert.equal(merged.state, "done");
    assert.equal(merged.worktree, null);
    assert.ok(existsSync(path.join(mergeRepo, "extra.js")));
    assert.ok(existsSync(path.join(mergeRepo, "other.txt")));
    assert.ok(!existsSync(wt2));
    assert.equal(git(mergeRepo, ["branch", "--list", task2.branch]), "");

    const detail = getTaskDetail(task2.id);
    assert.equal(detail.artifacts.reviewExists, true);
    assert.equal(detail.artifacts.diffExists, true);
    assert.ok(detail.events.some((event) => event.type === "task.merged"));
  });
});

describe("concurrency and worktree recovery", () => {
  it("enforces per-project lock and global concurrency limit with run.refused events", () => {
    const dirA = path.join(tempDir, "conc-a");
    const dirB = path.join(tempDir, "conc-b");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    const projA = addProject({ name: "conc-a", projectPath: dirA });
    const projB = addProject({ name: "conc-b", projectPath: dirB });

    const a1 = createTask({ projectId: projA.id, title: "A1", description: "first" });
    const a2 = createTask({ projectId: projA.id, title: "A2", description: "second" });
    const b1 = createTask({ projectId: projB.id, title: "B1", description: "other" });

    const active = new Map([[a1.id, { taskId: a1.id, projectId: projA.id }]]);

    assert.throws(() => checkConcurrency(a2, projA, active), /already has an active run/);
    const a2Events = getTaskDetail(a2.id).events;
    assert.ok(a2Events.some((event) => event.type === "run.refused"));

    withEnv({ ORC_MAX_CONCURRENCY: "1" }, () => {
      assert.throws(() => checkConcurrency(b1, projB, active), /global concurrency limit \(1\) reached/);
      const b1Events = getTaskDetail(b1.id).events;
      assert.ok(b1Events.some((event) => event.type === "run.refused"));
    });

    withEnv({ ORC_MAX_CONCURRENCY: "2" }, () => {
      assert.doesNotThrow(() => checkConcurrency(b1, projB, active));
    });
  });

  it("reattaches unlinked worktrees, flags stale in-flight tasks, and reports orphans", () => {
    const recDir = path.join(tempDir, "recover-repo");
    mkdirSync(recDir, { recursive: true });
    const proj = addProject({ name: "recover-repo", projectPath: recDir });

    const staleTask = createTask({ projectId: proj.id, title: "Stale task", description: "interrupted" });
    setState(staleTask.id, "working");

    const staleWt = path.join(recDir, ".worktrees", staleTask.id);
    const orphanWt = path.join(recDir, ".worktrees", "T-9999");
    mkdirSync(staleWt, { recursive: true });
    mkdirSync(orphanWt, { recursive: true });

    const summary = recoverWorktrees();
    assert.ok(summary.relinked.some((item) => item.taskId === staleTask.id));
    assert.ok(summary.staleTasks.some((item) => item.taskId === staleTask.id));
    assert.ok(summary.orphaned.some((item) => item.worktree === orphanWt));

    assert.equal(getTask(staleTask.id).worktree, staleWt);
    const events = getTaskDetail(staleTask.id).events;
    assert.ok(events.some((event) => event.type === "worktree.recovered"));
    assert.ok(events.some((event) => event.type === "worktree.stale"));
  });
});

describe("hardening: cmd quoting, PID reaping, event coalescing, reviewer fallback", () => {
  it("escapes %VAR% and newlines in quoteCmd", () => {
    assert.equal(quoteCmd("line1\nline2 %PATH%"), '"line1 line2 %%PATH%%"');
  });

  it("reaps only dead PIDs in reapDeadRuns and preserves live PIDs", () => {
    assert.equal(isPidAlive(process.pid), true);
    db.prepare(
      "INSERT INTO runs (id, task_id, agent, step, pid, status, started_at) VALUES (?, ?, ?, ?, ?, 'running', ?)",
    ).run("R-live", "T-0001", "claude", "implementation", process.pid, "2026-11-18T00:00:00.000Z");
    db.prepare(
      "INSERT INTO runs (id, task_id, agent, step, pid, status, started_at) VALUES (?, ?, ?, ?, ?, 'running', ?)",
    ).run("R-dead", "T-0001", "claude", "implementation", 99999999, "2026-11-18T00:00:00.000Z");

    const reaped = reapDeadRuns();
    assert.ok(reaped.includes("R-dead"));
    assert.ok(!reaped.includes("R-live"));

    const liveRow = db.prepare("SELECT status FROM runs WHERE id = 'R-live'").get();
    const deadRow = db.prepare("SELECT status FROM runs WHERE id = 'R-dead'").get();
    assert.equal(liveRow.status, "running");
    assert.equal(deadRow.status, "interrupted");

    db.prepare("DELETE FROM runs WHERE id IN ('R-live', 'R-dead')").run();
  });

  it("coalesces consecutive agent text deltas and flushes before tool events", () => {
    const emitted = [];
    const coalescer = createEventCoalescer("T-0001", "R-1", "claude", {
      flushMs: 5000,
      maxChars: 1000,
      emit: (_taskId, _runId, _agent, event) => emitted.push(event),
    });

    coalescer.push({ kind: "text", text: "Hello " });
    coalescer.push({ kind: "text", text: "world" });
    coalescer.push({ kind: "tool", text: "Read" });
    coalescer.push({ kind: "text", text: "Done." });
    coalescer.flush();

    assert.deepEqual(emitted, [
      { kind: "text", text: "Hello world" },
      { kind: "tool", text: "Read" },
      { kind: "text", text: "Done." },
    ]);
  });

  it("supports ORC_REVIEWER overrides and single-CLI auto fallback", () => {
    assert.equal(reviewerFor("claude", { env: {} }), "agy");
    assert.equal(reviewerFor("agy", { env: {} }), "claude");
    assert.equal(reviewerFor("claude", { env: { ORC_REVIEWER: "same" } }), "claude");
    assert.equal(reviewerFor("claude", { env: { ORC_REVIEWER: "claude" } }), "claude");
    assert.equal(
      reviewerFor("claude", {
        env: { ORC_REVIEWER: "auto" },
        health: { claude: { available: true }, agy: { available: false } },
      }),
      "claude",
    );
    assert.equal(
      reviewerFor("claude", {
        env: { ORC_REVIEWER: "auto" },
        health: { claude: { available: true }, agy: { available: true } },
      }),
      "agy",
    );
  });

  it("applies per-project model/reviewer overrides and updateProject", () => {
    const dir = path.join(tempDir, "proj-settings");
    mkdirSync(dir, { recursive: true });
    const proj = addProject({ name: "proj-settings", projectPath: dir });
    const updated = updateProject(proj.id, {
      setupCommand: "echo setup",
      reviewer: "same",
      implModel: "gemini-pro-orchestrator-argon",
      reviewModel: "gemini-4-argon-high",
    });

    assert.equal(updated.setupCommand, "echo setup");
    assert.equal(reviewerFor("agy", { env: {}, project: updated }), "agy");
    assert.equal(modelFor("agy", "impl", updated), "gemini-pro-orchestrator-argon");
    assert.equal(modelFor("agy", "review", updated), "gemini-4-argon-high");
    withEnv({ ORC_AGY_EFFORT: "high" }, () => {
      assert.equal(effortFor("agy", "impl", updated), null);
      assert.equal(effortFor("agy", "review", updated), "high");
    });
  });

  it("refuses oversized staged files in captureWork and unstages them cleanly", async () => {
    const bigRepo = path.join(tempDir, "big-file-repo");
    mkdirSync(bigRepo, { recursive: true });
    writeFileSync(path.join(bigRepo, "README.md"), "# big file test\n", "utf8");
    git(bigRepo, ["init", "-b", "main"]);
    git(bigRepo, ["config", "user.name", "Test User"]);
    git(bigRepo, ["config", "user.email", "test@example.invalid"]);
    git(bigRepo, ["add", "-A"]);
    git(bigRepo, ["commit", "-m", "initial"]);

    const before = git(bigRepo, ["rev-parse", "HEAD"]);
    writeFileSync(path.join(bigRepo, "dump.bin"), "x".repeat(2048), "utf8");

    const saved = process.env.ORC_MAX_FILE_BYTES;
    process.env.ORC_MAX_FILE_BYTES = "1024";
    try {
      assert.equal(maxTrackedFileBytes(), 1024);
      await assert.rejects(
        () =>
          captureWork(
            bigRepo,
            { id: "T-9001", title: "Big dump" },
            { baseBranch: "main" },
            "implementation",
            before,
          ),
        /Refused to commit oversized file/,
      );
      assert.equal(git(bigRepo, ["rev-parse", "HEAD"]), before);
      assert.equal(git(bigRepo, ["status", "--porcelain", "--untracked-files=no"]), "");
    } finally {
      if (saved === undefined) delete process.env.ORC_MAX_FILE_BYTES;
      else process.env.ORC_MAX_FILE_BYTES = saved;
    }
  });

  it("deletes tasks with worktree/artifact cleanup, unregisters projects with lock checks, and computes runtime info", async () => {
    const dir = path.join(tempDir, "cleanup-repo");
    mkdirSync(dir, { recursive: true });
    const proj = addProject({
      name: "cleanup-repo",
      projectPath: dir,
      reviewer: "same",
      implModel: "gemini-pro-orchestrator-argon",
      reviewModel: "gemini-4-argon-high",
    });

    const t = createTask({ projectId: proj.id, title: "Clean me", description: "temp task", agent: "agy" });
    const info = taskRuntimeInfo(t, proj);
    assert.equal(info.implementer, "agy");
    assert.equal(info.reviewer, "agy");
    assert.equal(info.implModel, "gemini-pro-orchestrator-argon");
    assert.equal(info.reviewModel, "gemini-4-argon-high");

    const fakeWt = path.join(dir, ".worktrees", t.id);
    const fakeArchive = path.join(dir, ".orc", t.id);
    mkdirSync(fakeWt, { recursive: true });
    mkdirSync(fakeArchive, { recursive: true });
    writeFileSync(path.join(fakeArchive, "review.md"), "ok\n", "utf8");
    const updatedTask = updateTask(t.id, { worktree: fakeWt });

    const active = new Map([[updatedTask.id, { taskId: updatedTask.id, projectId: proj.id }]]);
    await assert.rejects(() => removeTask(updatedTask.id, { cleanupWorktree: true, active }), /Stop/);
    assert.throws(() => unregisterProject(proj.id, active), /active run/);

    await removeTask(updatedTask.id, { cleanupWorktree: true });
    assert.equal(getTask(updatedTask.id), null);
    assert.equal(existsSync(fakeWt), false);
    assert.equal(existsSync(fakeArchive), false);

    const removedProj = unregisterProject(proj.id);
    assert.equal(removedProj.id, proj.id);
    assert.throws(() => unregisterProject(proj.id), /Unknown project/);
  });

  it("installs portable skills and global orc launchers into a custom home directory", () => {
    const fakeHome = path.join(tempDir, "fake-home");
    const res = installOrc({ homeDir: fakeHome });
    assert.ok(existsSync(res.agySkill));
    assert.ok(existsSync(res.claudeSkill));
    assert.ok(existsSync(res.cmdPath));
    assert.ok(existsSync(res.shPath));
    assert.match(readFileSync(res.cmdPath, "utf8"), /bin\\orc\.js/);
    assert.match(readFileSync(res.shPath, "utf8"), /bin\/orc\.js/);
  });
});
