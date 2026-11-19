import http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  addProject,
  initProject,
  loadConfig,
  PUBLIC_DIR,
  resolveProject,
  updateProject,
} from "./config.js";
import {
  addEvent,
  bus,
  createTask,
  failTask,
  getState,
  getTask,
  getTaskDetail,
  saveSpec,
  setState,
  syncAll,
} from "./board.js";
import {
  checkConcurrency,
  mergeTask,
  recoverWorktrees,
  removeTask,
  runningTaskIds,
  runTask,
  stopTask,
  taskRuntimeInfo,
  unregisterProject,
} from "./dispatch.js";
import { openTarget, revealFile } from "./open.js";
import { nowIso, truncate } from "./util.js";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const MAX_BODY = 1024 * 1024;

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function sendJson(res, value, status = 200) {
  const body = `${JSON.stringify(value)}\n`;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

function sendText(res, value, status = 200) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(String(value));
}

async function readJsonBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw httpError("Request body is too large", 413);
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw httpError("Invalid JSON body");
  }
}

function requireTask(id) {
  const task = getTask(id);
  if (!task) throw httpError(`Unknown task: ${id}`, 404);
  return task;
}

export function startServer({ port = loadConfig().port } = {}) {
  recoverWorktrees();
  const clients = new Set();

  const server = http.createServer(async (req, res) => {
    try {
      await route(req, res, clients);
    } catch (error) {
      const status = Number(error?.status) || 500;
      if (status >= 500) console.error(error);
      if (!res.headersSent) {
        sendJson(res, { error: error?.message || String(error) }, status);
      } else {
        res.end();
      }
    }
  });

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      try {
        client.write(`: ping ${Date.now()}\n\n`);
      } catch {
        clients.delete(client);
      }
    }
  }, 25000);
  heartbeat.unref?.();

  const onEvent = (event) => broadcast(clients, "task-event", event);
  const onRefresh = () =>
    broadcast(clients, "refresh", { at: nowIso(), running: runningTaskIds() });
  bus.on("event", onEvent);
  bus.on("refresh", onRefresh);

  server.on("close", () => {
    clearInterval(heartbeat);
    bus.off("event", onEvent);
    bus.off("refresh", onRefresh);
    for (const client of clients) {
      try {
        client.end();
      } catch {
        // Ignore.
      }
    }
    clients.clear();
  });

  server.listen(port, "127.0.0.1");
  return server;
}

function broadcast(clients, name, data) {
  const payload = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.write(payload);
    } catch {
      clients.delete(client);
    }
  }
}

