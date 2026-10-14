import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { makePng } from "./fixtures/images.js";
import { cleanup, fakeEnv, makeCodexWrapper, makeTmp, readLog, waitFor } from "./support.js";

const INDEX = fileURLToPath(new URL("../src/index.js", import.meta.url));

afterEach(cleanup);

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function withServer(scenario, extraEnv, fn) {
  const root = await makeTmp();
  const project = path.join(root, "project");
  await fs.mkdir(project);
  const logFile = path.join(root, "fake.log");
  const wrapper = await makeCodexWrapper(root);
  const env = fakeEnv({ ...process.env, CODEX_PATH: wrapper, CLAUDE_PROJECT_DIR: project }, scenario, { FAKE_LOG: logFile, ...extraEnv });
  const transport = new StdioClientTransport({ command: process.execPath, args: [INDEX], env, stderr: "pipe" });
  const stderr = [];
  transport.stderr?.on("data", chunk => stderr.push(String(chunk)));
  const client = new Client({ name: "e2e-test", version: "0.0.0" });
  let closed = false;
  const stop = async () => {
    if (closed) return;
    closed = true;
    await client.close();
  };
  try {
    await client.connect(transport);
    return await fn({ client, project, logFile, wrapper, root, stop, stderr: () => stderr.join("") });
  } finally {
    await stop();
  }
}

function textOf(result) {
  return result.content.filter(c => c.type === "text").map(c => c.text).join("\n");
}

