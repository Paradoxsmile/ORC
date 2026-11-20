import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
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

const { buildArgs, consumeLine, createStreamState, detectAgents, quoteCmd } = await import(
  "../src/agents.js"
);
const { addProject, updateProject } = await import("../src/config.js");
const { db, isPidAlive, reapDeadRuns } = await import("../src/db.js");
const { createTask, failTask, getTask, getTaskDetail, saveSpec, setState, updateTask } =
  await import("../src/board.js");
const {
  buildImplementPrompt,
  buildResearchPrompt,
  buildReviewPrompt,
  captureWork,
  checkConcurrency,
  checkDependencies,
  checkQuotaGuardrail,
  clearVendorQuota,
  compactHandoff,
  createEventCoalescer,
  drainQueue,
  effortFor,
  formatFixContext,
  getQuotaSnapshot,
  MAX_REVIEW_LOOPS,
  maxTrackedFileBytes,
  mergeTask,
  modelFor,
  parseVerdict,
  pauseThreshold,
  queueTask,
  recordVendorQuota,
  recoverWorktrees,
  removeTask,
  reviewerFor,
  runTask,
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

    const pathStates = ["working", "verify", "fixing", "working", "verify", "review", "done"];
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
    assert.match(readFileSync(res.cmdPath, "utf8"), /bin[/\\]orc\.js/);
    assert.match(readFileSync(res.shPath, "utf8"), /bin\/orc\.js/);
  });
});

function createFakePipelineClis(fakeBin, reviewLogPath) {
  mkdirSync(fakeBin, { recursive: true });

  writeFileSync(
    path.join(fakeBin, "fake-claude.js"),
    `import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const dir = path.join(process.cwd(), "src");
mkdirSync(dir, { recursive: true });
const counterPath = path.join(dir, "attempt.txt");
const count = existsSync(counterPath) ? Number(readFileSync(counterPath, "utf8").trim()) + 1 : 1;
writeFileSync(counterPath, String(count) + "\\n", "utf8");
const session = "fake-claude-session";
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: session }));
console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Attempt " + count + "\\n" }] } }));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Attempt " + count + "\\n", session_id: session }));
`,
    "utf8",
  );

  writeFileSync(
    path.join(fakeBin, "fake-agy.js"),
    `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(reviewLogPath)}, process.cwd() + "\\n", "utf8");
const conversation = "fake-agy-conversation";
const response = "Review complete.\\n\\nVERDICT: APPROVE\\n";
console.log(JSON.stringify({ event: "init", conversation_id: conversation, init: { cwd: process.cwd(), permission_mode: "plan" } }));
console.log(JSON.stringify({ event: "step_update", step_update: { conversation_id: conversation, step_index: 1, state: "DONE", step_type: "agent_response", text_delta: response } }));
console.log(JSON.stringify({ event: "result", result: { conversation_id: conversation, status: "SUCCESS", response, usage: { total_tokens: 10 } } }));
`,
    "utf8",
  );

  if (process.platform === "win32") {
    writeFileSync(path.join(fakeBin, "claude.cmd"), '@echo off\r\nnode "%~dp0fake-claude.js" %*\r\n', "utf8");
    writeFileSync(path.join(fakeBin, "agy.cmd"), '@echo off\r\nnode "%~dp0fake-agy.js" %*\r\n', "utf8");
  } else {
    for (const name of ["claude", "agy"]) {
      const file = path.join(fakeBin, name);
      writeFileSync(file, `#!/bin/sh\nexec node "${fakeBin}/fake-${name}.js" "$@"\n`, "utf8");
      chmodSync(file, 0o755);
    }
  }
}

function initPipelineRepo(repoDir) {
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(path.join(repoDir, ".gitignore"), ".worktrees/\n.orc/\n", "utf8");
  writeFileSync(path.join(repoDir, "README.md"), "# pipeline repo\n", "utf8");
  git(repoDir, ["init", "-b", "main"]);
  git(repoDir, ["config", "user.name", "Test User"]);
  git(repoDir, ["config", "user.email", "test@example.invalid"]);
  git(repoDir, ["add", "-A"]);
  git(repoDir, ["commit", "-m", "initial"]);
}

