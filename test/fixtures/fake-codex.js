import fs from "node:fs";
import readline from "node:readline";
import { makePng } from "./images.js";

const scenario = process.env.FAKE_SCENARIO;
if (!scenario) process.exit(0);

const logFile = process.env.FAKE_LOG || null;
const rateLimitsByLimitId = process.env.FAKE_RL_BY_ID === "1";
const modelPages = Number(process.env.FAKE_PAGES || 1);
const failModelListOnce = process.env.FAKE_MODEL_FAIL_ONCE === "1";
const stepDelayMs = Number(process.env.FAKE_DELAY_MS || 15);

const PNG_BASE64 = makePng(3, 2).toString("base64");

const DEFAULT_MODEL = {
  id: "m-default",
  model: "m-default",
  isDefault: true,
  hidden: false,
  supportedReasoningEfforts: [
    { reasoningEffort: "low", description: "" },
    { reasoningEffort: "high", description: "" },
  ],
  defaultReasoningEffort: "high",
  displayName: "",
  description: "",
};

record({ event: "started", pid: process.pid });

const waiting = new Map();
let modelListFailed = false;
let crashArmed = false;
let activeThreadId = null;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function snapshot() {
  return {
    limitId: "codex",
    primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: nowSeconds() + 3600 },
    secondary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: nowSeconds() + 3 * 86400 },
    planType: "plus",
  };
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function record(message) {
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, `${JSON.stringify(message)}\n`);
  } catch {}
}

function reply(id, result) {
  send({ id, result });
}

function replyError(id, code, message) {
  send({ id, error: { code, message } });
}

function notify(method, params) {
  send({ method, params });
}

function ask(id, method, params) {
  return new Promise(resolve => {
    waiting.set(id, resolve);
    send({ id, method, params });
  });
}

function revisedPromptFor(text) {
  if (process.env.FAKE_REVISED !== undefined) return process.env.FAKE_REVISED;
  if (scenario === "altered") return `${text} -- rewritten`;
  if (scenario === "norevised") return null;
  return text;
}

function failureFor() {
  if (process.env.FAKE_FAILURE !== undefined) return JSON.parse(process.env.FAKE_FAILURE);
  return { type: "usageLimitExceeded", limitId: "images", resetsAt: nowSeconds() + 7200 };
}

function failedItem(id) {
  return { type: "imageGeneration", id, status: "failed", revisedPrompt: null, result: "", savedPath: null, failure: failureFor() };
}

function errorInfo() {
  return process.env.FAKE_ERROR_INFO !== undefined ? JSON.parse(process.env.FAKE_ERROR_INFO) : "unauthorized";
}

function errorDetails() {
  return process.env.FAKE_ERROR_DETAILS ?? null;
}

function imageOverrides() {
  if (scenario === "savedpath") return { result: "", savedPath: process.env.FAKE_SAVED_PATH || null };
  if (scenario === "badimage") return { result: Buffer.from("this is not an image").toString("base64") };
  return {};
}

async function runTurn(threadId, text) {
  const completeTurn = turn => notify("turn/completed", { threadId, turn: { id: "u1", status: "completed", error: null, items: [], ...turn } });
  const itemStarted = id => notify("item/started", { threadId, turnId: "u1", item: { type: "imageGeneration", id, status: "in_progress", result: "" } });
  const itemCompleted = item => notify("item/completed", { threadId, turnId: "u1", item });

  await sleep(stepDelayMs);

  if (scenario === "hang") {
    itemStarted("img1");
    return;
  }

  if (scenario === "crash_midturn") {
    itemStarted("img1");
    await sleep(stepDelayMs);
    process.exit(3);
  }

  if (scenario === "noimage") {
    itemCompleted({ type: "agentMessage", id: "msg1", text: "policy refusal" });
    completeTurn({});
    return;
  }

  if (scenario === "fail_limit") {
    itemStarted("img1");
    itemCompleted(failedItem("img1"));
    completeTurn({});
    return;
  }

  if (scenario === "turn_error") {
    completeTurn({ status: "failed", error: { message: "boom", codexErrorInfo: errorInfo(), additionalDetails: errorDetails() } });
    return;
  }

  if (scenario === "error_notice") {
    notify("error", {
      threadId,
      turnId: "u1",
      willRetry: true,
      error: { message: "retrying transient failure", codexErrorInfo: "serverOverloaded", additionalDetails: null },
    });
    notify("error", {
      threadId,
      turnId: "u1",
      willRetry: false,
      error: { message: "stream failed", codexErrorInfo: errorInfo(), additionalDetails: errorDetails() },
    });
    completeTurn({});
    return;
  }

  if (scenario === "foreign_thread") {
    notify("item/completed", {
      threadId: "other",
      turnId: "z1",
      item: { type: "imageGeneration", id: "foreign", status: "completed", revisedPrompt: "foreign", result: PNG_BASE64, savedPath: null },
    });
    notify("turn/completed", { threadId: "other", turn: { id: "z1", status: "completed", error: null, items: [] } });
  }

  if (scenario === "server_request") {
    itemStarted("img0");
    const [approval, unknown] = await Promise.all([
      ask("srv1", "item/commandExecution/requestApproval", {}),
      ask("srv2", "item/nonexistent/method", {}),
    ]);
    const approvalOk = approval.result?.decision === "decline";
    const unknownOk = Boolean(unknown.error) && unknown.result === undefined;
    if (!approvalOk || !unknownOk) {
      completeTurn({ status: "failed", error: { message: "server_request mismatch", codexErrorInfo: null } });
      return;
    }
  }

  const total = scenario === "count2" || scenario === "partial" ? 2 : 1;
  for (let i = 1; i <= total; i++) {
    itemStarted(`img${i}`);
    if (i === 1) notify("account/rateLimits/updated", { rateLimits: snapshot() });
    await sleep(stepDelayMs);
    if (scenario === "partial" && i === 2) {
      itemCompleted(failedItem(`img${i}`));
      continue;
    }
    itemCompleted({
      type: "imageGeneration",
      id: `img${i}`,
      status: "completed",
      revisedPrompt: revisedPromptFor(text),
      result: PNG_BASE64,
      savedPath: null,
      ...imageOverrides(),
    });
  }
  completeTurn({});
}