describe("MCP server over stdio", { skip: process.platform === "win32" }, () => {
  it("lists generate_image and codex_status with their input schemas", async () => {
    await withServer("ok", {}, async ({ client }) => {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map(t => t.name).sort(), ["codex_status", "generate_image"]);
      const generate = tools.find(t => t.name === "generate_image");
      assert.deepEqual(generate.inputSchema.required, ["prompt"]);
      for (const key of ["prompt", "count", "transparent_background", "reference_images", "prompt_mode", "model", "reasoning_effort", "output_path"]) {
        assert.ok(key in generate.inputSchema.properties, key);
      }
      assert.equal(generate.inputSchema.properties.count.maximum, 4);
      assert.equal(generate.annotations.readOnlyHint, false);
      assert.equal(tools.find(t => t.name === "codex_status").annotations.readOnlyHint, true);
    });
  });

  it("codex_status reports path, version, sign-in, limits, config and models", async () => {
    await withServer("ok", {}, async ({ client, project, wrapper }) => {
      const result = await client.callTool({ name: "codex_status", arguments: {} });
      assert.notEqual(result.isError, true);
      const text = textOf(result);
      assert.ok(text.includes(`Codex: ${wrapper} (version 9.9.9)`), text);
      assert.ok(text.includes("Sign-in: ChatGPT account (plus plan)"), text);
      assert.ok(text.includes("Usage limits:"), text);
      assert.match(text, /- 5h: 90% left \(10% used\), resets in/);
      assert.match(text, /- weekly: 95% left \(5% used\), resets in/);
      assert.ok(text.includes("Codex config default: model m-default, reasoning effort high"), text);
      assert.ok(text.includes("- m-default [catalog default]: low, high"), text);
      assert.ok(text.includes(`Default save folder: ${path.join(project, "generated-images")}`), text);
    });
  });

  it("generate_image saves the file, returns it inline and reports limits", async () => {
    await withServer("ok", {}, async ({ client, project }) => {
      const result = await client.callTool({ name: "generate_image", arguments: { prompt: "A red fox" } });
      assert.notEqual(result.isError, true, textOf(result));
      const text = textOf(result);
      assert.match(text, /^Generated 1 image with GPT Image via Codex \(model m-default, effort low, prompt_mode exact\) in \d+s\./);
      const dir = path.join(project, "generated-images");
      const files = await fs.readdir(dir);
      assert.equal(files.length, 1);
      assert.match(files[0], /^\d{4}-\d{2}-\d{2}_\d{6}_a-red-fox\.png$/);
      assert.ok(text.includes(`Image 1: ${path.join(dir, files[0])} (3x2, 1 KB)`), text);
      assert.ok(text.includes("Prompt that reached GPT Image: identical to yours."), text);
      assert.ok(text.includes("Usage limits (ChatGPT plus):"), text);
      assert.match(text, /- 5h: 90% left/);
      const images = result.content.filter(c => c.type === "image");
      assert.equal(images.length, 1);
      assert.equal(images[0].mimeType, "image/png");
      const onDisk = await fs.readFile(path.join(dir, files[0]));
      assert.deepEqual(onDisk, makePng(3, 2));
      assert.equal(images[0].data, onDisk.toString("base64"));
    });
  });

  it("generate_image returns one inline image per generated file for count 2", async () => {
    await withServer("count2", {}, async ({ client, project }) => {
      const result = await client.callTool({ name: "generate_image", arguments: { prompt: "Two foxes", count: 2 } });
      assert.notEqual(result.isError, true, textOf(result));
      assert.equal(result.content.filter(c => c.type === "image").length, 2);
      assert.match(textOf(result), /Generated 2 images with GPT Image/);
      const files = await fs.readdir(path.join(project, "generated-images"));
      assert.equal(files.length, 2);
    });
  });

  it("generate_image shows the altered prompt when Codex changed it", async () => {
    await withServer("altered", {}, async ({ client }) => {
      const result = await client.callTool({ name: "generate_image", arguments: { prompt: "A red fox" } });
      const text = textOf(result);
      assert.ok(text.includes("Prompt that reached GPT Image (differs from yours):\nA red fox -- rewritten"), text);
    });
  });

  it("generate_image lists images that were not generated", async () => {
    await withServer("partial", {}, async ({ client }) => {
      const result = await client.callTool({ name: "generate_image", arguments: { prompt: "Two foxes", count: 2 } });
      assert.notEqual(result.isError, true, textOf(result));
      const text = textOf(result);
      assert.match(text, /Generated 1 of 2 requested images/);
      assert.match(text, /Not generated:\n- Image generation usage limit reached \(images\)\./);
    });
  });

  it("generate_image returns an error result when Codex produces no image", async () => {
    await withServer("noimage", {}, async ({ client }) => {
      const result = await client.callTool({ name: "generate_image", arguments: { prompt: "A red fox" } });
      assert.equal(result.isError, true);
      assert.match(textOf(result), /without generating/);
      assert.match(textOf(result), /policy refusal/);
    });
  });

  it("generate_image rejects arguments that violate the schema", async () => {
    await withServer("ok", {}, async ({ client }) => {
      for (const args of [{ prompt: "" }, { prompt: "x", count: 9 }, {}]) {
        let outcome;
        try {
          outcome = await client.callTool({ name: "generate_image", arguments: args });
        } catch (err) {
          outcome = { isError: true, content: [{ type: "text", text: err.message }] };
        }
        assert.equal(outcome.isError, true, JSON.stringify(args));
      }
    });
  });

  it("returns install guidance when CODEX_PATH points to nothing", async () => {
    await withServer("ok", { CODEX_PATH: path.join(path.sep, "no", "such", "codex") }, async ({ client }) => {
      const status = await client.callTool({ name: "codex_status", arguments: {} });
      assert.equal(status.isError, true);
      assert.match(textOf(status), /npm install -g @openai\/codex/);
      const generate = await client.callTool({ name: "generate_image", arguments: { prompt: "x" } });
      assert.equal(generate.isError, true);
      assert.match(textOf(generate), /npm install -g @openai\/codex/);
    });
  });

  it("reports that codex could not be started when the app-server dies at startup", async () => {
    await withServer("crash_init", {}, async ({ client }) => {
      const status = await client.callTool({ name: "codex_status", arguments: {} });
      assert.equal(status.isError, true);
      assert.match(textOf(status), /could not be started/);
      assert.match(textOf(status), /exit code 3/);
    });
  });

  it("stops the codex child process when the client disconnects", async () => {
    await withServer("ok", {}, async ({ client, logFile, stop }) => {
      await client.callTool({ name: "codex_status", arguments: {} });
      const started = await waitFor(async () => (await readLog(logFile)).find(m => m.event === "started"), { label: "fake codex start" });
      assert.ok(alive(started.pid));
      await stop();
      await waitFor(() => !alive(started.pid), { timeoutMs: 6000, label: "fake codex exit" });
    });
  });
});
