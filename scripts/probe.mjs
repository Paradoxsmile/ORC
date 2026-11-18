// Real-CLI headless probe for Claude Code (`claude`) and Google Antigravity (`agy`).
// Captures `--version`, `--help` flag presence, and a trivial read-only headless run
// as JSONL + JSON report files without touching the task board.
//
//   node scripts/probe.mjs [--agent claude|agy|all] [--out <dir>]

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectAgents, runAgent } from "../src/agents.js";
import { DATA_DIR } from "../src/config.js";
import { ensureDir } from "../src/util.js";

const EXPECTED_FLAGS = {
  claude: ["stream-json", "--permission-mode", "--allowedTools", "--resume", "--model"],
  agy: ["stream-json", "--mode", "--conversation", "--model", "--effort"],
};

function parseProbeArgs(argv) {
  let agent = "all";
  let outDir = path.join(DATA_DIR, "probes");

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/probe.mjs [--agent claude|agy|all] [--out <dir>]");
      process.exit(0);
    } else if (arg === "--agent" && argv[i + 1]) {
      agent = argv[++i];
    } else if (arg.startsWith("--agent=")) {
      agent = arg.slice("--agent=".length);
    } else if (arg === "--out" && argv[i + 1]) {
      outDir = path.resolve(argv[++i]);
    } else if (arg.startsWith("--out=")) {
      outDir = path.resolve(arg.slice("--out=".length));
    }
  }

  if (!["all", "claude", "agy"].includes(agent)) {
    throw new Error(`Invalid --agent "${agent}". Expected claude, agy, or all.`);
  }
  return { agent, outDir };
}

function invokeFlag(binaryPath, flag, cwd) {
  const isWinBatch = process.platform === "win32" && /\.(cmd|bat)$/i.test(binaryPath);
  const file = isWinBatch ? process.env.ComSpec || "cmd.exe" : binaryPath;
  const argv = isWinBatch ? ["/d", "/s", "/c", binaryPath, flag] : [flag];

  const result = spawnSync(file, argv, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
  return {
    code: result.status ?? -1,
    stdout: String(result.stdout ?? "").trim(),
    stderr: String(result.stderr ?? "").trim(),
  };
}

function summarizeEventShapes(rawEvents) {
  const seen = new Map();
  for (const event of rawEvents) {
    if (!event || typeof event !== "object") continue;
    const kind = String(event.event ?? event.type ?? "unknown");
    const keys = Object.keys(event).sort();
    const sig = `${kind}:${keys.join(",")}`;
    if (!seen.has(sig)) seen.set(sig, { kind, keys });
  }
  return [...seen.values()];
}

async function probeOne(agent, binary, outDir) {
  if (!binary?.available) {
    console.log(`[skip] ${agent}: CLI not found on PATH`);
    return { agent, available: false };
  }

  console.log(`[probe] ${agent} (${binary.path})`);
  const scratchDir = mkdtempSync(path.join(os.tmpdir(), `orc-probe-${agent}-`));
  let versionRun;
  let helpFlags;
  let runResult;
  try {
    versionRun = invokeFlag(binary.path, "--version", scratchDir);
    const helpRun = invokeFlag(binary.path, "--help", scratchDir);
    const helpText = `${helpRun.stdout}\n${helpRun.stderr}`;
    helpFlags = Object.fromEntries(
      EXPECTED_FLAGS[agent].map((flag) => [flag, helpText.includes(flag)]),
    );

    runResult = await runAgent({
      agent,
      prompt: "Reply with the single word PONG and nothing else.",
      cwd: scratchDir,
      mode: "plan",
      timeoutMs: 120_000,
      taskId: "probe",
      runId: `${agent}-${Date.now()}`,
    });
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }

  ensureDir(outDir);
  const jsonlPath = path.join(outDir, `${agent}-probe.jsonl`);
  if (runResult.logPath && existsSync(runResult.logPath)) {
    copyFileSync(runResult.logPath, jsonlPath);
  } else {
    const content = runResult.raw.map((item) => JSON.stringify(item)).join("\n");
    writeFileSync(jsonlPath, content ? `${content}\n` : "", "utf8");
  }

  const eventShapes = summarizeEventShapes(runResult.raw);
  const report = {
    agent,
    available: true,
    path: binary.path,
    version: versionRun.stdout || versionRun.stderr || null,
    helpFlags,
    exitCode: runResult.code,
    sessionId: runResult.sessionId,
    eventShapes,
    text: runResult.text,
    error: runResult.error,
    logPath: jsonlPath,
  };

  const reportPath = path.join(outDir, `${agent}-probe.report.json`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`  exitCode : ${report.exitCode}`);
  console.log(`  sessionId: ${report.sessionId ?? "(none)"}`);
  console.log(`  shapes   : ${eventShapes.map((s) => s.kind).join(", ") || "(none)"}`);
  console.log(`  report   : ${reportPath}`);

  return report;
}

async function main() {
  const { agent, outDir } = parseProbeArgs(process.argv.slice(2));
  const health = detectAgents(true);
  const targets = agent === "all" ? ["claude", "agy"] : [agent];

  const results = [];
  for (const target of targets) {
    results.push(await probeOne(target, health[target], outDir));
  }
  return results;
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