async function route(req, res, clients) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  const pathname = decodeURIComponent(url.pathname);
  const method = req.method ?? "GET";

  if (pathname === "/api/events" && method === "GET") {
    handleSse(req, res, clients);
    return;
  }

  if (pathname === "/api/state" && method === "GET") {
    sendJson(res, { ...getState(), running: runningTaskIds(), now: nowIso() });
    return;
  }

  if (pathname === "/api/tasks" && method === "POST") {
    const body = await readJsonBody(req);
    const task = createTask({
      projectId: body.projectId,
      title: body.title,
      description: body.description ?? "",
      acceptance: body.acceptance ?? "",
      agent: body.agent === "agy" ? "agy" : "claude",
    });
    sendJson(res, { task }, 201);
    return;
  }

  if (pathname === "/api/projects" && method === "POST") {
    const body = await readJsonBody(req);
    const project = addProject({
      name: body.name,
      projectPath: body.path,
      baseBranch: body.baseBranch || "main",
      testCommand: body.testCommand || "",
      setupCommand: body.setupCommand || "",
      reviewer: body.reviewer || "",
      implModel: body.implModel || "",
      reviewModel: body.reviewModel || "",
    });
    const init = initProject(project);
    syncAll();
    bus.emit("refresh");
    sendJson(res, { project, init }, 201);
    return;
  }

  const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)(?:\/([a-z]+))?$/);
  if (projectMatch) {
    const projectId = projectMatch[1];
    const action = projectMatch[2] ?? null;

    if (!action && (method === "POST" || method === "PATCH")) {
      const body = await readJsonBody(req);
      const project = updateProject(projectId, body);
      syncAll();
      bus.emit("refresh");
      sendJson(res, { project });
      return;
    }

    if ((!action && method === "DELETE") || (action === "remove" && method === "POST")) {
      const removed = unregisterProject(projectId);
      syncAll();
      sendJson(res, { ok: true, removed });
      return;
    }
  }

  const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)(?:\/([a-z]+))?$/);
  if (taskMatch) {
    const taskId = taskMatch[1];
    const action = taskMatch[2] ?? null;

    if (!action && method === "GET") {
      const detail = getTaskDetail(taskId);
      sendJson(res, {
        ...detail,
        runtime: taskRuntimeInfo(detail.task, detail.project),
        running: runningTaskIds().includes(taskId),
      });
      return;
    }

    if ((!action && method === "DELETE") || (action === "delete" && method === "POST")) {
      const body = method === "POST" ? await readJsonBody(req) : {};
      const deleted = await removeTask(taskId, { cleanupWorktree: body.cleanupWorktree !== false });
      sendJson(res, { ok: true, deleted });
      return;
    }

    if (action === "run" && method === "POST") {
      const task = requireTask(taskId);
      if (runningTaskIds().includes(task.id)) throw httpError(`${task.id} is already running`, 409);
      if (task.state === "inbox") {
        throw httpError(`${task.id} has no spec yet. Write the spec first.`, 400);
      }
      if (task.state === "blocked") {
        throw httpError(`${task.id} is blocked. Move it back to specced or fixing first.`, 400);
      }
      if (task.state === "done") throw httpError(`${task.id} is already done`, 400);

      const project = resolveProject(task.project_id);
      if (!project) throw httpError(`Unknown project: ${task.project_id}`, 400);
      checkConcurrency(task, project);

      runTask(task.id, { actor: "you" }).catch((error) => {
        addEvent({
          taskId: task.id,
          actor: "orc",
          type: "run.failed",
          text: truncate(error?.message || String(error), 1200),
        });
        bus.emit("refresh");
      });
      sendJson(res, { ok: true, taskId: task.id, running: true }, 202);
      return;
    }

    if (action === "stop" && method === "POST") {
      stopTask(taskId);
      sendJson(res, { ok: true, taskId });
      return;
    }

    if (action === "merge" && method === "POST") {
      await mergeTask(taskId, { actor: "you" });
      const detail = getTaskDetail(taskId);
      sendJson(res, { ok: true, ...detail, running: false });
      return;
    }

    if (action === "state" && method === "POST") {
      const body = await readJsonBody(req);
      const task = requireTask(taskId);
      if (runningTaskIds().includes(task.id)) {
        throw httpError(`Stop ${task.id} before changing its state`, 409);
      }
      const updated = setState(task.id, body.state, {
        note: body.note || "Set from dashboard",
        actor: "you",
      });
      sendJson(res, { task: updated });
      return;
    }

    if (action === "block" && method === "POST") {
      const body = await readJsonBody(req);
      const task = requireTask(taskId);
      if (runningTaskIds().includes(task.id)) {
        throw httpError(`Stop ${task.id} before blocking it`, 409);
      }
      const updated = failTask(task.id, body.note || "Blocked from dashboard");
      sendJson(res, { task: updated });
      return;
    }

    if (action === "spec" && method === "POST") {
      const body = await readJsonBody(req);
      const detail = saveSpec(taskId, body.content ?? "");
      sendJson(res, detail);
      return;
    }

    if (action === "open" && method === "POST") {
      const body = await readJsonBody(req);
      const task = requireTask(taskId);
      const detail = getTaskDetail(taskId);
      let opened;
      if (body.target === "spec") {
        opened = revealFile(task.spec_path);
      } else if (body.target === "review") {
        if (!detail.artifacts.review) throw httpError("No review artifact yet", 404);
        opened = revealFile(detail.artifacts.review);
      } else if (body.target === "project") {
        opened = openTarget(detail.project.path);
      } else {
        opened = task.worktree ? openTarget(task.worktree) : openTarget(detail.project.path);
      }
      sendJson(res, { ok: true, path: opened });
      return;
    }

    throw httpError(`Unknown task action: ${action ?? "(none)"}`, 404);
  }

  if (pathname.startsWith("/api/")) {
    throw httpError(`Unknown API route: ${method} ${pathname}`, 404);
  }

  if (method !== "GET" && method !== "HEAD") {
    throw httpError("Method not allowed", 405);
  }

  serveStatic(res, pathname);
}

function handleSse(req, res, clients) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "X-Content-Type-Options": "nosniff",
  });
  res.write("retry: 2000\n\n");
  res.write(`event: hello\ndata: ${JSON.stringify({ at: nowIso() })}\n\n`);
  clients.add(res);
  req.on("close", () => clients.delete(res));
}

function serveStatic(res, pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = path.resolve(PUBLIC_DIR, relative);

  if (!file.startsWith(path.resolve(PUBLIC_DIR))) {
    sendText(res, "Forbidden", 403);
    return;
  }

  const candidate = existsSync(file) && path.extname(file) ? file : path.join(PUBLIC_DIR, "index.html");
  if (!existsSync(candidate)) {
    sendText(res, "Dashboard is missing. Expected public/index.html.", 500);
    return;
  }

  const body = readFileSync(candidate);
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(candidate)] ?? "application/octet-stream",
    "Content-Length": body.length,
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'",
  });
  res.end(body);
}
