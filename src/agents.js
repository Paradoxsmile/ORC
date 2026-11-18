import { spawn, execFileSync } from "node:child_process";
import { accessSync, constants, createWriteStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { LOG_DIR } from "./config.js";
import { ensureDir, truncate } from "./util.js";

let cache = null;

export function detectAgents(force = false) {
  if (cache && !force) return cache;
  cache = {
    claude: findBinary("claude"),
    agy: findBinary("agy"),
    git: findBinary("git"),
  };
  return cache;
}

export function agentLabel(agent) {
  return agent === "agy" ? "Antigravity" : "Claude";
}

function findBinary(name) {
  const dirs = String(process.env.PATH ?? "")
    .split(path.delimiter)
    .map((dir) => dir.replace(/^"(.*)"$/, "$1").trim())
    .filter(Boolean);

  const extensions =
    process.platform === "win32"
      ? String(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .map((ext) => ext.trim())
          .filter(Boolean)
      : [""];

  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = path.join(dir, `${name}${extension}`);
      if (!existsSync(candidate)) continue;
      try {
        if (!statSync(candidate).isFile()) continue;
        if (process.platform !== "win32") accessSync(candidate, constants.X_OK);
        return { available: true, path: candidate };
      } catch {
        // Not executable; keep looking.
      }
    }
  }

  return { available: false, path: null };
}

export async function runAgent({
  agent,
  prompt,
  cwd,
  sessionId = null,
  mode = null,
  model = null,
  effort = null,
  yolo = false,
  timeoutMs = 45 * 60 * 1000,
  taskId = "task",
  runId = String(Date.now()),
  onEvent = () => {},
  onSpawn = () => {},
}) {
  const binary = detectAgents()[agent];
  if (!binary?.available) {
    throw new Error(
      `${agentLabel(agent)} CLI not found on PATH. Install it, sign in, and reopen the terminal.`,
    );
  }

  const args = buildArgs(agent, prompt, { sessionId, mode, model, effort, yolo });
  const wrapped = wrapWindows(binary.path, args);

  ensureDir(LOG_DIR);
  const logPath = path.join(LOG_DIR, `${taskId}-${runId}.jsonl`);
  const log = createWriteStream(logPath, { flags: "a" });

  onEvent({
    kind: "spawn",
    text: `${agent} ${args.slice(0, 4).join(" ")}`,
    data: { agent, cwd, logPath },
  });

  let child;
  try {
    child = spawn(wrapped.file, wrapped.argv, {
      cwd,
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
  } catch (error) {
    log.end();
    throw error;
  }

  const state = {
    sessionId: sessionId ?? null,
    initEmitted: false,
    text: "",
    raw: [],
    lastError: null,
    steps: new Map(),
  };

  onSpawn(child);

  let buffer = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      log.write(`${line}\n`);
      consumeLine(agent, line, state, onEvent);
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    log.write(chunk);
    if (stderr.length > 12000) stderr = stderr.slice(-12000);
  });

  const timer = timeoutMs
    ? setTimeout(() => {
      state.lastError = `Timed out after ${Math.round(timeoutMs / 60000)} minutes`;
      killTree(child);
    }, timeoutMs)
    : null;

  const code = await new Promise((resolve) => {
    child.on("error", (error) => {
      state.lastError = error.message;
      resolve(-1);
    });
    child.on("close", (exitCode) => resolve(exitCode ?? -1));
  });

  if (timer) clearTimeout(timer);
  log.end();

  if (buffer.trim()) consumeLine(agent, buffer.trim(), state, onEvent);
  if (stderr.trim()) onEvent({ kind: "stderr", text: truncate(stderr, 800) });

  return {
    code,
    sessionId: state.sessionId,
    text: state.text.trim(),
    raw: state.raw,
    logPath,
    error: state.lastError,
  };
}

export function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } else {
      process.kill(-child.pid, "SIGTERM");
    }
  } catch {
    // The process may already be gone.
  }
}

function buildArgs(agent, prompt, { sessionId, mode, model, effort, yolo }) {
  if (agent === "claude") {
    const review = mode === "plan";
    const args = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      review ? "plan" : "acceptEdits",
      "--allowedTools",
      // Reviews are read-only: no Edit/Write, even if plan mode is exited.
      review ? "Read,Grep,Glob,Bash" : "Read,Edit,Write,Bash",
    ];
    if (sessionId) args.push("--resume", sessionId);
    if (model) args.push("--model", String(model));
    return args;
  }

  const args = ["-p", prompt, "--output-format", "stream-json"];
  if (sessionId) args.push("--conversation", sessionId);
  if (mode) args.push("--mode", mode);
  if (model) args.push("--model", String(model));
  if (effort) args.push("--effort", String(effort));
  if (yolo) args.push("--dangerously-skip-permissions");
  return args;
}

