import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import spawn from "cross-spawn";
import {
  claudeConfigDir,
  installSkill,
  PACKAGE_SPEC,
  parseExisting,
  registerServer,
  removeSkill,
  runCommand,
  SERVER_NAME,
  serverCommand,
  SKILL_NAME,
  skillDir,
  skillSource,
  unregisterServer,
} from "../src/setup.js";
import { cleanup, makeTmp, waitFor } from "./support.js";

const SKILL_FILE = fileURLToPath(new URL("../skill/SKILL.md", import.meta.url));
const NOT_WINDOWS = process.platform === "win32" ? "posix only" : false;

afterEach(cleanup);

function enoent() {
  return Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
}

function stubRun(responses) {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args]);
    const next = responses[calls.length - 1];
    if (next === undefined) throw new Error(`unexpected extra call: ${command} ${args.join(" ")}`);
    return { stdout: "", stderr: "", ...next };
  };
  return { run, calls };
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killCalls = 0;
  child.kill = () => {
    child.killCalls += 1;
  };
  return child;
}

describe("constants", () => {
  it("uses gpt-image for the server and the skill and the GitHub package spec", () => {
    assert.equal(SERVER_NAME, "gpt-image");
    assert.equal(SKILL_NAME, "gpt-image");
    assert.equal(PACKAGE_SPEC, "github:Monayzera/mcp-gpt-image");
  });
});

describe("claudeConfigDir and skillDir", () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;

  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  });

  it("uses CLAUDE_CONFIG_DIR when set", () => {
    assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: path.resolve("/custom/claude") }), path.resolve("/custom/claude"));
  });

  it("resolves a relative CLAUDE_CONFIG_DIR and removes a trailing separator", () => {
    assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: "rel/claude" }), path.resolve("rel/claude"));
    assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: `${path.resolve("/custom/claude")}${path.sep}` }), path.resolve("/custom/claude"));
  });

  it("falls back to ~/.claude when CLAUDE_CONFIG_DIR is unset or empty", () => {
    const expected = path.join(os.homedir(), ".claude");
    assert.equal(claudeConfigDir({}), expected);
    assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: "" }), expected);
  });

  it("reads process.env by default", () => {
    process.env.CLAUDE_CONFIG_DIR = path.resolve("/from/process/env");
    assert.equal(claudeConfigDir(), path.resolve("/from/process/env"));
    assert.equal(skillDir(), path.join(path.resolve("/from/process/env"), "skills", "gpt-image"));
  });

  it("puts the skill under <config>/skills/gpt-image", () => {
    const config = path.resolve("/custom/claude");
    assert.equal(skillDir({ CLAUDE_CONFIG_DIR: config }), path.join(config, "skills", "gpt-image"));
  });
});

describe("skillSource", () => {
  it("points to the SKILL.md shipped in the package and it exists", async () => {
    assert.ok(path.isAbsolute(skillSource()));
    assert.equal(skillSource(), SKILL_FILE);
    const text = await fs.readFile(skillSource(), "utf8");
    assert.match(text, /^---\nname: gpt-image\n/);
  });
});

describe("serverCommand", () => {
  it("wraps npx in cmd /c on win32", () => {
    assert.deepEqual(serverCommand("win32"), ["cmd", "/c", "npx", "-y", "github:Monayzera/mcp-gpt-image"]);
  });

  it("calls npx directly on other platforms", () => {
    for (const platform of ["linux", "darwin", "freebsd"]) {
      assert.deepEqual(serverCommand(platform), ["npx", "-y", "github:Monayzera/mcp-gpt-image"], platform);
    }
  });

  it("defaults to the current platform", () => {
    assert.deepEqual(serverCommand(), serverCommand(process.platform));
  });
});

