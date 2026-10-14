import { createRequire } from "node:module";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { closeAppServer, getAppServer } from "./app-server.js";
import { formatRateLimits } from "./format.js";
import { resolveReferenceImages } from "./files.js";
import { envDefaults, generateImages, withEnvDefaults } from "./generate.js";
import { CodexNotFoundError, findCodex, INSTALL_HINT } from "./locate.js";

const pkg = createRequire(import.meta.url)("../package.json");
const CLIENT_INFO = { name: "mcp-gpt-image", title: "MCP GPT Image", version: pkg.version };

const SERVER_INSTRUCTIONS = [
  "Generates and edits images with GPT Image through the local Codex CLI, using the user's ChatGPT login (no API key).",
  "Each image takes roughly 30-90 seconds. Write the complete final prompt yourself: in prompt_mode \"exact\" (default) Codex is told to pass it to GPT Image unchanged, and the result reports whether it did.",
  "There is no size parameter: state the aspect ratio in the prompt (for example \"16:9 landscape\").",
  "Results include the saved file paths and the usage limits Codex reports (5-hour and weekly windows).",
  "Call codex_status to check the setup, the usage limits, and which models and reasoning efforts are available.",
  "To keep working while an image renders, call generate_image with background: true and collect it later with get_image_result.",
].join("\n");

const server = new McpServer({ name: "gpt-image", version: pkg.version }, { instructions: SERVER_INSTRUCTIONS });

function log(...args) {
  process.stderr.write(`[mcp-gpt-image] ${args.join(" ")}\n`);
}

