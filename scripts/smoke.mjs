// End-to-end smoke test with fake Claude/Antigravity CLIs.
// It exercises worktrees, diff capture, both stream parsers, review, tests, and the
// HTTP API without touching the real CLIs or the real ORC database.
//
//   node scripts/smoke.mjs

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
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const temp = mkdtempSync(path.join(os.tmpdir(), "orc-smoke-"));
const fakeBin = path.join(temp, "bin");
const repoDir = path.join(temp, "repo");
const configPath = path.join(temp, "orc.config.json");
const dataDir = path.join(temp, "data");
const statusPath = path.join(ROOT, "STATUS.md");
const previousStatus = existsSync(statusPath) ? readFileSync(statusPath, "utf8") : null;

function log(message) {
  console.log(`  ${message}`);
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

function fail(message) {
  console.error(`\nFAIL: ${message}`);
  console.error(`Temp directory kept for inspection: ${temp}`);
  process.exitCode = 1;
}

function writeFakeClis() {
  mkdirSync(fakeBin, { recursive: true });

  writeFileSync(
    path.join(fakeBin, "fake-claude.js"),
    `import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const dir = path.join(process.cwd(), "src");
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, "feature.txt"), "feature " + Date.now() + "-" + process.pid + "\\n");
const session = "fake-claude-session";
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: session }));
console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Implemented the task.\\n" }] } }));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Implemented the task.\\n", session_id: session }));
`,
    "utf8",
  );

  writeFileSync(
    path.join(fakeBin, "fake-agy.js"),
    `const args = process.argv.slice(2);
const modeIndex = args.indexOf("--mode");
const mode = modeIndex >= 0 ? args[modeIndex + 1] : "plan";
const conversation = "fake-agy-conversation";
const response = mode === "plan"
  ? "Review complete.\\n\\nVERDICT: APPROVE\\n"
  : "Antigravity implementation complete.\\n";
console.log(JSON.stringify({ event: "init", conversation_id: conversation, init: { cwd: process.cwd(), permission_mode: mode === "plan" ? "plan" : "accept-edits" } }));
console.log(JSON.stringify({ event: "step_update", step_update: { conversation_id: conversation, step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "Reviewing " } }));
console.log(JSON.stringify({ event: "step_update", step_update: { conversation_id: conversation, step_index: 1, state: "DONE", step_type: "agent_response", text_delta: response } }));
console.log(JSON.stringify({ event: "result", result: { conversation_id: conversation, status: "SUCCESS", response, usage: { total_tokens: 42 } } }));
`,
    "utf8",
  );

  if (process.platform === "win32") {
    writeFileSync(
      path.join(fakeBin, "claude.cmd"),
      '@echo off\r\nnode "%~dp0fake-claude.js" %*\r\n',
      "utf8",
    );
    writeFileSync(
      path.join(fakeBin, "agy.cmd"),
      '@echo off\r\nnode "%~dp0fake-agy.js" %*\r\n',
      "utf8",
    );
  } else {
    for (const name of ["claude", "agy"]) {
      const file = path.join(fakeBin, name);
      writeFileSync(file, `#!/bin/sh\nexec node "${fakeBin}/fake-${name}.js" "$@"\n`, "utf8");
      chmodSync(file, 0o755);
    }
  }
}

function setupRepo() {
  mkdirSync(path.join(repoDir, "src"), { recursive: true });
  writeFileSync(path.join(repoDir, "README.md"), "# smoke repo\n", "utf8");
  writeFileSync(path.join(repoDir, "src", "existing.txt"), "existing\n", "utf8");
  git(repoDir, ["init", "-b", "main"]);
  git(repoDir, ["config", "user.name", "Smoke Test"]);
  git(repoDir, ["config", "user.email", "smoke@example.invalid"]);
  git(repoDir, ["add", "-A"]);
  git(repoDir, ["commit", "-m", "initial"]);
}

async function main() {
  console.log(`ORC smoke test\n  temp: ${temp}`);

  writeFakeClis();
  setupRepo();

  process.env.ORC_CONFIG = configPath;
  process.env.ORC_DATA_DIR = dataDir;
  process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;

  const { addProject, initProject, updateProject } = await import("../src/config.js");
  const { createTask, getTaskDetail } = await import("../src/board.js");
  const { mergeTask, runTask } = await import("../src/dispatch.js");
  const { startServer } = await import("../src/server.js");
  const { db } = await import("../src/db.js");

  let server = null;

  try {
    const project = addProject({
      name: "smoke",
      projectPath: repoDir,
      baseBranch: "main",
      testCommand: 'node -e "console.log(\'tests ok\')"',
      setupCommand: 'node -e "console.log(\'setup ok\')"',
    });
    log(`registered ${project.id}`);

    const init = initProject(project);
    log(`scaffold: ${init.created.join(", ") || "(already present)"}`);
    if (init.warnings.length) log(`warnings: ${init.warnings.join(" | ")}`);

    git(repoDir, ["add", "-A"]);
    git(repoDir, ["commit", "-m", "orc scaffold"]);

    const task = createTask({
      projectId: project.id,
      title: "Add the feature file",
      description: "The smoke test needs one tracked file change.",
      acceptance: "- [ ] src/feature.txt exists",
    });
    log(`created ${task.id} in ${task.state} · ${task.spec_path}`);
    if (task.state !== "specced") throw new Error(`expected specced, got ${task.state}`);

    server = startServer({ port: 0 });
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const port = server.address().port;
    const stateResponse = await fetch(`http://127.0.0.1:${port}/api/state`);
    const state = await stateResponse.json();
    if (!stateResponse.ok || state.projects.length !== 1) {
      throw new Error(`state endpoint failed: ${stateResponse.status}`);
    }
    const indexResponse = await fetch(`http://127.0.0.1:${port}/`);
    const index = await indexResponse.text();
    if (!indexResponse.ok || !index.includes("ORC")) throw new Error("dashboard index failed");
    log(`server ok on 127.0.0.1:${port}`);

    const started = Date.now();
    const final = await runTask(task.id);
    log(`pipeline finished in ${Math.round((Date.now() - started) / 1000)}s · ${final.state}`);
    if (final.state !== "done") {
      const detail = getTaskDetail(task.id);
      console.error("\nEvents:");
      for (const event of detail.events.slice(-15)) {
        console.error(`  ${event.type}: ${event.text ?? ""}`);
      }
      console.error(`\nReview:\n${detail.review}`);
      console.error(`\nTests:\n${detail.test}`);
      throw new Error(`expected done, got ${final.state}: ${final.last_error ?? ""}`);
    }

    const detail = getTaskDetail(task.id);
    if (!detail.spec.trim()) throw new Error("missing spec");
    if (!detail.artifacts.diffExists) throw new Error("missing diff artifact");
    if (!detail.artifacts.reviewExists) throw new Error("missing review artifact");
    if (!detail.artifacts.testExists) throw new Error("missing test artifact");
    if (!detail.review.includes("VERDICT: APPROVE")) throw new Error("review verdict missing");
    if (!detail.diff.includes("src/feature.txt")) throw new Error("diff does not contain feature.txt");
    if (!detail.test.includes("tests ok")) throw new Error("test log missing output");

    const stateOrder = detail.events
      .filter((event) => event.type === "state")
      .map((event) => event.data?.to);
    if (stateOrder.join("->") !== "working->verify->review->done") {
      throw new Error(`expected working->verify->review->done, got ${stateOrder.join("->")}`);
    }
    const verifyPassedIdx = detail.events.findIndex((event) => event.type === "verify.passed");
    const reviewApprovedIdx = detail.events.findIndex((event) => event.type === "review.approved");
    if (verifyPassedIdx < 0 || reviewApprovedIdx <= verifyPassedIdx) {
      throw new Error("expected verify.passed before review.approved");
    }
    const reviewPrompt = readFileSync(
      path.join(repoDir, ".worktrees", task.id, ".orc", task.id, "prompt-review.md"),
      "utf8",
    );
    if (!reviewPrompt.includes(`.orc/${task.id}/test.log`)) {
      throw new Error("prompt-review.md missing test.log reference");
    }

    const branch = git(repoDir, ["branch", "--list", task.branch]);
    if (!branch.includes(task.branch)) throw new Error("task branch missing");
    if (!existsSync(path.join(repoDir, ".worktrees", task.id, "src", "feature.txt"))) {
      throw new Error("worktree feature file missing");
    }
    if (!existsSync(path.join(repoDir, ".worktrees", task.id, ".orc", task.id, "setup.log"))) {
      throw new Error("worktree setup.log missing");
    }

    const patchProjectRes = await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ implModel: "gemini-4-argon-high" }),
    });
    const patchProjectData = await patchProjectRes.json();
    if (!patchProjectRes.ok || patchProjectData.project?.implModel !== "gemini-4-argon-high") {
      throw new Error("project settings update endpoint failed");
    }

    const finalState = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
    if (finalState.tasks[0].state !== "done") throw new Error("API state is not done");
    if (finalState.running.length !== 0) throw new Error("running list is not empty");
    log("artifacts, branch, worktree, review, tests, API: ok");

    writeFileSync(path.join(repoDir, "README.md"), "# smoke repo\ndirty\n", "utf8");
    let refused = false;
    try {
      await mergeTask(task.id);
    } catch (error) {
      refused = /Main worktree has uncommitted changes/.test(error.message);
    } finally {
      git(repoDir, ["checkout", "--", "README.md"]);
    }
    if (!refused) throw new Error("expected mergeTask to refuse on dirty main worktree");
    log("dirty main worktree merge refusal: ok");

    const mergeResponse = await fetch(`http://127.0.0.1:${port}/api/tasks/${task.id}/merge`, {
      method: "POST",
    });
    const mergeData = await mergeResponse.json();
    if (!mergeResponse.ok || !mergeData.ok) {
      throw new Error(`merge endpoint failed: ${mergeResponse.status} ${mergeData.error ?? ""}`);
    }
    if (!existsSync(path.join(repoDir, "src", "feature.txt"))) {
      throw new Error("merged feature file missing on main");
    }
    if (existsSync(path.join(repoDir, ".worktrees", task.id))) {
      throw new Error("task worktree still exists after merge");
    }
    if (git(repoDir, ["branch", "--list", task.branch])) {
      throw new Error("task branch still exists after merge");
    }
    const mergedDetail = getTaskDetail(task.id);
    if (
      !mergedDetail.artifacts.diffExists ||
      !mergedDetail.artifacts.reviewExists ||
      !mergedDetail.artifacts.testExists
    ) {
      throw new Error("archived artifacts missing after merge");
    }
    log("merge, cleanup, archived artifacts: ok");

    updateProject(project.id, { testCommand: 'node -e "console.error(\'smoke fail\'); process.exit(1)"' });
    const failingTask = createTask({
      projectId: project.id,
      title: "Failing test skips review",
      description: "Verify failure must loop to fixing/blocked without calling reviewer.",
      acceptance: "- [ ] reviewer is never invoked",
    });
    const failingFinal = await runTask(failingTask.id);
    if (failingFinal.state !== "blocked") {
      throw new Error(`expected failing task to be blocked, got ${failingFinal.state}`);
    }
    const failingDetail = getTaskDetail(failingTask.id);
    const failingStates = failingDetail.events
      .filter((event) => event.type === "state")
      .map((event) => event.data?.to);
    if (failingStates.join("->") !== "working->verify->fixing->working->verify->blocked") {
      throw new Error(`unexpected failing task states: ${failingStates.join("->")}`);
    }
    if (failingDetail.runs.some((run) => run.step === "review")) {
      throw new Error("reviewer should not be invoked when tests fail");
    }
    if (failingDetail.artifacts.reviewExists) {
      throw new Error("review.md should not exist when tests fail");
    }
    if (!failingDetail.artifacts.testExists) {
      throw new Error("test.log missing for failing task");
    }
    const delFailRes = await fetch(`http://127.0.0.1:${port}/api/tasks/${failingTask.id}/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cleanupWorktree: true }),
    });
    if (!delFailRes.ok) throw new Error(`failing task delete failed: ${delFailRes.status}`);
    log("verify-before-review & failing test skips reviewer: ok");

    const probeDir = path.join(temp, "probes");
    execFileSync(process.execPath, [path.join(ROOT, "scripts", "probe.mjs"), "--out", probeDir], {
      env: process.env,
      encoding: "utf8",
      windowsHide: true,
    });
    if (
      !existsSync(path.join(probeDir, "claude-probe.report.json")) ||
      !existsSync(path.join(probeDir, "agy-probe.report.json"))
    ) {
      throw new Error("probe reports missing");
    }
    log("probe script: ok");

    const delRes = await fetch(`http://127.0.0.1:${port}/api/tasks/${task.id}/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cleanupWorktree: true }),
    });
    if (!delRes.ok) throw new Error(`task delete failed: ${delRes.status}`);

    const remRes = await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}/remove`, {
      method: "POST",
    });
    if (!remRes.ok) throw new Error(`project remove failed: ${remRes.status}`);

    const afterCleanState = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
    if (afterCleanState.tasks.length !== 0 || afterCleanState.projects.length !== 0) {
      throw new Error("expected empty tasks and projects after delete/remove");
    }
    log("task delete & project remove: ok");

    console.log("\nSMOKE PASS");
    console.log(`  task: ${task.id}`);
    console.log(`  branch: ${task.branch}`);
    console.log(`  temp: ${temp} (safe to delete)`);
  } finally {
    if (server?.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
    try {
      db.close();
    } catch {
      // Already closed.
    }
    if (previousStatus === null) rmSync(statusPath, { force: true });
    else writeFileSync(statusPath, previousStatus, "utf8");
  }
}

main().catch((error) => {
  fail(error?.stack || error?.message || String(error));
});