describe("installSkill and removeSkill", () => {
  async function configEnv() {
    const root = await makeTmp("setup-test-");
    const config = path.join(root, "nested", "claude-config");
    return { root, config, env: { CLAUDE_CONFIG_DIR: config } };
  }

  it("copies SKILL.md into <config>/skills/gpt-image creating the missing folders and reports installed", async () => {
    const { config, env } = await configEnv();
    const result = await installSkill(env);
    assert.deepEqual(result, { path: path.join(config, "skills", "gpt-image", "SKILL.md"), status: "installed" });
    assert.deepEqual(await fs.readFile(result.path), await fs.readFile(SKILL_FILE));
  });

  it("overwrites an older copy, reports replaced and keeps other files in the folder", async () => {
    const { config, env } = await configEnv();
    const dir = path.join(config, "skills", "gpt-image");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "SKILL.md"), "stale");
    await fs.writeFile(path.join(dir, "notes.txt"), "keep me");
    const result = await installSkill(env);
    assert.equal(result.status, "replaced");
    assert.deepEqual(await fs.readFile(result.path), await fs.readFile(SKILL_FILE));
    assert.equal(await fs.readFile(path.join(dir, "notes.txt"), "utf8"), "keep me");
  });

  it("goes installed, unchanged, replaced, unchanged across consecutive runs", async () => {
    const { env } = await configEnv();
    const first = await installSkill(env);
    assert.equal(first.status, "installed");
    const second = await installSkill(env);
    assert.equal(second.status, "unchanged");
    assert.equal(second.path, first.path);
    await fs.writeFile(first.path, "edited by the user");
    const third = await installSkill(env);
    assert.equal(third.status, "replaced");
    assert.equal(third.path, first.path);
    const fourth = await installSkill(env);
    assert.equal(fourth.status, "unchanged");
    assert.deepEqual(await fs.readFile(first.path), await fs.readFile(SKILL_FILE));
  });

  it("reports replaced for an empty existing file and for a copy with one extra byte", async () => {
    const { env } = await configEnv();
    const { path: dest } = await installSkill(env);
    await fs.writeFile(dest, "");
    assert.equal((await installSkill(env)).status, "replaced");
    await fs.writeFile(dest, Buffer.concat([await fs.readFile(SKILL_FILE), Buffer.from("\n")]));
    assert.equal((await installSkill(env)).status, "replaced");
    assert.equal((await installSkill(env)).status, "unchanged");
  });

  it("leaves no backup next to the replaced copy", async () => {
    const { config, env } = await configEnv();
    const { path: dest } = await installSkill(env);
    await fs.writeFile(dest, "old");
    await installSkill(env);
    assert.deepEqual(await fs.readdir(path.join(config, "skills", "gpt-image")), ["SKILL.md"]);
  });

  it("propagates a read error other than a missing file", async () => {
    const { config, env } = await configEnv();
    await fs.mkdir(path.join(config, "skills", "gpt-image", "SKILL.md"), { recursive: true });
    await assert.rejects(installSkill(env), err => err.code === "EISDIR");
  });

  it("does not touch other skills in the same config folder", async () => {
    const { config, env } = await configEnv();
    const other = path.join(config, "skills", "other-skill", "SKILL.md");
    await fs.mkdir(path.dirname(other), { recursive: true });
    await fs.writeFile(other, "other");
    await installSkill(env);
    assert.equal(await fs.readFile(other, "utf8"), "other");
    assert.equal(await removeSkill(env), true);
    assert.equal(await fs.readFile(other, "utf8"), "other");
  });

  it("removeSkill deletes the file and the empty folder and returns true", async () => {
    const { config, env } = await configEnv();
    await installSkill(env);
    assert.equal(await removeSkill(env), true);
    await assert.rejects(fs.stat(path.join(config, "skills", "gpt-image")), { code: "ENOENT" });
    assert.ok((await fs.stat(path.join(config, "skills"))).isDirectory());
  });

  it("removeSkill returns false when nothing is installed", async () => {
    const { env } = await configEnv();
    assert.equal(await removeSkill(env), false);
  });

  it("removeSkill returns false the second time", async () => {
    const { env } = await configEnv();
    await installSkill(env);
    assert.equal(await removeSkill(env), true);
    assert.equal(await removeSkill(env), false);
  });

  it("removeSkill keeps the folder when it holds other files", async () => {
    const { config, env } = await configEnv();
    await installSkill(env);
    const extra = path.join(config, "skills", "gpt-image", "extra.txt");
    await fs.writeFile(extra, "user file");
    assert.equal(await removeSkill(env), true);
    assert.equal(await fs.readFile(extra, "utf8"), "user file");
    await assert.rejects(fs.stat(path.join(config, "skills", "gpt-image", "SKILL.md")), { code: "ENOENT" });
  });

  it("removeSkill rethrows errors other than a missing file", { skip: NOT_WINDOWS }, async () => {
    const { root } = await configEnv();
    const blocker = path.join(root, "blocker");
    await fs.writeFile(blocker, "a file, not a directory");
    await assert.rejects(removeSkill({ CLAUDE_CONFIG_DIR: blocker }), err => err.code === "ENOTDIR");
  });

  it("installSkill rejects when the config folder cannot be created", { skip: NOT_WINDOWS }, async () => {
    const { root } = await configEnv();
    const blocker = path.join(root, "blocker");
    await fs.writeFile(blocker, "a file, not a directory");
    await assert.rejects(installSkill({ CLAUDE_CONFIG_DIR: blocker }));
  });
});