async function projectDir() {
  if (process.env.CLAUDE_PROJECT_DIR) return path.resolve(process.env.CLAUDE_PROJECT_DIR);
  try {
    if (server.server.getClientCapabilities()?.roots) {
      const { roots } = await server.server.listRoots(undefined, { timeout: 5_000 });
      const root = roots?.find(r => typeof r.uri === "string" && r.uri.startsWith("file:"));
      if (root) return fileURLToPath(root.uri);
    }
  } catch (err) {
    log("roots/list failed:", err?.message ?? err);
  }
  return process.cwd();
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

async function limitLines(client, since) {
  try {
    if (client.rateLimitsUpdatedAt < since) await client.readRateLimits({ timeoutMs: 10_000 });
  } catch (err) {
    log("rate limit read failed:", err?.message ?? err);
  }
  const snapshots = client.rateLimitSnapshots();
  const lines = formatRateLimits(snapshots);
  if (!lines.length) return ["Usage limits: unavailable right now."];
  const plan = snapshots.find(s => s.planType)?.planType;
  return [`Usage limits${plan ? ` (ChatGPT ${plan})` : ""}:`, ...lines.map(l => `- ${l}`)];
}

function errorResult(err) {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text", text: message }] };
}

async function runGeneration(args, { signal, onProgress } = {}) {
  const since = Date.now();
  let client = null;
  try {
    client = await getAppServer(CLIENT_INFO);
    const baseDir = await projectDir();
    const result = await generateImages({ client, params: withEnvDefaults(args), baseDir, signal, onProgress });

    const header = [
      result.images.length < result.requested
        ? `Generated ${result.images.length} of ${result.requested} requested images with GPT Image via Codex`
        : `Generated ${result.images.length} image${result.images.length > 1 ? "s" : ""} with GPT Image via Codex`,
      `(model ${result.model ?? "from Codex config"}${result.effort ? `, effort ${result.effort}` : ""}, prompt_mode ${result.mode}) in ${Math.round(result.durationMs / 1000)}s.`,
    ].join(" ");
    const lines = [header, ""];
    result.images.forEach((img, i) => {
      const dims = img.size ? `${img.size.width}x${img.size.height}, ` : "";
      lines.push(`Image ${i + 1}: ${img.path} (${dims}${formatBytes(img.bytes)})`);
      if (result.mode === "exact" && img.verbatim === true) {
        lines.push("Prompt that reached GPT Image: identical to yours.");
      } else if (img.revisedPrompt) {
        const note = result.mode === "exact" ? " (differs from yours)" : "";
        lines.push(`Prompt that reached GPT Image${note}:\n${img.revisedPrompt}`);
      } else {
        lines.push("Prompt that reached GPT Image: not reported by Codex.");
      }
      if (result.transparent) {
        if (img.alpha === true) lines.push("Transparent background: alpha channel present.");
        else if (img.alpha === false) lines.push("Transparent background requested, but this image has NO alpha channel.");
        else lines.push("Transparent background requested; alpha channel could not be checked for this format.");
      }
    });
    if (result.failures.length) lines.push("", "Not generated:", ...result.failures.map(f => `- ${f}`));
    lines.push("", ...(await limitLines(client, since)));

    return {
      content: [
        { type: "text", text: lines.join("\n") },
        ...result.images.map(img => ({ type: "image", data: img.data, mimeType: img.mimeType })),
      ],
    };
  } catch (err) {
    log("image generation failed:", err?.stack ?? err);
    const result = errorResult(err);
    if (client && !client.closed) {
      const limits = await limitLines(client, since).catch(() => []);
      if (limits.length) result.content[0].text += `\n\n${limits.join("\n")}`;
    }
    return result;
  }
}

const JOB_TTL_MS = 60 * 60_000;
const MAX_RUNNING_JOBS = 4;
const jobs = new Map();

function runningJobs() {
  return [...jobs.values()].filter(j => j.status === "running").length;
}

function newJobId() {
  let id;
  do id = randomUUID().replaceAll("-", "").slice(0, 16);
  while (jobs.has(id));
  return id;
}

function startJob(args) {
  const id = newJobId();
  const job = { id, status: "running", startedAt: Date.now(), finishedAt: null, progress: "Starting Codex", result: null, delivered: false };
  job.promise = runGeneration(args, { onProgress: ({ message }) => (job.progress = message) })
    .catch(err => errorResult(err))
    .then(result => {
      job.result = result;
      job.status = result.isError ? "failed" : "done";
      job.finishedAt = Date.now();
      setTimeout(() => jobs.delete(id), JOB_TTL_MS).unref();
    });
  jobs.set(id, job);
  return job;
}

function waitFor(promise, ms, signal) {
  return new Promise(resolve => {
    let timer = null;
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    if (signal?.aborted) {
      done();
      return;
    }
    timer = setTimeout(done, ms);
    promise.then(done, done);
    signal?.addEventListener("abort", done, { once: true });
  });
}

function collectJob(job) {
  if (!job.delivered) {
    job.delivered = true;
    const result = job.result;
    job.result = {
      ...result,
      content: [
        {
          type: "text",
          text: `${result.content.find(c => c.type === "text")?.text ?? ""}\n\n(Images of job ${job.id} were already returned once; open the saved files above to see them again.)`,
        },
      ],
    };
    return result;
  }
  return job.result;
}

server.registerTool(
  "generate_image",
  {
    title: "Generate image (GPT Image via Codex)",
    description: [
      "Generate or edit images with GPT Image through the local Codex CLI and return them inline, saved to disk.",
      "Pass reference_images to edit existing images or to use them as style/subject references.",
      "Set background: true to get a job id at once and keep working; the images then come from get_image_result.",
      "Takes about 30-90 seconds per image. There is no size parameter: put the aspect ratio in the prompt (for example \"16:9 landscape\", \"square 1:1\", \"vertical 9:16\").",
      "The result lists each saved file path and size, the prompt that reached GPT Image, an alpha-channel check when a transparent background was requested, and the usage limits Codex reports.",
    ].join(" "),
    inputSchema: {
      prompt: z
        .string()
        .refine(s => s.trim().length > 0, "prompt must not be empty")
        .describe(
          "The image prompt. In prompt_mode \"exact\" Codex is told to send it to GPT Image unchanged, so make it complete: aspect ratio, subject, composition, style, lighting, colors, and any text that must appear (in quotes, exact spelling). Do not put file paths in it; use reference_images."
        ),
      count: z.number().int().min(1).max(4).default(1).describe("How many images to generate from the same prompt (1-4). Each one uses the ChatGPT image quota. Codex may return fewer; the result says so."),
      transparent_background: z.boolean().default(false).describe("Ask for a transparent background (cutouts, icons, stickers). The result reports whether the PNG has an alpha channel."),
      reference_images: z
        .array(z.string().min(1))
        .max(16)
        .optional()
        .describe("Local image files (PNG, JPEG, WebP or GIF, up to 16) to edit, to use as references, or to place in the result (for example a real logo). Absolute, relative to the project directory, or starting with ~. Images the user pasted or attached in the chat come with a file path (\"[Image: source: <path>]\"): pass that path."),
      prompt_mode: z
        .enum(["exact", "enhance"])
        .default("exact")
        .describe("\"exact\" (default): Codex is told to pass the prompt to GPT Image unchanged; the result reports any difference. \"enhance\": the Codex model first rewrites it into a more detailed prompt, and the result shows the rewritten prompt."),
      model: z
        .string()
        .min(1)
        .optional()
        .describe("Codex chat model that relays the request and, in enhance mode, rewrites the prompt. It does not choose the image model. Default: GPT_IMAGE_MODEL if set, otherwise the model in the user's Codex config. Call codex_status for the list."),
      reasoning_effort: z
        .string()
        .min(1)
        .optional()
        .describe("Reasoning effort for the Codex model, e.g. low, medium, high. Default: GPT_IMAGE_EFFORT if set; otherwise low in exact mode when the model supports it, else the Codex config default. Call codex_status for the values each model supports."),
      output_path: z
        .string()
        .min(1)
        .optional()
        .describe("Where to save: a directory, or a file path such as hero.png (the name is kept; the extension follows the format returned, normally PNG). Relative paths resolve against the project directory; ~ is expanded. Default: <project>/generated-images/. Existing files are never overwritten; a numeric suffix is added instead."),
      background: z
        .boolean()
        .default(false)
        .describe("Return immediately with a job id and keep generating in the background, so you can do other work. Collect the images later with get_image_result."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async (args, extra) => {
    const { background, ...params } = args;
    if (background) {
      if (runningJobs() >= MAX_RUNNING_JOBS) {
        return errorResult(new Error(`${MAX_RUNNING_JOBS} background jobs are already running. Collect one with get_image_result before starting another.`));
      }
      try {
        await resolveReferenceImages(params.reference_images, await projectDir());
      } catch (err) {
        return errorResult(err);
      }
      const job = startJob(params);
      return {
        content: [
          {
            type: "text",
            text: [
              `Started background job ${job.id}.`,
              "Generation keeps running in the MCP server while you do other work (about 30-90 s per image).",
              `Call get_image_result with job_id "${job.id}" to collect the images. wait_seconds waits up to that long and returns as soon as the job finishes.`,
              "Errors such as an unknown model or a usage limit are reported when you collect the result.",
            ].join("\n"),
          },
        ],
      };
    }
    const progressToken = extra?._meta?.progressToken;
    const onProgress = ({ progress, total, message }) => {
      if (progressToken === undefined) return;
      extra
        .sendNotification({ method: "notifications/progress", params: { progressToken, progress, total, message } })
        .catch(() => {});
    };
    return runGeneration(params, { signal: extra?.signal, onProgress });
  }
);

server.registerTool(
  "get_image_result",
  {
    title: "Get background image result",
    description:
      "Collect the result of a generate_image call started with background: true. When the job is done it returns the same text and images as a normal call (images only the first time; later calls return the text and file paths). While it runs it returns its status. Finished jobs are kept for 1 hour and are lost if the MCP server restarts.",
    inputSchema: {
      job_id: z.string().min(1).describe("The job id returned by generate_image with background: true."),
      wait_seconds: z
        .number()
        .int()
        .min(0)
        .max(600)
        .default(0)
        .describe("Wait up to this many seconds; returns as soon as the job finishes. 0 returns the current status immediately."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ job_id, wait_seconds }, extra) => {
    const job = jobs.get(job_id);
    if (!job) {
      return errorResult(new Error(`Unknown job "${job_id}". Jobs are kept for 1 hour and are lost if the MCP server restarts.`));
    }
    if (job.status === "running" && wait_seconds > 0) await waitFor(job.promise, wait_seconds * 1000, extra?.signal);
    if (job.status !== "running") return collectJob(job);
    const elapsed = Math.round((Date.now() - job.startedAt) / 1000);
    return {
      content: [
        {
          type: "text",
          text: `Job ${job.id} is still running (${elapsed}s so far). Last progress: ${job.progress}. Call get_image_result again later.`,
        },
      ],
    };
  }
);

server.registerTool(
  "codex_status",
  {
    title: "Codex status and usage limits",
    description:
      "Check the Codex CLI setup used for image generation: install location, version, ChatGPT sign-in, remaining 5-hour and weekly usage limits, and the available models with their reasoning efforts.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async () => {
    const lines = [];
    let codexPath;
    try {
      codexPath = findCodex();
    } catch (err) {
      return errorResult(err instanceof CodexNotFoundError ? err : new Error(`${err.message}\n\n${INSTALL_HINT}`));
    }
    let client;
    try {
      client = await getAppServer(CLIENT_INFO);
    } catch (err) {
      return errorResult(new Error(`Codex was found at ${codexPath} but could not be started.\n${err.message}`));
    }
    lines.push(`Codex: ${client.codexPath}${client.version ? ` (version ${client.version})` : ""}`);

    try {
      const res = await client.request("account/read", {}, { timeoutMs: 20_000 });
      const account = res?.account;
      if (!account) {
        lines.push(res?.requiresOpenaiAuth ? "Sign-in: not signed in. Run: codex login" : "Sign-in: no account required by this provider.");
      } else if (account.type === "chatgpt") {
        lines.push(`Sign-in: ChatGPT account${account.planType ? ` (${account.planType} plan)` : ""}`);
      } else {
        lines.push(`Sign-in: ${account.type}`);
      }
    } catch (err) {
      lines.push(`Sign-in: could not be checked (${err.message})`);
    }

    try {
      const snapshots = await client.readRateLimits({ timeoutMs: 20_000 });
      const limitText = formatRateLimits(snapshots);
      lines.push("", "Usage limits:", ...(limitText.length ? limitText.map(l => `- ${l}`) : ["- not reported by Codex"]));
    } catch (err) {
      lines.push("", `Usage limits: could not be read (${err.message})`);
    }

    try {
      const res = await client.request("config/read", {}, { timeoutMs: 20_000 });
      const model = res?.config?.model;
      const effort = res?.config?.model_reasoning_effort;
      if (model || effort) {
        lines.push("", `Codex config default: model ${model ?? "(Codex default)"}${effort ? `, reasoning effort ${effort}` : ""}`);
      }
    } catch {}

    try {
      const models = await client.listModels();
      lines.push("", "Models (reasoning efforts):");
      for (const m of models) {
        const efforts = (m.supportedReasoningEfforts ?? []).map(e => (typeof e === "string" ? e : e?.reasoningEffort)).filter(Boolean);
        lines.push(`- ${m.id}${m.isDefault ? " [catalog default]" : ""}: ${efforts.join(", ") || "n/a"}`);
      }
    } catch (err) {
      lines.push("", `Models: could not be listed (${err.message})`);
    }

    const baseDir = await projectDir();
    const defaults = envDefaults();
    if (defaults.model || defaults.effort) {
      lines.push("", `MCP defaults: model ${defaults.model ?? "(Codex config)"}, reasoning effort ${defaults.effort ?? "(automatic)"} (GPT_IMAGE_MODEL / GPT_IMAGE_EFFORT)`);
    }
    lines.push("", `Default save folder: ${path.join(baseDir, "generated-images")}`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  closeAppServer();
  setTimeout(() => process.exit(code), 2_500).unref();
}

process.on("unhandledRejection", err => log("unhandled rejection:", err?.stack ?? err));
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.stdin.on("end", () => shutdown(0));
process.stdin.on("close", () => shutdown(0));

const transport = new StdioServerTransport();
transport.onclose = () => shutdown(0);
await server.connect(transport);
