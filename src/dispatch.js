import { execFile, spawn } from "node:child_process";
import { cpSync, existsSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { agentLabel, detectAgents, killPidTree, killTree, runAgent } from "./agents.js";
import {
  addEvent,
  bus,
  deleteTask,
  failTask,
  getTask,
  normalizeAgent,
  normalizeTier,
  parseDependsOn,
  setState,
  syncBoard,
  updateTask,
} from "./board.js";
import {
  effectiveDiffIgnore,
  ensureProjectGitignore,
  listProjects,
  loadConfig,
  removeProject,
  resolveProject,
} from "./config.js";
import { db, isPidAlive, reapDeadRuns } from "./db.js";
import { ensureDir, nowIso, readText, today, truncate, uniquePath } from "./util.js";

const execFileP = promisify(execFile);

export const MAX_REVIEW_LOOPS = 2;
const MAX_PIPELINE_STEPS = 16;
const AGENT_TIMEOUT_MS = 45 * 60 * 1000;
const TEST_TIMEOUT_MS = 30 * 60 * 1000;

const running = new Map();
const vendorQuota = new Map();

export function getQuotaSnapshot() {
  return Object.fromEntries(vendorQuota.entries());
}

export function recordVendorQuota(agent, info) {
  if (!agent || !info) return;
  const utilization = Number.isFinite(info.utilization) ? Number(info.utilization) : null;
  vendorQuota.set(agent, {
    agent,
    status: info.status || "rate_limit",
    rateLimitType: info.rateLimitType || null,
    utilization,
    resetsAt: info.resetsAt ?? null,
    updatedAt: nowIso(),
  });
}

export function clearVendorQuota() {
  vendorQuota.clear();
}

export function pauseThreshold(env = process.env) {
  const raw = String(env.ORC_PAUSE_ON_UTILIZATION ?? "").trim();
  if (!raw) return null;
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) return null;
  return num > 1 ? Math.min(1, num / 100) : Math.min(1, num);
}

export function checkQuotaGuardrail(agent, taskId = null, { env = process.env } = {}) {
  const threshold = pauseThreshold(env);
  if (threshold === null) return { paused: false };
  const entry = vendorQuota.get(agent);
  if (!entry || !Number.isFinite(entry.utilization)) return { paused: false };
  if (entry.utilization < threshold) return { paused: false };

  const pct = Math.round(entry.utilization * 100);
  const limitPct = Math.round(threshold * 100);
  const message = `Paused by quota guardrail: ${agentLabel(agent)} utilization is ${pct}% (threshold ${limitPct}%)`;
  if (taskId) {
    addEvent({
      taskId,
      actor: "orc",
      type: "run.paused_quota",
      text: message,
      data: { agent, utilization: entry.utilization, threshold },
    });
    bus.emit("refresh");
  }
  return { paused: true, message, utilization: entry.utilization, threshold };
}

export function checkDependencies(task) {
  const deps = parseDependsOn(task?.depends_on);
  if (!deps.length) return { ok: true, deps: [], pending: [], blocked: [], missing: [] };
  const pending = [];
  const blocked = [];
  const missing = [];
  for (const depId of deps) {
    if (depId === task.id) continue;
    const dep = getTask(depId);
    if (!dep) {
      missing.push(depId);
    } else if (dep.state === "blocked") {
      blocked.push(depId);
    } else if (dep.state !== "done") {
      pending.push(depId);
    }
  }
  return {
    ok: pending.length === 0 && blocked.length === 0 && missing.length === 0,
    deps,
    pending,
    blocked,
    missing,
  };
}

export function queueTask(taskId, { actor = "you", autoDrain = true } = {}) {
  const task = getTask(taskId);
  if (!task) throw new Error(`Unknown task: ${taskId}`);
  if (running.has(taskId)) {
    const error = new Error(`${taskId} is already running`);
    error.status = 409;
    throw error;
  }
  if (task.state === "inbox") {
    const error = new Error(`${taskId} has no spec yet. Write the spec before queueing.`);
    error.status = 400;
    throw error;
  }
  if (task.state === "done") {
    const error = new Error(`${taskId} is already done`);
    error.status = 400;
    throw error;
  }

  const updated = setState(taskId, "queued", {
    note: task.depends_on ? `Queued (depends on ${task.depends_on})` : "Queued for project drain",
    actor,
  });
  addEvent({
    taskId,
    actor,
    type: "task.queued",
    text: task.depends_on ? `Queued behind ${task.depends_on}` : "Queued",
    data: { dependsOn: parseDependsOn(task.depends_on) },
  });

  if (autoDrain) {
    setImmediate(() => drainQueue(task.project_id));
  }
  return updated;
}

export function drainQueue(projectId, { triggerRun = true } = {}) {
  const project = resolveProject(projectId);
  if (!project) return null;
  if (activeTaskForProject(project.id)) return null;
  if (running.size >= maxConcurrency()) return null;

  const candidates = db
    .prepare(
      "SELECT * FROM tasks WHERE project_id = ? AND state = 'queued' ORDER BY created_at ASC, id ASC",
    )
    .all(project.id);

  for (const row of candidates) {
    const task = getTask(row.id);
    if (!task) continue;
    const deps = checkDependencies(task);
    if (deps.blocked.length || deps.missing.length) {
      const reason = deps.blocked.length
        ? `Halted in queue: upstream dependency blocked (${deps.blocked.join(", ")})`
        : `Halted in queue: missing dependency (${deps.missing.join(", ")})`;
      addEvent({
        taskId: task.id,
        actor: "orc",
        type: "queue.halted",
        text: reason,
        data: deps,
      });
      continue;
    }
    if (deps.pending.length) continue;

    const quota = checkQuotaGuardrail(task.agent, task.id);
    if (quota.paused) continue;

    if (triggerRun) {
      runTask(task.id, { actor: "queue" }).catch((error) => {
        addEvent({
          taskId: task.id,
          actor: "orc",
          type: "run.failed",
          text: truncate(error?.message || String(error), 1200),
        });
        bus.emit("refresh");
      });
    }
    return task;
  }
  return null;
}

export function runningTaskIds() {
  return [...running.keys()];
}

export function isRunning(taskId) {
  return running.has(taskId);
}