const USER_GET_OUTPUT = [
  "gpt-image:",
  "  Scope: User config (available in all your projects)",
  "  Status: ✔ Connected",
  "  Type: stdio",
  "  Command: npx",
  "  Args: -y github:Monayzera/mcp-gpt-image",
  "",
  'To remove this server, run: claude mcp remove "gpt-image" -s user',
  "",
].join("\n");

const LOCAL_GET_OUTPUT = USER_GET_OUTPUT.replace("User config (available in all your projects)", "Local config (private to you in this project)");
const PROJECT_GET_OUTPUT = USER_GET_OUTPUT.replace("User config (available in all your projects)", "Project config (shared via .mcp.json)");

describe("parseExisting", () => {
  it("reads scope and status from the claude mcp get output of a user scope server", () => {
    assert.deepEqual(parseExisting(USER_GET_OUTPUT), {
      scope: "User config (available in all your projects)",
      health: "✔ Connected",
      userScope: true,
    });
  });

  it("flags local and project scopes as not user scope", () => {
    assert.deepEqual(parseExisting(LOCAL_GET_OUTPUT), {
      scope: "Local config (private to you in this project)",
      health: "✔ Connected",
      userScope: false,
    });
    assert.deepEqual(parseExisting(PROJECT_GET_OUTPUT), {
      scope: "Project config (shared via .mcp.json)",
      health: "✔ Connected",
      userScope: false,
    });
  });

  it("matches the user prefix case-insensitively", () => {
    for (const scope of ["user", "User", "USER config", "user config (available in all your projects)", "User"]) {
      assert.equal(parseExisting(`Scope: ${scope}\n`).userScope, true, scope);
    }
  });

  it("requires user to be a whole word", () => {
    assert.equal(parseExisting("Scope: Userland config\n").userScope, false);
    assert.equal(parseExisting("Scope: Superuser config\n").userScope, false);
  });

  it("treats a missing Scope line as user scope", () => {
    assert.deepEqual(parseExisting("gpt-image:\n  Status: ✔ Connected\n"), { scope: null, health: "✔ Connected", userScope: true });
  });

  it("returns a null health when there is no Status line", () => {
    assert.deepEqual(parseExisting("gpt-image:\n  Scope: Local config\n"), { scope: "Local config", health: null, userScope: false });
  });

  it("returns the defaults for empty, null and undefined output", () => {
    for (const input of ["", null, undefined, "   \n\n"]) {
      assert.deepEqual(parseExisting(input), { scope: null, health: null, userScope: true }, String(input));
    }
  });

  it("returns exactly scope, health and userScope", () => {
    assert.deepEqual(Object.keys(parseExisting(USER_GET_OUTPUT)).sort(), ["health", "scope", "userScope"]);
  });

  it("handles CRLF line endings", () => {
    const parsed = parseExisting("gpt-image:\r\n  Scope: Local config (private)\r\n  Status: ✗ Failed to connect\r\n  Type: stdio\r\n");
    assert.deepEqual(parsed, { scope: "Local config (private)", health: "✗ Failed to connect", userScope: false });
  });

  it("handles tabs and extra spaces around the label and the value", () => {
    const parsed = parseExisting("\tScope:\t  User config  \n      Status:    ! Needs authentication   \n");
    assert.deepEqual(parsed, { scope: "User config", health: "! Needs authentication", userScope: true });
  });

  it("matches the labels case-insensitively", () => {
    assert.deepEqual(parseExisting("scope: Local config\nSTATUS: ok\n"), { scope: "Local config", health: "ok", userScope: false });
  });

  it("uses the first Scope line when there are several", () => {
    assert.equal(parseExisting("Scope: Local config\nScope: User config\n").scope, "Local config");
  });

  it("ignores Scope and Status text that does not start a line", () => {
    assert.deepEqual(parseExisting("Command: tool --Scope: Local config --Status: bad\n"), { scope: null, health: null, userScope: true });
  });

  it("keeps a failed or unauthenticated status text verbatim", () => {
    assert.equal(parseExisting("Status: ✗ Failed to connect\n").health, "✗ Failed to connect");
    assert.equal(parseExisting("Status: ⚠ Needs authentication\n").health, "⚠ Needs authentication");
  });

  it("returns a null scope when the Scope line has no value", () => {
    const parsed = parseExisting("gpt-image:\n  Scope:\n  Status: ✔ Connected\n");
    assert.equal(parsed.scope, null);
    assert.equal(parsed.userScope, true);
    assert.equal(parsed.health, "✔ Connected");
  });

  it("returns a null health when the Status line has no value", () => {
    const parsed = parseExisting("gpt-image:\n  Scope: User config\n  Status:\n  Type: stdio\n");
    assert.equal(parsed.health, null);
  });
});