describe("pipeline order: verify before review", () => {
  it("includes .orc/<taskId>/test.log in buildReviewPrompt only when test.log exists", () => {
    const wt = path.join(tempDir, "review-prompt-wt");
    const artifacts = path.join(wt, ".orc", "T-0100");
    mkdirSync(artifacts, { recursive: true });

    const task = { id: "T-0100", title: "Verify first", worktree: wt };
    const project = { name: "demo" };

    const withoutLog = buildReviewPrompt(task, project);
    assert.match(withoutLog, /\.orc\/T-0100\/diff\.patch/);
    assert.doesNotMatch(withoutLog, /- Test log: \.orc\/T-0100\/test\.log/);
    assert.match(withoutLog, /do not run shell commands/i);

    writeFileSync(path.join(artifacts, "test.log"), "ok\n", "utf8");
    const withLog = buildReviewPrompt(task, project);
    assert.match(withLog, /- Test log: \.orc\/T-0100\/test\.log/);
  });

  it("runs verify before review, skips review on failing tests, and handles empty testCommand", async () => {
    const fakeBin = path.join(tempDir, "pipeline-fake-bin");
    const reviewLogPath = path.join(tempDir, "reviewer-calls.log");
    createFakePipelineClis(fakeBin, reviewLogPath);

    const savedPath = process.env.PATH;
    process.env.PATH = `${fakeBin}${path.delimiter}${savedPath ?? ""}`;
    detectAgents(true);

    const readReviewerCalls = () =>
      existsSync(reviewLogPath)
        ? readFileSync(reviewLogPath, "utf8").trim().split(/\r?\n/).filter(Boolean)
        : [];

    try {
      // 1) Passing testCommand: implement -> verify -> review -> done
      const passRepo = path.join(tempDir, "pipeline-pass");
      initPipelineRepo(passRepo);
      const passProj = addProject({
        name: "pipeline-pass",
        projectPath: passRepo,
        baseBranch: "main",
        testCommand: 'node -e "console.log(\'unit-pass\')"',
      });
      const passTask = createTask({
        projectId: passProj.id,
        title: "Pass test gate first",
        description: "Verify runs before review",
        acceptance: "- [ ] tests pass before review",
        agent: "claude",
      });

      const passFinal = await runTask(passTask.id);
      assert.equal(passFinal.state, "done");
      const passDetail = getTaskDetail(passTask.id);
      const passTransitions = passDetail.events
        .filter((event) => event.type === "state")
        .map((event) => event.data?.to);
      assert.deepEqual(passTransitions, ["working", "verify", "review", "done"]);

      const verifyPassedIdx = passDetail.events.findIndex((event) => event.type === "verify.passed");
      const reviewApprovedIdx = passDetail.events.findIndex((event) => event.type === "review.approved");
      assert.ok(verifyPassedIdx >= 0 && reviewApprovedIdx > verifyPassedIdx);

      const passReviewPrompt = readFileSync(
        path.join(passFinal.worktree, ".orc", passTask.id, "prompt-review.md"),
        "utf8",
      );
      assert.match(passReviewPrompt, new RegExp(`\\.orc/${passTask.id}/test\\.log`));
      assert.equal(readReviewerCalls().length, 1);

      // 2) No testCommand configured: implement -> verify (skipped) -> review -> done
      const noTestRepo = path.join(tempDir, "pipeline-notest");
      initPipelineRepo(noTestRepo);
      const noTestProj = addProject({
        name: "pipeline-notest",
        projectPath: noTestRepo,
        baseBranch: "main",
      });
      const noTestTask = createTask({
        projectId: noTestProj.id,
        title: "No test command",
        description: "Skips verify into review",
        acceptance: "- [ ] proceeds to review",
        agent: "claude",
      });

      const noTestFinal = await runTask(noTestTask.id);
      assert.equal(noTestFinal.state, "done");
      const noTestDetail = getTaskDetail(noTestTask.id);
      const noTestTransitions = noTestDetail.events
        .filter((event) => event.type === "state")
        .map((event) => event.data?.to);
      assert.deepEqual(noTestTransitions, ["working", "verify", "review", "done"]);
      assert.equal(noTestDetail.artifacts.testExists, false);
      const noTestReviewPrompt = readFileSync(
        path.join(noTestFinal.worktree, ".orc", noTestTask.id, "prompt-review.md"),
        "utf8",
      );
      assert.doesNotMatch(noTestReviewPrompt, /test\.log/);
      assert.equal(readReviewerCalls().length, 2);

      // 3) Failing testCommand: loops to fixing -> blocked without invoking reviewer
      const failRepo = path.join(tempDir, "pipeline-fail");
      initPipelineRepo(failRepo);
      const failProj = addProject({
        name: "pipeline-fail",
        projectPath: failRepo,
        baseBranch: "main",
        testCommand: 'node -e "console.error(\'test boom\'); process.exit(1)"',
      });
      const failTaskItem = createTask({
        projectId: failProj.id,
        title: "Failing tests skip review",
        description: "Broken tests should go to fixing then blocked",
        acceptance: "- [ ] reviewer never called",
        agent: "claude",
      });

      const failFinal = await runTask(failTaskItem.id);
      assert.equal(failFinal.state, "blocked");
      assert.equal(failFinal.review_loops, MAX_REVIEW_LOOPS);
      const failDetail = getTaskDetail(failTaskItem.id);
      const failTransitions = failDetail.events
        .filter((event) => event.type === "state")
        .map((event) => event.data?.to);
      assert.deepEqual(failTransitions, ["working", "verify", "fixing", "working", "verify", "blocked"]);
      assert.equal(failDetail.runs.filter((run) => run.step === "review").length, 0);
      assert.equal(failDetail.artifacts.reviewExists, false);
      assert.equal(failDetail.artifacts.testExists, true);
      assert.equal(readReviewerCalls().length, 2);

      // 4) Fails first verify, passes second verify after fix -> review runs once and approves
      const fixRepo = path.join(tempDir, "pipeline-fix-then-pass");
      initPipelineRepo(fixRepo);
      const fixProj = addProject({
        name: "pipeline-fix-then-pass",
        projectPath: fixRepo,
        baseBranch: "main",
        testCommand:
          'node -e "const fs=require(\'fs\'); const n=Number(fs.readFileSync(\'src/attempt.txt\',\'utf8\').trim()); process.exit(n>=2?0:1)"',
      });
      const fixTaskItem = createTask({
        projectId: fixProj.id,
        title: "Fix then pass tests",
        description: "First test fails, fix passes, then reviewer approves",
        acceptance: "- [ ] passes after one fix loop",
        agent: "claude",
      });

      const fixFinal = await runTask(fixTaskItem.id);
      assert.equal(fixFinal.state, "done");
      assert.equal(fixFinal.review_loops, 1);
      const fixDetail = getTaskDetail(fixTaskItem.id);
      const fixTransitions = fixDetail.events
        .filter((event) => event.type === "state")
        .map((event) => event.data?.to);
      assert.deepEqual(fixTransitions, ["working", "verify", "fixing", "working", "verify", "review", "done"]);
      assert.equal(fixDetail.runs.filter((run) => run.step === "review").length, 1);
      assert.equal(readReviewerCalls().length, 3);
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
      detectAgents(true);
    }
  });
});

