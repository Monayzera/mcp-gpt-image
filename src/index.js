#!/usr/bin/env node
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { closeAppServer, getAppServer } from "./app-server.js";
import { formatRateLimits } from "./format.js";
import { generateImages } from "./generate.js";
import { CodexNotFoundError, findCodex, INSTALL_HINT } from "./locate.js";

const pkg = createRequire(import.meta.url)("../package.json");
const CLIENT_INFO = { name: "mcp-gpt-image", title: "MCP GPT Image", version: pkg.version };

const SERVER_INSTRUCTIONS = [
  "Generates and edits images with GPT Image through the local Codex CLI, using the user's ChatGPT login (no API key).",
  "Each image takes roughly 30-90 seconds. Write the complete final prompt yourself: in prompt_mode \"exact\" (default) it reaches the image model unchanged.",
  "Every result includes the saved file path and the remaining 5-hour and weekly usage limits.",
  "Call codex_status to check the setup, the usage limits, and which models and reasoning efforts are available.",
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

server.registerTool(
  "generate_image",
  {
    title: "Generate image (GPT Image via Codex)",
    description: [
      "Generate or edit images with GPT Image through the local Codex CLI and return them inline, saved to disk.",
      "Pass reference_images to edit existing images or to use them as style/subject references.",
      "Takes about 30-90 seconds per image. The result lists each saved file path, the prompt that actually reached GPT Image, and the remaining 5-hour and weekly usage limits.",
    ].join(" "),
    inputSchema: {
      prompt: z
        .string()
        .min(1)
        .describe(
          "The image prompt. In prompt_mode \"exact\" it is sent to GPT Image unchanged, so make it complete: subject, composition, style, lighting, colors, and any text that must appear (in quotes, exact spelling)."
        ),
      count: z.number().int().min(1).max(4).default(1).describe("How many images to generate from the same prompt (1-4). Each one uses your ChatGPT image quota."),
      transparent_background: z.boolean().default(false).describe("Generate a PNG with a transparent background (cutouts, icons, stickers)."),
      reference_images: z
        .array(z.string().min(1))
        .max(16)
        .optional()
        .describe("Local image files (PNG, JPEG, WebP or GIF) to edit or to use as references. Absolute paths, or relative to the project directory."),
      prompt_mode: z
        .enum(["exact", "enhance"])
        .default("exact")
        .describe("\"exact\": the prompt reaches GPT Image verbatim. \"enhance\": the Codex model first rewrites it into a richer prompt (a stronger model and higher reasoning_effort write better prompts)."),
      model: z
        .string()
        .min(1)
        .optional()
        .describe("Codex model that relays the request (and rewrites the prompt in enhance mode). Default: the model in the user's Codex config. Call codex_status for the list."),
      reasoning_effort: z
        .string()
        .min(1)
        .optional()
        .describe("Reasoning effort for the Codex model, e.g. low, medium, high. Default: low in exact mode, the Codex config default in enhance mode. Call codex_status for the values each model supports."),
      output_path: z
        .string()
        .min(1)
        .optional()
        .describe("Where to save. A file path ending in .png, or a directory. Relative paths resolve against the project directory. Default: <project>/generated-images/. Existing files are never overwritten; a numeric suffix is added instead."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async (args, extra) => {
    const progressToken = extra?._meta?.progressToken;
    const onProgress = ({ progress, total, message }) => {
      if (progressToken === undefined) return;
      extra
        .sendNotification({ method: "notifications/progress", params: { progressToken, progress, total, message } })
        .catch(() => {});
    };
    const since = Date.now();
    try {
      const client = await getAppServer(CLIENT_INFO);
      const baseDir = await projectDir();
      const result = await generateImages({ client, params: args, baseDir, signal: extra?.signal, onProgress });

      const header = [
        `Generated ${result.images.length} of ${result.requested} image(s) with GPT Image via Codex`,
        `(model ${result.model ?? "default"}${result.effort ? `, effort ${result.effort}` : ""}, prompt_mode ${result.mode}) in ${Math.round(result.durationMs / 1000)}s.`,
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
      log("generate_image failed:", err?.stack ?? err);
      return errorResult(err);
    }
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
