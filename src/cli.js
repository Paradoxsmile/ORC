import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { agentLabel, detectAgents } from "./agents.js";
import {
  bus,
  createTask,
  failTask,
  getState,
  getTask,
  normalizeAgent,
  setState,
  STATES,
  syncAll,
} from "./board.js";
import {
  CONFIG_PATH,
  DATA_DIR,
  ROOT,
  addProject,
  initProject,
  listProjects,
  loadConfig,
  resolveProject,
} from "./config.js";
import {
  getQuotaSnapshot,
  mergeTask,
  queueTask,
  recoverWorktrees,
  removeTask,
  runningTaskIds,
  runTask,
  stopTask,
  unregisterProject,
} from "./dispatch.js";
import { openTarget, revealFile } from "./open.js";
import { truncate } from "./util.js";

const VALUE_FLAGS = new Set([
  "desc",
  "description",
  "accept",
  "agent",
  "agents",
  "tier",
  "kind",
  "type",
  "depends-on",
  "diff-ignore",
  "name",
  "path",
  "branch",
  "base",
  "test",
  "setup",
  "reviewer",
  "impl-model",
  "review-model",
  "port",
  "note",
]);

export async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help) {
    printHelp();
    return;
  }
  const command = positional[0] ?? "help";

  switch (command) {
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;

    case "serve":
    case "start": {
      const { startServer } = await import("./server.js");
      const config = loadConfig();
      const port = Number(flags.port ?? config.port) || 4317;
      const server = startServer({ port });
      server.on("error", (error) => {
        if (error.code === "EADDRINUSE") {
          console.error(`Port ${port} is already in use. Try: node bin/orc.js serve --port 4318`);
        } else {
          console.error(error.message);
        }
        process.exitCode = 1;
      });
      server.on("listening", () => {
        const actual = server.address();
        const address = typeof actual === "object" && actual ? actual.port : port;
        console.log("");
        console.log(`  ORC — mission control`);
        console.log(`  http://127.0.0.1:${address}`);
        console.log(`  ${listProjects().length} project(s) · ${runningTaskIds().length} running`);
        console.log(`  Ctrl+C to stop`);
        console.log("");
      });
      return;
    }

    case "add": {
      const projectRef = positional[1];
      const title = positional.slice(2).join(" ").trim();
      if (!projectRef || !title) {
        throw new Error(
          'Usage: node bin/orc.js add <project> "<title>" --desc "..." --accept "- ..." [--agent claude|agy|codex] [--tier low|med|high] [--depends-on T-0001]',
        );
      }
      const project = resolveProject(projectRef);
      if (!project) {
        throw new Error(
          `Unknown project "${projectRef}". Register it: node bin/orc.js project add <path> --name "${projectRef}"`,
        );
      }
      const task = createTask({
        projectId: project.id,
        title,
        description: String(flags.desc ?? flags.description ?? ""),
        acceptance: String(flags.accept ?? ""),
        agent: normalizeAgent(flags.agent),
        kind: String(flags.kind ?? flags.type ?? "code"),
        tier: String(flags.tier ?? "med"),
        dependsOn: flags["depends-on"] ?? null,
        implModel: String(flags["impl-model"] ?? ""),
        reviewModel: String(flags["review-model"] ?? ""),
        researchAgents: flags.agents ?? null,
      });
      console.log(`Created ${task.id} · ${task.state} (${task.kind}/${task.tier})`);
      console.log(`  project : ${project.name}`);
      console.log(`  agent   : ${agentLabel(task.agent)}`);
      console.log(`  spec    : ${task.spec_path}`);
      if (task.branch) console.log(`  branch  : ${task.branch}`);
      if (task.depends_on) console.log(`  depends : ${task.depends_on}`);
      if (task.state === "inbox") {
        console.log(`  next    : write the spec, then run ${task.id}`);
      } else if (task.depends_on) {
        console.log(`  next    : node bin/orc.js queue ${task.id}`);
      } else {
        console.log(`  next    : node bin/orc.js run ${task.id}`);
      }
      return;
    }

    case "research": {
      const projectRef = positional[1];
      const question = positional.slice(2).join(" ").trim();
      if (!projectRef || !question) {
        throw new Error(
          'Usage: node bin/orc.js research <project> "<question>" [--agents claude,agy] [--tier low|med|high] [--run]',
        );
      }
      const project = resolveProject(projectRef);
      if (!project) {
        throw new Error(
          `Unknown project "${projectRef}". Register it: node bin/orc.js project add <path> --name "${projectRef}"`,
        );
      }
      const primaryAgent = normalizeAgent(
        flags.agent || String(flags.agents ?? "claude").split(",")[0],
      );
      const task = createTask({
        projectId: project.id,
        title: question,
        description: String(flags.desc ?? flags.description ?? question),
        acceptance: String(flags.accept ?? ""),
        agent: primaryAgent,
        kind: "research",
        tier: String(flags.tier ?? "med"),
        researchAgents: flags.agents ?? primaryAgent,
      });
      console.log(`Created research ${task.id} · ${task.state}`);
      console.log(`  project : ${project.name}`);
      console.log(`  agents  : ${(task.researchAgents || [task.agent]).join(", ")}`);
      console.log(`  spec    : ${task.spec_path}`);
      if (flags.run) {
        console.log(`Running research ${task.id}…`);
        const final = await runTask(task.id);
        console.log(`${final.id} · ${final.state}`);
        if (final.state === "blocked") process.exitCode = 1;
      } else {
        console.log(`  next    : node bin/orc.js run ${task.id}`);
      }
      return;
    }

    case "queue": {
      const id = positional[1];
      if (!id) throw new Error("Usage: node bin/orc.js queue <taskId>");
      const task = queueTask(id, { actor: "you", autoDrain: !flags["no-drain"] });
      console.log(`Queued ${task.id} · ${task.title}`);
      if (task.depends_on) console.log(`  depends : ${task.depends_on}`);
      return;
    }

    case "list": {
      const state = getState();
      const filter = positional[1];
      let tasks = state.tasks;
      if (filter) {
        const project = resolveProject(filter);
        const needle = (project?.id ?? filter).toLowerCase();
        tasks = tasks.filter((task) => task.project_id.toLowerCase() === needle);
      }
      if (!tasks.length) {
        console.log("No tasks. Add one: node bin/orc.js add <project> \"<title>\" --desc \"...\"");
        return;
      }
      console.log(`${pad("ID", 8)}${pad("STATE", 10)}${pad("TIER", 6)}${pad("PROJECT", 18)}${pad("AGENT", 9)}${pad("UPDATED", 18)}TITLE`);
      console.log("-".repeat(106));
      for (const task of tasks) {
        const kindTag = task.kind === "research" ? "[R] " : "";
        console.log(
          `${pad(task.id, 8)}${pad(task.state, 10)}${pad(task.tier || "med", 6)}${pad(task.projectName, 18)}${pad(task.agent, 9)}${pad(
            String(task.updated_at ?? "").slice(0, 16).replace("T", " "),
            18,
          )}${truncate(`${kindTag}${task.title}`, 56)}`,
        );
      }
      console.log("");
      console.log(`${tasks.length} task(s) · ${runningTaskIds().length} running now`);
      return;
    }

    case "run": {
      const id = positional[1];
      if (!id) throw new Error("Usage: node bin/orc.js run <taskId>");
      const onEvent = (event) => {
        if (event.taskId !== id) return;
        if (event.type === "state") {
          console.log(`  · ${event.text}`);
        } else if (event.type === "review.approved") {
          console.log("  · review approved");
        } else if (event.type === "review.changes_requested") {
          console.log(`  · ${event.text}`);
        } else if (event.type === "verify.failed") {
          console.log(`  · tests failed: ${event.text}`);
        } else if (event.type === "run.failed") {
          console.error(`  ! ${event.text}`);
        }
      };
      bus.on("event", onEvent);
      console.log(`Running ${id}…`);
      try {
        const task = await runTask(id);
        console.log("");
        console.log(`${task.id} · ${task.state} · ${task.title}`);
        if (task.last_error) console.log(`  ${task.last_error}`);
        if (task.worktree) console.log(`  worktree: ${task.worktree}`);
        if (task.branch) console.log(`  branch  : ${task.branch}`);
        if (task.state === "blocked") process.exitCode = 1;
      } finally {
        bus.off("event", onEvent);
      }
      return;
    }

    case "stop": {
      const id = positional[1];
      if (!id) throw new Error("Usage: node bin/orc.js stop <taskId>");
      stopTask(id);
      console.log(`Stopping ${id}…`);
      return;
    }

    case "merge": {
      const id = positional[1];
      if (!id) throw new Error("Usage: node bin/orc.js merge <taskId>");
      const task = await mergeTask(id, { actor: "you" });
      console.log(`Merged ${task.id} → ${task.state}`);
      console.log(`  branch  : ${task.branch} (removed)`);
      console.log(`  worktree: cleaned up`);
      return;
    }

    case "delete": {
      const id = positional[1];
      if (!id) throw new Error("Usage: node bin/orc.js delete <taskId> [--clean]");
      const deleted = await removeTask(id, { cleanupWorktree: Boolean(flags.clean) });
      console.log(`Deleted ${deleted.id} (${deleted.title})`);
      return;
    }

    case "install":
    case "install-skill": {
      const { installOrc, printInstallResult } = await import("../scripts/install-skill.mjs");
      const result = installOrc();
      printInstallResult(result);
      return;
    }

    case "done": {
      const id = positional[1];
      if (!id) throw new Error("Usage: node bin/orc.js done <taskId> [--note \"...\"]");
      const task = setState(id, "done", {
        note: String(flags.note ?? "Marked done from CLI"),
        actor: "you",
      });
      console.log(`${task.id} → done`);
      return;
    }

    case "block": {
      const id = positional[1];
      if (!id) throw new Error("Usage: node bin/orc.js block <taskId> [--note \"...\"]");
      const note = String(flags.note ?? positional.slice(2).join(" ") ?? "").trim();
      const task = failTask(id, note || "Blocked from CLI");
      console.log(`${task.id} → blocked`);
      return;
    }

    case "state": {
      const id = positional[1];
      const next = positional[2];
      if (!id || !next) throw new Error(`Usage: node bin/orc.js state <taskId> <${STATES.join("|")}>`);
      if (!STATES.includes(next)) throw new Error(`Unknown state "${next}". Use: ${STATES.join(", ")}`);
      const task = setState(id, next, { note: String(flags.note ?? "Set from CLI"), actor: "you" });
      console.log(`${task.id} → ${task.state}`);
      return;
    }

    case "status": {
      syncAll();
      const state = getState();
      const running = new Set(runningTaskIds());
      console.log("");
      console.log("ORC status");
      console.log("");
      console.log(`${pad("PROJECT", 22)}${pad("ACTIVE", 8)}${pad("QUEUED", 8)}${pad("REVIEW", 8)}${pad("BLOCKED", 9)}${pad("DONE", 6)}TOTAL`);
      console.log("-".repeat(68));
      for (const project of state.projects) {
        console.log(
          `${pad(truncate(project.name, 20), 22)}${pad(project.active, 8)}${pad(project.counts.queued ?? 0, 8)}${pad(project.counts.review, 8)}${pad(
            project.blocked,
            9,
          )}${pad(project.done, 6)}${project.total}`,
        );
      }
      if (!state.projects.length) console.log("(no projects registered)");

      const active = state.tasks.filter((task) =>
        ["working", "review", "fixing", "verify"].includes(task.state),
      );
      console.log("");
      console.log("Active");
      if (!active.length) console.log("  none");
      for (const task of active) {
        console.log(
          `  ${task.id}  ${pad(task.state, 8)} ${pad(task.projectName, 18)} ${truncate(task.title, 50)}${
            running.has(task.id) ? "  [running]" : ""
          }`,
        );
      }

      const queued = state.tasks.filter((task) => task.state === "queued");
      if (queued.length) {
        console.log("");
        console.log("Queued");
        for (const task of queued) {
          console.log(
            `  ${task.id}  ${pad(task.projectName, 18)} ${truncate(task.title, 46)}${
              task.depends_on ? `  [after ${task.depends_on}]` : ""
            }`,
          );
        }
      }

      const blocked = state.tasks.filter((task) => task.state === "blocked");
      console.log("");
      console.log("Needs a human");
      if (!blocked.length) console.log("  nothing blocked");
      for (const task of blocked) {
        console.log(`  ${task.id}  ${task.projectName}  ${truncate(task.title, 50)}`);
        console.log(`        ${truncate(task.last_error ?? task.last_event ?? "", 100)}`);
      }

      const totalTokens = state.tasks.reduce((sum, task) => sum + Number(task.usage?.totalTokens ?? 0), 0);
      const totalCost = state.tasks.reduce((sum, task) => sum + Number(task.usage?.costUsd ?? 0), 0);
      if (totalTokens > 0 || totalCost > 0) {
        console.log("");
        console.log(
          `Usage: ${totalTokens.toLocaleString()} tokens${totalCost > 0 ? ` · $${totalCost.toFixed(4)} est.` : ""}`,
        );
      }
      const quota = getQuotaSnapshot();
      const quotaEntries = Object.values(quota);
      if (quotaEntries.length) {
        for (const entry of quotaEntries) {
          const pct = Number.isFinite(entry.utilization) ? `${Math.round(entry.utilization * 100)}%` : "";
          console.log(`Quota (${entry.agent}): ${[entry.status, entry.rateLimitType, pct].filter(Boolean).join(" · ")}`);
        }
      }
      console.log("");
      console.log(`Board: ${path.join(ROOT, "STATUS.md")}`);
      return;
    }

    case "doctor": {
      doctor();
      return;
    }

    case "open": {
      const ref = positional[1];
      if (!ref) {
        openTarget(ROOT);
        console.log(`Opened ${ROOT}`);
        return;
      }
      const task = getTask(ref);
      if (task) {
        if (flags.project) {
          const project = resolveProject(task.project_id);
          const opened = openTarget(project.path);
          console.log(`Opened ${opened}`);
        } else if (flags.spec) {
          const opened = revealFile(task.spec_path);
          console.log(`Revealed ${opened}`);
        } else if (task.worktree) {
          const opened = openTarget(task.worktree);
          console.log(`Opened ${opened}`);
        } else {
          const project = resolveProject(task.project_id);
          const opened = openTarget(project.path);
          console.log(`No worktree yet; opened ${opened}`);
        }
        return;
      }
      const project = resolveProject(ref);
      if (!project) throw new Error(`Unknown task or project: ${ref}`);
      const opened = openTarget(project.path);
      console.log(`Opened ${opened}`);
      return;
    }

    case "init": {
      const ref = positional[1];
      if (!ref) throw new Error("Usage: node bin/orc.js init <project|path>");
      let project = resolveProject(ref);
      if (!project) {
        const abs = path.resolve(ref);
        if (!existsSync(abs) || !statSync(abs).isDirectory()) {
          throw new Error(`Unknown project "${ref}" and no such directory: ${abs}`);
        }
        project = addProject({ projectPath: abs, name: flags.name });
        console.log(`Registered ${project.name} (${project.id})`);
      }
      const result = initProject(project);
      console.log(`Initialized ${project.name}`);
      console.log(result.created.length ? `  created: ${result.created.join(", ")}` : "  nothing to create");
      for (const warning of result.warnings) console.log(`  ! ${warning}`);
      return;
    }

    case "project": {
      const sub = positional[1];
      if (sub === "list" || !sub) {
        const projects = listProjects();
        if (!projects.length) {
          console.log("No projects. Add: node bin/orc.js project add C:\\path\\to\\repo --name my-app");
          return;
        }
        for (const project of projects) {
          const state = getState().projects.find((item) => item.id === project.id);
          console.log(`${project.id}  ${project.name}`);
          console.log(`  path   : ${project.path}`);
          console.log(`  base   : ${project.baseBranch} · tasks: ${state?.total ?? 0} · blocked: ${state?.blocked ?? 0}`);
          if (project.testCommand) console.log(`  test   : ${project.testCommand}`);
          if (project.setupCommand) console.log(`  setup  : ${project.setupCommand}`);
          if (project.reviewer) console.log(`  review : ${project.reviewer}`);
          if (project.implModel || project.reviewModel) {
            console.log(`  models : impl=${project.implModel || "default"} · review=${project.reviewModel || "default"}`);
          }
        }
        return;
      }

      if (sub === "add") {
        const target = positional[2] ?? flags.path;
        if (!target) throw new Error("Usage: node bin/orc.js project add <path> [--name \"...\"] [--base main] [--test \"npm test\"] [--setup \"...\"] [--diff-ignore \"...\"]");
        const project = addProject({
          name: flags.name,
          projectPath: target,
          baseBranch: flags.base || flags.branch || "main",
          testCommand: flags.test || "",
          setupCommand: flags.setup || "",
          reviewer: flags.reviewer || "",
          implModel: flags["impl-model"] || "",
          reviewModel: flags["review-model"] || "",
          diffIgnore: flags["diff-ignore"] || "",
        });
        let init = null;
        if (!flags["no-init"]) init = initProject(project);
        const state = getState().projects.find((item) => item.id === project.id);
        console.log(`Registered ${project.name} (${project.id})`);
        console.log(`  path : ${project.path}`);
        console.log(`  base : ${project.baseBranch}`);
        console.log(`  tasks: ${state?.total ?? 0}`);
        if (init) {
          console.log(init.created.length ? `  files: ${init.created.join(", ")}` : "  files: already present");
          for (const warning of init.warnings) console.log(`  ! ${warning}`);
        }
        return;
      }

      if (sub === "remove" || sub === "rm") {
        const ref = positional[2];
        if (!ref) throw new Error("Usage: node bin/orc.js project remove <projectId|name>");
        const removed = unregisterProject(ref);
        syncAll();
        console.log(`Unregistered ${removed.name} (${removed.id})`);
        return;
      }

      throw new Error(`Unknown project command "${sub}". Use: project add|list|remove`);
    }

    default:
      throw new Error(`Unknown command "${command}". Run: node bin/orc.js help`);
  }
}

