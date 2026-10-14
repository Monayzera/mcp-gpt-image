import fs from "node:fs/promises";
import os from "node:os";
import { detectFormat, imageSize, planTargets, resolveReferenceImages, writeUnique } from "./files.js";
import { localDateTime } from "./format.js";

export const TURN_TIMEOUT_MS = 15 * 60_000;
const EXACT_DEFAULT_EFFORT = "low";

const RULES = [
  "Rules:",
  "- Do not load or follow any skill, including the imagegen skill.",
  "- Do not run shell commands, read or write files, browse the web, or call any tool other than the image generation tool.",
  "- Do not ask questions. Nobody will answer them.",
  "- When every call has finished, reply with the single word DONE. If the tool is unavailable or refuses, reply with one short sentence explaining why.",
];

export function buildInstructions({ mode, count, transparent, hasReferences }) {
  const calls =
    count > 1
      ? `exactly ${count} times, one separate call per image (never one call asking for several images)`
      : "exactly once";
  const lines = [
    "You are a non-interactive relay between a program and your built-in image generation tool. Your text replies are not shown to anyone.",
    "",
  ];
  if (mode === "enhance") {
    lines.push(
      "Step 1: rewrite the user's message into the strongest possible prompt for the image generation tool.",
      "Keep every subject, requirement, constraint, and any text that must appear in the image (quoted, exact spelling).",
      "Add concrete detail about composition, framing, style, lighting, materials, and color only where the message leaves it open. Do not change the intent.",
      `Step 2: call the image generation tool ${calls}, using that rewritten prompt in every call.`
    );
  } else {
    lines.push(
      `Call the image generation tool ${calls}.`,
      "In every call, the prompt argument must be the user's message copied verbatim, character for character: same language, wording, punctuation, and line breaks.",
      "Do not translate, summarize, expand, rephrase, correct, or add anything to it."
    );
  }
  lines.push(`In every call, set transparent_background to ${transparent ? "true" : "false"}.`);
  if (hasReferences) {
    lines.push(
      "The user's message has attached images. They are the input images for the generation (images to edit, or references for style, subject, or composition). Use them as the tool's input images. Do not describe them."
    );
  }
  lines.push("", ...RULES);
  return lines.join("\n");
}

function normalizePrompt(text) {
  return String(text ?? "").replace(/\r\n?/g, "\n").trim();
}

function modelEfforts(model) {
  return (model?.supportedReasoningEfforts ?? [])
    .map(e => (typeof e === "string" ? e : e?.reasoningEffort))
    .filter(Boolean);
}

function findModel(models, id) {
  return models.find(m => m.id === id || m.model === id) ?? null;
}

function describeModels(models) {
  return models.map(m => `${m.id}${m.isDefault ? " (default)" : ""}: ${modelEfforts(m).join(", ")}`).join("\n");
}

async function safeListModels(client) {
  try {
    return await client.listModels();
  } catch {
    return null;
  }
}

export async function validateModel(client, model) {
  if (!model) return;
  const models = await client.listModels();
  if (!findModel(models, model)) {
    throw new Error(`Unknown Codex model "${model}". Available models and reasoning efforts:\n${describeModels(models)}`);
  }
}

export async function chooseEffort(client, modelId, requested, mode) {
  const models = await safeListModels(client);
  const info = models ? findModel(models, modelId) : null;
  const supported = modelEfforts(info);
  if (requested) {
    if (supported.length && !supported.includes(requested)) {
      throw new Error(`Model "${modelId}" does not support reasoning_effort "${requested}". Supported: ${supported.join(", ")}`);
    }
    return requested;
  }
  if (mode === "exact" && supported.includes(EXACT_DEFAULT_EFFORT)) return EXACT_DEFAULT_EFFORT;
  return null;
}

function describeTurnError(error) {
  if (!error) return null;
  const info = error.codexErrorInfo;
  const kind = typeof info === "string" ? info : info && typeof info === "object" ? Object.keys(info)[0] : null;
  const hints = {
    unauthorized: "Codex is not signed in. Run: codex login",
    usageLimitExceeded: "Your ChatGPT/Codex usage limit was reached. Call codex_status to see when it resets.",
    rateLimitExceeded: "Codex is rate limited right now. Wait a moment and try again.",
    serverOverloaded: "OpenAI servers are overloaded. Try again in a few minutes.",
  };
  const parts = [error.message, error.additionalDetails, hints[kind]].filter(Boolean);
  return parts.join("\n");
}

function describeFailure(item) {
  const failure = item?.failure;
  if (failure?.type === "usageLimitExceeded") {
    const reset = failure.resetsAt ? ` It resets at ${localDateTime(failure.resetsAt)}.` : "";
    return `Image generation usage limit reached (${failure.limitId}).${reset}`;
  }
  return `Image generation ended with status "${item?.status ?? "unknown"}".`;
}

