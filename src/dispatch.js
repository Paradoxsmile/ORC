import { execFile, spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { agentLabel, detectAgents, killTree, runAgent } from "./agents.js";
import {
  addEvent,
  bus,
  failTask,
  getTask,
  setState,
  updateTask,
} from "./board.js";
import { ensureProjectGitignore, resolveProject } from "./config.js";
import { db } from "./db.js";
import { ensureDir, nowIso, readText, truncate } from "./util.js";

const execFileP = promisify(execFile);

export const MAX_REVIEW_LOOPS = 2;
const MAX_PIPELINE_STEPS = 16;
const AGENT_TIMEOUT_MS = 45 * 60 * 1000;
const TEST_TIMEOUT_MS = 30 * 60 * 1000;

const running = new Map();

export function runningTaskIds() {
  return [...running.keys()];
}

export function isRunning(taskId) {
  return running.has(taskId);
}

export function stopTask(taskId) {
  const run = running.get(taskId);
  if (!run) throw new Error(`${taskId} is not running`);
  run.cancelled = true;
  addEvent({ taskId, actor: "you", type: "run.stop_requested", text: "Stop requested" });
  if (run.child) killTree(run.child);
  bus.emit("refresh");
  return true;
}

export { MAX_PIPELINE_STEPS };

/**
 * Drives one task until it reaches `done`, `blocked`, or a safety limit.
 * Every externally visible step is written to the events table so the UI can
 * reconstruct what happened even after a restart.
 */
export async function runTask(taskId, { actor = "you" } = {}) {
  let task = getTask(taskId);
  if (!task) throw new Error(`Unknown task: ${taskId}`);
  if (running.has(taskId)) throw new Error(`${taskId} is already running`);
  if (task.state === "done") return task;
  if (task.state === "blocked") {
    throw new Error(
      `${taskId} is blocked. Resolve the issue, move it back to specced/fixing, then run again.`,
    );
  }
  if (task.state === "inbox") {
    throw new Error(
      `${taskId} has no spec yet. Add a description or acceptance criteria (or edit the spec), then run again.`,
    );
  }

  const project = resolveProject(task.project_id);
  if (!project) throw new Error(`Project "${task.project_id}" is not registered`);

  const controller = { taskId, child: null, cancelled: false };
  running.set(taskId, controller);
  addEvent({
    taskId,
    actor,
    type: "run.started",
    text: `Pipeline started · ${agentLabel(task.agent)} implements, ${agentLabel(reviewerFor(task.agent))} reviews`,
  });
  bus.emit("refresh");

  try {
    await provision(task, project);

    for (let step = 0; step < MAX_PIPELINE_STEPS; step += 1) {
      if (controller.cancelled) throw cancelledError();
      task = getTask(taskId);

      if (task.state === "done") break;
      if (task.state === "blocked") break;

      if (["specced", "working", "fixing"].includes(task.state)) {
        await implementStep(task, project, controller);
      } else if (task.state === "review") {
        await reviewStep(task, project, controller);
      } else if (task.state === "verify") {
        await verifyStep(task, project, controller);
      } else {
        throw new Error(`Cannot run a task from state "${task.state}"`);
      }
    }

    const final = getTask(taskId);
    if (final.state !== "done" && final.state !== "blocked") {
      throw new Error(
        `Pipeline stopped after ${MAX_PIPELINE_STEPS} steps in state "${final.state}" — inspect the task.`,
      );
    }
    return final;
  } catch (error) {
    if (error?.cancelled) {
      addEvent({ taskId, actor: "orc", type: "run.stopped", text: "Stopped by user" });
      if (getTask(taskId)?.state !== "blocked") failTask(taskId, "Stopped by user");
    } else {
      const message = error?.message || String(error);
      addEvent({
        taskId,
        actor: "orc",
        type: "run.failed",
        text: truncate(message, 1200),
      });
      failTask(taskId, message);
    }
    return getTask(taskId);
  } finally {
    running.delete(taskId);
    controller.child = null;
    bus.emit("refresh");
  }
}

export function reviewerFor(implementer) {
  return implementer === "agy" ? "claude" : "agy";
}

export function modelFor(agent, role) {
  if (agent === "agy") {
    const specific = role === "review" ? "ORC_AGY_REVIEW_MODEL" : "ORC_AGY_IMPL_MODEL";
    return process.env[specific] || process.env.ORC_AGY_MODEL || null;
  }
  const specific = role === "review" ? "ORC_CLAUDE_REVIEW_MODEL" : "ORC_CLAUDE_IMPL_MODEL";
  return process.env[specific] || process.env.ORC_CLAUDE_MODEL || null;
}

export function effortFor(agent, role) {
  if (agent !== "agy") return null;
  const model = modelFor(agent, role);
  // Orchestrator uses a fixed configuration and rejects --effort.
  if (model && model.includes("orchestrator")) return null;
  return process.env.ORC_AGY_EFFORT || null;
}

export function yoloFor(agent, role) {
  if (agent !== "agy" || role !== "impl") return false;
  return /^(1|true|yes)$/i.test(String(process.env.ORC_AGY_YOLO ?? "").trim());
}

function cancelledError() {
  const error = new Error("Stopped by user");
  error.cancelled = true;
  return error;
}

async function provision(task, project) {
  const top = await git(project.path, ["rev-parse", "--show-toplevel"], { allowFailure: true });
  if (!top.ok) {
    throw new Error(
      `${project.name} is not a git repository. Run "git init" in ${project.path} before dispatching tasks.`,
    );
  }

  const base = project.baseBranch || "main";
  const baseCheck = await git(project.path, ["rev-parse", "--verify", base], { allowFailure: true });
  if (!baseCheck.ok) {
    throw new Error(
      `Base branch "${base}" not found in ${project.name}. Set baseBranch in orc.config.json or create the branch.`,
    );
  }

  ensureProjectGitignore(project);

  const worktree = task.worktree || path.join(project.path, ".worktrees", task.id);
  const branch = task.branch || `task/${task.id}-${task.slug}`;

  if (!existsSync(worktree)) {
    const branchCheck = await git(project.path, ["rev-parse", "--verify", `refs/heads/${branch}`], {
      allowFailure: true,
    });
    if (branchCheck.ok) {
      await git(project.path, ["worktree", "add", worktree, branch]);
    } else {
      await git(project.path, ["worktree", "add", "-b", branch, worktree, base]);
    }
    addEvent({
      taskId: task.id,
      actor: "orc",
      type: "worktree.created",
      text: worktree,
      data: { branch, base },
    });
  }

  const artifactsDir = path.join(worktree, ".orc", task.id);
  ensureDir(artifactsDir);

  const sourceSpec = task.spec_path ? readText(task.spec_path, "") : "";
  if (!sourceSpec.trim()) {
    throw new Error(`Spec file is missing or empty: ${task.spec_path ?? "(none)"}`);
  }
  writeFileSync(path.join(artifactsDir, "spec.md"), sourceSpec, "utf8");
  writeFileSync(
    path.join(artifactsDir, "task.json"),
    `${JSON.stringify(
      {
        id: task.id,
        title: task.title,
        project: project.name,
        branch,
        baseBranch: base,
        agent: task.agent,
        reviewer: reviewerFor(task.agent),
        spec: task.spec_path,
        createdAt: task.created_at,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  if (task.worktree !== worktree || task.branch !== branch) {
    updateTask(task.id, { worktree, branch });
  }

  return { worktree, artifactsDir, branch, base };
}

async function implementStep(task, project, controller) {
  const { worktree, artifactsDir, base } = await provision(task, project);
  const fixing = task.state === "fixing";
  const label = fixing ? "fix" : "implementation";

  setState(task.id, "working", {
    note: fixing ? "Applying review findings" : "Implementation agent started",
    actor: "orc",
  });

  const sessionId = task.session_id || null;
  const prompt = buildImplementPrompt(task, project, { fixing, worktree });
  const implementer = task.agent === "agy" ? "agy" : "claude";
  const runId = startRun(task.id, implementer, label);

  addEvent({
    taskId: task.id,
    runId,
    actor: implementer,
    type: "agent.prompt",
    text: fixing ? "Fixing review findings" : "Implementing the spec",
    data: { prompt: path.join(artifactsDir, "prompt-implement.md") },
  });
  writeFileSync(path.join(artifactsDir, "prompt-implement.md"), prompt, "utf8");

  const before = (await git(worktree, ["rev-parse", "HEAD"], { allowFailure: true })).stdout.trim();

  let result;
  try {
    result = await runAgent({
      agent: implementer,
      prompt,
      cwd: worktree,
      sessionId,
      mode: implementer === "agy" ? "accept-edits" : null,
      model: modelFor(implementer, "impl"),
      effort: effortFor(implementer, "impl"),
      yolo: yoloFor(implementer, "impl"),
      timeoutMs: AGENT_TIMEOUT_MS,
      taskId: task.id,
      runId,
      onSpawn: (child) => {
        controller.child = child;
        setRunPid(runId, child.pid);
      },
      onEvent: (event) => recordAgentEvent(task.id, runId, implementer, event),
    });
  } catch (error) {
    controller.child = null;
    finishRun(runId, { code: -1, error: error.message });
    throw error;
  }

  controller.child = null;
  finishRun(runId, result, controller.cancelled);
  if (controller.cancelled) throw cancelledError();

  if (result.sessionId && result.sessionId !== task.session_id) {
    updateTask(task.id, { session_id: result.sessionId });
  }

  if (result.code !== 0 || result.error) {
    throw new Error(
      `${agentLabel(implementer)} ${label} failed (exit ${result.code})${result.error ? `: ${result.error}` : ""}\n${tail(result.text, 1500)}`,
    );
  }

  const { patch, head } = await captureWork(worktree, task, project, label, before);
  writeFileSync(path.join(artifactsDir, "diff.patch"), patch, "utf8");

  if (!patch.trim() || head === before) {
    throw new Error(
      `${agentLabel(implementer)} finished the ${label} without changing any tracked files. See ${artifactsDir}.`,
    );
  }

  addEvent({
    taskId: task.id,
    runId,
    actor: "orc",
    type: "diff.captured",
    text: `${patch.split("\n").length} lines of diff`,
    data: { head },
  });

  setState(task.id, "review", {
    note: `${agentLabel(implementer)} ${label} complete · ${agentLabel(reviewerFor(implementer))} will review`,
    actor: "orc",
  });
}

async function reviewStep(task, project, controller) {
  if (!task.worktree) throw new Error("Task has no worktree; run the implementation step first.");
  const artifactsDir = path.join(task.worktree, ".orc", task.id);
  const reviewer = reviewerFor(task.agent);
  const prompt = buildReviewPrompt(task, project);
  writeFileSync(path.join(artifactsDir, "prompt-review.md"), prompt, "utf8");

  const runId = startRun(task.id, reviewer, "review");
  addEvent({
    taskId: task.id,
    runId,
    actor: reviewer,
    type: "agent.prompt",
    text: "Reviewing the diff against the spec",
  });

  let result;
  try {
    result = await runAgent({
      agent: reviewer,
      prompt,
      cwd: task.worktree,
      mode: "plan",
      model: modelFor(reviewer, "review"),
      effort: effortFor(reviewer, "review"),
      timeoutMs: AGENT_TIMEOUT_MS,
      taskId: task.id,
      runId,
      onSpawn: (child) => {
        controller.child = child;
        setRunPid(runId, child.pid);
      },
      onEvent: (event) => recordAgentEvent(task.id, runId, reviewer, event),
    });
  } catch (error) {
    controller.child = null;
    finishRun(runId, { code: -1, error: error.message });
    throw error;
  }

  controller.child = null;
  finishRun(runId, result, controller.cancelled);
  if (controller.cancelled) throw cancelledError();

  if (result.sessionId) updateTask(task.id, { conversation_id: result.sessionId });

  if (result.code !== 0 || result.error) {
    throw new Error(
      `${agentLabel(reviewer)} review failed (exit ${result.code})${result.error ? `: ${result.error}` : ""}\n${tail(result.text, 1500)}`,
    );
  }

  const verdict = parseVerdict(result.text);
  const header = [
    `# Review · ${task.id} ${task.title}`,
    "",
    `- Reviewer: ${agentLabel(reviewer)}`,
    `- At: ${nowIso()}`,
    `- Verdict: ${verdict ?? "missing"}`,
    "",
    "---",
    "",
  ].join("\n");

  writeFileSync(path.join(artifactsDir, "review.md"), `${header}${result.text}\n`, "utf8");

  if (!verdict) {
    throw new Error(
      `The reviewer did not emit a VERDICT line. Read ${path.join(artifactsDir, "review.md")} and decide manually.`,
    );
  }

  if (verdict === "approve") {
    updateTask(task.id, { review_verdict: "approve", last_error: null });
    addEvent({ taskId: task.id, runId, actor: reviewer, type: "review.approved", text: "VERDICT: APPROVE" });
    setState(task.id, "verify", { note: "Review approved", actor: "orc" });
    return;
  }

  const loops = Number(task.review_loops ?? 0) + 1;
  updateTask(task.id, { review_verdict: "request_changes", review_loops: loops });
  addEvent({
    taskId: task.id,
    runId,
    actor: reviewer,
    type: "review.changes_requested",
    text: `VERDICT: REQUEST CHANGES (loop ${loops}/${MAX_REVIEW_LOOPS})`,
  });

  if (loops >= MAX_REVIEW_LOOPS) {
    setState(task.id, "blocked", {
      note: `Review still requests changes after ${loops} loops — human decision needed`,
      actor: "orc",
    });
  } else {
    setState(task.id, "fixing", { note: `Review loop ${loops}/${MAX_REVIEW_LOOPS}`, actor: "orc" });
  }
}

async function verifyStep(task, project, controller) {
  const command = String(project.testCommand ?? "").trim();
  if (!command) {
    updateTask(task.id, { last_error: null });
    setState(task.id, "done", { note: "No test command configured — verification skipped", actor: "orc" });
    return;
  }

  if (!task.worktree) throw new Error("Task has no worktree to verify.");
  const artifactsDir = path.join(task.worktree, ".orc", task.id);
  const testPath = path.join(artifactsDir, "test.log");
  const runId = startRun(task.id, "shell", "verify");

  addEvent({
    taskId: task.id,
    runId,
    actor: "orc",
    type: "verify.started",
    text: command,
  });

  const result = await runShell(command, {
    cwd: task.worktree,
    timeoutMs: TEST_TIMEOUT_MS,
    onSpawn: (child) => {
      controller.child = child;
      setRunPid(runId, child.pid);
    },
  });

  controller.child = null;
  finishRun(runId, result, controller.cancelled);

  const log = [
    `$ ${command}`,
    `cwd: ${task.worktree}`,
    `exit: ${result.code}${result.error ? ` (${result.error})` : ""}`,
    `at: ${nowIso()}`,
    "",
    result.output,
    "",
  ].join("\n");
  writeFileSync(testPath, log, "utf8");

  if (controller.cancelled) throw cancelledError();

  if (result.code === 0 && !result.error) {
    updateTask(task.id, { last_error: null });
    addEvent({ taskId: task.id, runId, actor: "orc", type: "verify.passed", text: command });
    setState(task.id, "done", { note: "Tests passed", actor: "orc" });
    return;
  }

  addEvent({
    taskId: task.id,
    runId,
    actor: "orc",
    type: "verify.failed",
    text: `Exit ${result.code}${result.error ? ` · ${result.error}` : ""}`,
    data: { log: testPath },
  });

  const loops = Number(task.review_loops ?? 0) + 1;
  updateTask(task.id, { review_loops: loops });
  if (loops >= MAX_REVIEW_LOOPS) {
    setState(task.id, "blocked", {
      note: `Tests failed after ${loops} fix loops — human decision needed`,
      actor: "orc",
    });
  } else {
    setState(task.id, "fixing", { note: `Tests failed; fix loop ${loops}/${MAX_REVIEW_LOOPS}`, actor: "orc" });
  }
}

function buildImplementPrompt(task, project, { fixing, worktree }) {
  const artifacts = `.orc/${task.id}`;
  const testCommand = project.testCommand || "(no test command configured)";
  const lines = [
    `# Task ${task.id} — ${task.title}`,
    "",
    `Project: ${project.name}`,
    `Worktree: ${worktree}`,
    `Read first: ${artifacts}/spec.md`,
    "Then read AGENTS.md. Open only the files the task actually needs.",
    "",
    "## Job",
    fixing
      ? "Address the reviewer's findings below. Fix causes, not symptoms. Re-run the relevant checks."
      : "Implement the spec in this worktree. Stay inside its acceptance criteria and constraints.",
    "",
    "## Rules",
    "- Work only inside this worktree. Do not touch the main checkout.",
    "- Do not edit anything under .orc/ except the spec copy if the task requires it.",
    "- Do not commit; ORC records the diff and commits it for review.",
    "- If the task is ambiguous, make the smallest reasonable choice and note it.",
    `- Test command: ${testCommand}`,
    "",
    "## Finish",
    "End with at most 10 lines: what changed, what you ran, and any open question.",
  ];

  if (fixing) {
    const review = readText(path.join(worktree, ".orc", task.id, "review.md"), "");
    const test = readText(path.join(worktree, ".orc", task.id, "test.log"), "");
    const context = [review, test].filter((value) => value.trim()).join("\n\n");
    lines.push("", "## Findings to address", "", truncate(context, 9000) || "(none recorded)");
  }

  return `${lines.join("\n")}\n`;
}

function buildReviewPrompt(task, project) {
  const artifacts = `.orc/${task.id}`;
  const lines = [
    `# Review ${task.id} — ${task.title}`,
    "",
    `Project: ${project.name}`,
    `You are the reviewer. Do not modify files and do not implement the task.`,
    "",
    "## Read",
    `- Spec: ${artifacts}/spec.md`,
    `- Diff: ${artifacts}/diff.patch`,
    `- Task metadata: ${artifacts}/task.json`,
    "- AGENTS.md, if it helps verify project rules.",
    "",
    "## Check",
    "- Every acceptance criterion is actually met.",
    "- The diff is scoped; no unrelated files, secrets, or generated artifacts.",
    "- Tests or checks are adequate. You may run read-only commands or the test suite.",
    "- Failure modes, edge cases, and regressions the spec named.",
    "",
    "## Output",
    "List findings as: `file:line — issue — concrete fix`.",
    "Be specific. Do not restate the diff.",
    "",
    "End with exactly one of these lines:",
    "VERDICT: APPROVE",
    "VERDICT: REQUEST CHANGES",
  ];
  return `${lines.join("\n")}\n`;
}

export function parseVerdict(text) {
  const matches = [
    ...String(text ?? "").matchAll(/[*`\s]*VERDICT:\s*(APPROVE|REQUEST\s+CHANGES)\b[*`\s.]*$/gim),
  ];
  const last = matches.at(-1);
  if (!last) return null;
  return /APPROVE/i.test(last[1]) ? "approve" : "request_changes";
}

export async function captureWork(worktree, task, project, label, before) {
  const base = project.baseBranch || "main";

  // Stage everything, then unstage artifacts. This also works when the project
  // scaffold has not been committed yet and .orc/ is not in .gitignore.
  await git(worktree, ["add", "-A"]);
  if (existsSync(path.join(worktree, ".orc"))) {
    await git(worktree, ["reset", "-q", "--", ".orc"]);
  }

  // Only tracked changes count. Untracked artifacts are intentionally ignored.
  const staged = await git(worktree, ["status", "--porcelain", "--untracked-files=no"]);

  if (staged.stdout.trim()) {
    await git(worktree, [
      "-c",
      "user.name=ORC",
      "-c",
      "user.email=orc@local",
      "commit",
      "-m",
      `task ${task.id}: ${task.title} [${label}]`,
    ]);
  }

  const head = (await git(worktree, ["rev-parse", "HEAD"])).stdout.trim();
  const diff = await git(worktree, ["diff", `${base}...HEAD`], { maxBuffer: 32 * 1024 * 1024 });
  return { patch: diff.stdout, head, before };
}

function startRun(taskId, agent, step) {
  const runId = `R-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  db.prepare(
    `INSERT INTO runs (id, task_id, agent, step, status, started_at)
     VALUES (?, ?, ?, ?, 'running', ?)`,
  ).run(runId, taskId, agent, step, nowIso());
  return runId;
}

function setRunPid(runId, pid) {
  try {
    db.prepare("UPDATE runs SET pid = ? WHERE id = ?").run(pid ?? null, runId);
  } catch {
    // Best effort only.
  }
}

function finishRun(runId, result, cancelled = false) {
  const status = cancelled ? "stopped" : result.code === 0 && !result.error ? "ok" : "failed";
  db.prepare("UPDATE runs SET status = ?, ended_at = ?, exit_code = ? WHERE id = ?").run(
    status,
    nowIso(),
    result.code ?? null,
    runId,
  );
}

function recordAgentEvent(taskId, runId, agent, event) {
  const kind = event.kind || "event";
  if (kind === "init") {
    addEvent({
      taskId,
      runId,
      actor: agent,
      type: "agent.init",
      text: `Session ${event.sessionId ?? "(unknown)"}`,
      data: event.data ?? null,
    });
    return;
  }
  if (kind === "tool") {
    addEvent({ taskId, runId, actor: agent, type: "agent.tool", text: event.text ?? "tool" });
    return;
  }
  if (kind === "tool_result") {
    addEvent({
      taskId,
      runId,
      actor: agent,
      type: "agent.tool_result",
      text: truncate(event.text ?? "", 700),
    });
    return;
  }
  if (kind === "stderr") {
    addEvent({ taskId, runId, actor: agent, type: "agent.stderr", text: truncate(event.text ?? "", 1200) });
    return;
  }
  addEvent({
    taskId,
    runId,
    actor: agent,
    type: `agent.${kind}`,
    text: truncate(event.text ?? "", 4000),
    data: event.data ?? null,
  });
}

function runShell(command, { cwd, timeoutMs, onSpawn = () => {} }) {
  return new Promise((resolve) => {
    let child;
    try {
      // `shell: true` lets Node handle Windows cmd.exe quoting correctly. Handing
      // the raw command to cmd.exe ourselves breaks nested quotes in arguments.
      child = spawn(command, {
        cwd,
        env: process.env,
        windowsHide: true,
        shell: true,
        detached: process.platform !== "win32",
      });
    } catch (error) {
      resolve({ code: -1, output: "", error: error.message });
      return;
    }

    let output = "";
    let error = null;
    const timer = timeoutMs
      ? setTimeout(() => {
        error = `Timed out after ${Math.round(timeoutMs / 60000)} minutes`;
        killTree(child);
      }, timeoutMs)
      : null;

    const append = (chunk) => {
      output += String(chunk);
      if (output.length > 350000) output = output.slice(-350000);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (spawnError) => {
      error = spawnError.message;
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, output, error });
    });

    onSpawn(child);
  });
}

async function git(cwd, args, { allowFailure = false, maxBuffer = 8 * 1024 * 1024 } = {}) {
  try {
    const { stdout, stderr } = await execFileP("git", args, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer,
    });
    return { ok: true, stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (error) {
    const stderr = String(error?.stderr ?? error?.message ?? "").trim();
    if (allowFailure) return { ok: false, stdout: String(error?.stdout ?? ""), stderr };
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  }
}

function tail(value, max) {
  const text = String(value ?? "").trim();
  return text.length > max ? `…${text.slice(-max)}` : text;
}

export function agentHealth() {
  return detectAgents();
}
