import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIP = new Set(["node_modules", ".git", ".worktrees", ".orc", "data", "smoke_work"]);
const REQUIRED = [
  "package.json",
  "orc.config.example.json",
  "bin/orc.js",
  "src/cli.js",
  "src/server.js",
  "src/board.js",
  "src/dispatch.js",
  "src/agents.js",
  "src/config.js",
  "src/db.js",
  "src/util.js",
  "src/open.js",
  "public/index.html",
  "public/style.css",
  "public/app.js",
  "templates/spec.md",
  "templates/agents.md",
  "templates/docs-index.md",
  "templates/adr.md",
  "README.md",
  "LICENSE",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CHANGELOG.md",
  "scripts/smoke.mjs",
  "scripts/probe.mjs",
  "scripts/install-skill.mjs",
  "test/orc.test.mjs",
  "test/fixtures/claude-stream.jsonl",
  "test/fixtures/agy-stream.jsonl",
  "docs/decisions/ADR-0001-orchestrate-official-clis.md",
  "docs/decisions/ADR-0002-worktree-merge-and-concurrency.md",
  "docs/best-practices.md",
  "docs/troubleshooting.md",
  "skills/orc-orchestrator/SKILL.md",
  ".github/workflows/ci.yml",
  ".github/ISSUE_TEMPLATE/bug_report.md",
  ".github/ISSUE_TEMPLATE/feature_request.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
];

function walk(dir, output = []) {
  if (!existsSync(dir)) return output;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, output);
    } else if (/\.(js|mjs)$/i.test(entry.name)) {
      output.push(full);
    }
  }
  return output;
}

const jsFiles = [
  ...walk(path.join(ROOT, "bin")),
  ...walk(path.join(ROOT, "src")),
  ...walk(path.join(ROOT, "scripts")),
  ...walk(path.join(ROOT, "test")),
  ...walk(path.join(ROOT, "public")),
];

let failed = 0;

for (const file of jsFiles) {
  const relative = path.relative(ROOT, file);
  const result = spawnSync(process.execPath, ["--check", file], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status === 0) {
    console.log(`ok   ${relative}`);
  } else {
    failed += 1;
    console.error(`FAIL ${relative}`);
    console.error((result.stderr || result.stdout || "").trim());
  }
}

const jsonFiles = ["package.json", "orc.config.example.json"];
for (const relative of jsonFiles) {
  const file = path.join(ROOT, relative);
  try {
    JSON.parse(readFileSync(file, "utf8"));
    console.log(`ok   ${relative}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${relative}: ${error.message}`);
  }
}

for (const relative of REQUIRED) {
  if (!existsSync(path.join(ROOT, relative))) {
    failed += 1;
    console.error(`FAIL missing ${relative}`);
  }
}

const SKIP_PRIVACY = new Set(["orc.config.json", "STATUS.md"]);
const BANNED_PATTERNS = [
  new RegExp("[/\\\\]Users[/\\\\]max" + "vo\\b", "i"),
  new RegExp("Standard" + "projekt", "i"),
];

function walkTextFiles(dir, output = []) {
  if (!existsSync(dir)) return output;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name) || SKIP_PRIVACY.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTextFiles(full, output);
    } else if (/\.(js|mjs|json|md|yml|yaml|html|css|jsonl)$/i.test(entry.name)) {
      output.push(full);
    }
  }
  return output;
}

for (const file of walkTextFiles(ROOT)) {
  const text = readFileSync(file, "utf8");
  for (const pattern of BANNED_PATTERNS) {
    if (pattern.test(text)) {
      failed += 1;
      console.error(`FAIL privacy leak (${pattern}) in ${path.relative(ROOT, file)}`);
    }
  }
}

console.log("");
if (failed) {
  console.error(`${failed} problem(s) found.`);
  process.exitCode = 1;
} else {
  console.log(`Checked ${jsFiles.length} JS file(s), ${jsonFiles.length} JSON file(s), ${REQUIRED.length} required path(s). All good.`);
}
