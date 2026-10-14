import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { childEnv, CodexNotFoundError, extraSearchDirs, findCodex, INSTALL_HINT } from "../src/locate.js";

const NODE_DIR = path.dirname(process.execPath);

let tmp;
const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

function useFakeHome(dir) {
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "locate-test-"));
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedHome)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
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
const SYSTEM_FALLBACK_DIRS = ["/opt/homebrew/bin", "/home/linuxbrew/.linuxbrew/bin", "/usr/local/bin", "/usr/bin"];
const SKIP_POSIX_ONLY = process.platform === "win32" ? "posix file semantics" : false;
const SKIP_POSIX_SEARCH =
  SKIP_POSIX_ONLY ||
  (anyExists([NODE_DIR], ["codex"]) ? "a codex executable exists next to node" : false) ||
  (anyExists(SYSTEM_FALLBACK_DIRS, ["codex"]) ? "a real codex exists in a system fallback dir" : false);

function mockMntPaths(t) {
  const realStat = fs.statSync;
  const realAccess = fs.accessSync;
  t.mock.method(fs, "statSync", (p, ...rest) => (String(p).startsWith("/mnt/") ? { isFile: () => true } : realStat(p, ...rest)));
  t.mock.method(fs, "accessSync", (p, ...rest) => (String(p).startsWith("/mnt/") ? undefined : realAccess(p, ...rest)));
}

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

  it("throws the exact CODEX_PATH message for a missing file", () => {
    const missing = path.join(tmp, "nope", "codex");
    assert.throws(
      () => findCodex({ CODEX_PATH: missing }),
      err => {
        assert.ok(err instanceof CodexNotFoundError);
        assert.ok(err.message.startsWith(`CODEX_PATH is set but no executable file exists at: ${missing}\n\n`));
        return true;
      }
    );
  });

  it("throws the exact CODEX_PATH message for a file without the execute bit", { skip: SKIP_POSIX_ONLY }, () => {
    const file = touch(path.join(tmp, "plain", "codex"));
    fs.chmodSync(file, 0o644);
    assert.throws(
      () => findCodex({ CODEX_PATH: file }, "linux"),
      err => {
        assert.ok(err instanceof CodexNotFoundError);
        assert.ok(err.message.startsWith(`CODEX_PATH is set but no executable file exists at: ${file}\n\n`));
        assert.ok(err.message.endsWith(INSTALL_HINT));
        return true;
      }
    );
  });

  it("does not search PATH when CODEX_PATH is a non-executable file", { skip: SKIP_POSIX_ONLY }, () => {
    const plain = touch(path.join(tmp, "plain", "codex"));
    fs.chmodSync(plain, 0o644);
    const onPath = touch(path.join(tmp, "bin", "codex"));
    assert.throws(() => findCodex({ CODEX_PATH: plain, PATH: path.dirname(onPath) }, "linux"), /CODEX_PATH is set/);
  });

  it("on win32 accepts a CODEX_PATH file without the execute bit", { skip: SKIP_POSIX_ONLY }, () => {
    const file = touch(path.join(tmp, "plain", "codex.cmd"));
    fs.chmodSync(file, 0o644);
    assert.equal(findCodex({ CODEX_PATH: file }, "win32"), file);
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

  it("skips a non-executable codex file and keeps searching", { skip: SKIP_POSIX_ONLY }, () => {
    const plain = touch(path.join(tmp, "plain", "codex"));
    fs.chmodSync(plain, 0o644);
    const good = touch(path.join(tmp, "good", "codex"));
    const env = { PATH: [path.dirname(plain), path.dirname(good)].join(path.delimiter) };
    assert.equal(findCodex(env, "linux"), good);
  });

  it(
    "does not return a non-executable codex file when nothing else is found",
    { skip: SKIP_POSIX_SEARCH },
    () => {
      const plain = touch(path.join(tmp, "plain", "codex"));
      fs.chmodSync(plain, 0o644);
      useFakeHome(tmp);
      assert.throws(() => findCodex({ PATH: path.dirname(plain) }, "linux"), err => err instanceof CodexNotFoundError && /was not found/.test(err.message));
    }
  );

  it("on win32 accepts a codex.cmd without the execute bit", { skip: SKIP_POSIX_ONLY || SKIP_WIN32 }, () => {
    const file = touch(path.join(tmp, "bin", "codex.cmd"));
    fs.chmodSync(file, 0o644);
    assert.equal(findCodex({ PATH: path.dirname(file), PATHEXT: ".CMD" }, "win32"), file);
  });

  it("strips surrounding double quotes from PATH segments", () => {
    const file = touch(path.join(tmp, "bin", "codex"));
    assert.equal(findCodex({ PATH: `"${path.dirname(file)}"` }, "linux"), file);
  });

  it("trims whitespace around PATH segments", () => {
    const file = touch(path.join(tmp, "bin", "codex"));
    assert.equal(findCodex({ PATH: `  ${path.dirname(file)}  ` }, "linux"), file);
  });

  it("trims whitespace and then strips the quotes", () => {
    const file = touch(path.join(tmp, "bin", "codex"));
    assert.equal(findCodex({ PATH: `  "${path.dirname(file)}"  ` }, "linux"), file);
  });

  it("handles a quoted segment among other segments and ignores a segment of only quotes", () => {
    const file = touch(path.join(tmp, "my tools", "codex"));
    const env = { PATH: ['""', path.join(tmp, "missing"), `"${path.dirname(file)}"`].join(path.delimiter) };
    assert.equal(findCodex(env, "linux"), file);
  });

  it("on win32 strips quotes from a PATH segment with spaces", { skip: SKIP_WIN32 }, () => {
    const file = touch(path.join(tmp, "Program Files", "codex.cmd"));
    const env = { PATH: `"${path.dirname(file)}"`, PATHEXT: ".CMD" };
    assert.equal(findCodex(env, "win32"), file);
  });

  it("on WSL skips /mnt directories in PATH and finds the Linux install", { skip: SKIP_POSIX_ONLY }, t => {
    mockMntPaths(t);
    const linux = touch(path.join(tmp, "linux-bin", "codex"));
    const env = { PATH: ["/mnt/c/Users/me/AppData/Roaming/npm", path.dirname(linux)].join(path.delimiter), WSL_DISTRO_NAME: "Ubuntu" };
    assert.equal(findCodex(env, "linux"), linux);
  });

  it("without WSL variables the same /mnt directory is used", { skip: SKIP_POSIX_ONLY }, t => {
    mockMntPaths(t);
    const linux = touch(path.join(tmp, "linux-bin", "codex"));
    const env = { PATH: ["/mnt/c/Users/me/AppData/Roaming/npm", path.dirname(linux)].join(path.delimiter) };
    assert.equal(findCodex(env, "linux"), path.join("/mnt/c/Users/me/AppData/Roaming/npm", "codex"));
  });

  it("WSL_INTEROP alone also enables the /mnt skip", { skip: SKIP_POSIX_ONLY }, t => {
    mockMntPaths(t);
    const linux = touch(path.join(tmp, "linux-bin", "codex"));
    const env = { PATH: ["/mnt/c/tools", path.dirname(linux)].join(path.delimiter), WSL_INTEROP: "/run/WSL/1_interop" };
    assert.equal(findCodex(env, "linux"), linux);
  });

  it("an empty WSL_DISTRO_NAME does not enable the /mnt skip", { skip: SKIP_POSIX_ONLY }, t => {
    mockMntPaths(t);
    const env = { PATH: "/mnt/c/tools", WSL_DISTRO_NAME: "" };
    assert.equal(findCodex(env, "linux"), path.join("/mnt/c/tools", "codex"));
  });

  it("only skips /mnt on linux, not on darwin or win32 style lookups", { skip: SKIP_POSIX_ONLY }, t => {
    mockMntPaths(t);
    const env = { PATH: "/mnt/c/tools", WSL_DISTRO_NAME: "Ubuntu" };
    assert.equal(findCodex(env, "darwin"), path.join("/mnt/c/tools", "codex"));
  });

  it("on WSL also skips a /mnt directory that comes from the fallback list", { skip: SKIP_POSIX_SEARCH }, t => {
    mockMntPaths(t);
    const linux = touch(path.join(tmp, "nvm-bin", "codex"));
    const env = { PATH: "", CODEX_INSTALL_DIR: "/mnt/c/tools", NVM_BIN: path.dirname(linux), WSL_DISTRO_NAME: "Ubuntu" };
    assert.equal(findCodex(env, "linux"), linux);
    const withoutWsl = { PATH: "", CODEX_INSTALL_DIR: "/mnt/c/tools", NVM_BIN: path.dirname(linux) };
    assert.equal(findCodex(withoutWsl, "linux"), path.join("/mnt/c/tools", "codex"));
  });

  it("finds codex in CODEX_INSTALL_DIR when PATH has nothing", { skip: SKIP_POSIX_SEARCH }, () => {
    const file = touch(path.join(tmp, "install", "codex"));
    useFakeHome(tmp);
    assert.equal(findCodex({ PATH: path.join(tmp, "empty"), CODEX_INSTALL_DIR: path.dirname(file) }, "linux"), file);
  });

  it("PATH wins over CODEX_INSTALL_DIR", { skip: SKIP_POSIX_ONLY }, () => {
    const onPath = touch(path.join(tmp, "bin", "codex"));
    const install = touch(path.join(tmp, "install", "codex"));
    assert.equal(findCodex({ PATH: path.dirname(onPath), CODEX_INSTALL_DIR: path.dirname(install) }, "linux"), onPath);
  });

  it("CODEX_INSTALL_DIR wins over the home and system fallback dirs", { skip: SKIP_POSIX_SEARCH }, () => {
    const home = path.join(tmp, "home");
    useFakeHome(home);
    touch(path.join(home, ".local", "bin", "codex"));
    const install = touch(path.join(tmp, "install", "codex"));
    assert.equal(findCodex({ PATH: "", CODEX_INSTALL_DIR: path.dirname(install) }, "linux"), install);
  });

  it("on win32 finds codex.cmd in CODEX_INSTALL_DIR", { skip: SKIP_WIN32 }, () => {
    const file = touch(path.join(tmp, "install", "codex.cmd"));
    const env = { PATH: path.join(tmp, "empty"), PATHEXT: ".CMD", CODEX_INSTALL_DIR: path.dirname(file) };
    assert.equal(findCodex(env, "win32"), file);
  });

  it("on win32 finds codex.cmd in LOCALAPPDATA Programs OpenAI Codex bin", { skip: SKIP_WIN32 }, () => {
    const file = touch(path.join(tmp, "Programs", "OpenAI", "Codex", "bin", "codex.cmd"));
    const env = { PATH: path.join(tmp, "empty"), PATHEXT: ".CMD", LOCALAPPDATA: tmp };
    assert.equal(findCodex(env, "win32"), file);
  });

  it("on win32 finds codex.cmd in LOCALAPPDATA pnpm", { skip: SKIP_WIN32 }, () => {
    const file = touch(path.join(tmp, "pnpm", "codex.cmd"));
    const env = { PATH: path.join(tmp, "empty"), PATHEXT: ".CMD", LOCALAPPDATA: tmp };
    assert.equal(findCodex(env, "win32"), file);
  });

  it("on win32 finds codex.exe in the bun bin folder of the home directory", { skip: SKIP_WIN32 }, () => {
    useFakeHome(tmp);
    const file = touch(path.join(tmp, ".bun", "bin", "codex.exe"));
    const env = { PATH: path.join(tmp, "empty"), PATHEXT: ".EXE" };
    assert.equal(findCodex(env, "win32"), file);
  });

  for (const rel of [
    [".local", "bin"],
    [".npm-global", "bin"],
    [".volta", "bin"],
    [".bun", "bin"],
    [".asdf", "shims"],
    ["Library", "pnpm"],
    [".local", "share", "pnpm"],
  ]) {
    it(`finds codex in ~/${rel.join("/")}`, { skip: SKIP_POSIX_SEARCH }, () => {
      const home = path.join(tmp, "home");
      useFakeHome(home);
      const file = touch(path.join(home, ...rel, "codex"));
      assert.equal(findCodex({ PATH: "" }, "linux"), file);
    });
  }

  it("finds codex in NVM_BIN and PNPM_HOME", { skip: SKIP_POSIX_SEARCH }, () => {
    useFakeHome(path.join(tmp, "home"));
    const nvm = touch(path.join(tmp, "nvm", "codex"));
    assert.equal(findCodex({ PATH: "", NVM_BIN: path.dirname(nvm) }, "linux"), nvm);
    const pnpm = touch(path.join(tmp, "pnpm-home", "codex"));
    fs.rmSync(nvm);
    assert.equal(findCodex({ PATH: "", PNPM_HOME: path.dirname(pnpm) }, "linux"), pnpm);
  });

  it("finds codex in the nvm versions folders and prefers the newest version", { skip: SKIP_POSIX_SEARCH }, () => {
    const home = path.join(tmp, "home");
    useFakeHome(home);
    touch(path.join(home, ".nvm", "versions", "node", "v9.11.2", "bin", "codex"));
    touch(path.join(home, ".nvm", "versions", "node", "v18.20.4", "bin", "codex"));
    const newest = touch(path.join(home, ".nvm", "versions", "node", "v20.11.1", "bin", "codex"));
    assert.equal(findCodex({ PATH: "" }, "linux"), newest);
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
    useFakeHome(tmp);
    const env = { APPDATA: tmp, LOCALAPPDATA: tmp };
    assert.deepEqual(extraSearchDirs(env, "win32"), [
      NODE_DIR,
      path.join(tmp, "Programs", "OpenAI", "Codex", "bin"),
      path.join(tmp, "pnpm"),
      path.join(tmp, "Volta", "bin"),
      path.join(tmp, "npm"),
      path.join(tmp, ".bun", "bin"),
    ]);
    const posix = extraSearchDirs(env, "linux");
    assert.ok(!posix.includes(path.join(tmp, "npm")));
    assert.ok(!posix.includes(path.join(tmp, "pnpm")));
    assert.ok(!posix.includes(path.join(tmp, "Volta", "bin")));
    assert.ok(!posix.includes(path.join(tmp, "Programs", "OpenAI", "Codex", "bin")));
  });

  it("win32 without APPDATA and LOCALAPPDATA only has the node dir and the bun bin folder", () => {
    useFakeHome(tmp);
    assert.deepEqual(extraSearchDirs({}, "win32"), [NODE_DIR, path.join(tmp, ".bun", "bin")]);
  });

  it("win32 ignores the posix-only variables and folders", () => {
    useFakeHome(tmp);
    const dirs = extraSearchDirs({ NVM_BIN: "/x/nvm", PNPM_HOME: "/x/pnpm" }, "win32");
    for (const unexpected of ["/x/nvm", "/x/pnpm", "/usr/bin", "/opt/homebrew/bin", path.join(tmp, ".local", "bin")]) {
      assert.ok(!dirs.slice(1).includes(unexpected), unexpected);
    }
  });

  it("adds CODEX_INSTALL_DIR right after the node dir on every platform", () => {
    for (const platform of ["linux", "darwin", "win32"]) {
      const dirs = extraSearchDirs({ CODEX_INSTALL_DIR: "/custom/codex" }, platform);
      assert.equal(dirs[0], NODE_DIR, platform);
      assert.equal(dirs[1], "/custom/codex", platform);
    }
  });

  it("omits CODEX_INSTALL_DIR when it is unset or empty", () => {
    assert.ok(!extraSearchDirs({ CODEX_INSTALL_DIR: "" }, "linux").includes(""));
    assert.equal(extraSearchDirs({}, "linux")[1], extraSearchDirs({ CODEX_INSTALL_DIR: "" }, "linux")[1]);
  });

  it("lists the posix directories in order with NVM_BIN, PNPM_HOME and the nvm versions newest first", { skip: SKIP_POSIX_ONLY }, () => {
    const home = path.join(tmp, "home");
    useFakeHome(home);
    for (const version of ["v9.11.2", "v20.11.1", "v18.20.4"]) fs.mkdirSync(path.join(home, ".nvm", "versions", "node", version, "bin"), { recursive: true });
    const env = { CODEX_INSTALL_DIR: "/custom/codex", NVM_BIN: "/x/nvm/bin", PNPM_HOME: "/x/pnpm", npm_config_prefix: "/opt/prefix" };
    assert.deepEqual(extraSearchDirs(env, "linux"), [
      NODE_DIR,
      "/custom/codex",
      "/x/nvm/bin",
      "/x/pnpm",
      path.join(home, ".local", "bin"),
      path.join(home, ".npm-global", "bin"),
      path.join(home, ".volta", "bin"),
      path.join(home, ".bun", "bin"),
      path.join(home, ".asdf", "shims"),
      path.join(home, "Library", "pnpm"),
      path.join(home, ".local", "share", "pnpm"),
      "/opt/homebrew/bin",
      "/home/linuxbrew/.linuxbrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      path.join(home, ".nvm", "versions", "node", "v20.11.1", "bin"),
      path.join(home, ".nvm", "versions", "node", "v18.20.4", "bin"),
      path.join(home, ".nvm", "versions", "node", "v9.11.2", "bin"),
      path.join("/opt/prefix", "bin"),
    ]);
  });

  it("lists the win32 directories in order", () => {
    const home = path.join(tmp, "home");
    useFakeHome(home);
    const env = { CODEX_INSTALL_DIR: "C:\\codex", LOCALAPPDATA: "L", APPDATA: "A", npm_config_prefix: "P" };
    assert.deepEqual(extraSearchDirs(env, "win32"), [
      NODE_DIR,
      "C:\\codex",
      path.join("L", "Programs", "OpenAI", "Codex", "bin"),
      path.join("L", "pnpm"),
      path.join("L", "Volta", "bin"),
      path.join("A", "npm"),
      path.join(home, ".bun", "bin"),
      "P",
    ]);
  });

  it("skips the nvm versions when the folder does not exist", { skip: SKIP_POSIX_ONLY }, () => {
    useFakeHome(path.join(tmp, "no-nvm"));
    const dirs = extraSearchDirs({}, "linux");
    assert.equal(dirs.at(-1), "/usr/bin");
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
