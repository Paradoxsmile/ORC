import { EventEmitter } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { db, nextTaskId, tx } from "./db.js";
import { ROOT, listProjects, resolveProject } from "./config.js";
import { detectAgents } from "./agents.js";
import {
  ensureDir,
  nowIso,
  readText,
  renderTemplate,
  slugify,
  today,
  truncate,
  uniquePath,
} from "./util.js";

export const STATES = [
  "inbox",
  "specced",
  "queued",
  "working",
  "review",
  "fixing",
  "verify",
  "done",
  "blocked",
];

export const TIERS = ["low", "med", "high"];
export const KINDS = ["code", "research"];
export const AGENTS = ["claude", "agy", "codex"];

export const bus = new EventEmitter();

const TASK_FIELDS = new Set([
  "state",
  "agent",
  "kind",
  "tier",
  "depends_on",
  "impl_model",
  "review_model",
  "research_agents",
  "branch",
  "worktree",
  "spec_path",
  "session_id",
  "conversation_id",
  "review_verdict",
  "review_loops",
  "last_error",
]);

export function normalizeAgent(value) {
  const clean = String(value ?? "").trim().toLowerCase();
  return AGENTS.includes(clean) ? clean : "claude";
}

export function normalizeTier(value) {
  const clean = String(value ?? "").trim().toLowerCase();
  return TIERS.includes(clean) ? clean : "med";
}

export function normalizeKind(value) {
  const clean = String(value ?? "").trim().toLowerCase();
  return KINDS.includes(clean) ? clean : "code";
}

export function normalizeDependsOn(value) {
  const items = Array.isArray(value)
    ? value
    : String(value ?? "")
        .split(/[\s,]+/)
        .filter(Boolean);
  const clean = [...new Set(items.map((item) => String(item).trim().toUpperCase()).filter(Boolean))];
  return clean.length ? clean.join(",") : null;
}

export function parseDependsOn(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
}

export function normalizeResearchAgents(value, fallbackAgent = "claude") {
  const items = Array.isArray(value)
    ? value
    : String(value ?? "")
        .split(/[\s,]+/)
        .filter(Boolean);
  const valid = [...new Set(items.map((a) => String(a).trim().toLowerCase()).filter((a) => AGENTS.includes(a)))];
  if (valid.length) return valid.join(",");
  return normalizeAgent(fallbackAgent);
}

function template(name) {
  return readText(path.join(ROOT, "templates", name));
}

function normalizeAcceptance(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "- [ ] ...";
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (/^[-*]\s/.test(line) ? line : `- [ ] ${line}`))
    .join("\n");
}

