// Installs the portable `orc-orchestrator` skill for Antigravity & Claude Code
// and creates global `orc` / `orc.cmd` launchers in `~/.local/bin`.
//
//   node scripts/install-skill.mjs [--home <dir>]

import { chmodSync, copyFileSync, existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir } from "../src/util.js";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SKILL_SRC = path.join(ROOT, "skills", "orc-orchestrator", "SKILL.md");
const CLI_ENTRY = path.join(ROOT, "bin", "orc.js");

function parseArgs(argv) {
  let homeDir = os.homedir();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/install-skill.mjs [--home <dir>]");
      process.exit(0);
    } else if (arg === "--home" && argv[i + 1]) {
      homeDir = path.resolve(argv[++i]);
    } else if (arg.startsWith("--home=")) {
      homeDir = path.resolve(arg.slice("--home=".length));
    }
  }
  return { homeDir };
}

/**
 * Copies `orc-orchestrator/SKILL.md` into Antigravity & Claude Code skill directories
 * and installs global `orc` / `orc.cmd` shims into `<homeDir>/.local/bin`.
 */
export function installOrc({ homeDir = os.homedir() } = {}) {
  if (!existsSync(SKILL_SRC)) {
    throw new Error(`Skill file not found: ${SKILL_SRC}`);
  }

  const agySkill = path.join(homeDir, ".gemini", "config", "skills", "orc-orchestrator", "SKILL.md");
  const claudeSkill = path.join(homeDir, ".claude", "skills", "orc-orchestrator", "SKILL.md");
  for (const dest of [agySkill, claudeSkill]) {
    ensureDir(path.dirname(dest));
    copyFileSync(SKILL_SRC, dest);
  }

  const binDir = path.join(homeDir, ".local", "bin");
  ensureDir(binDir);

  const cmdPath = path.join(binDir, "orc.cmd");
  const shPath = path.join(binDir, "orc");
  const posixEntry = CLI_ENTRY.replaceAll("\\", "/");

  writeFileSync(cmdPath, `@echo off\r\nnode "${CLI_ENTRY}" %*\r\n`, "utf8");
  writeFileSync(shPath, `#!/bin/sh\nexec node "${posixEntry}" "$@"\n`, "utf8");
  if (process.platform !== "win32") {
    chmodSync(shPath, 0o755);
  }

  const pathDirs = String(process.env.PATH ?? "")
    .split(path.delimiter)
    .map((dir) => dir.replace(/^"(.*)"$/, "$1").trim().toLowerCase())
    .filter(Boolean);
  const binOnPath = pathDirs.includes(binDir.toLowerCase());

  return { agySkill, claudeSkill, binDir, cmdPath, shPath, binOnPath };
}

export function printInstallResult(result) {
  console.log("");
  console.log("ORC global install complete");
  console.log(`  antigravity skill : ${result.agySkill}`);
  console.log(`  claude code skill : ${result.claudeSkill}`);
  console.log(`  launcher (win)    : ${result.cmdPath}`);
  console.log(`  launcher (posix)  : ${result.shPath}`);

  if (!result.binOnPath) {
    console.log("");
    console.log(`Note: ${result.binDir} is not currently on your PATH.`);
    if (process.platform === "win32") {
      console.log(
        `Add it once in PowerShell:\n  [Environment]::SetEnvironmentVariable("PATH", "$env:PATH;${result.binDir}", [EnvironmentVariableTarget]::User)`,
      );
    } else {
      console.log(`Add it to your shell profile:\n  export PATH="${result.binDir}:$PATH"`);
    }
  } else {
    console.log("\nYou can now run `orc serve` or `orc doctor` from any directory.");
  }
  console.log("");
}

function main() {
  const { homeDir } = parseArgs(process.argv.slice(2));
  const result = installOrc({ homeDir });
  printInstallResult(result);
}

if (path.resolve(process.argv[1] || "") === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
