import assert from "node:assert/strict";
import { spawn as spawnProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { makePng } from "./fixtures/images.js";
import { cleanup, fakeEnv, makeCodexWrapper, makeTmp, readLog, waitFor } from "./support.js";

const INDEX = fileURLToPath(new URL("../src/index.js", import.meta.url));
const SKILL_SOURCE = fileURLToPath(new URL("../skill/SKILL.md", import.meta.url));

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
      for (const args of [{ prompt: "" }, { prompt: "   " }, { prompt: "\n\t \r\n" }, { prompt: "x", count: 9 }, {}]) {
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

  it("generate_image does not reach Codex for a whitespace-only prompt", async () => {
    await withServer("ok", {}, async ({ client, logFile }) => {
      let outcome;
      try {
        outcome = await client.callTool({ name: "generate_image", arguments: { prompt: "   " } });
      } catch (err) {
        outcome = { isError: true, content: [{ type: "text", text: err.message }] };
      }
      assert.equal(outcome.isError, true);
      assert.match(textOf(outcome), /prompt must not be empty/);
      const sent = (await readLog(logFile)).filter(m => m.method === "turn/start");
      assert.equal(sent.length, 0);
    });
  });

  it("generate_image sends the prompt to Codex without trimming it", async () => {
    await withServer("ok", {}, async ({ client, logFile }) => {
      const prompt = "  A red fox \n";
      const result = await client.callTool({ name: "generate_image", arguments: { prompt } });
      assert.notEqual(result.isError, true, textOf(result));
      const [turn] = (await readLog(logFile)).filter(m => m.method === "turn/start");
      assert.equal(turn.params.input[0].text, prompt);
      assert.ok(textOf(result).includes("Prompt that reached GPT Image: identical to yours."), textOf(result));
    });
  });

  it("generate_image reports a trailing space added by Codex as a difference", async () => {
    await withServer("ok", { FAKE_REVISED: "A red fox " }, async ({ client }) => {
      const result = await client.callTool({ name: "generate_image", arguments: { prompt: "A red fox" } });
      assert.ok(textOf(result).includes("Prompt that reached GPT Image (differs from yours):\nA red fox "), textOf(result));
    });
  });

  it("generate_image says the model comes from the Codex config when Codex reports none", async () => {
    await withServer("ok", { FAKE_THREAD_MODEL: "none" }, async ({ client }) => {
      const result = await client.callTool({ name: "generate_image", arguments: { prompt: "A red fox" } });
      assert.notEqual(result.isError, true, textOf(result));
      assert.match(textOf(result), /^Generated 1 image with GPT Image via Codex \(model from Codex config, prompt_mode exact\) in \d+s\./);
    });
  });

  it("generate_image says the prompt was not reported when Codex returns no revised prompt", async () => {
    await withServer("norevised", {}, async ({ client }) => {
      const result = await client.callTool({ name: "generate_image", arguments: { prompt: "A red fox" } });
      assert.notEqual(result.isError, true, textOf(result));
      assert.ok(textOf(result).includes("Prompt that reached GPT Image: not reported by Codex."), textOf(result));
    });
  });

  it("generate_image confirms the alpha channel when a transparent background was requested", async () => {
    await withServer("ok", { FAKE_PNG_COLOR_TYPE: "6" }, async ({ client }) => {
      const result = await client.callTool({ name: "generate_image", arguments: { prompt: "A red fox", transparent_background: true } });
      assert.notEqual(result.isError, true, textOf(result));
      assert.ok(textOf(result).includes("Transparent background: alpha channel present."), textOf(result));
      assert.ok(!textOf(result).includes("NO alpha channel"));
    });
  });

  it("generate_image warns when the transparent image has no alpha channel", async () => {
    await withServer("ok", {}, async ({ client }) => {
      const result = await client.callTool({ name: "generate_image", arguments: { prompt: "A red fox", transparent_background: true } });
      assert.ok(textOf(result).includes("Transparent background requested, but this image has NO alpha channel."), textOf(result));
    });
  });

  it("generate_image says the alpha channel could not be checked for a jpeg", async () => {
    await withServer("ok", { FAKE_IMAGE_FORMAT: "jpeg" }, async ({ client, project }) => {
      const result = await client.callTool({ name: "generate_image", arguments: { prompt: "A red fox", transparent_background: true } });
      assert.notEqual(result.isError, true, textOf(result));
      assert.ok(textOf(result).includes("Transparent background requested; alpha channel could not be checked for this format."), textOf(result));
      const files = await fs.readdir(path.join(project, "generated-images"));
      assert.match(files[0], /\.jpg$/);
      assert.equal(result.content.find(c => c.type === "image").mimeType, "image/jpeg");
    });
  });

  it("generate_image prints no transparency line when it was not requested", async () => {
    await withServer("ok", { FAKE_PNG_COLOR_TYPE: "6" }, async ({ client }) => {
      const result = await client.callTool({ name: "generate_image", arguments: { prompt: "A red fox" } });
      assert.ok(!textOf(result).includes("Transparent background"), textOf(result));
    });
  });

  it("generate_image reports a transparency line per image for count 2", async () => {
    await withServer("count2", { FAKE_PNG_COLOR_TYPE: "6" }, async ({ client }) => {
      const result = await client.callTool({ name: "generate_image", arguments: { prompt: "Two foxes", count: 2, transparent_background: true } });
      assert.equal(textOf(result).match(/Transparent background: alpha channel present\./g).length, 2);
    });
  });

  it("generate_image returns the saved image and lists the one that could not be saved", async () => {
    const dir = await makeTmp();
    const missing = path.join(dir, "gone.png");
    await withServer("savedpath", { FAKE_COUNT: "2", FAKE_BAD_ONLY_FIRST: "1", FAKE_SAVED_PATH: missing }, async ({ client, project }) => {
      const result = await client.callTool({ name: "generate_image", arguments: { prompt: "Two foxes", count: 2 } });
      assert.notEqual(result.isError, true, textOf(result));
      const text = textOf(result);
      assert.match(text, /Generated 1 of 2 requested images/);
      assert.match(text, /Not generated:\n- Image 1 could not be saved: .*ENOENT/);
      assert.equal(result.content.filter(c => c.type === "image").length, 1);
      assert.equal((await fs.readdir(path.join(project, "generated-images"))).length, 1);
    });
  });

  it("generate_image appends the usage limits to an error result while Codex is alive", async () => {
    await withServer("noimage", {}, async ({ client }) => {
      const result = await client.callTool({ name: "generate_image", arguments: { prompt: "A red fox" } });
      assert.equal(result.isError, true);
      const text = textOf(result);
      assert.match(text, /without generating/);
      assert.ok(text.includes("\n\nUsage limits (ChatGPT plus):\n"), text);
      assert.match(text, /- 5h: 90% left/);
      assert.ok(text.indexOf("without generating") < text.indexOf("Usage limits"));
    });
  });

  it("generate_image appends the usage limits when the image quota is exhausted", async () => {
    await withServer("fail_limit", {}, async ({ client }) => {
      const result = await client.callTool({ name: "generate_image", arguments: { prompt: "A red fox" } });
      assert.equal(result.isError, true);
      assert.match(textOf(result), /Image generation usage limit reached \(images\)\./);
      assert.match(textOf(result), /Usage limits \(ChatGPT plus\):/);
    });
  });

  it("generate_image adds no usage limit lines to an error when Codex died", async () => {
    await withServer("crash_midturn", {}, async ({ client }) => {
      const result = await client.callTool({ name: "generate_image", arguments: { prompt: "A red fox" } });
      assert.equal(result.isError, true);
      assert.match(textOf(result), /Codex app-server stopped \(exit code 3/);
      assert.doesNotMatch(textOf(result), /Usage limits/);
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

const USER_SCOPE = "User config (available in all your projects)";
const LOCAL_SCOPE = "Local config (private to you in this project)";
const PROJECT_SCOPE = "Project config (shared via .mcp.json)";

const FAKE_CLAUDE_SCRIPT = [
  "#!/bin/sh",
  'echo "$*" >> "$FAKE_CLAUDE_LOG"',
  'if [ "$1" = "mcp" ] && [ "$2" = "get" ]; then',
  '  if [ "${FAKE_CLAUDE_GET:-1}" = "0" ]; then',
  '    echo "gpt-image:"',
  '    if [ -n "$FAKE_CLAUDE_SCOPE" ]; then echo "  Scope: $FAKE_CLAUDE_SCOPE"; fi',
  '    if [ -n "$FAKE_CLAUDE_STATUS" ]; then echo "  Status: $FAKE_CLAUDE_STATUS"; fi',
  '    echo "  Type: stdio"',
  "    exit 0",
  "  fi",
  '  echo "No MCP server found with name: gpt-image" >&2',
  "  exit 1",
  "fi",
  'exit "${FAKE_CLAUDE_ACTION:-0}"',
  "",
].join("\n");

const REGISTERED = { FAKE_CLAUDE_GET: "0", FAKE_CLAUDE_SCOPE: USER_SCOPE, FAKE_CLAUDE_STATUS: "✔ Connected" };

async function cliSandbox({ claude = false, codex = false, extraEnv = {} } = {}) {
  const root = await makeTmp("mcp-gpt-image-cli-");
  const config = path.join(root, "claude-config");
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  const claudeLog = path.join(root, "claude.log");
  await fs.mkdir(bin);
  await fs.mkdir(home);
  if (claude) await fs.writeFile(path.join(bin, "claude"), FAKE_CLAUDE_SCRIPT, { mode: 0o755 });
  let codexPath = path.join(root, "missing-codex");
  if (codex) {
    const codexDir = path.join(root, "codex-bin");
    await fs.mkdir(codexDir);
    codexPath = await makeCodexWrapper(codexDir);
  }
  const env = fakeEnv(
    { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: config, PATH: bin, CODEX_PATH: codexPath, FAKE_CLAUDE_LOG: claudeLog, ...extraEnv },
    "ok"
  );
  const skillFile = path.join(config, "skills", "gpt-image", "SKILL.md");
  const claudeCalls = async () => {
    try {
      return (await fs.readFile(claudeLog, "utf8")).split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  return { root, config, bin, home, env, skillFile, codexPath, claudeCalls };
}

function runCli(args, env, { timeoutMs = 30_000, holdStdin = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(process.execPath, [INDEX, ...args], { env, stdio: [holdStdin ? "pipe" : "ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI ${args.join(" ")} timed out\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, timeoutMs);
    child.stdout.on("data", chunk => (stdout += chunk));
    child.stderr.on("data", chunk => (stderr += chunk));
    child.stdin?.on("error", () => {});
    child.on("error", err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

describe("index.js command dispatch", { skip: process.platform === "win32" }, () => {
  for (const flag of ["help", "--help", "-h"]) {
    it(`${flag} prints the usage to stdout and exits 0 without starting the server`, async () => {
      const box = await cliSandbox();
      const { code, stdout, stderr } = await runCli([flag], box.env, { timeoutMs: 10_000, holdStdin: true });
      assert.equal(code, 0, `${stdout}\n${stderr}`);
      assert.equal(stderr, "");
      assert.ok(stdout.startsWith("Usage:\n"), stdout);
      assert.match(stdout, /github:Monayzera\/mcp-gpt-image setup\s+install the skill and register the MCP server in Claude Code/);
      assert.match(stdout, /github:Monayzera\/mcp-gpt-image uninstall\s+remove both/);
      assert.match(stdout, /github:Monayzera\/mcp-gpt-image\s+run the MCP server \(stdio\)/);
      await assert.rejects(fs.stat(box.config), { code: "ENOENT" });
    });
  }

  for (const arg of ["bogus", "--stdio", "Setup", "SETUP", "start", "--version", "-v", "help me"]) {
    it(`unknown argument "${arg}" prints Unknown command and the usage to stderr and exits 1 without starting the server`, async () => {
      const box = await cliSandbox();
      const { code, stdout, stderr } = await runCli([arg], box.env, { timeoutMs: 10_000, holdStdin: true });
      assert.equal(code, 1, `${stdout}\n${stderr}`);
      assert.equal(stdout, "");
      assert.ok(stderr.startsWith(`Unknown command: ${arg}\n\nUsage:\n`), stderr);
      assert.match(stderr, /setup\s+install the skill/);
      assert.match(stderr, /uninstall\s+remove both/);
      await assert.rejects(fs.stat(box.config), { code: "ENOENT" });
    });
  }

  it("an empty string argument is an unknown command", async () => {
    const box = await cliSandbox();
    const { code, stdout, stderr } = await runCli([""], box.env, { timeoutMs: 10_000, holdStdin: true });
    assert.equal(code, 1);
    assert.equal(stdout, "");
    assert.ok(stderr.startsWith("Unknown command: \n\nUsage:"), stderr);
  });

  it("only the first argument decides the command", async () => {
    const box = await cliSandbox();
    const help = await runCli(["help", "setup"], box.env, { timeoutMs: 10_000, holdStdin: true });
    assert.equal(help.code, 0);
    await assert.rejects(fs.stat(box.config), { code: "ENOENT" });
    const unknown = await runCli(["bogus", "help"], box.env, { timeoutMs: 10_000, holdStdin: true });
    assert.equal(unknown.code, 1);
    assert.ok(unknown.stderr.startsWith("Unknown command: bogus\n"), unknown.stderr);
  });

  it("no argument starts the MCP server and keeps it running while stdin is open", async () => {
    const box = await cliSandbox();
    const child = spawnProcess(process.execPath, [INDEX], { env: box.env, stdio: ["pipe", "pipe", "pipe"] });
    const exited = new Promise(resolve => child.once("close", code => resolve(code)));
    try {
      await new Promise(resolve => setTimeout(resolve, 600));
      assert.equal(child.exitCode, null);
      assert.equal(child.signalCode, null);
    } finally {
      child.stdin.end();
    }
    assert.equal(await exited, 0);
  });
});

describe("setup and uninstall commands", { skip: process.platform === "win32" }, () => {
  const manualAdd = codexPath =>
    `claude mcp add --scope user gpt-image -e CODEX_PATH=${path.resolve(codexPath)} -- npx -y github:Monayzera/mcp-gpt-image`;

  it("setup writes the skill and exits 1 with guidance when claude and codex are not found", async () => {
    const box = await cliSandbox();
    assert.deepEqual(await fs.readdir(box.bin), []);
    const { code, stdout, stderr } = await runCli(["setup"], box.env);
    assert.equal(code, 1, `${stdout}\n${stderr}`);
    assert.deepEqual(await fs.readFile(box.skillFile), await fs.readFile(SKILL_SOURCE));
    assert.ok(stdout.includes(`Skill:  ${box.skillFile} (installed)`), stdout);
    assert.ok(stdout.includes("Claude Code CLI not found"), stdout);
    assert.ok(stdout.includes(manualAdd(box.codexPath)), stdout);
    assert.ok(stdout.includes("Codex:  not found"), stdout);
    assert.ok(stdout.includes("npm install -g @openai/codex"), stdout);
    assert.ok(stdout.includes("Finish the steps above, then restart Claude Code."), stdout);
    assert.deepEqual(await box.claudeCalls(), []);
    await assert.rejects(fs.stat(path.join(box.home, ".claude")), { code: "ENOENT" });
  });

  it("setup says already up to date on the second run and replaced when the copy differs", async () => {
    const box = await cliSandbox();
    const first = await runCli(["setup"], box.env);
    assert.ok(first.stdout.includes(`Skill:  ${box.skillFile} (installed)`), first.stdout);
    const second = await runCli(["setup"], box.env);
    assert.ok(second.stdout.includes(`Skill:  ${box.skillFile} (already up to date)`), second.stdout);
    await fs.writeFile(box.skillFile, "edited by the user");
    const third = await runCli(["setup"], box.env);
    assert.ok(third.stdout.includes(`Skill:  ${box.skillFile} (replaced the existing copy)`), third.stdout);
    assert.deepEqual(await fs.readFile(box.skillFile), await fs.readFile(SKILL_SOURCE));
    assert.deepEqual(await fs.readdir(path.dirname(box.skillFile)), ["SKILL.md"]);
  });

  it("setup registers the server through claude with CODEX_PATH and exits 0 when codex is signed in", async () => {
    const box = await cliSandbox({ claude: true, codex: true });
    const { code, stdout, stderr } = await runCli(["setup"], box.env);
    assert.equal(code, 0, `${stdout}\n${stderr}`);
    assert.ok(stdout.includes(`Skill:  ${box.skillFile} (installed)`), stdout);
    assert.ok(stdout.includes('MCP:    "gpt-image" added to Claude Code (user scope)'), stdout);
    assert.ok(stdout.includes(`Codex:  ${box.codexPath} (9.9.9, ChatGPT plus)`), stdout);
    assert.ok(stdout.includes("Done. Restart Claude Code to load the skill and the MCP server."), stdout);
    assert.deepEqual(await box.claudeCalls(), [
      "mcp get gpt-image",
      `mcp add --scope user gpt-image -e CODEX_PATH=${path.resolve(box.codexPath)} -- npx -y github:Monayzera/mcp-gpt-image`,
    ]);
    assert.deepEqual(await fs.readFile(box.skillFile), await fs.readFile(SKILL_SOURCE));
  });

  it("setup leaves an existing user scope registration unchanged and shows its status", async () => {
    const box = await cliSandbox({ claude: true, codex: true, extraEnv: REGISTERED });
    const { code, stdout, stderr } = await runCli(["setup"], box.env);
    assert.equal(code, 0, `${stdout}\n${stderr}`);
    assert.ok(stdout.includes('MCP:    "gpt-image" already registered at user scope, left unchanged (status: ✔ Connected)'), stdout);
    assert.ok(stdout.includes("Done. Restart Claude Code"), stdout);
    assert.deepEqual(await box.claudeCalls(), ["mcp get gpt-image"]);
  });

  it("setup omits the status suffix when claude prints no Status line", async () => {
    const box = await cliSandbox({ claude: true, codex: true, extraEnv: { FAKE_CLAUDE_GET: "0", FAKE_CLAUDE_SCOPE: USER_SCOPE } });
    const { code, stdout } = await runCli(["setup"], box.env);
    assert.equal(code, 0);
    assert.ok(stdout.includes('MCP:    "gpt-image" already registered at user scope, left unchanged\n'), stdout);
    assert.ok(!stdout.includes("(status:"), stdout);
  });

  it("setup treats an existing registration without a Scope line as user scope", async () => {
    const box = await cliSandbox({ claude: true, codex: true, extraEnv: { FAKE_CLAUDE_GET: "0", FAKE_CLAUDE_STATUS: "✗ Failed to connect" } });
    const { code, stdout } = await runCli(["setup"], box.env);
    assert.equal(code, 0);
    assert.ok(stdout.includes('already registered at user scope, left unchanged (status: ✗ Failed to connect)'), stdout);
    assert.deepEqual(await box.claudeCalls(), ["mcp get gpt-image"]);
  });

  for (const [label, scope] of [
    ["local", LOCAL_SCOPE],
    ["project", PROJECT_SCOPE],
  ]) {
    it(`setup exits 1 and explains the ${label} scope registration without touching it`, async () => {
      const box = await cliSandbox({ claude: true, codex: true, extraEnv: { FAKE_CLAUDE_GET: "0", FAKE_CLAUDE_SCOPE: scope, FAKE_CLAUDE_STATUS: "✔ Connected" } });
      const { code, stdout, stderr } = await runCli(["setup"], box.env);
      assert.equal(code, 1, `${stdout}\n${stderr}`);
      assert.ok(stdout.includes(`MCP:    "gpt-image" is registered in another scope (${scope}). It only works there.`), stdout);
      assert.ok(stdout.includes("To make it available everywhere, remove that entry and run setup again."), stdout);
      assert.ok(!stdout.includes("already registered at user scope"), stdout);
      assert.ok(stdout.includes("Finish the steps above, then restart Claude Code."), stdout);
      assert.ok(!stdout.includes("Done. Restart Claude Code"), stdout);
      assert.ok(stdout.includes(`Codex:  ${box.codexPath} (9.9.9, ChatGPT plus)`), stdout);
      assert.deepEqual(await box.claudeCalls(), ["mcp get gpt-image"]);
      assert.deepEqual(await fs.readFile(box.skillFile), await fs.readFile(SKILL_SOURCE));
    });
  }

  it("setup exits 1 and prints the manual command with CODEX_PATH when claude refuses to add the server", async () => {
    const box = await cliSandbox({ claude: true, codex: true, extraEnv: { FAKE_CLAUDE_ACTION: "1" } });
    const { code, stdout } = await runCli(["setup"], box.env);
    assert.equal(code, 1);
    assert.ok(stdout.includes("MCP:    registration failed:"), stdout);
    assert.ok(stdout.includes(manualAdd(box.codexPath)), stdout);
    assert.ok(stdout.includes("Finish the steps above, then restart Claude Code."), stdout);
  });

  it("setup exits 1 when codex is missing even though the server was registered", async () => {
    const box = await cliSandbox({ claude: true });
    const { code, stdout } = await runCli(["setup"], box.env);
    assert.equal(code, 1);
    assert.ok(stdout.includes('"gpt-image" added to Claude Code'), stdout);
    assert.ok(stdout.includes("Codex:  not found"), stdout);
  });

  it("setup reports a failure and exits 1 when the config folder cannot be written", async () => {
    const box = await cliSandbox();
    await fs.writeFile(box.config, "a file where the config folder should be");
    const { code, stderr } = await runCli(["setup"], box.env);
    assert.equal(code, 1);
    assert.match(stderr, /^mcp-gpt-image setup failed: /);
  });

  it("uninstall removes the skill and the user scope registration and exits 0", async () => {
    const box = await cliSandbox({ claude: true, extraEnv: REGISTERED });
    await fs.mkdir(path.dirname(box.skillFile), { recursive: true });
    await fs.copyFile(SKILL_SOURCE, box.skillFile);
    const { code, stdout, stderr } = await runCli(["uninstall"], box.env);
    assert.equal(code, 0, `${stdout}\n${stderr}`);
    assert.ok(stdout.includes(`Skill:  removed from ${path.dirname(box.skillFile)}`), stdout);
    assert.ok(stdout.includes('MCP:    "gpt-image" removed from Claude Code'), stdout);
    assert.deepEqual(await box.claudeCalls(), ["mcp get gpt-image", "mcp remove gpt-image --scope user"]);
    await assert.rejects(fs.stat(path.dirname(box.skillFile)), { code: "ENOENT" });
  });

  it("uninstall removes a registration whose output has no Scope line", async () => {
    const box = await cliSandbox({ claude: true, extraEnv: { FAKE_CLAUDE_GET: "0" } });
    const { code, stdout } = await runCli(["uninstall"], box.env);
    assert.equal(code, 0);
    assert.ok(stdout.includes('MCP:    "gpt-image" removed from Claude Code'), stdout);
    assert.deepEqual(await box.claudeCalls(), ["mcp get gpt-image", "mcp remove gpt-image --scope user"]);
  });

  for (const [label, scope] of [
    ["local", LOCAL_SCOPE],
    ["project", PROJECT_SCOPE],
  ]) {
    it(`uninstall exits 1 without calling remove for a ${label} scope registration`, async () => {
      const box = await cliSandbox({ claude: true, extraEnv: { FAKE_CLAUDE_GET: "0", FAKE_CLAUDE_SCOPE: scope, FAKE_CLAUDE_STATUS: "✔ Connected" } });
      await fs.mkdir(path.dirname(box.skillFile), { recursive: true });
      await fs.copyFile(SKILL_SOURCE, box.skillFile);
      const { code, stdout, stderr } = await runCli(["uninstall"], box.env);
      assert.equal(code, 1, `${stdout}\n${stderr}`);
      assert.ok(stdout.includes(`MCP:    "gpt-image" is registered in another scope (${scope}), not removed. Remove it with: claude mcp remove gpt-image`), stdout);
      assert.ok(stdout.includes(`Skill:  removed from ${path.dirname(box.skillFile)}`), stdout);
      assert.deepEqual(await box.claudeCalls(), ["mcp get gpt-image"]);
      await assert.rejects(fs.stat(box.skillFile), { code: "ENOENT" });
    });
  }

  it("uninstall exits 0 when nothing is installed or registered", async () => {
    const box = await cliSandbox({ claude: true });
    const { code, stdout } = await runCli(["uninstall"], box.env);
    assert.equal(code, 0);
    assert.ok(stdout.includes("Skill:  not installed"), stdout);
    assert.ok(stdout.includes('MCP:    "gpt-image" not registered'), stdout);
    assert.deepEqual(await box.claudeCalls(), ["mcp get gpt-image"]);
  });

  it("uninstall removes the skill and prints the manual command when claude is not found", async () => {
    const box = await cliSandbox();
    await fs.mkdir(path.dirname(box.skillFile), { recursive: true });
    await fs.copyFile(SKILL_SOURCE, box.skillFile);
    const { code, stdout } = await runCli(["uninstall"], box.env);
    assert.equal(code, 0);
    assert.ok(stdout.includes("Claude Code CLI not found. Remove it manually: claude mcp remove gpt-image --scope user"), stdout);
    await assert.rejects(fs.stat(box.skillFile), { code: "ENOENT" });
  });

  it("uninstall exits 1 when claude fails to remove the server", async () => {
    const box = await cliSandbox({ claude: true, extraEnv: { ...REGISTERED, FAKE_CLAUDE_ACTION: "1" } });
    const { code, stdout } = await runCli(["uninstall"], box.env);
    assert.equal(code, 1);
    assert.ok(stdout.includes("MCP:    removal failed:"), stdout);
  });

  it("uninstall reports a failure and exits 1 when the skill folder cannot be inspected", async () => {
    const box = await cliSandbox();
    await fs.writeFile(box.config, "a file where the config folder should be");
    const { code, stderr } = await runCli(["uninstall"], box.env);
    assert.equal(code, 1);
    assert.match(stderr, /^mcp-gpt-image uninstall failed: /);
  });
});