describe("Issue #6 & compact protocol: diffIgnore, tail-trimmed fix context, tiered routing", () => {
  it("omits lockfile/minified hunks from diff.patch while prepending diff --stat and committing them", async () => {
    const repo = path.join(tempDir, "diff-ignore-repo");
    initPipelineRepo(repo);
    git(repo, ["checkout", "-b", "task/T-0601-diff-ignore"]);
    const before = git(repo, ["rev-parse", "HEAD"]);

    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src", "logic.js"), "export const ok = 42;\n", "utf8");
    writeFileSync(path.join(repo, "package-lock.json"), '{"lockfileVersion":3,"huge":"LOCK_MARKER"}\n', "utf8");
    writeFileSync(path.join(repo, "bundle.min.js"), "var MINIFIED_MARKER=1;\n", "utf8");

    const task = { id: "T-0601", title: "Diff ignore check" };
    const filtered = await captureWork(repo, task, { baseBranch: "main" }, "implementation", before);
    assert.match(filtered.patch, /# diff --stat/);
    assert.match(filtered.patch, /src\/logic\.js/);
    assert.match(filtered.patch, /export const ok = 42;/);
    assert.doesNotMatch(filtered.patch, /LOCK_MARKER/);
    assert.doesNotMatch(filtered.patch, /MINIFIED_MARKER/);
    assert.ok(filtered.omittedFiles.includes("package-lock.json"));
    assert.ok(filtered.omittedFiles.includes("bundle.min.js"));

    // Lockfile was still committed to git so the branch is intact
    const committed = git(repo, ["ls-tree", "-r", "HEAD", "--name-only"]);
    assert.match(committed, /package-lock\.json/);

    // Disabling diffIgnore via ["none"] restores full lockfile hunks
    const unfiltered = await captureWork(
      repo,
      task,
      { baseBranch: "main", diffIgnore: ["none"] },
      "fix",
      filtered.head,
    );
    assert.match(unfiltered.patch, /LOCK_MARKER/);
  });

  it("preserves full review.md and keeps the tail of test.log in fix-loop context", () => {
    const review = "src/app.js:12|high|null deref|guard req.user";
    const noisyPrefix = "PASS test/a.test.mjs\n".repeat(400);
    const tailFailure = "FAIL AssertionError: expected 401 to equal 200 at src/auth.js:88";
    const ctx = formatFixContext(review, `${noisyPrefix}\n${tailFailure}`, {
      reviewMax: 6000,
      testMax: 500,
    });

    assert.match(ctx, /null deref/);
    assert.match(ctx, /expected 401 to equal 200/);
    assert.match(ctx, /earlier test output trimmed/);
  });

  it("emits compact machine-dense prompts by default and honors ORC_COMPACT_HANDOFF=0", () => {
    const wt = path.join(tempDir, "compact-prompt-wt");
    mkdirSync(path.join(wt, ".orc", "T-0602"), { recursive: true });
    const task = { id: "T-0602", title: "Compact check", tier: "low", worktree: wt };
    const project = { name: "demo", testCommand: "node --test" };

    withEnv({ ORC_COMPACT_HANDOFF: undefined }, () => {
      assert.equal(compactHandoff(), true);
      const impl = buildImplementPrompt(task, project, { fixing: false, worktree: wt });
      assert.match(impl, /TASK:T-0602\|Compact check\|TIER:low/);
      assert.match(impl, /CHANGED:/);
      const rev = buildReviewPrompt(task, project);
      assert.match(rev, /FILE:LINE\|SEV/);
      assert.match(rev, /Do not run shell commands/i);
    });

    withEnv({ ORC_COMPACT_HANDOFF: "0" }, () => {
      assert.equal(compactHandoff(), false);
      const impl = buildImplementPrompt(task, project, { fixing: false, worktree: wt });
      assert.match(impl, /# Task T-0602/);
    });
  });

  it("routes models by tier (low/med/high) with reviewer defaulting to high tier", () => {
    const lowTask = { tier: "low" };
    const highTask = { tier: "high" };

    withEnv(
      {
        ORC_CLAUDE_LOW_MODEL: "haiku",
        ORC_CLAUDE_HIGH_MODEL: "opus",
        ORC_CLAUDE_IMPL_MODEL: undefined,
        ORC_CLAUDE_REVIEW_MODEL: undefined,
        ORC_CLAUDE_MODEL: undefined,
      },
      () => {
        assert.equal(modelFor("claude", "impl", null, lowTask), "haiku");
        assert.equal(modelFor("claude", "review", null, lowTask), "opus");
        assert.equal(modelFor("claude", "impl", null, highTask), "opus");
      },
    );

    // Built-in low-tier plan-saver routes Claude low tasks to sonnet when unset
    withEnv(
      {
        ORC_CLAUDE_LOW_MODEL: undefined,
        ORC_CLAUDE_IMPL_MODEL: undefined,
        ORC_CLAUDE_MODEL: undefined,
        ORC_TIER_DEFAULTS: undefined,
      },
      () => {
        assert.equal(modelFor("claude", "impl", null, lowTask), "sonnet");
        assert.equal(modelFor("claude", "impl", null, { tier: "med" }), null);
      },
    );

    // Task explicit override wins over project and env
    assert.equal(
      modelFor("agy", "impl", { implModel: "proj-model" }, { tier: "low", impl_model: "task-model" }),
      "task-model",
    );
  });
});

describe("Issue #4: token/cost telemetry and quota guardrails", () => {
  it("extracts token usage and cost from Claude, Antigravity, and Codex streams", () => {
    const claudeState = createStreamState();
    consumeLine(
      "claude",
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "ok",
        total_cost_usd: 0.042,
        usage: { input_tokens: 1500, output_tokens: 250, cache_read_input_tokens: 900 },
      }),
      claudeState,
      () => {},
    );
    assert.equal(claudeState.usage.inputTokens, 1500);
    assert.equal(claudeState.usage.outputTokens, 250);
    assert.equal(claudeState.usage.cacheReadTokens, 900);
    assert.equal(claudeState.usage.costUsd, 0.042);

    const agyState = createStreamState();
    consumeLine(
      "agy",
      JSON.stringify({
        event: "result",
        result: {
          status: "SUCCESS",
          response: "done",
          usage: { input_tokens: 2000, output_tokens: 300, thinking_tokens: 400, cache_read_tokens: 1200 },
        },
      }),
      agyState,
      () => {},
    );
    assert.equal(agyState.usage.inputTokens, 2000);
    assert.equal(agyState.usage.outputTokens, 300);
    assert.equal(agyState.usage.thinkingTokens, 400);
    assert.equal(agyState.usage.cacheReadTokens, 1200);
  });

  it("pauses launches when vendor utilization exceeds ORC_PAUSE_ON_UTILIZATION", () => {
    clearVendorQuota();
    try {
      assert.equal(pauseThreshold({ ORC_PAUSE_ON_UTILIZATION: "0.90" }), 0.9);
      assert.equal(pauseThreshold({ ORC_PAUSE_ON_UTILIZATION: "85" }), 0.85);
      assert.equal(pauseThreshold({}), null);

      recordVendorQuota("claude", {
        status: "allowed_warning",
        rateLimitType: "seven_day",
        utilization: 0.95,
      });
      assert.equal(getQuotaSnapshot().claude.utilization, 0.95);

      const dir = path.join(tempDir, "quota-repo");
      mkdirSync(dir, { recursive: true });
      const proj = addProject({ name: "quota-repo", projectPath: dir });
      const task = createTask({ projectId: proj.id, title: "Quota test", description: "desc" });

      const paused = checkQuotaGuardrail("claude", task.id, {
        env: { ORC_PAUSE_ON_UTILIZATION: "0.90" },
      });
      assert.equal(paused.paused, true);
      assert.match(paused.message, /95%/);
      assert.ok(getTaskDetail(task.id).events.some((e) => e.type === "run.paused_quota"));

      const allowed = checkQuotaGuardrail("agy", task.id, {
        env: { ORC_PAUSE_ON_UTILIZATION: "0.90" },
      });
      assert.equal(allowed.paused, false);
    } finally {
      clearVendorQuota();
    }
  });
});