function doctor() {
  const config = loadConfig();
  console.log("");
  console.log("ORC doctor");
  console.log("");
  line(true, "node", `${process.version} (node:sqlite available)`);
  line(existsSync(DATA_DIR), "data", DATA_DIR);
  line(
    existsSync(CONFIG_PATH),
    "config",
    existsSync(CONFIG_PATH)
      ? `${CONFIG_PATH} · port ${config.port}`
      : `${CONFIG_PATH} (defaults until first project is added) · port ${config.port}`,
  );

  const health = detectAgents(true);
  line(
    Boolean(health.git?.available),
    "git",
    health.git?.available ? health.git.path : "not found on PATH — required for worktrees",
  );
  line(
    Boolean(health.claude?.available),
    "claude",
    health.claude?.available
      ? health.claude.path
      : "not found — install Claude Code and sign in once",
  );
  line(
    Boolean(health.agy?.available),
    "agy",
    health.agy?.available
      ? health.agy.path
      : "not found — install Google Antigravity and sign in once",
  );
  line(
    Boolean(health.codex?.available),
    "codex",
    health.codex?.available
      ? health.codex.path
      : "not found (optional) — install OpenAI Codex CLI (@openai/codex) if desired",
  );

  console.log("");
  const projects = listProjects();
  if (!projects.length) {
    console.log("No projects registered. Add one:");
    console.log("  node bin/orc.js project add C:\\path\\to\\repo --name my-app");
  }
  for (const project of projects) {
    const exists = existsSync(project.path);
    const isGit = exists && existsSync(path.join(project.path, ".git"));
    let branchOk = false;
    if (isGit) {
      try {
        execFileSync("git", ["rev-parse", "--verify", project.baseBranch || "main"], {
          cwd: project.path,
          stdio: "ignore",
          windowsHide: true,
        });
        branchOk = true;
      } catch {
        branchOk = false;
      }
    }
    const ok = exists && isGit && branchOk;
    line(
      ok,
      project.name,
      `${project.path} · base ${project.baseBranch}${project.testCommand ? ` · test "${project.testCommand}"` : " · no test command"}`,
    );
    if (exists && !isGit) console.log("       ! not a git repository; worktrees will fail");
    if (isGit && !branchOk) console.log(`       ! base branch "${project.baseBranch}" not found`);
  }
  const recovery = recoverWorktrees();
  if (recovery.relinked.length || recovery.staleTasks.length || recovery.orphaned.length) {
    const clean = recovery.staleTasks.length === 0 && recovery.orphaned.length === 0;
    line(
      clean,
      "worktrees",
      `${recovery.relinked.length} reattached · ${recovery.staleTasks.length} stale · ${recovery.orphaned.length} orphaned`,
    );
    for (const stale of recovery.staleTasks) {
      console.log(`       ! stale ${stale.taskId} (${stale.state}): ${stale.worktree}`);
    }
    for (const orphan of recovery.orphaned) {
      console.log(`       ! orphaned (${orphan.projectId}): ${orphan.worktree}`);
    }
  }
  console.log("");
}