export async function generateImages({ client, params, baseDir, signal, onProgress = () => {}, timeoutMs = TURN_TIMEOUT_MS }) {
  const prompt = params.prompt;
  const count = params.count ?? 1;
  const mode = params.prompt_mode ?? "exact";
  const transparent = params.transparent_background ?? false;
  const startedAt = new Date();

  if (signal?.aborted) throw new Error("Cancelled.");
  const references = await resolveReferenceImages(params.reference_images, baseDir);
  await validateModel(client, params.model);

  let progressValue = 0;
  const progress = (value, message) => {
    progressValue = Math.max(progressValue + 0.001, value);
    try {
      onProgress({ progress: progressValue, total: count, message });
    } catch {}
  };

  const threadParams = {
    ephemeral: true,
    sandbox: "read-only",
    approvalPolicy: "never",
    cwd: os.tmpdir(),
    developerInstructions: buildInstructions({ mode, count, transparent, hasReferences: references.length > 0 }),
  };
  if (params.model) threadParams.model = params.model;

  const thread = await client.request("thread/start", threadParams, { timeoutMs: 60_000 });
  const threadId = thread?.thread?.id;
  if (!threadId) throw new Error("Codex did not return a thread id.");
  const threadModel = thread?.model ?? params.model ?? null;

  const images = [];
  const failures = [];
  let agentText = "";
  let lastError = null;
  let startedCount = 0;
  let turnId = null;
  let cleanup = () => {};

  try {
    const effort = await chooseEffort(client, threadModel, params.reasoning_effort, mode);
    progress(0.05, `Codex ready (${threadModel ?? "default model"}${effort ? `, effort ${effort}` : ""})`);

    const finished = new Promise((resolve, reject) => {
      const onNotification = msg => {
        const p = msg?.params;
        if (!p || p.threadId !== threadId) return;
        if (msg.method === "item/started" && p.item?.type === "imageGeneration") {
          startedCount += 1;
          progress(images.length + 0.1, `Generating image ${startedCount} of ${count}`);
        } else if (msg.method === "item/completed" && p.item?.type === "imageGeneration") {
          if (p.item.status === "completed" && (p.item.result || p.item.savedPath)) {
            images.push(p.item);
            progress(images.length, `Image ${images.length} of ${count} ready`);
          } else {
            failures.push(p.item);
          }
        } else if (msg.method === "item/completed" && p.item?.type === "agentMessage" && p.item.text) {
          agentText = p.item.text;
        } else if (msg.method === "error" && !p.willRetry) {
          lastError = p.error;
        } else if (msg.method === "turn/completed") {
          resolve(p.turn);
        }
      };
      const onClose = err => reject(err ?? new Error("Codex app-server stopped."));
      const interrupt = () => {
        if (turnId) client.request("turn/interrupt", { threadId, turnId }, { timeoutMs: 10_000 }).catch(() => {});
      };
      const onAbort = () => {
        interrupt();
        reject(new Error("Cancelled. The Codex turn was interrupted."));
      };
      const timer = setTimeout(() => {
        interrupt();
        reject(new Error(`Timed out after ${Math.round(timeoutMs / 60_000)} minutes waiting for Codex.`));
      }, timeoutMs);
      timer.unref?.();
      client.on("notification", onNotification);
      client.once("close", onClose);
      signal?.addEventListener("abort", onAbort, { once: true });
      cleanup = () => {
        clearTimeout(timer);
        client.off("notification", onNotification);
        client.off("close", onClose);
        signal?.removeEventListener("abort", onAbort);
      };
    });
    finished.catch(() => {});

    const input = [{ type: "text", text: prompt, text_elements: [] }, ...references.map(p => ({ type: "localImage", path: p }))];
    const turnParams = { threadId, input };
    if (effort) turnParams.effort = effort;
    const started = await client.request("turn/start", turnParams, { timeoutMs: 60_000 });
    turnId = started?.turn?.id ?? null;
    if (signal?.aborted) {
      client.request("turn/interrupt", { threadId, turnId }, { timeoutMs: 10_000 }).catch(() => {});
      throw new Error("Cancelled. The Codex turn was interrupted.");
    }

    const turn = await finished;

    if (!images.length) {
      const reasons = [
        describeTurnError(turn?.error) ?? describeTurnError(lastError),
        ...failures.map(describeFailure),
        agentText && agentText.trim() !== "DONE" ? `Codex said: ${agentText.trim()}` : null,
      ].filter(Boolean);
      throw new Error(`Codex finished without generating an image.${reasons.length ? `\n${reasons.join("\n")}` : ""}`);
    }

    const targets = planTargets({ outputPath: params.output_path, baseDir, prompt, count: images.length, date: startedAt });
    const saved = [];
    for (const [i, item] of images.entries()) {
      let buffer = item.result ? Buffer.from(item.result, "base64") : null;
      if ((!buffer || !detectFormat(buffer)) && item.savedPath) {
        buffer = await fs.readFile(item.savedPath);
      }
      const format = buffer ? detectFormat(buffer) : null;
      if (!format) {
        failures.push({ status: "unreadable image data" });
        continue;
      }
      const file = await writeUnique(targets[i].dir, targets[i].stem, format.ext, buffer);
      const revisedPrompt = item.revisedPrompt ?? null;
      saved.push({
        path: file,
        mimeType: format.mime,
        data: buffer.toString("base64"),
        bytes: buffer.length,
        size: imageSize(buffer),
        revisedPrompt,
        verbatim: revisedPrompt === null ? null : normalizePrompt(revisedPrompt) === normalizePrompt(prompt),
        codexPath: item.savedPath ?? null,
      });
    }
    if (!saved.length) throw new Error("Codex returned image data that could not be decoded.");

    return {
      images: saved,
      requested: count,
      failures: failures.map(describeFailure),
      model: threadModel,
      effort,
      mode,
      turnStatus: turn?.status ?? null,
      durationMs: Date.now() - startedAt.getTime(),
    };
  } finally {
    cleanup();
    client.request("thread/unsubscribe", { threadId }, { timeoutMs: 10_000 }).catch(() => {});
  }
}