export function stopTask(taskId) {
  const run = running.get(taskId);
  if (run) {
    run.cancelled = true;
    addEvent({ taskId, actor: "you", type: "run.stop_requested", text: "Stop requested" });
    if (run.child) killTree(run.child);
    bus.emit("refresh");
    return true;
  }

  const activeRow = db
    .prepare("SELECT id, pid FROM runs WHERE task_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1")
    .get(taskId);
  if (activeRow?.pid && isPidAlive(activeRow.pid)) {
    addEvent({ taskId, actor: "you", type: "run.stop_requested", text: "Stop requested (cross-process)" });
    killPidTree(activeRow.pid);
    db.prepare("UPDATE runs SET status = 'stopped', ended_at = ? WHERE id = ?").run(nowIso(), activeRow.id);
    addEvent({ taskId, actor: "orc", type: "run.stopped", text: "Stopped by user" });
    if (getTask(taskId)?.state !== "blocked") failTask(taskId, "Stopped by user");
    bus.emit("refresh");
    return true;
  }

  throw new Error(`${taskId} is not running`);
}

export { MAX_PIPELINE_STEPS };

export function maxConcurrency() {
  const envVal = Number(process.env.ORC_MAX_CONCURRENCY);
  if (Number.isFinite(envVal) && envVal >= 1) return Math.floor(envVal);
  const cfgVal = Number(loadConfig().maxConcurrency);
  if (Number.isFinite(cfgVal) && cfgVal >= 1) return Math.floor(cfgVal);
  return 2;
}

export function activeTaskForProject(projectId, excludeTaskId = null, active = running) {
  for (const entry of active.values()) {
    if (entry.projectId === projectId && entry.taskId !== excludeTaskId) {
      return entry.taskId;
    }
  }
  return null;
}

/**
 * Enforces the per-project single-run lock and global concurrency limit.
 */
export function checkConcurrency(task, project, active = running) {
  if (active.has(task.id)) {
    const error = new Error(`${task.id} is already running`);
    error.status = 409;
    throw error;
  }

  const activeOnProject = activeTaskForProject(project.id, task.id, active);
  if (activeOnProject) {
    const message = `Refused: project "${project.name}" already has an active run (${activeOnProject})`;
    addEvent({
      taskId: task.id,
      actor: "orc",
      type: "run.refused",
      text: message,
      data: { reason: "project_locked", activeTaskId: activeOnProject, projectId: project.id },
    });
    bus.emit("refresh");
    const error = new Error(message);
    error.status = 409;
    throw error;
  }

  const limit = maxConcurrency();
  if (active.size >= limit) {
    const runningIds = [...active.keys()];
    const message = `Refused: global concurrency limit (${limit}) reached (${runningIds.join(", ")})`;
    addEvent({
      taskId: task.id,
      actor: "orc",
      type: "run.refused",
      text: message,
      data: { reason: "max_concurrency", limit, running: runningIds },
    });
    bus.emit("refresh");
    const error = new Error(message);
    error.status = 409;
    throw error;
  }
}

/**
 * Scans registered projects for existing `.worktrees/<taskId>` directories and
 * reattaches missing paths, flags stale in-flight tasks, or reports orphans.
 */