export function addEvent({
  taskId = null,
  runId = null,
  actor = "orc",
  type = "note",
  text = "",
  data = null,
}) {
  const ts = nowIso();
  const info = db
    .prepare("INSERT INTO events (task_id, run_id, ts, actor, type, text, data) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(taskId, runId, ts, actor, type, text, data == null ? null : JSON.stringify(data));
  const event = {
    id: Number(info.lastInsertRowid),
    taskId,
    runId,
    ts,
    actor,
    type,
    text,
    data,
  };
  bus.emit("event", event);
  return event;
}

export function createTask({
  projectId,
  title,
  description = "",
  acceptance = "",
  agent = "claude",
  kind = "code",
  tier = "med",
  dependsOn = null,
  implModel = "",
  reviewModel = "",
  researchAgents = null,
}) {
  const project = resolveProject(projectId);
  if (!project) throw new Error(`Unknown project: ${projectId}`);
  const cleanTitle = String(title ?? "").trim();
  if (!cleanTitle) throw new Error("Title is required");

  const normKind = normalizeKind(kind);
  const normAgent = normalizeAgent(agent);
  const normTier = normalizeTier(tier);
  const normDepends = normalizeDependsOn(dependsOn);
  const normImplModel = String(implModel ?? "").trim() || null;
  const normReviewModel = String(reviewModel ?? "").trim() || null;
  const normResearchAgents =
    normKind === "research" ? normalizeResearchAgents(researchAgents, normAgent) : null;

  const slug = slugify(cleanTitle);
  const id = nextTaskId();
  const branch = normKind === "research" ? null : `task/${id}-${slug}`;
  const specPath =
    normKind === "research"
      ? uniquePath(path.join(project.path, "docs", "research", `${today()}-${slug}-question.md`))
      : uniquePath(path.join(project.path, "docs", "specs", `${today()}-${slug}.md`));
  const state =
    normKind === "research" || description.trim() || acceptance.trim() ? "specced" : "inbox";

  const spec =
    normKind === "research"
      ? [
          "---",
          `title: ${cleanTitle}`,
          "kind: research",
          "status: active",
          `created: ${today()}`,
          `agents: ${normResearchAgents}`,
          `tier: ${normTier}`,
          "---",
          "",
          `# Research · ${cleanTitle}`,
          "",
          "## Question",
          description.trim() || cleanTitle,
          "",
          "## Focus / Constraints",
          acceptance.trim() ? normalizeAcceptance(acceptance) : "- [ ] Return cited file:line findings and a concise brief",
          "",
        ].join("\n")
      : renderTemplate(template("spec.md"), {
          TITLE: cleanTitle,
          DATE: today(),
          AGENT: normAgent,
          BRANCH: branch,
          DESCRIPTION:
            description.trim() || "_Describe the problem: what hurts, for whom, why now._",
          ACCEPTANCE: normalizeAcceptance(acceptance),
        }).replace("status: draft", `status: ${state === "specced" ? "active" : "draft"}`);

  ensureDir(path.dirname(specPath));
  writeFileSync(specPath, spec, "utf8");

  const ts = nowIso();
  db.prepare(
    `INSERT INTO tasks
      (id, project_id, title, slug, state, agent, kind, tier, depends_on, impl_model, review_model, research_agents, branch, spec_path, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    project.id,
    cleanTitle,
    slug,
    state,
    normAgent,
    normKind,
    normTier,
    normDepends,
    normImplModel,
    normReviewModel,
    normResearchAgents,
    branch,
    specPath,
    ts,
    ts,
  );

  addEvent({
    taskId: id,
    actor: "you",
    type: "task.created",
    text: `Created ${id} (${normKind}/${normTier}) in ${state}`,
    data: { project: project.name, specPath, kind: normKind, tier: normTier, dependsOn: normDepends },
  });
  syncBoard(project.id);
  bus.emit("refresh");
  return getTask(id);
}

export function getTask(id) {
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
  return row ? hydrate(row) : null;
}

export function updateTask(id, patch) {
  const keys = Object.keys(patch).filter((key) => TASK_FIELDS.has(key));
  if (!keys.length) return getTask(id);
  keys.push("updated_at");
  const values = keys.map((key) => (key === "updated_at" ? nowIso() : patch[key]));
  db.prepare(`UPDATE tasks SET ${keys.map((key) => `${key} = ?`).join(", ")} WHERE id = ?`).run(
    ...values,
    id,
  );
  return getTask(id);
}

export function setState(id, state, { note = "", actor = "orc" } = {}) {
  if (!STATES.includes(state)) throw new Error(`Unknown state: ${state}`);
  const task = getTask(id);
  if (!task) throw new Error(`Unknown task: ${id}`);
  const from = task.state;
  updateTask(id, { state });
  addEvent({
    taskId: id,
    actor,
    type: "state",
    text: `${from} → ${state}${note ? ` · ${note}` : ""}`,
    data: { from, to: state, note },
  });
  syncBoard(task.project_id);
  bus.emit("refresh");
  return getTask(id);
}

export function failTask(id, message) {
  const text = truncate(message || "Unknown failure", 1000);
  updateTask(id, { last_error: text });
  return setState(id, "blocked", { note: truncate(text, 500), actor: "orc" });
}

/**
 * Deletes a task and its events/runs from SQLite and refreshes board summaries.
 */
export function deleteTask(id) {
  const task = getTask(id);
  if (!task) throw new Error(`Unknown task: ${id}`);
  tx(() => {
    db.prepare("DELETE FROM events WHERE task_id = ?").run(id);
    db.prepare("DELETE FROM runs WHERE task_id = ?").run(id);
    db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
  });
  syncBoard(task.project_id);
  syncStatus();
  bus.emit("refresh");
  return task;
}

export function getTaskUsage(taskId) {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
         COALESCE(SUM(thinking_tokens), 0) AS thinking_tokens,
         SUM(cost_usd) AS cost_usd,
         COUNT(*) AS run_count
       FROM runs
       WHERE task_id = ? AND agent != 'shell'`,
    )
    .get(taskId);
  const inputTokens = Number(row?.input_tokens ?? 0);
  const outputTokens = Number(row?.output_tokens ?? 0);
  const cacheReadTokens = Number(row?.cache_read_tokens ?? 0);
  const thinkingTokens = Number(row?.thinking_tokens ?? 0);
  const costUsd = row?.cost_usd === null || row?.cost_usd === undefined ? null : Number(row.cost_usd);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    thinkingTokens,
    totalTokens: inputTokens + outputTokens + thinkingTokens,
    costUsd,
    runCount: Number(row?.run_count ?? 0),
  };
}

