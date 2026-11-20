import path from "node:path";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ensureDir, readJson, readText, renderTemplate, slugify, writeJson } from "./util.js";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const CONFIG_PATH = process.env.ORC_CONFIG || path.join(ROOT, "orc.config.json");
export const DATA_DIR = process.env.ORC_DATA_DIR || path.join(ROOT, "data");
export const LOG_DIR = path.join(DATA_DIR, "logs");
export const TEMPLATES_DIR = path.join(ROOT, "templates");
export const PUBLIC_DIR = path.join(ROOT, "public");

export const DEFAULT_DIFF_IGNORE = [
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "*.lock",
  "*.min.js",
  "*.min.css",
];

const DEFAULT_CONFIG = { port: 4317, projects: [] };

export function loadConfig() {
  const config = readJson(CONFIG_PATH, null);
  if (!config || typeof config !== "object") return structuredClone(DEFAULT_CONFIG);
  config.port = Number(config.port) || 4317;
  config.projects = Array.isArray(config.projects) ? config.projects : [];
  if (config.tiers && typeof config.tiers !== "object") delete config.tiers;
  return config;
}

export function saveConfig(config) {
  writeJson(CONFIG_PATH, config);
}

export function listProjects() {
  return loadConfig().projects;
}

export function resolveProject(ref) {
  if (!ref) return null;
  const needle = String(ref).toLowerCase();
  return listProjects().find(
    (project) => project.id.toLowerCase() === needle || project.name.toLowerCase() === needle,
  ) ?? null;
}

export function addProject({
  name,
  projectPath,
  baseBranch = "main",
  testCommand = "",
  setupCommand = "",
  reviewer = "",
  implModel = "",
  reviewModel = "",
  diffIgnore = "",
}) {
  const config = loadConfig();
  const abs = path.resolve(String(projectPath ?? "").trim());
  if (!projectPath || !existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new Error(`Project path does not exist or is not a directory: ${abs}`);
  }

  const existing = config.projects.find(
    (project) => path.resolve(project.path).toLowerCase() === abs.toLowerCase(),
  );
  if (existing) return existing;

  const displayName = String(name || path.basename(abs)).trim();
  let id = slugify(displayName, "project");
  const ids = new Set(config.projects.map((project) => project.id));
  if (ids.has(id)) {
    let i = 2;
    while (ids.has(`${id}-${i}`)) i += 1;
    id = `${id}-${i}`;
  }

  const project = {
    id,
    name: displayName,
    path: abs,
    baseBranch: String(baseBranch || "main").trim() || "main",
    testCommand: String(testCommand || "").trim(),
    setupCommand: String(setupCommand || "").trim(),
    reviewer: normalizeReviewer(reviewer),
    implModel: String(implModel || "").trim(),
    reviewModel: String(reviewModel || "").trim(),
    diffIgnore: normalizeDiffIgnore(diffIgnore),
  };
  config.projects.push(project);
  saveConfig(config);
  return project;
}

export function updateProject(ref, patch = {}) {
  const config = loadConfig();
  const needle = String(ref ?? "").toLowerCase();
  const project = config.projects.find(
    (item) => item.id.toLowerCase() === needle || item.name.toLowerCase() === needle,
  );
  if (!project) throw new Error(`Unknown project: ${ref}`);

  if (patch.name !== undefined && String(patch.name).trim()) {
    project.name = String(patch.name).trim();
  }
  if (patch.baseBranch !== undefined) {
    project.baseBranch = String(patch.baseBranch).trim() || "main";
  }
  if (patch.testCommand !== undefined) {
    project.testCommand = String(patch.testCommand).trim();
  }
  if (patch.setupCommand !== undefined) {
    project.setupCommand = String(patch.setupCommand).trim();
  }
  if (patch.reviewer !== undefined) {
    project.reviewer = normalizeReviewer(patch.reviewer);
  }
  if (patch.implModel !== undefined) {
    project.implModel = String(patch.implModel).trim();
  }
  if (patch.reviewModel !== undefined) {
    project.reviewModel = String(patch.reviewModel).trim();
  }
  if (patch.diffIgnore !== undefined) {
    project.diffIgnore = normalizeDiffIgnore(patch.diffIgnore);
  }

  saveConfig(config);
  return project;
}

