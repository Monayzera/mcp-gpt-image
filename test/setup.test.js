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

  it("copies SKILL.md into <config>/skills/gpt-image creating the missing folders", async () => {
    const { config, env } = await configEnv();
    const dest = await installSkill(env);
    assert.equal(dest, path.join(config, "skills", "gpt-image", "SKILL.md"));
    assert.deepEqual(await fs.readFile(dest), await fs.readFile(SKILL_FILE));
  });

  it("overwrites an older copy and keeps other files in the folder", async () => {
    const { config, env } = await configEnv();
    const dir = path.join(config, "skills", "gpt-image");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "SKILL.md"), "stale");
    await fs.writeFile(path.join(dir, "notes.txt"), "keep me");
    const dest = await installSkill(env);
    assert.deepEqual(await fs.readFile(dest), await fs.readFile(SKILL_FILE));
    assert.equal(await fs.readFile(path.join(dir, "notes.txt"), "utf8"), "keep me");
  });

  it("is idempotent", async () => {
    const { env } = await configEnv();
    const first = await installSkill(env);
    const second = await installSkill(env);
    assert.equal(first, second);
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

describe("registerServer", () => {
  const GET = ["claude", "mcp", "get", "gpt-image"];

  it("reports no-claude when the claude command does not exist and stops there", async () => {
    const { run, calls } = stubRun([{ code: null, error: enoent() }]);
    assert.deepEqual(await registerServer(run), { status: "no-claude" });
    assert.deepEqual(calls, [GET]);
  });

  it("reports exists when the server is already registered and does not add it again", async () => {
    const { run, calls } = stubRun([{ code: 0 }]);
    assert.deepEqual(await registerServer(run), { status: "exists" });
    assert.deepEqual(calls, [GET]);
  });

  it("adds the server at user scope with the npx command when it is not registered", async () => {
    const { run, calls } = stubRun([{ code: 1, stderr: "No MCP server found" }, { code: 0 }]);
    assert.deepEqual(await registerServer(run), { status: "added" });
    assert.deepEqual(calls, [GET, ["claude", "mcp", "add", "--scope", "user", "gpt-image", "--", ...serverCommand()]]);
  });

  it("uses the literal npx command line on posix", { skip: NOT_WINDOWS }, async () => {
    const { run, calls } = stubRun([{ code: 1 }, { code: 0 }]);
    await registerServer(run);
    assert.deepEqual(calls[1], ["claude", "mcp", "add", "--scope", "user", "gpt-image", "--", "npx", "-y", "github:Monayzera/mcp-gpt-image"]);
  });

  it("reports failed with the trimmed stderr when add exits non-zero", async () => {
    const { run } = stubRun([{ code: 1 }, { code: 2, stderr: "  permission denied\n", stdout: "ignored" }]);
    assert.deepEqual(await registerServer(run), { status: "failed", detail: "permission denied" });
  });

  it("falls back to stdout when stderr is empty", async () => {
    const { run } = stubRun([{ code: 1 }, { code: 2, stderr: "", stdout: "stdout reason\n" }]);
    assert.deepEqual(await registerServer(run), { status: "failed", detail: "stdout reason" });
  });

  it("prefers the error message over the output", async () => {
    const { run } = stubRun([{ code: 1 }, { code: null, error: new Error("claude timed out"), stderr: "ignored" }]);
    assert.deepEqual(await registerServer(run), { status: "failed", detail: "claude timed out" });
  });

  it("reports an empty detail when add fails silently", async () => {
    const { run } = stubRun([{ code: 1 }, { code: 1 }]);
    assert.deepEqual(await registerServer(run), { status: "failed", detail: "" });
  });

  it("reports failed when claude disappears between get and add", async () => {
    const { run } = stubRun([{ code: 1 }, { code: null, error: enoent() }]);
    assert.deepEqual(await registerServer(run), { status: "failed", detail: "spawn claude ENOENT" });
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

  it("removes the server at user scope when it is registered", async () => {
    const { run, calls } = stubRun([{ code: 0 }, { code: 0 }]);
    assert.deepEqual(await unregisterServer(run), { status: "removed" });
    assert.deepEqual(calls, [GET, ["claude", "mcp", "remove", "gpt-image", "--scope", "user"]]);
  });

  it("reports failed with the trimmed stderr when remove exits non-zero", async () => {
    const { run } = stubRun([{ code: 0 }, { code: 1, stderr: "cannot write config\n" }]);
    assert.deepEqual(await unregisterServer(run), { status: "failed", detail: "cannot write config" });
  });

  it("reports failed with the error message when remove cannot run", async () => {
    const { run } = stubRun([{ code: 0 }, { code: null, error: new Error("spawn exploded") }]);
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