function handleRequest(message) {
  const { id, method, params } = message;

  if (scenario === "crash_init" && method === "initialize") process.exit(3);
  if (crashArmed && method !== "initialize") process.exit(3);

  switch (method) {
    case "initialize":
      reply(id, { userAgent: "mcp-gpt-image/9.9.9 (test)", codexHome: "/tmp" });
      if (scenario === "crash") crashArmed = true;
      return;
    case "model/list": {
      if (failModelListOnce && !modelListFailed) {
        modelListFailed = true;
        replyError(id, -32000, "model list unavailable");
        return;
      }
      const page = params?.cursor ? Number(params.cursor) : 1;
      const data = page === 1 ? [DEFAULT_MODEL] : [{ ...DEFAULT_MODEL, id: `m-page${page}`, model: `m-page${page}`, isDefault: false }];
      reply(id, { data, nextCursor: page < modelPages ? String(page + 1) : null });
      return;
    }
    case "thread/start":
      activeThreadId = "t1";
      reply(id, { thread: { id: "t1" }, model: "m-default", cwd: params?.cwd ?? "/tmp", approvalPolicy: "never", reasoningEffort: null });
      return;
    case "turn/start":
      reply(id, { turn: { id: "u1", status: "inProgress" } });
      runTurn(params?.threadId ?? activeThreadId, params?.input?.[0]?.text ?? "").catch(err => process.stderr.write(`fake turn error: ${err?.message ?? err}\n`));
      return;
    case "turn/interrupt":
      reply(id, {});
      notify("turn/completed", { threadId: params?.threadId ?? activeThreadId, turn: { id: "u1", status: "interrupted", error: null, items: [] } });
      return;
    case "thread/unsubscribe":
      reply(id, {});
      return;
    case "account/rateLimits/read":
      if (rateLimitsByLimitId) {
        const images = { limitId: "images", primary: { usedPercent: 40, windowDurationMins: 1440, resetsAt: nowSeconds() + 7200 } };
        reply(id, { rateLimits: snapshot(), rateLimitsByLimitId: { codex: snapshot(), images } });
      } else {
        reply(id, { rateLimits: snapshot() });
      }
      return;
    case "account/read":
      reply(id, { account: { type: "chatgpt", email: "test@example.com", planType: "plus" }, requiresOpenaiAuth: true });
      return;
    case "config/read":
      reply(id, { config: { model: "m-default", model_reasoning_effort: "high" } });
      return;
    case "test/hang":
      return;
    case "test/emit":
      for (const notification of params?.notifications ?? []) notify(notification.method, notification.params);
      for (const raw of params?.raw ?? []) process.stdout.write(`${raw}\n`);
      reply(id, {});
      return;
    case "test/stderr":
      process.stderr.write(`${params?.text ?? ""}\n`);
      reply(id, {});
      return;
    default:
      replyError(id, -32601, `unknown method ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", line => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  record(message);
  const hasId = message.id !== undefined && message.id !== null;
  if (hasId && message.method === undefined) {
    const resolve = waiting.get(message.id);
    waiting.delete(message.id);
    if (resolve) resolve(message);
    return;
  }
  if (hasId) {
    try {
      handleRequest(message);
    } catch (err) {
      replyError(message.id, -32603, err?.message ?? String(err));
    }
  }
});

rl.on("close", () => process.exit(0));
