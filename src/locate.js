import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const INSTALL_HINT =
  "Install the Codex CLI and sign in with your ChatGPT account:\n" +
  "  npm install -g @openai/codex\n" +
  "  codex login\n" +
  "If Codex is installed in a custom location, set the CODEX_PATH environment variable to the codex executable.";

export class CodexNotFoundError extends Error {
  constructor(message) {
    super(`${message}\n\n${INSTALL_HINT}`);
    this.name = "CodexNotFoundError";
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function readPathVar(env) {
  const key = Object.keys(env).find(k => k.toUpperCase() === "PATH");
  return key ? env[key] ?? "" : "";
}

export function extraSearchDirs(env = process.env, platform = process.platform) {
  const home = os.homedir();
  const dirs = [path.dirname(process.execPath)];
  if (platform === "win32") {
    if (env.APPDATA) dirs.push(path.join(env.APPDATA, "npm"));
    if (env.LOCALAPPDATA) dirs.push(path.join(env.LOCALAPPDATA, "Volta", "bin"));
  } else {
    dirs.push(
      path.join(home, ".npm-global", "bin"),
      path.join(home, ".local", "bin"),
      path.join(home, ".volta", "bin"),
      path.join(home, ".bun", "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin"
    );
  }
  if (env.npm_config_prefix) {
    dirs.push(platform === "win32" ? env.npm_config_prefix : path.join(env.npm_config_prefix, "bin"));
  }
  return dirs;
}

export function findCodex(env = process.env, platform = process.platform) {
  if (env.CODEX_PATH) {
    if (isFile(env.CODEX_PATH)) return env.CODEX_PATH;
    throw new CodexNotFoundError(`CODEX_PATH is set but no file exists at: ${env.CODEX_PATH}`);
  }
  const exts =
    platform === "win32"
      ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  const dirs = [...readPathVar(env).split(path.delimiter), ...extraSearchDirs(env, platform)].filter(Boolean);
  const seen = new Set();
  for (const dir of dirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    for (const ext of exts) {
      const candidate = path.join(dir, `codex${ext.toLowerCase()}`);
      if (isFile(candidate)) return candidate;
    }
  }
  throw new CodexNotFoundError("Codex CLI was not found on this machine.");
}

export function childEnv(env = process.env) {
  const key = Object.keys(env).find(k => k.toUpperCase() === "PATH") ?? "PATH";
  const nodeDir = path.dirname(process.execPath);
  const current = env[key] ?? "";
  const parts = current.split(path.delimiter).filter(Boolean);
  if (parts.includes(nodeDir)) return { ...env };
  return { ...env, [key]: [nodeDir, ...parts].join(path.delimiter) };
}