export function recoverWorktrees() {
  const reapedRuns = reapDeadRuns();
  const relinked = [];
  const staleTasks = [];
  const orphaned = [];

  for (const project of listProjects()) {
    const worktreesRoot = path.join(project.path, ".worktrees");
    if (!existsSync(worktreesRoot)) continue;

    for (const entry of readdirSync(worktreesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(worktreesRoot, entry.name);
      const task = getTask(entry.name);

      if (task) {
        if (task.worktree !== fullPath) {
          updateTask(task.id, { worktree: fullPath });
          relinked.push({ taskId: task.id, worktree: fullPath });
          addEvent({
            taskId: task.id,
            actor: "orc",
            type: "worktree.recovered",
            text: `Reattached worktree ${fullPath}`,
          });
        }
        if (!running.has(task.id) && ["working", "review", "verify"].includes(task.state)) {
          staleTasks.push({ taskId: task.id, state: task.state, worktree: fullPath });
          addEvent({
            taskId: task.id,
            actor: "orc",
            type: "worktree.stale",
            text: `Stale in-flight worktree detected in state "${task.state}" at ${fullPath}`,
          });
        }
      } else {
        orphaned.push({ projectId: project.id, worktree: fullPath });
      }
    }
  }

  if (relinked.length || staleTasks.length || reapedRuns.length) bus.emit("refresh");
  return { relinked, staleTasks, orphaned, reapedRuns };
}

/**
 * Rebases a task branch onto baseBranch, fast-forwards baseBranch, archives
 * `.orc/<taskId>/` artifacts, cleans up the worktree and branch, and marks done.
 */
export async function mergeTask(taskId, { actor = "you" } = {}) {
  const task = getTask(taskId);
  if (!task) throw new Error(`Unknown task: ${taskId}`);
  if (running.has(taskId)) throw new Error(`${taskId} is currently running; stop it before merging.`);

  const project = resolveProject(task.project_id);
  if (!project) throw new Error(`Project "${task.project_id}" is not registered`);

  const activeOnProject = activeTaskForProject(project.id, taskId);
  if (activeOnProject) {
    throw new Error(`Project "${project.name}" has an active run (${activeOnProject}); wait or stop it before merging.`);
  }

  const base = project.baseBranch || "main";
  const branch = task.branch || `task/${task.id}-${task.slug}`;
  const worktree = task.worktree || path.join(project.path, ".worktrees", task.id);

  const refuseMerge = (message) => {
    addEvent({ taskId: task.id, actor: "orc", type: "merge.refused", text: message });
    bus.emit("refresh");
    const error = new Error(message);
    error.status = 409;
    throw error;
  };

  const branchCheck = await git(project.path, ["rev-parse", "--verify", `refs/heads/${branch}`], {
    allowFailure: true,
  });
  if (!branchCheck.ok) {
    throw new Error(`Task branch "${branch}" does not exist in ${project.name}.`);
  }

  const currentBranch = (
    await git(project.path, ["symbolic-ref", "--short", "HEAD"], { allowFailure: true })
  ).stdout.trim();
  if (currentBranch !== base) {
    refuseMerge(`Main worktree is on branch "${currentBranch || "(detached)"}", expected "${base}".`);
  }

  const mainStatus = await git(project.path, ["status", "--porcelain", "--untracked-files=no"]);
  const dirtyMain = mainStatus.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      const file = line.replace(/^[MADRCU?!]+\s+/, "");
      return file !== "docs/board.md";
    });
  if (dirtyMain.length) {
    refuseMerge(`Main worktree has uncommitted changes (${dirtyMain.join(", ")}). Commit or stash them before merging.`);
  }

  if (existsSync(worktree)) {
    const wtStatus = await git(worktree, ["status", "--porcelain", "--untracked-files=no"]);
    const dirtyWt = wtStatus.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (dirtyWt.length) {
      refuseMerge(`Task worktree has uncommitted changes (${dirtyWt.join(", ")}). Commit or discard them before merging.`);
    }

    const wtOrcRoot = path.join(worktree, ".orc");
    const wtArtifacts = path.join(wtOrcRoot, task.id);
    const projectArtifacts = path.join(project.path, ".orc", task.id);
    let archived = false;

    if (existsSync(wtArtifacts)) {
      ensureDir(path.dirname(projectArtifacts));
      cpSync(wtArtifacts, projectArtifacts, { recursive: true, force: true });
      archived = true;
    }
    if (existsSync(wtOrcRoot)) {
      rmSync(wtOrcRoot, { recursive: true, force: true });
    }

    const rebase = await git(worktree, ["rebase", base], { allowFailure: true });
    if (!rebase.ok) {
      await git(worktree, ["rebase", "--abort"], { allowFailure: true });
      if (archived && existsSync(projectArtifacts)) {
        ensureDir(wtOrcRoot);
        cpSync(projectArtifacts, wtArtifacts, { recursive: true, force: true });
      }
      refuseMerge(`Rebase of ${branch} onto ${base} failed with conflicts. Resolve manually in ${worktree}.`);
    }
  }

  const ff = await git(project.path, ["merge", "--ff-only", branch], { allowFailure: true });
  if (!ff.ok) {
    refuseMerge(`Fast-forward merge of ${branch} into ${base} failed: ${ff.stderr}`);
  }
  const head = (await git(project.path, ["rev-parse", "HEAD"])).stdout.trim();

  if (existsSync(worktree)) {
    await git(project.path, ["worktree", "remove", "--force", worktree], { allowFailure: true });
    if (existsSync(worktree)) rmSync(worktree, { recursive: true, force: true });
    await git(project.path, ["worktree", "prune"], { allowFailure: true });
  }
  await git(project.path, ["branch", "-d", branch]);

  updateTask(task.id, { worktree: null, last_error: null });
  addEvent({
    taskId: task.id,
    actor,
    type: "task.merged",
    text: `Merged ${branch} into ${base} (${head.slice(0, 7)}) and removed worktree`,
    data: { branch, base, head },
  });

  if (task.state !== "done") {
    setState(task.id, "done", { note: `Merged into ${base}`, actor });
  } else {
    syncBoard(project.id);
    bus.emit("refresh");
  }

  return getTask(task.id);
}

/**
 * Unregisters a project from orc.config.json after checking no run is active.
 */
export function unregisterProject(ref, active = running) {
  const project = resolveProject(ref);
  if (!project) throw new Error(`Unknown project: ${ref}`);
  const activeId = activeTaskForProject(project.id, null, active);
  if (activeId) {
    const error = new Error(
      `Project "${project.name}" has an active run (${activeId}); stop it before removing the project.`,
    );
    error.status = 409;
    throw error;
  }
  const removed = removeProject(project.id);
  bus.emit("refresh");
  return removed;
}

/**
 * Removes a task from the board and optionally deletes its worktree and archived `.orc/` folder.
 */
export async function removeTask(taskId, { cleanupWorktree = false, active = running } = {}) {
  const task = getTask(taskId);
  if (!task) throw new Error(`Unknown task: ${taskId}`);
  if (active.has(taskId)) {
    const error = new Error(`Stop ${taskId} before deleting it`);
    error.status = 409;
    throw error;
  }

  if (cleanupWorktree) {
    const project = resolveProject(task.project_id);
    if (task.worktree && existsSync(task.worktree)) {
      if (project && existsSync(project.path)) {
        await git(project.path, ["worktree", "remove", "--force", task.worktree], {
          allowFailure: true,
        });
        await git(project.path, ["worktree", "prune"], { allowFailure: true });
      }
      if (existsSync(task.worktree)) rmSync(task.worktree, { recursive: true, force: true });
    }
    const projectArtifacts = project ? path.join(project.path, ".orc", task.id) : null;
    if (projectArtifacts && existsSync(projectArtifacts)) {
      rmSync(projectArtifacts, { recursive: true, force: true });
    }
  }

  return deleteTask(taskId);
}

/**
 * Computes effective implementer, reviewer, models, tier, and YOLO state for UI display.
 */
export function taskRuntimeInfo(task, project = null) {
  const proj = project ?? resolveProject(task.project_id);
  const implementer = normalizeAgent(task.agent);
  const reviewer = reviewerFor(implementer, { project: proj });
  const tier = normalizeTier(task.tier);
  return {
    kind: task.kind === "research" ? "research" : "code",
    tier,
    implementer,
    reviewer,
    researchAgents: task.researchAgents?.length ? task.researchAgents : [implementer],
    implModel: modelFor(implementer, "impl", proj, task) || "default",
    reviewModel: modelFor(reviewer, "review", proj, task) || "default",
    agyYolo: yoloFor("agy", "impl"),
    codexYolo: yoloFor("codex", "impl"),
  };
}

/**
 * Drives one task until it reaches `done`, `blocked`, or a safety limit.
 * Every externally visible step is written to the events table so the UI can
 * reconstruct what happened even after a restart.
 */
