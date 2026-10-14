import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { childEnv, CodexNotFoundError, extraSearchDirs, findCodex, INSTALL_HINT } from "../src/locate.js";

const NODE_DIR = path.dirname(process.execPath);

let tmp;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "locate-test-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function touch(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "", { mode: 0o755 });
  return file;
}

function anyExists(dirs, names) {
  return dirs.some(dir => names.some(name => fs.existsSync(path.join(dir, name))));
}

const NODE_DIR_HAS_CODEX = anyExists([NODE_DIR], ["codex.exe", "codex.cmd", "codex.com", "codex.bat"]);
const SKIP_WIN32 = NODE_DIR_HAS_CODEX ? "a codex executable exists next to node" : false;
const REAL_CODEX_IN_FALLBACK_DIRS = anyExists(extraSearchDirs({ PATH: "" }, "linux"), ["codex"]);

describe("findCodex with CODEX_PATH", () => {
  it("returns CODEX_PATH when it points to an existing file", () => {
    const file = touch(path.join(tmp, "custom-codex"));
    assert.equal(findCodex({ CODEX_PATH: file }), file);
  });

  it("CODEX_PATH wins over a codex found on PATH", () => {
    const onPath = touch(path.join(tmp, "bin", "codex"));
    const custom = touch(path.join(tmp, "custom", "codex-custom"));
    assert.equal(findCodex({ CODEX_PATH: custom, PATH: path.dirname(onPath) }), custom);
  });

  it("throws CodexNotFoundError with the install hint when CODEX_PATH is missing", () => {
    const missing = path.join(tmp, "nope", "codex");
    assert.throws(
      () => findCodex({ CODEX_PATH: missing, PATH: "" }),
      err => {
        assert.ok(err instanceof CodexNotFoundError);
        assert.equal(err.name, "CodexNotFoundError");
        assert.ok(err.message.includes("npm install -g @openai/codex"));
        assert.ok(err.message.includes("codex login"));
        assert.ok(err.message.includes(missing));
        assert.ok(err.message.endsWith(INSTALL_HINT));
        return true;
      }
    );
  });

  it("throws when CODEX_PATH points to a directory", () => {
    assert.throws(() => findCodex({ CODEX_PATH: tmp }), CodexNotFoundError);
  });

  it("does not fall back to PATH when CODEX_PATH is set but invalid", () => {
    const onPath = touch(path.join(tmp, "bin", "codex"));
    assert.throws(() => findCodex({ CODEX_PATH: path.join(tmp, "missing"), PATH: path.dirname(onPath) }), CodexNotFoundError);
  });

  it("ignores an empty CODEX_PATH and searches PATH", () => {
    const onPath = touch(path.join(tmp, "bin", "codex"));
    assert.equal(findCodex({ CODEX_PATH: "", PATH: path.dirname(onPath) }), onPath);
  });
});

describe("findCodex PATH search", () => {
  it("finds an executable named codex in a PATH directory", () => {
    const file = touch(path.join(tmp, "bin", "codex"));
    assert.equal(findCodex({ PATH: path.dirname(file) }, "linux"), file);
  });

  it("returns the first PATH directory that contains codex", () => {
    const first = touch(path.join(tmp, "first", "codex"));
    const second = touch(path.join(tmp, "second", "codex"));
    const env = { PATH: [path.dirname(first), path.dirname(second)].join(path.delimiter) };
    assert.equal(findCodex(env, "linux"), first);
    const reversed = { PATH: [path.dirname(second), path.dirname(first)].join(path.delimiter) };
    assert.equal(findCodex(reversed, "linux"), second);
  });

  it("skips empty PATH segments and directories without codex", () => {
    const file = touch(path.join(tmp, "bin", "codex"));
    const env = { PATH: [`${path.delimiter}`, path.join(tmp, "empty"), path.dirname(file)].join(path.delimiter) };
    assert.equal(findCodex(env, "linux"), file);
  });

  it("does not treat a directory named codex as the executable", () => {
    fs.mkdirSync(path.join(tmp, "bin", "codex"), { recursive: true });
    const real = touch(path.join(tmp, "bin2", "codex"));
    const env = { PATH: [path.join(tmp, "bin"), path.dirname(real)].join(path.delimiter) };
    assert.equal(findCodex(env, "linux"), real);
  });

  it("reads PATH from a differently cased key", () => {
    const file = touch(path.join(tmp, "bin", "codex"));
    assert.equal(findCodex({ Path: path.dirname(file) }, "linux"), file);
  });

  it("on win32 finds codex.cmd using PATHEXT", () => {
    const file = touch(path.join(tmp, "bin", "codex.cmd"));
    assert.equal(findCodex({ PATH: path.dirname(file), PATHEXT: ".EXE;.CMD" }, "win32"), file);
  });

  it("on win32 prefers the earlier PATHEXT extension", () => {
    const exe = touch(path.join(tmp, "bin", "codex.exe"));
    touch(path.join(tmp, "bin", "codex.cmd"));
    assert.equal(findCodex({ PATH: path.dirname(exe), PATHEXT: ".EXE;.CMD" }, "win32"), exe);
  });

  it("on win32 falls back to the default extension list without PATHEXT", () => {
    const file = touch(path.join(tmp, "bin", "codex.bat"));
    assert.equal(findCodex({ PATH: path.dirname(file) }, "win32"), file);
  });

  it("on win32 does not match an extensionless codex file", { skip: SKIP_WIN32 }, () => {
    const bare = touch(path.join(tmp, "bin", "codex"));
    assert.throws(() => findCodex({ PATH: path.dirname(bare), PATHEXT: ".EXE;.CMD" }, "win32"), CodexNotFoundError);
  });

  it("on win32 finds codex.cmd in the APPDATA npm folder", { skip: SKIP_WIN32 }, () => {
    const file = touch(path.join(tmp, "npm", "codex.cmd"));
    const env = { PATH: path.join(tmp, "empty"), PATHEXT: ".CMD", APPDATA: tmp };
    assert.equal(findCodex(env, "win32"), file);
  });

  it("on win32 finds codex.cmd in the LOCALAPPDATA Volta folder", { skip: SKIP_WIN32 }, () => {
    const file = touch(path.join(tmp, "Volta", "bin", "codex.cmd"));
    const env = { PATH: path.join(tmp, "empty"), PATHEXT: ".CMD", LOCALAPPDATA: tmp };
    assert.equal(findCodex(env, "win32"), file);
  });

  it("on win32 finds codex.cmd in npm_config_prefix", { skip: SKIP_WIN32 }, () => {
    const file = touch(path.join(tmp, "prefix", "codex.cmd"));
    const env = { PATH: path.join(tmp, "empty"), PATHEXT: ".CMD", npm_config_prefix: path.dirname(file) };
    assert.equal(findCodex(env, "win32"), file);
  });

  it("on win32 throws when nothing is found", { skip: SKIP_WIN32 }, () => {
    const empty = path.join(tmp, "empty");
    fs.mkdirSync(empty);
    assert.throws(
      () => findCodex({ PATH: empty, PATHEXT: ".EXE;.CMD" }, "win32"),
      err => {
        assert.ok(err instanceof CodexNotFoundError);
        assert.ok(err.message.includes("Codex CLI was not found"));
        assert.ok(err.message.includes("npm install -g @openai/codex"));
        return true;
      }
    );
  });

  it(
    "on posix throws when codex is nowhere to be found",
    { skip: REAL_CODEX_IN_FALLBACK_DIRS ? "a real codex exists in the fallback search dirs" : false },
    () => {
      const env = { PATH: path.join(tmp, "empty") };
      fs.mkdirSync(env.PATH);
      assert.throws(() => findCodex(env, "linux"), CodexNotFoundError);
    }
  );
});