describe("registerServer", () => {
  const GET = ["claude", "mcp", "get", "gpt-image"];
  const CODEX = path.resolve("/opt/codex/bin/codex");

  it("reports no-claude when the claude command does not exist and stops there", async () => {
    const { run, calls } = stubRun([{ code: null, error: enoent() }]);
    assert.deepEqual(await registerServer(run, {}), { status: "no-claude" });
    assert.deepEqual(calls, [GET]);
  });

  it("reports exists with the defaults when get succeeds with no recognizable output", async () => {
    const { run, calls } = stubRun([{ code: 0 }]);
    assert.deepEqual(await registerServer(run, {}), { status: "exists", scope: null, health: null, userScope: true });
    assert.deepEqual(calls, [GET]);
  });

  it("reports exists with scope and health for a user scope server and does not add it again", async () => {
    const { run, calls } = stubRun([{ code: 0, stdout: USER_GET_OUTPUT }]);
    assert.deepEqual(await registerServer(run, {}), {
      status: "exists",
      scope: "User config (available in all your projects)",
      health: "✔ Connected",
      userScope: true,
    });
    assert.deepEqual(calls, [GET]);
  });

  it("reports exists with a failed health for a user scope server that cannot connect", async () => {
    const { run } = stubRun([{ code: 0, stdout: USER_GET_OUTPUT.replace("✔ Connected", "✗ Failed to connect") }]);
    const result = await registerServer(run, {});
    assert.equal(result.status, "exists");
    assert.equal(result.health, "✗ Failed to connect");
  });

  it("reports other-scope for a local scope server and never adds or removes", async () => {
    const { run, calls } = stubRun([{ code: 0, stdout: LOCAL_GET_OUTPUT }]);
    assert.deepEqual(await registerServer(run, {}), {
      status: "other-scope",
      scope: "Local config (private to you in this project)",
      health: "✔ Connected",
      userScope: false,
    });
    assert.deepEqual(calls, [GET]);
  });

  it("reports other-scope for a project scope server", async () => {
    const { run, calls } = stubRun([{ code: 0, stdout: PROJECT_GET_OUTPUT }]);
    const result = await registerServer(run, {});
    assert.equal(result.status, "other-scope");
    assert.equal(result.scope, "Project config (shared via .mcp.json)");
    assert.equal(result.userScope, false);
    assert.equal(calls.length, 1);
  });

  it("adds the server at user scope with the npx command when it is not registered", async () => {
    const { run, calls } = stubRun([{ code: 1, stderr: "No MCP server found" }, { code: 0 }]);
    assert.deepEqual(await registerServer(run, {}), { status: "added" });
    assert.deepEqual(calls, [GET, ["claude", "mcp", "add", "--scope", "user", "gpt-image", "--", ...serverCommand()]]);
  });

  it("uses the literal npx command line on posix", { skip: NOT_WINDOWS }, async () => {
    const { run, calls } = stubRun([{ code: 1 }, { code: 0 }]);
    await registerServer(run, {});
    assert.deepEqual(calls[1], ["claude", "mcp", "add", "--scope", "user", "gpt-image", "--", "npx", "-y", "github:Monayzera/mcp-gpt-image"]);
  });

  it("passes -e CODEX_PATH=<absolute path> before the separator when CODEX_PATH is set", async () => {
    const { run, calls } = stubRun([{ code: 1 }, { code: 0 }]);
    assert.deepEqual(await registerServer(run, { CODEX_PATH: CODEX }), { status: "added" });
    assert.deepEqual(calls[1], ["claude", "mcp", "add", "--scope", "user", "gpt-image", "-e", `CODEX_PATH=${CODEX}`, "--", ...serverCommand()]);
    const args = calls[1];
    assert.ok(args.indexOf("-e") < args.indexOf("--"));
    assert.ok(args.indexOf("gpt-image") < args.indexOf("-e"));
  });

  it("resolves a relative CODEX_PATH to an absolute path", async () => {
    const { run, calls } = stubRun([{ code: 1 }, { code: 0 }]);
    await registerServer(run, { CODEX_PATH: path.join("relative", "dir", "codex") });
    const value = calls[1][calls[1].indexOf("-e") + 1];
    assert.equal(value, `CODEX_PATH=${path.resolve("relative", "dir", "codex")}`);
    assert.ok(path.isAbsolute(value.slice("CODEX_PATH=".length)));
  });

  it("passes a CODEX_PATH with spaces as one argument", async () => {
    const { run, calls } = stubRun([{ code: 1 }, { code: 0 }]);
    const spaced = path.resolve("/opt/my tools/codex");
    await registerServer(run, { CODEX_PATH: spaced });
    assert.equal(calls[1][calls[1].indexOf("-e") + 1], `CODEX_PATH=${spaced}`);
  });

  it("adds no -e argument when CODEX_PATH is unset or empty", async () => {
    for (const env of [{}, { CODEX_PATH: "" }, { OTHER: "x" }]) {
      const { run, calls } = stubRun([{ code: 1 }, { code: 0 }]);
      await registerServer(run, env);
      assert.ok(!calls[1].includes("-e"), JSON.stringify(env));
      assert.ok(!calls[1].some(a => a.startsWith("CODEX_PATH=")), JSON.stringify(env));
    }
  });

  it("does not look at CODEX_PATH when the server already exists", async () => {
    const { run, calls } = stubRun([{ code: 0, stdout: USER_GET_OUTPUT }]);
    await registerServer(run, { CODEX_PATH: CODEX });
    assert.equal(calls.length, 1);
  });

  it("reads process.env when no env is passed", async () => {
    const saved = process.env.CODEX_PATH;
    process.env.CODEX_PATH = CODEX;
    try {
      const { run, calls } = stubRun([{ code: 1 }, { code: 0 }]);
      await registerServer(run);
      assert.deepEqual(calls[1].slice(5, 8), ["gpt-image", "-e", `CODEX_PATH=${CODEX}`]);
    } finally {
      if (saved === undefined) delete process.env.CODEX_PATH;
      else process.env.CODEX_PATH = saved;
    }
  });

  it("reports failed with the trimmed stderr when add exits non-zero", async () => {
    const { run } = stubRun([{ code: 1 }, { code: 2, stderr: "  permission denied\n", stdout: "ignored" }]);
    assert.deepEqual(await registerServer(run, {}), { status: "failed", detail: "permission denied" });
  });

  it("falls back to stdout when stderr is empty", async () => {
    const { run } = stubRun([{ code: 1 }, { code: 2, stderr: "", stdout: "stdout reason\n" }]);
    assert.deepEqual(await registerServer(run, {}), { status: "failed", detail: "stdout reason" });
  });

  it("prefers the error message over the output", async () => {
    const { run } = stubRun([{ code: 1 }, { code: null, error: new Error("claude timed out"), stderr: "ignored" }]);
    assert.deepEqual(await registerServer(run, {}), { status: "failed", detail: "claude timed out" });
  });

  it("reports an empty detail when add fails silently", async () => {
    const { run } = stubRun([{ code: 1 }, { code: 1 }]);
    assert.deepEqual(await registerServer(run, {}), { status: "failed", detail: "" });
  });

  it("reports failed when claude disappears between get and add", async () => {
    const { run } = stubRun([{ code: 1 }, { code: null, error: enoent() }]);
    assert.deepEqual(await registerServer(run, {}), { status: "failed", detail: "spawn claude ENOENT" });
  });
});

