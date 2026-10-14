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

function isExecutable(p, platform) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    if (platform !== "win32") fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readPathVar(env) {
  const key = Object.keys(env).find(k => k.toUpperCase() === "PATH");
  return key ? env[key] ?? "" : "";
}

function nvmBinDirs(home) {
  const root = path.join(home, ".nvm", "versions", "node");
  try {
    return fs
      .readdirSync(root)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map(v => path.join(root, v, "bin"));
  } catch {
    return [];
  }
}

export function extraSearchDirs(env = process.env, platform = process.platform) {
  const home = os.homedir();
  const dirs = [path.dirname(process.execPath)];
  if (env.CODEX_INSTALL_DIR) dirs.push(env.CODEX_INSTALL_DIR);
  if (platform === "win32") {
    if (env.LOCALAPPDATA) {
      dirs.push(
        path.join(env.LOCALAPPDATA, "Programs", "OpenAI", "Codex", "bin"),
        path.join(env.LOCALAPPDATA, "pnpm"),
        path.join(env.LOCALAPPDATA, "Volta", "bin")
      );
    }
    if (env.APPDATA) dirs.push(path.join(env.APPDATA, "npm"));
    dirs.push(path.join(home, ".bun", "bin"));
  } else {
    if (env.NVM_BIN) dirs.push(env.NVM_BIN);
    if (env.PNPM_HOME) dirs.push(env.PNPM_HOME);
    dirs.push(
      path.join(home, ".local", "bin"),
      path.join(home, ".npm-global", "bin"),
      path.join(home, ".volta", "bin"),
      path.join(home, ".bun", "bin"),
      path.join(home, ".asdf", "shims"),
      path.join(home, "Library", "pnpm"),
      path.join(home, ".local", "share", "pnpm"),
      "/opt/homebrew/bin",
      "/home/linuxbrew/.linuxbrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      ...nvmBinDirs(home)
    );
  }
  if (env.npm_config_prefix) {
    dirs.push(platform === "win32" ? env.npm_config_prefix : path.join(env.npm_config_prefix, "bin"));
  }
  return dirs;
}

function isWsl(env, platform) {
  return platform === "linux" && Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP);
}

export function findCodex(env = process.env, platform = process.platform) {
  if (env.CODEX_PATH) {
    if (isExecutable(env.CODEX_PATH, platform)) return env.CODEX_PATH;
    throw new CodexNotFoundError(`CODEX_PATH is set but no executable file exists at: ${env.CODEX_PATH}`);
  }
  const exts =
    platform === "win32"
      ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  const skipWindowsMounts = isWsl(env, platform);
  const dirs = [...readPathVar(env).split(path.delimiter), ...extraSearchDirs(env, platform)]
    .map(d => d.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean)
    .filter(d => !(skipWindowsMounts && d.startsWith("/mnt/")));
  const seen = new Set();
  for (const dir of dirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    for (const ext of exts) {
      const candidate = path.join(dir, `codex${ext.toLowerCase()}`);
      if (isExecutable(candidate, platform)) return candidate;
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