function line(ok, label, detail) {
  console.log(`${ok ? "[ok]" : "[--]"} ${pad(label, 10)} ${detail}`);
}

function pad(value, width) {
  return String(value ?? "").padEnd(width);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      flags.help = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const equals = body.indexOf("=");
      let key = body;
      let value = true;
      if (equals !== -1) {
        key = body.slice(0, equals);
        value = body.slice(equals + 1);
      } else if (VALUE_FLAGS.has(key)) {
        value = argv[i + 1];
        i += 1;
        if (value === undefined) throw new Error(`Missing value for --${key}`);
      }
      if (key === "accept") {
        flags.accept = flags.accept ? `${flags.accept}\n${value}` : String(value);
      } else {
        flags[key] = value;
      }
      continue;
    }
    positional.push(arg);
  }

  return { positional, flags };
}

function printHelp() {
  console.log(`
ORC — local mission control for Claude Code, Google Antigravity, and Codex

  node bin/orc.js serve [--port 4317]      dashboard at http://127.0.0.1:4317
  node bin/orc.js doctor                   check CLIs, git, and projects
  node bin/orc.js project add <path>       register + scaffold a project
  node bin/orc.js project list             list registered projects
  node bin/orc.js project remove <id>      unregister a project
  node bin/orc.js init <project|path>      write docs/AGENTS scaffolding only
  node bin/orc.js add <project> "<title>"  create a task + spec + branch name
        [--desc "..."] [--accept "- ..."] [--agent claude|agy|codex]
        [--tier low|med|high] [--depends-on T-0001] [--type code|research]
  node bin/orc.js research <project> "<q>" create read-only research task (no edits)
        [--agents claude,agy] [--tier low|med|high] [--run]
  node bin/orc.js list [project]           list tasks
  node bin/orc.js run <taskId>             drive implementation → verify → review
  node bin/orc.js queue <taskId>           queue task behind active run / dependencies
  node bin/orc.js stop <taskId>            stop the active agent process
  node bin/orc.js merge <taskId>           rebase onto base, clean worktree, mark done
  node bin/orc.js delete <taskId> [--clean] remove task from board (--clean removes worktree)
  node bin/orc.js state <taskId> <state>   move a task manually
  node bin/orc.js done <taskId>            mark done
  node bin/orc.js block <taskId>           mark blocked (needs a human)
  node bin/orc.js status                   regenerate + print the board + usage
  node bin/orc.js open [task|project]      open in Explorer (--spec, --project)
  node bin/orc.js install                  install global orc launcher + agent skill

What "add" creates
  A task row (T-0001), a spec file under docs/specs/, and a branch name.
  Title only → inbox. With --desc or --accept → specced and runnable.
  Running a code task creates a git worktree at <project>/.worktrees/T-0001.
  Research tasks run read-only directly against the repo and write docs/research/.

States
  inbox → specced → queued → working → verify → review → done
  review/fixing loops (max 2) · blocked = needs a human

Notes
  · Local only: the server binds 127.0.0.1 and has no auth.
  · ORC never calls model APIs; it drives the official CLIs headlessly.
  · Each CLI keeps its own login, quota, and terms of use.
`);
}

export { parseArgs };
