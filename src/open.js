import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

function launch(file, args, options = {}) {
  const child = spawn(file, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: process.platform !== "win32",
    ...options,
  });
  child.on("error", () => {});
  child.unref();
}

export function openTarget(target) {
  const abs = path.resolve(String(target));
  if (!existsSync(abs)) throw new Error(`Path does not exist: ${abs}`);

  if (process.platform === "win32") {
    launch("explorer.exe", [abs]);
    return abs;
  }
  if (process.platform === "darwin") {
    launch("open", [abs]);
    return abs;
  }
  launch("xdg-open", [abs]);
  return abs;
}

export function revealFile(file) {
  const abs = path.resolve(String(file));
  if (!existsSync(abs)) throw new Error(`File does not exist: ${abs}`);

  if (process.platform === "win32") {
    if (statSync(abs).isDirectory()) {
      launch("explorer.exe", [abs]);
    } else {
      launch("explorer.exe", [`/select,"${abs}"`], { windowsVerbatimArguments: true });
    }
    return abs;
  }

  if (process.platform === "darwin") {
    launch("open", ["-R", abs]);
    return abs;
  }

  launch("xdg-open", [statSync(abs).isDirectory() ? abs : path.dirname(abs)]);
  return abs;
}
