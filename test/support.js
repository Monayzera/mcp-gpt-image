import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import spawn from "cross-spawn";
import { AppServerClient } from "../src/app-server.js";

export const FIXTURE = fileURLToPath(new URL("./fixtures/fake-codex.js", import.meta.url));
export const CLIENT_INFO = { name: "mcp-gpt-image", title: "MCP GPT Image", version: "0.0.0-test" };

const clients = new Set();
const dirs = new Set();

export async function makeTmp(prefix = "mcp-gpt-image-test-") {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.add(dir);
  return dir;
}

export function fakeEnv(base, scenario, extra = {}) {
  const env = { ...base, FAKE_SCENARIO: scenario, ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

export function createClient(scenario = "ok", extraEnv = {}) {
  const spawnImpl = (command, args, options) =>
    spawn(command, args, { ...options, env: fakeEnv(options.env, scenario, extraEnv) });
  const client = new AppServerClient({ codexPath: process.execPath, args: [FIXTURE], clientInfo: CLIENT_INFO, spawnImpl });
  clients.add(client);
  return client;
}

export async function readLog(file) {
  let text;
  try {
    text = await fsp.readFile(file, "utf8");
  } catch {
    return [];
  }
  const messages = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      messages.push(JSON.parse(line));
    } catch {}
  }
  return messages;
}

export async function session(scenario = "ok", extraEnv = {}) {
  const root = await makeTmp();
  const base = path.join(root, "base");
  await fsp.mkdir(base);
  const logFile = path.join(root, "fake.log");
  const client = createClient(scenario, { FAKE_LOG: logFile, ...extraEnv });
  return { client, root, base, logFile, log: () => readLog(logFile) };
}

export async function makeCodexWrapper(dir) {
  const file = path.join(dir, "codex");
  await fsp.writeFile(file, `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE}" "$@"\n`, { mode: 0o755 });
  return file;
}

export async function waitFor(check, { timeoutMs = 4000, intervalMs = 10, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

export function waitForNotification(client, predicate, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const handler = message => {
      if (!predicate(message)) return;
      clearTimeout(timer);
      client.off("notification", handler);
      resolve(message);
    };
    const timer = setTimeout(() => {
      client.off("notification", handler);
      reject(new Error("Timed out waiting for notification"));
    }, timeoutMs);
    client.on("notification", handler);
  });
}

export async function closeClient(client) {
  const child = client.child;
  client.close();
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.stdin.end();
  } catch {}
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 3000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function cleanup() {
  await Promise.all([...clients].map(closeClient));
  clients.clear();
  await Promise.all([...dirs].map(dir => fsp.rm(dir, { recursive: true, force: true })));
  dirs.clear();
}