describe("unregisterServer", () => {
  const GET = ["claude", "mcp", "get", "gpt-image"];

  it("reports no-claude when the claude command does not exist", async () => {
    const { run, calls } = stubRun([{ code: null, error: enoent() }]);
    assert.deepEqual(await unregisterServer(run), { status: "no-claude" });
    assert.deepEqual(calls, [GET]);
  });

  it("reports absent when get exits non-zero and does not call remove", async () => {
    const { run, calls } = stubRun([{ code: 1 }]);
    assert.deepEqual(await unregisterServer(run), { status: "absent" });
    assert.deepEqual(calls, [GET]);
  });

  it("removes the server at user scope when it is registered at user scope", async () => {
    const { run, calls } = stubRun([{ code: 0, stdout: USER_GET_OUTPUT }, { code: 0 }]);
    assert.deepEqual(await unregisterServer(run), { status: "removed" });
    assert.deepEqual(calls, [GET, ["claude", "mcp", "remove", "gpt-image", "--scope", "user"]]);
  });

  it("removes the server when get succeeds with no Scope line", async () => {
    const { run, calls } = stubRun([{ code: 0 }, { code: 0 }]);
    assert.deepEqual(await unregisterServer(run), { status: "removed" });
    assert.equal(calls.length, 2);
  });

  it("reports other-scope with the scope for a local scope server and does not call remove", async () => {
    const { run, calls } = stubRun([{ code: 0, stdout: LOCAL_GET_OUTPUT }]);
    assert.deepEqual(await unregisterServer(run), {
      status: "other-scope",
      scope: "Local config (private to you in this project)",
      health: "✔ Connected",
      userScope: false,
    });
    assert.deepEqual(calls, [GET]);
  });

  it("reports other-scope for a project scope server and does not call remove", async () => {
    const { run, calls } = stubRun([{ code: 0, stdout: PROJECT_GET_OUTPUT }]);
    const result = await unregisterServer(run);
    assert.equal(result.status, "other-scope");
    assert.equal(result.scope, "Project config (shared via .mcp.json)");
    assert.equal(calls.length, 1);
  });

  it("reports failed with the trimmed stderr when remove exits non-zero", async () => {
    const { run } = stubRun([{ code: 0, stdout: USER_GET_OUTPUT }, { code: 1, stderr: "cannot write config\n" }]);
    assert.deepEqual(await unregisterServer(run), { status: "failed", detail: "cannot write config" });
  });

  it("reports failed with the error message when remove cannot run", async () => {
    const { run } = stubRun([{ code: 0, stdout: USER_GET_OUTPUT }, { code: null, error: new Error("spawn exploded") }]);
    assert.deepEqual(await unregisterServer(run), { status: "failed", detail: "spawn exploded" });
  });
});

