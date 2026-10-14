import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import spawn from "cross-spawn";
import { AppServerClient } from "./app-server.js";
import { findCodex, INSTALL_HINT } from "./locate.js";

export const SERVER_NAME = "gpt-image";
export const SKILL_NAME = "gpt-image";
export const PACKAGE_SPEC = "github:Monayzera/mcp-gpt-image";
const COMMAND_TIMEOUT_MS = 120_000;

export function claudeConfigDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(os.homedir(), ".claude");
}

export function skillDir(env = process.env) {
  return path.join(claudeConfigDir(env), "skills", SKILL_NAME);
}

export function skillSource() {
  return fileURLToPath(new URL("../skill/SKILL.md", import.meta.url));
}

export function serverCommand(platform = process.platform) {
  const base = ["npx", "-y", PACKAGE_SPEC];
  return platform === "win32" ? ["cmd", "/c", ...base] : base;
}

export function runCommand(command, args, { timeoutMs = COMMAND_TIMEOUT_MS, spawnImpl = spawn } = {}) {
  return new Promise(resolve => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, ...result });
    };
    let child;
    try {
      child = spawnImpl(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      resolve({ code: null, stdout, stderr, error });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish({ code: null, error: new Error(`${command} ${args.join(" ")} timed out`) });
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", d => (stdout += d));
    child.stderr?.on("data", d => (stderr += d));
    child.on("error", error => finish({ code: null, error }));
    child.on("close", code => finish({ code }));
  });
}

export async function installSkill(env = process.env) {
  const dir = skillDir(env);
  await fs.mkdir(dir, { recursive: true });
  const dest = path.join(dir, "SKILL.md");
  await fs.copyFile(skillSource(), dest);
  return dest;
}

export async function removeSkill(env = process.env) {
  const dir = skillDir(env);
  const file = path.join(dir, "SKILL.md");
  try {
    await fs.unlink(file);
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
  await fs.rmdir(dir).catch(() => {});
  return true;
}

function manualAddCommand() {
  return `claude mcp add --scope user ${SERVER_NAME} -- ${serverCommand().join(" ")}`;
}

export async function registerServer(run = runCommand) {
  const existing = await run("claude", ["mcp", "get", SERVER_NAME]);
  if (existing.error?.code === "ENOENT") return { status: "no-claude" };
  if (existing.code === 0) return { status: "exists" };
  const added = await run("claude", ["mcp", "add", "--scope", "user", SERVER_NAME, "--", ...serverCommand()]);
  if (added.code === 0) return { status: "added" };
  return { status: "failed", detail: (added.error?.message ?? (added.stderr || added.stdout)).trim() };
}

export async function unregisterServer(run = runCommand) {
  const existing = await run("claude", ["mcp", "get", SERVER_NAME]);
  if (existing.error?.code === "ENOENT") return { status: "no-claude" };
  if (existing.code !== 0) return { status: "absent" };
  const removed = await run("claude", ["mcp", "remove", SERVER_NAME, "--scope", "user"]);
  if (removed.code === 0) return { status: "removed" };
  return { status: "failed", detail: (removed.error?.message ?? (removed.stderr || removed.stdout)).trim() };
}

async function checkCodex(print) {
  let codexPath;
  try {
    codexPath = findCodex();
  } catch {
    print(`Codex:  not found\n\n${INSTALL_HINT}`);
    return false;
  }
  const client = new AppServerClient({ codexPath, clientInfo: { name: "mcp-gpt-image-setup", version: "1" } });
  try {
    await client.start();
    const res = await client.request("account/read", {}, { timeoutMs: 30_000 });
    const account = res?.account;
    if (!account && res?.requiresOpenaiAuth) {
      print(`Codex:  ${codexPath} (${client.version ?? "unknown version"}), not signed in. Run: codex login`);
      return false;
    }
    const plan = account?.type === "chatgpt" && account.planType ? `, ChatGPT ${account.planType}` : "";
    print(`Codex:  ${codexPath} (${client.version ?? "unknown version"}${plan})`);
    return true;
  } catch (err) {
    print(`Codex:  ${codexPath} could not be started: ${err.message}`);
    return false;
  } finally {
    client.close();
  }
}

export async function setup(print = console.log) {
  const skillFile = await installSkill();
  print(`Skill:  ${skillFile}`);

  const reg = await registerServer();
  if (reg.status === "added") print(`MCP:    "${SERVER_NAME}" added to Claude Code (user scope)`);
  else if (reg.status === "exists") print(`MCP:    "${SERVER_NAME}" already registered, left unchanged`);
  else if (reg.status === "no-claude") print(`MCP:    Claude Code CLI not found. Register it manually:\n        ${manualAddCommand()}`);
  else print(`MCP:    registration failed: ${reg.detail}\n        Register it manually:\n        ${manualAddCommand()}`);

  const codexReady = await checkCodex(print);
  const ok = reg.status === "added" || reg.status === "exists";
  print("");
  print(ok && codexReady ? "Done. Restart Claude Code to load the skill and the MCP server." : "Finish the steps above, then restart Claude Code.");
  return ok && codexReady ? 0 : 1;
}

export async function uninstall(print = console.log) {
  const removedSkill = await removeSkill();
  print(removedSkill ? `Skill:  removed from ${skillDir()}` : "Skill:  not installed");
  const reg = await unregisterServer();
  if (reg.status === "removed") print(`MCP:    "${SERVER_NAME}" removed from Claude Code`);
  else if (reg.status === "absent") print(`MCP:    "${SERVER_NAME}" not registered`);
  else if (reg.status === "no-claude") print(`MCP:    Claude Code CLI not found. Remove it manually: claude mcp remove ${SERVER_NAME} --scope user`);
  else print(`MCP:    removal failed: ${reg.detail}`);
  return reg.status === "failed" ? 1 : 0;
}
