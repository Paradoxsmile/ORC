import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import path from "node:path";

export function nowIso() {
  return new Date().toISOString();
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function slugify(input, fallback = "item") {
  const slug = String(input ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || fallback;
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

export function readText(file, fallback = "") {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return fallback;
  }
}

export function renderTemplate(text, vars) {
  return String(text).replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g, (_, key) => vars[key] ?? "");
}

export function stripAnsi(value) {
  return String(value).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

export function truncate(value, max = 200) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function uniquePath(file) {
  if (!existsSync(file)) return file;
  const ext = path.extname(file);
  const base = file.slice(0, -ext.length);
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}-${i}${ext}`;
    if (!existsSync(candidate)) return candidate;
  }
  return `${base}-${Date.now()}${ext}`;
}