describe("Issue #5: per-project task queue and --depends-on", () => {
  it("blocks direct run on unmet dependencies, halts on blocked upstream, and drains when upstream finishes", async () => {
    const dir = path.join(tempDir, "queue-repo");
    mkdirSync(dir, { recursive: true });
    const proj = addProject({ name: "queue-repo", projectPath: dir });

    const t1 = createTask({ projectId: proj.id, title: "Upstream task", description: "first" });
    const t2 = createTask({
      projectId: proj.id,
      title: "Downstream task",
      description: "second",
      dependsOn: t1.id,
    });

    assert.equal(checkDependencies(t2).ok, false);
    assert.deepEqual(checkDependencies(t2).pending, [t1.id]);
    await assert.rejects(() => runTask(t2.id), /unmet dependencies/);

    queueTask(t2.id, { autoDrain: false });
    assert.equal(getTask(t2.id).state, "queued");
    assert.equal(drainQueue(proj.id, { triggerRun: false }), null);

    // If upstream blocks, queue halts downstream with queue.halted
    failTask(t1.id, "upstream broke");
    assert.equal(drainQueue(proj.id, { triggerRun: false }), null);
    assert.ok(getTaskDetail(t2.id).events.some((e) => e.type === "queue.halted"));

    // Once upstream reaches done, drainQueue picks t2 as runnable
    setState(t1.id, "done", { note: "resolved" });
    const picked = drainQueue(proj.id, { triggerRun: false });
    assert.equal(picked?.id, t2.id);
  });
});

