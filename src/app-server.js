import { EventEmitter } from "node:events";
import readline from "node:readline";
import spawn from "cross-spawn";
import { childEnv, findCodex } from "./locate.js";

const STDERR_KEEP = 30;
const INIT_TIMEOUT_MS = 60_000;
const CLOSE_GRACE_MS = 2_000;

const SERVER_REQUEST_REPLIES = {
  "item/commandExecution/requestApproval": { decision: "decline" },
  "item/fileChange/requestApproval": { decision: "decline" },
  "item/tool/requestUserInput": { answers: {} },
  "mcpServer/elicitation/request": { action: "decline" },
  applyPatchApproval: { decision: "abort" },
  execCommandApproval: { decision: "abort" },
};

export class CodexRpcError extends Error {
  constructor(method, error) {
    super(`Codex request "${method}" failed: ${error?.message ?? "unknown error"}`);
    this.name = "CodexRpcError";
    this.code = error?.code;
    this.data = error?.data;
  }
}

function stripAnsi(text) {
  return text.replace(/\x1B\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1B\][^\x07]*\x07/g, "");
}

function mergeSnapshot(prev, next) {
  const merged = { ...(prev ?? {}) };
  for (const [key, value] of Object.entries(next ?? {})) {
    if (value !== null && value !== undefined) merged[key] = value;
  }
  return merged;
}

export class AppServerClient extends EventEmitter {
  constructor({ codexPath, clientInfo, args = ["app-server"], spawnImpl = spawn }) {
    super();
    this.setMaxListeners(0);
    this.codexPath = codexPath;
    this.clientInfo = clientInfo;
    this.args = args;
    this.spawnImpl = spawnImpl;
    this.nextId = 1;
    this.pending = new Map();
    this.stderrLines = [];
    this.closed = false;
    this.child = null;
    this.startPromise = null;
    this.info = null;
    this.rateLimits = new Map();
    this.rateLimitsUpdatedAt = 0;
    this.modelsPromise = null;
  }

  start() {
    if (!this.startPromise) this.startPromise = this.#start();
    return this.startPromise;
  }