describe("runCommand with real processes", () => {
  it("captures stdout and a zero exit code", async () => {
    const result = await runCommand(process.execPath, ["-e", "process.stdout.write('hello')"]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "hello");
    assert.equal(result.stderr, "");
    assert.equal(result.error, undefined);
  });

  it("captures stderr and a non-zero exit code", async () => {
    const result = await runCommand(process.execPath, ["-e", "process.stderr.write('bad news'); process.exit(3)"]);
    assert.equal(result.code, 3);
    assert.equal(result.stderr, "bad news");
    assert.equal(result.stdout, "");
    assert.equal(result.error, undefined);
  });

  it("captures stdout and stderr together", async () => {
    const result = await runCommand(process.execPath, ["-e", "process.stdout.write('out'); process.stderr.write('err')"]);
    assert.deepEqual({ code: result.code, stdout: result.stdout, stderr: result.stderr }, { code: 0, stdout: "out", stderr: "err" });
  });

  it("captures large output across many chunks", async () => {
    const result = await runCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(300000))"]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout.length, 300000);
  });

  it("passes the arguments through unchanged", async () => {
    const result = await runCommand(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "a b", "--flag", "c"]);
    assert.deepEqual(JSON.parse(result.stdout), ["a b", "--flag", "c"]);
  });

  it("gives the child a closed stdin", async () => {
    const script = "process.stdin.on('end', () => process.stdout.write('eof')); process.stdin.resume()";
    const result = await runCommand(process.execPath, ["-e", script], { timeoutMs: 10_000 });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "eof");
  });

  it("kills a process that outlives the timeout and reports a timeout error with null code", async () => {
    let child;
    const spawnImpl = (command, args, options) => {
      child = spawn(command, args, options);
      return child;
    };
    const startedAt = Date.now();
    const result = await runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 300, spawnImpl });
    assert.ok(Date.now() - startedAt < 5000);
    assert.equal(result.code, null);
    assert.ok(result.error instanceof Error);
    assert.ok(result.error.message.startsWith(`${process.execPath} -e setInterval(() => {}, 1000) timed out`), result.error.message);
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, { label: "child exit after timeout kill" });
    assert.equal(child.signalCode, "SIGTERM");
  });

  it("keeps the output produced before a timeout", async () => {
    const result = await runCommand(process.execPath, ["-e", "process.stdout.write('partial'); setInterval(() => {}, 1000)"], { timeoutMs: 500 });
    assert.equal(result.code, null);
    assert.equal(result.stdout, "partial");
    assert.match(result.error.message, /timed out/);
  });

  it("does not time out a process that finishes in time", async () => {
    const result = await runCommand(process.execPath, ["-e", "process.stdout.write('quick')"], { timeoutMs: 20_000 });
    assert.equal(result.code, 0);
    assert.equal(result.error, undefined);
  });

  it("reports ENOENT for a command that does not exist", async () => {
    const result = await runCommand("mcp-gpt-image-no-such-command-4f1c", ["--version"]);
    assert.equal(result.code, null);
    assert.equal(result.error?.code, "ENOENT");
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });
});