export function normalizeDiffIgnore(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item ?? "").trim()).filter(Boolean);
  }
  const raw = String(value ?? "").trim();
  if (!raw) return [];
  return raw
    .split(/[,\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function effectiveDiffIgnore(project = null) {
  const configured = normalizeDiffIgnore(project?.diffIgnore);
  if (!configured.length) return [...DEFAULT_DIFF_IGNORE];
  if (configured.length === 1 && configured[0].toLowerCase() === "none") return [];
  return configured;
}

function normalizeReviewer(value) {
  const clean = String(value ?? "").trim().toLowerCase();
  return ["", "claude", "agy", "codex", "same", "auto"].includes(clean) ? clean : "";
}

export function removeProject(ref) {
  const config = loadConfig();
  const needle = String(ref ?? "").toLowerCase();
  const index = config.projects.findIndex(
    (item) => item.id.toLowerCase() === needle || item.name.toLowerCase() === needle,
  );
  if (index === -1) throw new Error(`Unknown project: ${ref}`);
  const [removed] = config.projects.splice(index, 1);
  saveConfig(config);
  return removed;
}

export function initProject(project) {
  const created = [];
  const warnings = [];

  const dirs = [
    "docs",
    "docs/specs",
    "docs/decisions",
    "docs/reviews",
    "docs/research",
    "docs/_templates",
  ];
  for (const dir of dirs) {
    const full = path.join(project.path, dir);
    if (!existsSync(full)) {
      ensureDir(full);
      created.push(`${dir}/`);
    }
  }

  const writeIfAbsent = (relative, content) => {
    const full = path.join(project.path, relative);
    if (existsSync(full)) return;
    ensureDir(path.dirname(full));
    writeFileSync(full, content, "utf8");
    created.push(relative);
  };

  writeIfAbsent(
    "AGENTS.md",
    renderTemplate(readText(path.join(TEMPLATES_DIR, "agents.md")), { PROJECT_NAME: project.name }),
  );
  writeIfAbsent(
    "docs/index.md",
    renderTemplate(readText(path.join(TEMPLATES_DIR, "docs-index.md")), { PROJECT_NAME: project.name }),
  );
  writeIfAbsent(
    "docs/architecture.md",
    "# Architecture\n\nDescribe the system in one page. Link ADRs instead of duplicating them.\n",
  );
  writeIfAbsent("docs/_templates/spec.md", readText(path.join(TEMPLATES_DIR, "spec.md")));
  writeIfAbsent("docs/_templates/adr.md", readText(path.join(TEMPLATES_DIR, "adr.md")));

  const gitignoreLines = [".worktrees/", ".orc/", ".obsidian/workspace*.json", ".obsidian/cache"];
  appendGitignore(project.path, gitignoreLines, created);

  if (!existsSync(path.join(project.path, ".git"))) {
    warnings.push("Not a git repository. Task worktrees need git; run `git init` in the project.");
  } else if (created.length) {
    warnings.push(
      "Scaffold files are uncommitted. Commit them before running tasks so worktrees inherit AGENTS.md and docs/.",
    );
  }

  return { created, warnings };
}

export function ensureProjectGitignore(project) {
  appendGitignore(project.path, [".worktrees/", ".orc/"], []);
}

function appendGitignore(projectPath, lines, created) {
  const file = path.join(projectPath, ".gitignore");
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  const present = new Set(current.split(/\r?\n/));
  const missing = lines.filter((line) => !present.has(line));
  if (!missing.length) return;
  const prefix = current && !current.endsWith("\n") ? "\n" : "";
  writeFileSync(file, `${current}${prefix}${missing.join("\n")}\n`, "utf8");
  if (created) created.push(".gitignore (entries)");
}