describe("extraSearchDirs", () => {
  it("starts with the directory of the running node binary", () => {
    assert.equal(extraSearchDirs({}, "linux")[0], NODE_DIR);
    assert.equal(extraSearchDirs({}, "win32")[0], NODE_DIR);
  });

  it("lists common posix install locations", () => {
    const dirs = extraSearchDirs({}, "linux");
    for (const expected of [
      path.join(os.homedir(), ".npm-global", "bin"),
      path.join(os.homedir(), ".local", "bin"),
      path.join(os.homedir(), ".volta", "bin"),
      path.join(os.homedir(), ".bun", "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
    ]) {
      assert.ok(dirs.includes(expected), `missing ${expected}`);
    }
  });

  it("adds npm_config_prefix/bin on posix and the prefix itself on win32", () => {
    assert.equal(extraSearchDirs({ npm_config_prefix: "/opt/prefix" }, "linux").at(-1), path.join("/opt/prefix", "bin"));
    assert.equal(extraSearchDirs({ npm_config_prefix: "/opt/prefix" }, "win32").at(-1), "/opt/prefix");
  });

  it("uses APPDATA and LOCALAPPDATA only on win32", () => {
    const env = { APPDATA: tmp, LOCALAPPDATA: tmp };
    assert.deepEqual(extraSearchDirs(env, "win32"), [NODE_DIR, path.join(tmp, "npm"), path.join(tmp, "Volta", "bin")]);
    const posix = extraSearchDirs(env, "linux");
    assert.ok(!posix.includes(path.join(tmp, "npm")));
  });
});

describe("childEnv", () => {
  it("prepends the node binary directory when missing", () => {
    const env = { PATH: ["/aaa", "/bbb"].join(path.delimiter), FOO: "1" };
    const result = childEnv(env);
    assert.equal(result.PATH, [NODE_DIR, "/aaa", "/bbb"].join(path.delimiter));
    assert.equal(result.FOO, "1");
  });

  it("does not mutate the input env", () => {
    const env = { PATH: "/aaa" };
    childEnv(env);
    assert.equal(env.PATH, "/aaa");
  });

  it("does not duplicate the node binary directory when already present", () => {
    const original = ["/aaa", NODE_DIR, "/bbb"].join(path.delimiter);
    const env = { PATH: original };
    const result = childEnv(env);
    assert.equal(result.PATH, original);
    assert.notEqual(result, env);
    assert.equal(result.PATH.split(path.delimiter).filter(p => p === NODE_DIR).length, 1);
  });

  it("preserves the casing of the PATH key", () => {
    const result = childEnv({ Path: "/aaa" });
    assert.equal(result.Path, [NODE_DIR, "/aaa"].join(path.delimiter));
    assert.ok(!("PATH" in result));
  });

  it("creates PATH when the env has none", () => {
    assert.deepEqual(childEnv({ FOO: "1" }), { FOO: "1", PATH: NODE_DIR });
  });

  it("drops empty PATH segments when it rewrites PATH", () => {
    const result = childEnv({ PATH: `${path.delimiter}/aaa${path.delimiter}${path.delimiter}` });
    assert.equal(result.PATH, [NODE_DIR, "/aaa"].join(path.delimiter));
  });

  it("defaults to process.env", () => {
    const result = childEnv();
    assert.ok(result.PATH.split(path.delimiter).includes(NODE_DIR));
  });
});