describe("Issue #2: read-only research mode", () => {
  it("runs read-only research without worktrees, writes docs/research notes and brief.md", async () => {
    const fakeBin = path.join(tempDir, "research-fake-bin");
    const reviewLogPath = path.join(tempDir, "research-calls.log");
    createFakePipelineClis(fakeBin, reviewLogPath);

    const savedPath = process.env.PATH;
    process.env.PATH = `${fakeBin}${path.delimiter}${savedPath ?? ""}`;
    detectAgents(true);

    try {
      const repo = path.join(tempDir, "research-repo");
      initPipelineRepo(repo);
      const proj = addProject({ name: "research-repo", projectPath: repo, baseBranch: "main" });

      const resTask = createTask({
        projectId: proj.id,
        title: "Map auth flow",
        description: "Find all token verification paths",
        kind: "research",
        agent: "agy",
        researchAgents: "agy",
        tier: "low",
      });
      assert.equal(resTask.kind, "research");
      assert.equal(resTask.branch, null);
      assert.equal(resTask.state, "specced");
      assert.match(buildResearchPrompt(resTask, proj, "agy"), /read-only codebase researcher/i);

      const headBefore = git(repo, ["rev-parse", "HEAD"]);
      const done = await runTask(resTask.id);
      assert.equal(done.state, "done");
      assert.equal(done.worktree, null);
      assert.equal(existsSync(path.join(repo, ".worktrees")), false);
      assert.equal(git(repo, ["rev-parse", "HEAD"]), headBefore);

      const detail = getTaskDetail(resTask.id);
      assert.equal(detail.artifacts.briefExists, true);
      assert.match(detail.brief, /# Brief · /);
      assert.ok(detail.events.some((e) => e.type === "research.completed"));
      assert.ok(detail.usage.totalTokens >= 0);
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
      detectAgents(true);
    }
  });
});

describe("Issue #3: OpenAI Codex CLI adapter", () => {
  it("builds codex exec flags for impl, review, resume, and yolo", () => {
    const implArgs = buildArgs("codex", "Implement spec", { mode: null, model: "gpt-5-codex" });
    assert.deepEqual(implArgs, [
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--full-auto",
      "--model",
      "gpt-5-codex",
      "Implement spec",
    ]);

    const reviewArgs = buildArgs("codex", "Review diff", { mode: "plan" });
    assert.deepEqual(reviewArgs, ["exec", "--json", "--sandbox", "read-only", "Review diff"]);

    const resumeArgs = buildArgs("codex", "Apply fix", { sessionId: "codex-thread-77" });
    assert.deepEqual(resumeArgs, ["exec", "resume", "codex-thread-77", "--json", "Apply fix"]);

    const yoloArgs = buildArgs("codex", "Implement", { mode: null, yolo: true });
    assert.ok(yoloArgs.includes("--dangerously-bypass-approvals-and-sandbox"));
    assert.ok(!yoloArgs.includes("--full-auto"));
  });

  it("parses Codex JSONL fixture including thread_id, tools, text, usage, and errors", () => {
    const lines = readFileSync(path.join(FIXTURES_DIR, "codex-stream.jsonl"), "utf8")
      .trim()
      .split(/\r?\n/);
    const state = createStreamState();
    const events = [];

    for (const line of lines) {
      consumeLine("codex", line, state, (event) => events.push(event));
    }

    assert.equal(state.sessionId, "codex-thread-77");
    assert.match(state.text, /VERDICT: APPROVE/);
    assert.equal(state.usage.inputTokens, 1240);
    assert.equal(state.usage.cacheReadTokens, 800);
    assert.equal(state.usage.outputTokens, 95);
    assert.ok(events.some((e) => e.kind === "tool" && e.text.includes("git status")));
    assert.ok(events.some((e) => e.kind === "tool" && e.text.includes("src/app.js")));
    assert.equal(state.lastError, null);

    consumeLine(
      "codex",
      JSON.stringify({ type: "turn.failed", error: { message: "Rate limit hit" } }),
      state,
      (event) => events.push(event),
    );
    assert.equal(state.lastError, "Rate limit hit");
  });

  it("supports codex in reviewerFor", () => {
    assert.equal(reviewerFor("codex", { env: {} }), "claude");
    assert.equal(reviewerFor("claude", { env: { ORC_REVIEWER: "codex" } }), "codex");
    assert.equal(
      reviewerFor("codex", {
        env: { ORC_REVIEWER: "auto" },
        health: { codex: { available: true }, claude: { available: false }, agy: { available: true } },
      }),
      "agy",
    );
  });
});
