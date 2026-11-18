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

const { buildArgs, consumeLine, createStreamState } = await import("../src/agents.js");
const { addProject } = await import("../src/config.js");
const { db } = await import("../src/db.js");
const { createTask, failTask, getTask, getTaskDetail, saveSpec, setState } = await import(
  "../src/board.js"
);
const { captureWork, effortFor, parseVerdict, yoloFor } = await import("../src/dispatch.js");

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
  });
});