function wrapWindows(file, args) {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(file)) {
    const command = [file, ...args].map(quoteCmd).join(" ");
    return { file: process.env.ComSpec || "cmd.exe", argv: ["/d", "/s", "/c", command] };
  }
  return { file, argv: args };
}

function quoteCmd(value) {
  const text = String(value);
  if (!/[\s"&|<>^()]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function consumeLine(agent, line, state, onEvent) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    state.text += `${line}\n`;
    onEvent({ kind: "text", text: line });
    return;
  }

  state.raw.push(event);

  const sessionId =
    event.session_id ??
    event.sessionId ??
    event.conversation_id ??
    event.conversationId ??
    event.step_update?.conversation_id ??
    event.result?.conversation_id ??
    event.thread_id ??
    event.threadId;
  if (sessionId) state.sessionId = sessionId;

  if (
    !state.initEmitted &&
    (event.type === "system" || event.type === "init" || event.event === "init" || sessionId)
  ) {
    state.initEmitted = true;
    onEvent({
      kind: "init",
      sessionId: state.sessionId,
      data: {
        model: event.model ?? event.init?.model,
        permissionMode: event.init?.permission_mode,
      },
    });
  }

  // Antigravity CLI stream-json: { event: "init" | "step_update" | "result", ... }
  if (typeof event.event === "string") {
    consumeAntigravityEvent(event, state, onEvent);
    return;
  }

  if (event.type === "system") return;

  if (event.type === "result") {
    const text =
      typeof event.result === "string"
        ? event.result
        : typeof event.result?.text === "string"
          ? event.result.text
          : typeof event.response === "string"
            ? event.response
            : "";
    if (text) {
      state.text = text;
      onEvent({
        kind: "result",
        text,
        data: {
          cost: event.total_cost_usd,
          isError: event.is_error,
          status: event.subtype,
        },
      });
    }
    if (event.is_error) {
      state.lastError = String(event.error ?? event.result ?? "Claude run reported an error");
      onEvent({ kind: "stderr", text: state.lastError });
    }
    return;
  }

  if (event.type === "assistant" && event.message?.content) {
    const content = event.message.content;
    if (typeof content === "string") {
      state.text += content;
      onEvent({ kind: "text", text: content });
      return;
    }
    for (const block of content) {
      if (block.type === "text" && block.text) {
        state.text += block.text;
        onEvent({ kind: "text", text: block.text });
      } else if (block.type === "tool_use") {
        onEvent({ kind: "tool", text: block.name ?? "tool", data: { input: block.input } });
      }
    }
    return;
  }

  if (event.type === "user" && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === "tool_result") {
        onEvent({ kind: "tool_result", text: stringify(block.content) });
      }
    }
    return;
  }

  const text =
    typeof event.text === "string"
      ? event.text
      : typeof event.delta?.text === "string"
        ? event.delta.text
        : typeof event.content === "string"
          ? event.content
          : null;

  if (text) {
    state.text += text;
    onEvent({ kind: "text", text });
  } else {
    onEvent({ kind: "event", text: event.type ?? `${agent}.event` });
  }
}

function consumeAntigravityEvent(event, state, onEvent) {
  if (event.event === "init") return;

  if (event.event === "step_update") {
    const step = event.step_update ?? {};

    if (step.step_type === "agent_response" && typeof step.text_delta === "string") {
      const key = String(step.step_index ?? "");
      const previous = state.steps.get(key) ?? "";
      const next = step.text_delta;
      let delta = next;

      // ACTIVE deltas are usually fragments; a DONE event may repeat the whole
      // accumulated text. Emit only the new suffix so the UI never duplicates.
      if (next.startsWith(previous)) delta = next.slice(previous.length);
      else if (previous.startsWith(next)) delta = "";
      if (next.length >= previous.length) state.steps.set(key, next);

      if (delta) {
        state.text += delta;
        onEvent({ kind: "text", text: delta });
      }
      return;
    }

    if (step.step_type === "tool") {
      const info = step.tool_info ?? {};
      const name = step.tool_name ?? info.name ?? "tool";
      onEvent({ kind: "tool", text: name, data: { parameters: info.parameters } });
      if (info.output) onEvent({ kind: "tool_result", text: stringify(info.output) });
      if (info.error) onEvent({ kind: "stderr", text: stringify(info.error) });
      return;
    }

    return;
  }

  if (event.event === "result") {
    const payload = event.result ?? {};
    const text = typeof payload.response === "string" ? payload.response : "";
    if (text) {
      // The result is authoritative; live deltas may be partial or repeated.
      state.text = text;
      onEvent({
        kind: "result",
        text,
        data: { status: payload.status, usage: payload.usage },
      });
    }
    if (payload.status && payload.status !== "SUCCESS") {
      state.lastError = payload.error || `Antigravity status: ${payload.status}`;
      onEvent({ kind: "stderr", text: state.lastError });
    }
    return;
  }

  onEvent({ kind: "event", text: event.event });
}

function stringify(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