export async function runTask(taskId, { actor = "you", skipDependencies = false } = {}) {
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

  if (!skipDependencies) {
    const deps = checkDependencies(task);
    if (!deps.ok) {
      const reasons = [];
      if (deps.blocked.length) reasons.push(`blocked: ${deps.blocked.join(", ")}`);
      if (deps.pending.length) reasons.push(`waiting on: ${deps.pending.join(", ")}`);
      if (deps.missing.length) reasons.push(`missing: ${deps.missing.join(", ")}`);
      const error = new Error(
        `${taskId} has unmet dependencies (${reasons.join("; ")}). Queue it with "orc queue ${taskId}" or finish upstream tasks first.`,
      );
      error.status = 409;
      throw error;
    }
  }

  const project = resolveProject(task.project_id);
  if (!project) throw new Error(`Project "${task.project_id}" is not registered`);
  checkConcurrency(task, project);

  const implementer = normalizeAgent(task.agent);
  const quota = checkQuotaGuardrail(implementer, task.id);
  if (quota.paused) {
    const error = new Error(quota.message);
    error.status = 429;
    error.quotaPaused = true;
    throw error;
  }

  const controller = { taskId, projectId: project.id, child: null, cancelled: false };
  running.set(taskId, controller);
  const reviewer = reviewerFor(implementer, { project });
  const startLabel =
    task.kind === "research"
      ? `Research started · ${(task.researchAgents?.length ? task.researchAgents : [implementer]).map(agentLabel).join(" + ")} (read-only)`
      : `Pipeline started · ${agentLabel(implementer)} (${task.tier || "med"}) implements, ${agentLabel(reviewer)} reviews`;
  addEvent({
    taskId,
    actor,
    type: "run.started",
    text: startLabel,
  });
  bus.emit("refresh");

  try {
    if (task.kind === "research") {
      await runResearchTask(task, project, controller);
      return getTask(taskId);
    }

    await provision(task, project);

    for (let step = 0; step < MAX_PIPELINE_STEPS; step += 1) {
      if (controller.cancelled) throw cancelledError();
      task = getTask(taskId);

      if (task.state === "done") break;
      if (task.state === "blocked") break;

      if (["specced", "queued", "working", "fixing"].includes(task.state)) {
        await implementStep(task, project, controller);
      } else if (task.state === "verify") {
        await verifyStep(task, project, controller);
      } else if (task.state === "review") {
        await reviewStep(task, project, controller);
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
    const finished = getTask(taskId);
    running.delete(taskId);
    controller.child = null;
    bus.emit("refresh");
    if (finished?.state === "done") {
      setImmediate(() => drainQueue(project.id));
    }
  }
}

export function reviewerFor(implementer, { env = process.env, health = null, project = null } = {}) {
  const normImpl = normalizeAgent(implementer);
  const opposite = normImpl === "agy" ? "claude" : normImpl === "codex" ? "claude" : "agy";
  const override = String(project?.reviewer || env.ORC_REVIEWER || "").trim().toLowerCase();
  if (override === "claude" || override === "agy" || override === "codex") return override;
  if (override === "same") return normImpl;
  if (override === "auto") {
    const detected = health ?? detectAgents();
    const candidates = [opposite, "claude", "agy", "codex"].filter((a, i, arr) => arr.indexOf(a) === i);
    for (const candidate of candidates) {
      if (candidate !== normImpl && detected[candidate]?.available) return candidate;
    }
    return normImpl;
  }
  return opposite;
}

export function modelFor(agent, role, project = null, task = null, { env = process.env } = {}) {
  const normAgent = normalizeAgent(agent);
  const effectiveTier = role === "review" ? "high" : normalizeTier(task?.tier);

  const taskModel = String(role === "review" ? task?.review_model ?? "" : task?.impl_model ?? "").trim();
  if (taskModel) return taskModel;

  const projectModel = String(role === "review" ? project?.reviewModel ?? "" : project?.implModel ?? "").trim();
  if (projectModel) return projectModel;

  const prefix = normAgent === "agy" ? "ORC_AGY" : normAgent === "codex" ? "ORC_CODEX" : "ORC_CLAUDE";
  const tierKey = `${prefix}_${effectiveTier.toUpperCase()}_MODEL`;
  if (env[tierKey]) return env[tierKey];

  const roleKey = role === "review" ? `${prefix}_REVIEW_MODEL` : `${prefix}_IMPL_MODEL`;
  if (env[roleKey]) return env[roleKey];

  const configTierModel = String(loadConfig()?.tiers?.[normAgent]?.[effectiveTier] ?? "").trim();
  if (configTierModel) return configTierModel;

  if (env[`${prefix}_MODEL`]) return env[`${prefix}_MODEL`];

  // Built-in plan-saver: when a task is explicitly marked tier=low on Claude,
  // route implementation to Sonnet unless disabled via ORC_TIER_DEFAULTS=0.
  if (
    normAgent === "claude" &&
    role !== "review" &&
    task?.tier === "low" &&
    env.ORC_TIER_DEFAULTS !== "0"
  ) {
    return "sonnet";
  }

  return null;
}

export function effortFor(agent, role, project = null, task = null, { env = process.env } = {}) {
  if (agent !== "agy") return null;
  const model = modelFor(agent, role, project, task, { env });
  // Orchestrator uses a fixed configuration and rejects --effort.
  if (model && model.includes("orchestrator")) return null;
  const effectiveTier = role === "review" ? "high" : normalizeTier(task?.tier);
  return env[`ORC_AGY_${effectiveTier.toUpperCase()}_EFFORT`] || env.ORC_AGY_EFFORT || null;
}

export function maxTrackedFileBytes() {
  const envVal = Number(process.env.ORC_MAX_FILE_BYTES);
  if (Number.isFinite(envVal) && envVal >= 1024) return Math.floor(envVal);
  return 5 * 1024 * 1024;
}

export function yoloFor(agent, role) {
  if (role !== "impl") return false;
  if (agent === "agy") return /^(1|true|yes)$/i.test(String(process.env.ORC_AGY_YOLO ?? "").trim());
  if (agent === "codex") return /^(1|true|yes)$/i.test(String(process.env.ORC_CODEX_YOLO ?? "").trim());
  return false;
}

export function compactHandoff(env = process.env) {
  return String(env.ORC_COMPACT_HANDOFF ?? "1").trim() !== "0";
}

function cancelledError() {
  const error = new Error("Stopped by user");
  error.cancelled = true;
  return error;
}

async function runResearchTask(task, project, controller) {
  ensureProjectGitignore(project);
  const artifactsDir = path.join(project.path, ".orc", task.id);
  const researchDir = path.join(project.path, "docs", "research");
  ensureDir(artifactsDir);
  ensureDir(researchDir);

  const sourceSpec = task.spec_path ? readText(task.spec_path, "") : `# ${task.title}\n`;
  writeFileSync(path.join(artifactsDir, "spec.md"), sourceSpec, "utf8");

  setState(task.id, "working", { note: "Read-only research started", actor: "orc" });

  const agents = task.researchAgents?.length ? task.researchAgents : [normalizeAgent(task.agent)];
  const outputs = [];

  for (const agent of agents) {
    if (controller.cancelled) throw cancelledError();
    const quota = checkQuotaGuardrail(agent, task.id);
    if (quota.paused) throw new Error(quota.message);

    const promptFile = `prompt-research-${agent}.md`;
    const prompt = buildResearchPrompt(task, project, agent);
    writeFileSync(path.join(artifactsDir, promptFile), prompt, "utf8");
    const cliPrompt = `Read and follow .orc/${task.id}/${promptFile}. Read-only mode: do not edit files or run shell commands.`;

    const model = modelFor(agent, "research", project, task);
    const runId = startRun(task.id, agent, "research", model);
    addEvent({
      taskId: task.id,
      runId,
      actor: agent,
      type: "agent.prompt",
      text: `Researching (${agentLabel(agent)}, read-only)`,
      data: { prompt: path.join(artifactsDir, promptFile), model: model || "default" },
    });

    const coalescer = createEventCoalescer(task.id, runId, agent);
    let result;
    try {
      result = await runAgent({
        agent,
        prompt: cliPrompt,
        cwd: project.path,
        mode: "plan",
        model,
        effort: effortFor(agent, "research", project, task),
        timeoutMs: AGENT_TIMEOUT_MS,
        taskId: task.id,
        runId,
        onSpawn: (child) => {
          controller.child = child;
          setRunPid(runId, child.pid);
        },
        onEvent: (event) => coalescer.push(event),
      });
    } catch (error) {
      coalescer.flush();
      controller.child = null;
      finishRun(runId, { code: -1, error: error.message });
      throw error;
    }
    coalescer.flush();
    controller.child = null;
    finishRun(runId, result, controller.cancelled);
    if (result.rateLimit) recordVendorQuota(agent, result.rateLimit);
    if (controller.cancelled) throw cancelledError();

    if (result.code !== 0 || result.error) {
      throw new Error(
        `${agentLabel(agent)} research failed (exit ${result.code})${result.error ? `: ${result.error}` : ""}\n${tail(result.text, 1500)}`,
      );
    }

    const noteHeader = [
      "---",
      `task: ${task.id}`,
      `title: ${task.title}`,
      `agent: ${agent}`,
      `date: ${today()}`,
      "kind: research-note",
      "---",
      "",
    ].join("\n");
    const noteBody = `${noteHeader}${result.text.trim()}\n`;
    const artifactNote = path.join(artifactsDir, `research-${agent}.md`);
    const docNote = uniquePath(path.join(researchDir, `${today()}-${task.slug}-${agent}.md`));
    writeFileSync(artifactNote, noteBody, "utf8");
    writeFileSync(docNote, noteBody, "utf8");
    outputs.push({ agent, text: result.text.trim(), artifactNote, docNote });
  }

  if (controller.cancelled) throw cancelledError();

  let briefText = "";
  if (outputs.length === 1) {
    briefText = outputs[0].text;
  } else {
    const synthAgent = reviewerFor(agents[0], { project });
    const synthModel = modelFor(synthAgent, "review", project, task);
    const synthPromptFile = "prompt-research-brief.md";
    const synthPrompt = buildResearchSynthesisPrompt(task, project, outputs);
    writeFileSync(path.join(artifactsDir, synthPromptFile), synthPrompt, "utf8");
    const runId = startRun(task.id, synthAgent, "synthesize", synthModel);
    const coalescer = createEventCoalescer(task.id, runId, synthAgent);

    let synthResult = null;
    try {
      synthResult = await runAgent({
        agent: synthAgent,
        prompt: `Read and follow .orc/${task.id}/${synthPromptFile}. Read-only mode: do not edit files or run shell commands.`,
        cwd: project.path,
        mode: "plan",
        model: synthModel,
        effort: effortFor(synthAgent, "review", project, task),
        timeoutMs: AGENT_TIMEOUT_MS,
        taskId: task.id,
        runId,
        onSpawn: (child) => {
          controller.child = child;
          setRunPid(runId, child.pid);
        },
        onEvent: (event) => coalescer.push(event),
      });
      coalescer.flush();
      controller.child = null;
      finishRun(runId, synthResult, controller.cancelled);
      if (synthResult.rateLimit) recordVendorQuota(synthAgent, synthResult.rateLimit);
      if (synthResult.code === 0 && !synthResult.error && synthResult.text.trim()) {
        briefText = synthResult.text.trim();
      }
    } catch {
      coalescer.flush();
      controller.child = null;
      finishRun(runId, { code: -1, error: "Synthesis fallback used" });
    }
    if (controller.cancelled) throw cancelledError();

    if (!briefText) {
      briefText = outputs
        .map((item) => `## ${agentLabel(item.agent)}\n${truncate(item.text, 2200)}`)
        .join("\n\n");
    }
  }

  const briefHeader = [
    "---",
    `task: ${task.id}`,
    `title: ${task.title}`,
    `agents: ${agents.join(",")}`,
    `date: ${today()}`,
    "kind: research-brief",
    "---",
    "",
    `# Brief · ${task.id} ${task.title}`,
    "",
  ].join("\n");
  const briefContent = `${briefHeader}${briefText.trim()}\n`;
  const artifactBrief = path.join(artifactsDir, "brief.md");
  const docBrief = uniquePath(path.join(researchDir, `${today()}-${task.slug}-brief.md`));
  writeFileSync(artifactBrief, briefContent, "utf8");
  writeFileSync(docBrief, briefContent, "utf8");

  updateTask(task.id, { last_error: null });
  addEvent({
    taskId: task.id,
    actor: "orc",
    type: "research.completed",
    text: `Brief written (${briefContent.split("\n").length} lines) → ${path.relative(project.path, docBrief).replaceAll("\\", "/")}`,
    data: { brief: docBrief, notes: outputs.map((o) => o.docNote) },
  });
  setState(task.id, "done", { note: "Research brief ready", actor: "orc" });
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

  const createdWorktree = !existsSync(worktree);
  if (createdWorktree) {
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

  if (createdWorktree && String(project.setupCommand ?? "").trim()) {
    const setupCmd = String(project.setupCommand).trim();
    addEvent({
      taskId: task.id,
      actor: "orc",
      type: "worktree.setup_started",
      text: setupCmd,
    });
    const setupResult = await runShell(setupCmd, {
      cwd: worktree,
      timeoutMs: TEST_TIMEOUT_MS,
    });
    writeFileSync(
      path.join(artifactsDir, "setup.log"),
      [`$ ${setupCmd}`, `cwd: ${worktree}`, `exit: ${setupResult.code}${setupResult.error ? ` (${setupResult.error})` : ""}`, "", setupResult.output, ""].join("\n"),
      "utf8",
    );
    if (setupResult.code !== 0 || setupResult.error) {
      throw new Error(
        `Worktree setupCommand failed (exit ${setupResult.code})${setupResult.error ? `: ${setupResult.error}` : ""}\n${tail(setupResult.output, 1200)}`,
      );
    }
    addEvent({
      taskId: task.id,
      actor: "orc",
      type: "worktree.setup_done",
      text: setupCmd,
    });
  }

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
        reviewer: reviewerFor(task.agent, { project }),
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
  const { worktree, artifactsDir } = await provision(task, project);
  const fixing = task.state === "fixing";
  const label = fixing ? "fix" : "implementation";

  setState(task.id, "working", {
    note: fixing ? "Applying review findings" : "Implementation agent started",
    actor: "orc",
  });

  const sessionId = task.session_id || null;
  const prompt = buildImplementPrompt(task, project, { fixing, worktree });
  const implementer = normalizeAgent(task.agent);
  const implModel = modelFor(implementer, "impl", project, task);
  const runId = startRun(task.id, implementer, label, implModel);

  const promptFile = fixing
    ? `prompt-fix-${Number(task.review_loops ?? 0) || 1}.md`
    : "prompt-implement.md";
  addEvent({
    taskId: task.id,
    runId,
    actor: implementer,
    type: "agent.prompt",
    text: fixing ? "Fixing review findings" : `Implementing spec (${task.tier || "med"}${implModel ? ` · ${implModel}` : ""})`,
    data: { prompt: path.join(artifactsDir, promptFile), model: implModel || "default" },
  });
  writeFileSync(path.join(artifactsDir, promptFile), prompt, "utf8");
  if (promptFile !== "prompt-implement.md") {
    writeFileSync(path.join(artifactsDir, "prompt-implement.md"), prompt, "utf8");
  }
  const fixFiles = [`.orc/${task.id}/${promptFile}`];
  if (fixing && existsSync(path.join(artifactsDir, "review.md"))) {
    fixFiles.push(`.orc/${task.id}/review.md`);
  }
  if (fixing && existsSync(path.join(artifactsDir, "test.log"))) {
    fixFiles.push(`.orc/${task.id}/test.log`);
  }
  const cliPrompt = fixing
    ? `Tests failed or reviewer requested changes. Read ${fixFiles.join(", ")}, apply fixes in this worktree.`
    : `Read and follow .orc/${task.id}/prompt-implement.md in this worktree.`;

  const before = (await git(worktree, ["rev-parse", "HEAD"], { allowFailure: true })).stdout.trim();
  const coalescer = createEventCoalescer(task.id, runId, implementer);

  let result;
  try {
    result = await runAgent({
      agent: implementer,
      prompt: cliPrompt,
      cwd: worktree,
      sessionId,
      mode: implementer === "agy" ? "accept-edits" : null,
      model: implModel,
      effort: effortFor(implementer, "impl", project, task),
      yolo: yoloFor(implementer, "impl"),
      timeoutMs: AGENT_TIMEOUT_MS,
      taskId: task.id,
      runId,
      onSpawn: (child) => {
        controller.child = child;
        setRunPid(runId, child.pid);
      },
      onEvent: (event) => coalescer.push(event),
    });
  } catch (error) {
    coalescer.flush();
    controller.child = null;
    finishRun(runId, { code: -1, error: error.message });
    throw error;
  }
  coalescer.flush();

  controller.child = null;
  finishRun(runId, result, controller.cancelled);
  if (result.rateLimit) recordVendorQuota(implementer, result.rateLimit);
  if (controller.cancelled) throw cancelledError();

  if (result.sessionId && result.sessionId !== task.session_id) {
    updateTask(task.id, { session_id: result.sessionId });
  }

  if (result.code !== 0 || result.error) {
    throw new Error(
      `${agentLabel(implementer)} ${label} failed (exit ${result.code})${result.error ? `: ${result.error}` : ""}\n${tail(result.text, 1500)}`,
    );
  }

  const { patch, head, omittedFiles } = await captureWork(worktree, task, project, label, before);
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
    text: `${patch.split("\n").length} lines of diff${omittedFiles?.length ? ` (${omittedFiles.length} ignored file(s) stat-only)` : ""}`,
    data: { head, omittedFiles: omittedFiles ?? [] },
  });

  const hasTest = Boolean(String(project.testCommand ?? "").trim());
  setState(task.id, "verify", {
    note: hasTest
      ? `${agentLabel(implementer)} ${label} complete · running test gate`
      : `${agentLabel(implementer)} ${label} complete · proceeding to ${agentLabel(reviewerFor(implementer, { project }))} review`,
    actor: "orc",
  });
}

async function reviewStep(task, project, controller) {
  if (!task.worktree) throw new Error("Task has no worktree; run the implementation step first.");
  const artifactsDir = path.join(task.worktree, ".orc", task.id);
  const reviewer = reviewerFor(task.agent, { project });
  const quota = checkQuotaGuardrail(reviewer, task.id);
  if (quota.paused) throw new Error(quota.message);

  const prompt = buildReviewPrompt(task, project);
  writeFileSync(path.join(artifactsDir, "prompt-review.md"), prompt, "utf8");
  const cliPrompt = `Read and follow .orc/${task.id}/prompt-review.md in this worktree.`;

  const reviewModel = modelFor(reviewer, "review", project, task);
  const runId = startRun(task.id, reviewer, "review", reviewModel);
  addEvent({
    taskId: task.id,
    runId,
    actor: reviewer,
    type: "agent.prompt",
    text: `Reviewing diff (${reviewModel || "default"})`,
    data: { model: reviewModel || "default" },
  });

  const coalescer = createEventCoalescer(task.id, runId, reviewer);
  let result;
  try {
    result = await runAgent({
      agent: reviewer,
      prompt: cliPrompt,
      cwd: task.worktree,
      mode: "plan",
      model: reviewModel,
      effort: effortFor(reviewer, "review", project, task),
      timeoutMs: AGENT_TIMEOUT_MS,
      taskId: task.id,
      runId,
      onSpawn: (child) => {
        controller.child = child;
        setRunPid(runId, child.pid);
      },
      onEvent: (event) => coalescer.push(event),
    });
  } catch (error) {
    coalescer.flush();
    controller.child = null;
    finishRun(runId, { code: -1, error: error.message });
    throw error;
  }
  coalescer.flush();

  controller.child = null;
  finishRun(runId, result, controller.cancelled);
  if (result.rateLimit) recordVendorQuota(reviewer, result.rateLimit);
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
    `- Reviewer: ${agentLabel(reviewer)}${reviewModel ? ` (${reviewModel})` : ""}`,
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
    setState(task.id, "done", { note: "Review approved", actor: "orc" });
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
  const reviewer = reviewerFor(task.agent, { project });
  if (!command) {
    updateTask(task.id, { last_error: null });
    setState(task.id, "review", {
      note: `No test command configured — proceeding to ${agentLabel(reviewer)} review`,
      actor: "orc",
    });
    return;
  }

  if (!task.worktree) throw new Error("Task has no worktree to verify.");
  const artifactsDir = path.join(task.worktree, ".orc", task.id);
  ensureDir(artifactsDir);
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
    setState(task.id, "review", {
      note: `Tests passed · ${agentLabel(reviewer)} will review`,
      actor: "orc",
    });
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

export function formatFixContext(reviewText, testText, { reviewMax = 6000, testMax = 3000 } = {}) {
  const sections = [];
  const cleanReview = String(reviewText ?? "").trim();
  const cleanTest = String(testText ?? "").trim();

  if (cleanReview) {
    sections.push(`### review.md\n${truncate(cleanReview, reviewMax)}`);
  }
  if (cleanTest) {
    const trimmedTest =
      cleanTest.length > testMax
        ? `[...earlier test output trimmed...]\n${cleanTest.slice(-testMax)}`
        : cleanTest;
    sections.push(`### test.log (tail)\n${trimmedTest}`);
  }
  return sections.join("\n\n");
}

export function buildImplementPrompt(task, project, { fixing, worktree }) {
  const artifacts = `.orc/${task.id}`;
  const testCommand = project.testCommand || "none";
  const compact = compactHandoff();

  const lines = compact
    ? [
        `TASK:${task.id}|${task.title}|TIER:${task.tier || "med"}`,
        `REPO:${project.name}|WT:${worktree}`,
        `READ:${artifacts}/spec.md, AGENTS.md (open only needed files)`,
        `MODE:${fixing ? "FIX(root-cause findings/test-fail; re-run checks)" : "IMPL(strict AC+constraints)"}`,
        `RULES:wt-only; no-.orc-edits; no-git-commit; smallest-safe-choice-if-ambiguous; TEST=${testCommand}`,
        `OUT:<=6 lines, zero filler prose. Format:`,
        `CHANGED:<comma-separated files>`,
        `RAN:<cmd:ok|fail>`,
        `OPEN:<none or blocker>`,
      ]
    : [
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
    const context = formatFixContext(review, test);
    lines.push("", "## Findings", "", context || "(none recorded)");
  }

  return `${lines.join("\n")}\n`;
}

export function buildReviewPrompt(task, project) {
  const artifacts = `.orc/${task.id}`;
  const hasTestLog = Boolean(task.worktree && existsSync(path.join(task.worktree, ".orc", task.id, "test.log")));
  const compact = compactHandoff();

  if (compact) {
    const lines = [
      `REVIEW:${task.id}|${task.title}|REPO:${project.name}`,
      "ROLE:read-only-reviewer. Do not modify files. Do not run shell commands (file-read tools only).",
      "READ:",
      `- Spec: ${artifacts}/spec.md`,
      `- Diff: ${artifacts}/diff.patch`,
      ...(hasTestLog ? [`- Test log: ${artifacts}/test.log`] : []),
      `- Meta: ${artifacts}/task.json`,
      "- AGENTS.md (rules check)",
      "CHECK:every AC met | diff scoped (no secrets/noise) | tests adequate | edge-cases/regressions",
      "OUT:terse machine-dense; zero prose or diff restatement; max 15 lines.",
      "FINDINGS format (omit if clean): `FILE:LINE|SEV(high|med|low)|ISSUE|FIX`",
      "FINAL LINE exact:",
      "VERDICT: APPROVE",
      "VERDICT: REQUEST CHANGES",
    ];
    return `${lines.join("\n")}\n`;
  }

  const lines = [
    `# Review ${task.id} — ${task.title}`,
    "",
    `Project: ${project.name}`,
    `You are the reviewer. Do not modify files and do not implement the task.`,
    "",
    "## Read",
    `- Spec: ${artifacts}/spec.md`,
    `- Diff: ${artifacts}/diff.patch`,
    ...(hasTestLog ? [`- Test log: ${artifacts}/test.log`] : []),
    `- Task metadata: ${artifacts}/task.json`,
    "- AGENTS.md, if it helps verify project rules.",
    "",
    "## Check",
    "- Every acceptance criterion is actually met.",
    "- The diff is scoped; no unrelated files, secrets, or generated artifacts.",
    `- Tests or checks are adequate. ${hasTestLog ? `Inspect ${artifacts}/test.log; do` : "Do"} not run shell commands (headless review uses file-read tools only).`,
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

export function buildResearchPrompt(task, project, agent) {
  const artifacts = `.orc/${task.id}`;
  return [
    `RESEARCH:${task.id}|${task.title}|REPO:${project.name}|AGENT:${agent}`,
    "ROLE:read-only codebase researcher. Do not modify files. Do not run shell commands.",
    `READ:${artifacts}/spec.md, AGENTS.md, then only relevant files.`,
    "OUT:dense agent-handoff brief (<=45 lines, zero filler prose, cite exact file:line).",
    "SECTIONS:",
    "## SUMMARY (<=5 bullets, facts only)",
    "## REFS (`path:line|symbol|role`)",
    "## CONSTRAINTS (invariants, configs, edge cases)",
    "## RISKS (gotchas, coupling, breaking areas)",
    "## SUBTASKS (ordered candidate ORC subtasks with target files)",
  ].join("\n") + "\n";
}

function buildResearchSynthesisPrompt(task, project, outputs) {
  const artifacts = `.orc/${task.id}`;
  const files = outputs.map((o) => `- ${artifacts}/research-${o.agent}.md`).join("\n");
  return [
    `SYNTH:${task.id}|${task.title}|REPO:${project.name}`,
    "ROLE:read-only research synthesizer. Do not modify files. Do not run shell commands.",
    "READ:",
    `- ${artifacts}/spec.md`,
    files,
    "TASK:Merge and deduplicate findings into ONE compact executive brief (<=45 lines, zero filler).",
    "SECTIONS: SUMMARY | REFS (`path:line|symbol|role`) | CONSTRAINTS | RISKS | SUBTASKS",
  ].join("\n") + "\n";
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

  // Guard against accidental binaries, build artifacts, or large telemetry dumps.
  const limitBytes = maxTrackedFileBytes();
  const stagedNames = await git(worktree, ["diff", "--cached", "--name-only", "--diff-filter=AM", "-z"]);
  const oversized = [];
  for (const rel of stagedNames.stdout.split("\0").filter(Boolean)) {
    const full = path.join(worktree, rel);
    if (!existsSync(full)) continue;
    try {
      const stats = statSync(full);
      if (stats.isFile() && stats.size > limitBytes) {
        oversized.push(`${rel} (${(stats.size / (1024 * 1024)).toFixed(2)} MB)`);
      }
    } catch {
      // Ignore vanished temp entries.
    }
  }
  if (oversized.length) {
    await git(worktree, ["reset", "-q"], { allowFailure: true });
    throw new Error(
      `Refused to commit oversized file(s) exceeding ${(limitBytes / (1024 * 1024)).toFixed(1)} MB: ${oversized.join(", ")}. Add them to .gitignore or raise ORC_MAX_FILE_BYTES.`,
    );
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
  const ignorePatterns = effectiveDiffIgnore(project);
  const excludes = ignorePatterns.map((pattern) => `:(exclude)${pattern}`);

  const allChangedRes = await git(worktree, ["diff", "--name-only", `${base}...HEAD`], {
    allowFailure: true,
  });
  const allChanged = allChangedRes.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  let patch = "";
  let omittedFiles = [];

  if (excludes.length && allChanged.length) {
    const keptNamesRes = await git(
      worktree,
      ["diff", "--name-only", `${base}...HEAD`, "--", ".", ...excludes],
      { allowFailure: true },
    );
    const keptSet = new Set(
      keptNamesRes.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    );
    omittedFiles = allChanged.filter((file) => !keptSet.has(file));

    const filteredDiff = await git(
      worktree,
      ["diff", `${base}...HEAD`, "--", ".", ...excludes],
      { maxBuffer: 32 * 1024 * 1024 },
    );

    if (omittedFiles.length) {
      const statRes = await git(worktree, ["diff", "--stat", `${base}...HEAD`], { allowFailure: true });
      const header = [
        `# diff --stat (omitted from patch via diffIgnore: ${omittedFiles.join(", ")})`,
        statRes.stdout.trim(),
        "",
      ].join("\n");
      patch = filteredDiff.stdout.trim() ? `${header}${filteredDiff.stdout}` : `${header}`;
    } else {
      patch = filteredDiff.stdout;
    }
  } else {
    const diff = await git(worktree, ["diff", `${base}...HEAD`], { maxBuffer: 32 * 1024 * 1024 });
    patch = diff.stdout;
  }

  return { patch, head, before, omittedFiles };
}

function startRun(taskId, agent, step, model = null) {
  const runId = `R-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  db.prepare(
    `INSERT INTO runs (id, task_id, agent, step, model, status, started_at)
     VALUES (?, ?, ?, ?, ?, 'running', ?)`,
  ).run(runId, taskId, agent, step, model || null, nowIso());
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
  const usage = result.usage ?? null;
  db.prepare(
    `UPDATE runs
     SET status = ?, ended_at = ?, exit_code = ?,
         input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, thinking_tokens = ?, cost_usd = ?
     WHERE id = ?`,
  ).run(
    status,
    nowIso(),
    result.code ?? null,
    usage?.inputTokens || null,
    usage?.outputTokens || null,
    usage?.cacheReadTokens || null,
    usage?.thinkingTokens || null,
    usage?.costUsd ?? null,
    runId,
  );
}

/**
 * Coalesces consecutive agent text deltas to prevent per-token SQLite/SSE flooding.
 */
export function createEventCoalescer(
  taskId,
  runId,
  agent,
  { flushMs = 400, maxChars = 1000, emit = recordAgentEvent } = {},
) {
  let buffer = "";
  let timer = null;

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!buffer) return;
    const text = buffer;
    buffer = "";
    emit(taskId, runId, agent, { kind: "text", text });
  };

  const push = (event) => {
    if (event?.kind === "text" && typeof event.text === "string") {
      buffer += event.text;
      if (buffer.length >= maxChars) {
        flush();
      } else if (!timer && flushMs > 0) {
        timer = setTimeout(flush, flushMs);
        timer.unref?.();
      }
      return;
    }
    flush();
    emit(taskId, runId, agent, event);
  };

  return { push, flush };
}

function recordAgentEvent(taskId, runId, agent, event) {
  const kind = event.kind || "event";
  if (kind === "rate_limit" && event.data) {
    recordVendorQuota(agent, event.data);
  }
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