describe("runCommand with an injected spawn", () => {
  it("spawns with a closed stdin, piped output and a hidden window", async () => {
    const child = fakeChild();
    const seen = [];
    const promise = runCommand("claude", ["mcp", "get", "x"], {
      spawnImpl: (command, args, options) => {
        seen.push({ command, args, options });
        return child;
      },
    });
    child.emit("close", 0);
    await promise;
    assert.deepEqual(seen, [{ command: "claude", args: ["mcp", "get", "x"], options: { stdio: ["ignore", "pipe", "pipe"], windowsHide: true } }]);
  });

  it("concatenates string and buffer chunks", async () => {
    const child = fakeChild();
    const promise = runCommand("x", [], { spawnImpl: () => child });
    child.stdout.emit("data", Buffer.from("he"));
    child.stdout.emit("data", "llo");
    child.stderr.emit("data", Buffer.from("e1"));
    child.stderr.emit("data", Buffer.from("e2"));
    child.emit("close", 0);
    assert.deepEqual(await promise, { stdout: "hello", stderr: "e1e2", code: 0 });
  });

  it("resolves with the error and a null code on an error event, and ignores a later close", async () => {
    const child = fakeChild();
    const promise = runCommand("x", [], { spawnImpl: () => child });
    const err = enoent();
    child.emit("error", err);
    child.emit("close", 0);
    const result = await promise;
    assert.equal(result.code, null);
    assert.equal(result.error, err);
  });

  it("reports a null code when the process was ended by a signal", async () => {
    const child = fakeChild();
    const promise = runCommand("x", [], { spawnImpl: () => child });
    child.emit("close", null, "SIGKILL");
    const result = await promise;
    assert.equal(result.code, null);
    assert.equal(result.error, undefined);
  });

  it("resolves with the spawn error when spawn throws synchronously", async () => {
    const boom = new Error("spawn exploded");
    const result = await runCommand("x", [], {
      spawnImpl: () => {
        throw boom;
      },
    });
    assert.deepEqual(result, { code: null, stdout: "", stderr: "", error: boom });
  });

  it("times out, kills the child once and still resolves when kill throws", async () => {
    const child = fakeChild();
    child.kill = () => {
      child.killCalls += 1;
      throw new Error("kill failed");
    };
    const promise = runCommand("claude", ["mcp", "add"], { timeoutMs: 20, spawnImpl: () => child });
    child.stdout.emit("data", "so far");
    const result = await promise;
    assert.equal(child.killCalls, 1);
    assert.equal(result.code, null);
    assert.equal(result.stdout, "so far");
    assert.equal(result.error.message, "claude mcp add timed out");
    child.emit("close", 0);
  });

  it("does not kill the child after it already closed", async () => {
    const child = fakeChild();
    const promise = runCommand("x", [], { timeoutMs: 30, spawnImpl: () => child });
    child.emit("close", 0);
    await promise;
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(child.killCalls, 0);
  });

  it("works with a child that has no stdout or stderr streams", async () => {
    const child = new EventEmitter();
    child.kill = () => {};
    const promise = runCommand("x", [], { spawnImpl: () => child });
    child.emit("close", 5);
    assert.deepEqual(await promise, { stdout: "", stderr: "", code: 5 });
  });

  it("awaits a real child process through the same injected spawn", async () => {
    let child;
    const result = await runCommand(process.execPath, ["-e", "process.stdout.write('ok')"], {
      spawnImpl: (command, args, options) => {
        child = spawn(command, args, options);
        return child;
      },
    });
    assert.equal(result.stdout, "ok");
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
    assert.equal(child.exitCode, 0);
  });
});