  async #start() {
    if (this.closed) throw new Error("Codex app-server was closed.");
    let child;
    try {
      child = this.spawnImpl(this.codexPath, this.args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: childEnv(),
        windowsHide: true,
      });
    } catch (err) {
      this.#fail(new Error(`Failed to start Codex at ${this.codexPath}: ${err.message}`));
      throw err;
    }
    this.child = child;
    child.on("error", err => this.#fail(new Error(`Failed to start Codex at ${this.codexPath}: ${err.message}`)));
    child.on("exit", (code, signal) =>
      this.#fail(new Error(`Codex app-server stopped (exit code ${code ?? "none"}, signal ${signal ?? "none"}).${this.stderrTail()}`))
    );
    child.stdin.on("error", () => {});
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});
    child.stderr.setEncoding("utf8");
    readline.createInterface({ input: child.stderr }).on("line", line => this.#keepStderr(line));
    readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", line => this.#onLine(line));

    const info = await this.request(
      "initialize",
      { clientInfo: this.clientInfo, capabilities: null },
      { timeoutMs: INIT_TIMEOUT_MS }
    );
    this.notify("initialized");
    this.info = info;
    return info;
  }

  get version() {
    const match = /^[^/\s]+\/(\S+)/.exec(this.info?.userAgent ?? "");
    return match ? match[1] : null;
  }

  stderrTail() {
    const lines = this.stderrLines.filter(l => l.trim());
    return lines.length ? `\nCodex stderr (last lines):\n${lines.slice(-10).join("\n")}` : "";
  }

  #keepStderr(line) {
    this.stderrLines.push(stripAnsi(line));
    if (this.stderrLines.length > STDERR_KEEP) this.stderrLines.shift();
  }

  #onLine(line) {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.#keepStderr(line);
      return;
    }
    if (!msg || typeof msg !== "object") return;
    const hasId = msg.id !== undefined && msg.id !== null;
    if (hasId && !msg.method) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new CodexRpcError(entry.method, msg.error));
      else entry.resolve(msg.result);
      return;
    }
    if (hasId && msg.method) {
      this.#answerServerRequest(msg);
      return;
    }
    if (msg.method) {
      if (msg.method === "account/rateLimits/updated") this.#storeRateLimits(msg.params?.rateLimits);
      try {
        this.emit("notification", msg);
      } catch (err) {
        this.#keepStderr(`notification handler error: ${err?.message ?? err}`);
      }
    }
  }

  #answerServerRequest(msg) {
    if (this.closed) return;
    const reply = SERVER_REQUEST_REPLIES[msg.method];
    const response = reply
      ? { jsonrpc: "2.0", id: msg.id, result: reply }
      : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `mcp-gpt-image does not handle "${msg.method}"` } };
    try {
      this.#write(response);
    } catch (err) {
      this.#keepStderr(`could not answer ${msg.method}: ${err?.message ?? err}`);
    }
  }

  #storeRateLimits(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return;
    const key = snapshot.limitId ?? "codex";
    this.rateLimits.set(key, mergeSnapshot(this.rateLimits.get(key), snapshot));
    this.rateLimitsUpdatedAt = Date.now();
  }

  async readRateLimits({ timeoutMs = 15_000 } = {}) {
    const res = await this.request("account/rateLimits/read", {}, { timeoutMs });
    const buckets = res?.rateLimitsByLimitId && Object.keys(res.rateLimitsByLimitId).length
      ? Object.values(res.rateLimitsByLimitId)
      : [res?.rateLimits];
    this.rateLimits.clear();
    for (const bucket of buckets) this.#storeRateLimits(bucket);
    return this.rateLimitSnapshots();
  }

  rateLimitSnapshots() {
    return [...this.rateLimits.values()];
  }

  async listModels() {
    if (!this.modelsPromise) {
      this.modelsPromise = (async () => {
        const models = [];
        let cursor = null;
        do {
          const res = await this.request("model/list", { cursor, includeHidden: false }, { timeoutMs: 30_000 });
          models.push(...(Array.isArray(res?.data) ? res.data : []));
          cursor = res?.nextCursor ?? null;
        } while (cursor && models.length < 1000);
        return models;
      })();
      this.modelsPromise.catch(() => {
        this.modelsPromise = null;
      });
    }
    return this.modelsPromise;
  }

  #write(msg) {
    if (this.closed || !this.child?.stdin?.writable) {
      throw new Error(`Codex app-server is not running.${this.stderrTail()}`);
    }
    this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  notify(method, params) {
    const msg = { jsonrpc: "2.0", method };
    if (params !== undefined) msg.params = params;
    this.#write(msg);
  }

  request(method, params, { timeoutMs = 120_000 } = {}) {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error(`Codex app-server is not running.${this.stderrTail()}`));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`Codex request "${method}" timed out after ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.#write({ jsonrpc: "2.0", id, method, params: params ?? {} });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  #fail(err) {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
    this.#terminate();
    this.emit("close", err);
  }

  #terminate() {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.stdin.end();
    } catch {}
    const timer = setTimeout(() => {
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      } catch {}
    }, CLOSE_GRACE_MS);
    timer.unref?.();
  }

  close() {
    this.#fail(new Error("Codex app-server was closed."));
  }
}

let current = null;

export async function getAppServer(clientInfo) {
  if (current && !current.closed) {
    await current.start();
    return current;
  }
  const client = new AppServerClient({ codexPath: findCodex(), clientInfo });
  current = client;
  client.once("close", () => {
    if (current === client) current = null;
  });
  try {
    await client.start();
  } catch (err) {
    if (current === client) current = null;
    client.close();
    throw err;
  }
  return client;
}

export function closeAppServer() {
  if (current) current.close();
  current = null;
}
