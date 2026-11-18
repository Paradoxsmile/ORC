import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR, LOG_DIR } from "./config.js";
import { ensureDir, nowIso } from "./util.js";

ensureDir(DATA_DIR);
ensureDir(LOG_DIR);

export const db = new DatabaseSync(path.join(DATA_DIR, "orc.db"));

db.exec("PRAGMA journal_mode = WAL;");
db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  state TEXT NOT NULL,
  agent TEXT NOT NULL,
  branch TEXT,
  worktree TEXT,
  spec_path TEXT,
  session_id TEXT,
  conversation_id TEXT,
  review_verdict TEXT,
  review_loops INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT,
  run_id TEXT,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  type TEXT NOT NULL,
  text TEXT,
  data TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  step TEXT NOT NULL,
  pid INTEGER,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  exit_code INTEGER,
  log_path TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id);
`);

export function nextTaskId() {
  const row = db
    .prepare("SELECT COALESCE(MAX(CAST(SUBSTR(id, 3) AS INTEGER)), 0) AS n FROM tasks")
    .get();
  return `T-${String(Number(row?.n ?? 0) + 1).padStart(4, "0")}`;
}

export function tx(fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function isPidAlive(pid) {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) return false;
  try {
    process.kill(id, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * Marks stale "running" rows as interrupted only when their PID is no longer alive.
 */
export function reapDeadRuns() {
  const rows = db.prepare("SELECT id, pid FROM runs WHERE status = 'running'").all();
  const reaped = [];
  const ts = nowIso();
  for (const row of rows) {
    if (!row.pid || !isPidAlive(row.pid)) {
      db.prepare("UPDATE runs SET status = 'interrupted', ended_at = ? WHERE id = ?").run(ts, row.id);
      reaped.push(row.id);
    }
  }
  return reaped;
}