export function getState() {
  const projects = listProjects();
  const byId = new Map(projects.map((project) => [project.id, project]));

  const usageByTask = new Map();
  const usageRows = db
    .prepare(
      `SELECT task_id,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
         COALESCE(SUM(thinking_tokens), 0) AS thinking_tokens,
         SUM(cost_usd) AS cost_usd
       FROM runs
       WHERE agent != 'shell'
       GROUP BY task_id`,
    )
    .all();
  for (const row of usageRows) {
    const inputTokens = Number(row.input_tokens ?? 0);
    const outputTokens = Number(row.output_tokens ?? 0);
    const cacheReadTokens = Number(row.cache_read_tokens ?? 0);
    const thinkingTokens = Number(row.thinking_tokens ?? 0);
    usageByTask.set(row.task_id, {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      thinkingTokens,
      totalTokens: inputTokens + outputTokens + thinkingTokens,
      costUsd: row.cost_usd === null || row.cost_usd === undefined ? null : Number(row.cost_usd),
    });
  }

  const hydratedProjects = projects.map((project) => {
    const rows = db
      .prepare("SELECT state, COUNT(*) AS n FROM tasks WHERE project_id = ? GROUP BY state")
      .all(project.id);
    const counts = Object.fromEntries(STATES.map((state) => [state, 0]));
    for (const row of rows) counts[row.state] = Number(row.n);
    const active = counts.working + counts.review + counts.fixing + counts.verify;
    return {
      ...project,
      counts,
      active,
      queued: counts.queued,
      blocked: counts.blocked,
      done: counts.done,
      total: Object.values(counts).reduce((sum, n) => sum + n, 0),
    };
  });

  const tasks = db
    .prepare(
      `SELECT t.*,
        (SELECT e.text FROM events e WHERE e.task_id = t.id ORDER BY e.id DESC LIMIT 1) AS last_event,
        (SELECT e.ts FROM events e WHERE e.task_id = t.id ORDER BY e.id DESC LIMIT 1) AS last_event_at
       FROM tasks t
       ORDER BY t.updated_at DESC`,
    )
    .all()
    .map((row) => ({
      ...hydrate(row),
      projectName: byId.get(row.project_id)?.name ?? row.project_id,
      usage: usageByTask.get(row.id) ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        thinkingTokens: 0,
        totalTokens: 0,
        costUsd: null,
      },
    }));

  return {
    projects: hydratedProjects,
    tasks,
    health: detectAgents(),
    generatedAt: nowIso(),
  };
}

export function getTaskDetail(id) {
  const task = getTask(id);
  if (!task) throw new Error(`Unknown task: ${id}`);
  const project = resolveProject(task.project_id);
  const spec = task.spec_path ? readText(task.spec_path) : "";

  const worktreeArtifacts = task.worktree ? path.join(task.worktree, ".orc", task.id) : null;
  const projectArtifacts = project ? path.join(project.path, ".orc", task.id) : null;
  const artifactsDir =
    worktreeArtifacts && existsSync(worktreeArtifacts)
      ? worktreeArtifacts
      : projectArtifacts && existsSync(projectArtifacts)
        ? projectArtifacts
        : worktreeArtifacts || projectArtifacts;
  const reviewPath = artifactsDir ? path.join(artifactsDir, "review.md") : null;
  const diffPath = artifactsDir ? path.join(artifactsDir, "diff.patch") : null;
  const testPath = artifactsDir ? path.join(artifactsDir, "test.log") : null;
  const briefPath = artifactsDir ? path.join(artifactsDir, "brief.md") : null;

  const events = db
    .prepare(
      `SELECT * FROM (
         SELECT * FROM events WHERE task_id = ? ORDER BY id DESC LIMIT 500
       ) ORDER BY id ASC`,
    )
    .all(id)
    .map((event) => ({
      ...event,
      data: event.data ? safeParse(event.data) : null,
    }));

  const runs = db
    .prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 20")
    .all(id);

  return {
    task,
    project,
    spec,
    review: reviewPath ? readText(reviewPath) : "",
    diff: diffPath ? readText(diffPath) : "",
    test: testPath ? readText(testPath) : "",
    brief: briefPath ? readText(briefPath) : "",
    events,
    runs,
    usage: getTaskUsage(id),
    artifacts: {
      dir: artifactsDir,
      review: reviewPath,
      diff: diffPath,
      test: testPath,
      brief: briefPath,
      reviewExists: reviewPath ? existsSync(reviewPath) : false,
      diffExists: diffPath ? existsSync(diffPath) : false,
      testExists: testPath ? existsSync(testPath) : false,
      briefExists: briefPath ? existsSync(briefPath) : false,
    },
  };
}

export function saveSpec(id, content) {
  const task = getTask(id);
  if (!task) throw new Error(`Unknown task: ${id}`);
  if (!task.spec_path) throw new Error(`Task ${id} has no spec file`);
  writeFileSync(task.spec_path, String(content ?? ""), "utf8");
  addEvent({ taskId: id, actor: "you", type: "spec.saved", text: "Spec updated" });
  if (task.state === "inbox") {
    setState(id, "specced", { note: "Spec written", actor: "you" });
  } else {
    syncBoard(task.project_id);
    bus.emit("refresh");
  }
  return getTaskDetail(id);
}

export function syncBoard(projectId) {
  const project = resolveProject(projectId);
  if (!project) return;

  const tasks = db
    .prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY updated_at DESC")
    .all(projectId);
  const counts = Object.fromEntries(STATES.map((state) => [state, 0]));
  for (const task of tasks) counts[task.state] = (counts[task.state] ?? 0) + 1;

  const rows = tasks
    .map((task) => {
      const spec = task.spec_path
        ? path.relative(path.join(project.path, "docs"), task.spec_path).replaceAll("\\", "/")
        : "";
      const title = String(task.title).replaceAll("|", "\\|");
      const link = spec ? `[${title}](${spec})` : title;
      const updated = task.updated_at ? task.updated_at.slice(0, 16).replace("T", " ") : "";
      return `| ${task.id} | ${link} | ${task.state} | ${task.agent} | \`${task.branch ?? ""}\` | ${updated} |`;
    })
    .join("\n");

  const markdown = `# Board — ${project.name}

_Generated by ORC · ${nowIso()}_

**${counts.working + counts.review + counts.fixing + counts.verify} active · ${counts.queued ?? 0} queued · ${counts.blocked} blocked · ${counts.done} done**

| Task | Title | State | Agent | Branch | Updated |
| --- | --- | --- | --- | --- | --- |
${rows || "| — | _No tasks yet_ | — | — | — | — |"}
`;

  const docsDir = path.join(project.path, "docs");
  ensureDir(docsDir);
  writeFileSync(path.join(docsDir, "board.md"), markdown, "utf8");
  syncStatus();
}

export function syncStatus() {
  const { projects, tasks } = getState();
  const active = tasks.filter((task) =>
    ["working", "review", "fixing", "verify"].includes(task.state),
  );
  const blocked = tasks.filter((task) => task.state === "blocked");

  const projectRows = projects
    .map(
      (project) =>
        `| ${project.name} | ${project.active} | ${project.counts.review} | ${project.blocked} | ${project.done} | ${project.total} |`,
    )
    .join("\n");

  const activeRows = active
    .map((task) => `| ${task.id} | ${task.projectName} | ${task.state} | ${task.agent} | ${truncate(task.last_event ?? "", 90)} |`)
    .join("\n");

  const markdown = `# ORC status

_Generated by ORC · ${nowIso()}_

| Project | Active | Review | Blocked | Done | Total |
| --- | --- | --- | --- | --- | --- |
${projectRows || "| — | — | — | — | — | — |"}

## Active tasks

| Task | Project | State | Agent | Last event |
| --- | --- | --- | --- | --- |
${activeRows || "| — | — | — | — | — |"}

## Needs a human

${blocked.length ? blocked.map((task) => `- **${task.id}** ${task.title} — ${task.last_error ?? task.last_event ?? ""}`).join("\n") : "_Nothing blocked._"}
`;

  writeFileSync(path.join(ROOT, "STATUS.md"), markdown, "utf8");
}

export function syncAll() {
  for (const project of listProjects()) syncBoard(project.id);
  syncStatus();
}

function hydrate(row) {
  if (!row) return null;
  return {
    ...row,
    kind: normalizeKind(row.kind),
    tier: normalizeTier(row.tier),
    dependsOn: parseDependsOn(row.depends_on),
    researchAgents: row.research_agents
      ? String(row.research_agents)
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
      : [],
    review_loops: Number(row.review_loops ?? 0),
    projectName: resolveProject(row.project_id)?.name ?? row.project_id,
  };
}

function safeParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
