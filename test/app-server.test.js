import assert from "node:assert/strict";
import { once } from "node:events";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import spawn from "cross-spawn";
import { AppServerClient, closeAppServer, CodexRpcError, getAppServer } from "../src/app-server.js";
import { CodexNotFoundError } from "../src/locate.js";
import {
  CLIENT_INFO,
  cleanup,
  closeClient,
  createClient,
  FIXTURE,
  makeCodexWrapper,
  makeTmp,
  session,
  waitFor,
  waitForNotification,
} from "./support.js";

afterEach(cleanup);

function rateNotification(snapshot) {
  return { method: "account/rateLimits/updated", params: { rateLimits: snapshot } };
}

describe("AppServerClient start", () => {
  it("initializes and exposes the server info", async () => {
    const { client, log } = await session("ok");
    const info = await client.start();
    assert.equal(info.userAgent, "mcp-gpt-image/9.9.9 (test)");
    assert.equal(info.codexHome, "/tmp");
    assert.equal(client.info, info);
    const messages = await waitFor(async () => {
      const all = await log();
      return all.some(m => m.method === "initialized") ? all : null;
    });
    const init = messages.find(m => m.method === "initialize");
    assert.deepEqual(init.params.clientInfo, CLIENT_INFO);
    assert.equal(init.params.capabilities, null);
    assert.equal(init.jsonrpc, "2.0");
    assert.equal(messages.find(m => m.method === "initialized").id, undefined);
  });

  it("parses the version from the user agent", async () => {
    const { client } = await session("ok");
    assert.equal(client.version, null);
    await client.start();
    assert.equal(client.version, "9.9.9");
  });

  it("returns null version for an unparsable user agent", () => {
    const client = createClient("ok");
    client.info = { userAgent: "" };
    assert.equal(client.version, null);
    client.info = { userAgent: "no-slash-here" };
    assert.equal(client.version, null);
  });

  it("returns the same promise on repeated start calls and spawns once", async () => {
    let spawned = 0;
    const client = new AppServerClient({
      codexPath: process.execPath,
      args: [FIXTURE],
      clientInfo: CLIENT_INFO,
      spawnImpl: (command, args, options) => {
        spawned += 1;
        return spawn(command, args, { ...options, env: { ...options.env, FAKE_SCENARIO: "ok" } });
      },
    });
    try {
      const first = client.start();
      const second = client.start();
      assert.equal(first, second);
      await first;
      assert.equal(client.start(), first);
      assert.equal(spawned, 1);
    } finally {
      await closeClient(client);
    }
  });

  it("rejects start when the executable does not exist", async () => {
    const client = new AppServerClient({
      codexPath: path.join(path.sep, "definitely", "not", "here", "codex"),
      clientInfo: CLIENT_INFO,
    });
    await assert.rejects(client.start(), /Failed to start Codex/);
    assert.equal(client.closed, true);
  });

  it("rejects start and closes when spawn throws synchronously", async () => {
    const client = new AppServerClient({
      codexPath: "codex",
      clientInfo: CLIENT_INFO,
      spawnImpl: () => {
        throw new Error("spawn exploded");
      },
    });
    await assert.rejects(client.start(), /spawn exploded/);
    assert.equal(client.closed, true);
  });

  it("rejects start when the server crashes during initialize", async () => {
    const { client } = await session("crash_init");
    await assert.rejects(client.start(), /stopped \(exit code 3/);
    assert.equal(client.closed, true);
  });
});

describe("AppServerClient request", () => {
  it("rejects when called before start", async () => {
    const client = createClient("ok");
    await assert.rejects(client.request("model/list", {}), /not running/);
    assert.equal(client.pending.size, 0);
  });

  it("resolves with the result and clears the pending entry", async () => {
    const { client } = await session("ok");
    await client.start();
    const result = await client.request("thread/unsubscribe", { threadId: "t1" });
    assert.deepEqual(result, {});
    assert.equal(client.pending.size, 0);
  });

  it("sends params as an empty object when omitted", async () => {
    const { client, log } = await session("ok");
    await client.start();
    await client.request("thread/unsubscribe");
    const sent = (await log()).find(m => m.method === "thread/unsubscribe");
    assert.deepEqual(sent.params, {});
  });

  it("rejects on timeout and stays usable afterwards", async () => {
    const { client } = await session("ok");
    await client.start();
    await assert.rejects(client.request("test/hang", {}, { timeoutMs: 80 }), /"test\/hang" timed out/);
    assert.equal(client.pending.size, 0);
    assert.equal(client.closed, false);
    const models = await client.request("model/list", {});
    assert.equal(models.data[0].id, "m-default");
  });

  it("rejects with CodexRpcError carrying code and message for error replies", async () => {
    const { client } = await session("ok");
    await client.start();
    await assert.rejects(client.request("does/not/exist", {}), err => {
      assert.ok(err instanceof CodexRpcError);
      assert.equal(err.name, "CodexRpcError");
      assert.equal(err.code, -32601);
      assert.match(err.message, /"does\/not\/exist" failed: unknown method does\/not\/exist/);
      return true;
    });
    assert.equal(client.closed, false);
  });

  it("matches concurrent responses to the right callers", async () => {
    const { client } = await session("ok");
    await client.start();
    const [models, limits, unsub] = await Promise.all([
      client.request("model/list", {}),
      client.request("account/rateLimits/read", {}),
      client.request("thread/unsubscribe", { threadId: "t1" }),
    ]);
    assert.equal(models.data[0].id, "m-default");
    assert.equal(limits.rateLimits.limitId, "codex");
    assert.deepEqual(unsub, {});
  });
});

describe("AppServerClient crash handling", () => {
  it("rejects the pending request, emits close and marks the client closed", async () => {
    const { client } = await session("crash");
    await client.start();
    const closed = once(client, "close");
    await assert.rejects(client.request("model/list", {}), /stopped \(exit code 3, signal none\)/);
    const [err] = await closed;
    assert.ok(err instanceof Error);
    assert.match(err.message, /Codex app-server stopped/);
    assert.equal(client.closed, true);
    assert.equal(client.pending.size, 0);
  });

  it("rejects every pending request when the server dies", async () => {
    const { client } = await session("crash");
    await client.start();
    const results = await Promise.allSettled([client.request("model/list", {}), client.request("test/hang", {})]);
    assert.ok(results.every(r => r.status === "rejected"));
    assert.ok(results.every(r => /stopped/.test(r.reason.message)));
  });

  it("rejects new requests after the server died", async () => {
    const { client } = await session("crash");
    await client.start();
    const closed = once(client, "close");
    await assert.rejects(client.request("model/list", {}));
    await closed;
    await assert.rejects(client.request("model/list", {}), /not running/);
  });

  it("emits close only once", async () => {
    const { client } = await session("crash");
    await client.start();
    let closes = 0;
    client.on("close", () => {
      closes += 1;
    });
    await assert.rejects(client.request("model/list", {}));
    client.close();
    client.close();
    assert.equal(closes, 1);
  });

  it("close() rejects pending requests, emits close and terminates the child", async () => {
    const { client } = await session("ok");
    await client.start();
    const child = client.child;
    const pending = client.request("test/hang", {});
    const closed = once(client, "close");
    client.close();
    await assert.rejects(pending, /was closed/);
    const [err] = await closed;
    assert.match(err.message, /was closed/);
    assert.equal(client.closed, true);
    await assert.rejects(client.request("model/list", {}), /not running/);
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
    assert.equal(child.exitCode, 0);
  });

  it("close() ends stdin, then SIGTERM after 2s, then SIGKILL after another 2s while the child stays alive", t => {
    const client = createClient("ok");
    const calls = [];
    const child = {
      exitCode: null,
      signalCode: null,
      stdin: { end: () => calls.push("stdin.end") },
      kill: signal => calls.push(signal ?? "SIGTERM"),
    };
    client.child = child;
    t.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      client.close();
      assert.deepEqual(calls, ["stdin.end"]);
      t.mock.timers.tick(1999);
      assert.deepEqual(calls, ["stdin.end"]);
      t.mock.timers.tick(1);
      assert.deepEqual(calls, ["stdin.end", "SIGTERM"]);
      t.mock.timers.tick(1999);
      assert.deepEqual(calls, ["stdin.end", "SIGTERM"]);
      t.mock.timers.tick(1);
      assert.deepEqual(calls, ["stdin.end", "SIGTERM", "SIGKILL"]);
      t.mock.timers.tick(10_000);
      assert.deepEqual(calls, ["stdin.end", "SIGTERM", "SIGKILL"]);
    } finally {
      t.mock.timers.reset();
      child.exitCode = 0;
    }
  });

  it("close() sends no signal when the child exits right after stdin ends", t => {
    const client = createClient("ok");
    const calls = [];
    const child = {
      exitCode: null,
      signalCode: null,
      stdin: {
        end: () => {
          calls.push("stdin.end");
          child.exitCode = 0;
        },
      },
      kill: signal => calls.push(signal ?? "SIGTERM"),
    };
    client.child = child;
    t.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      client.close();
      t.mock.timers.tick(10_000);
      assert.deepEqual(calls, ["stdin.end"]);
    } finally {
      t.mock.timers.reset();
    }
  });

  it("close() skips SIGKILL when the child dies after SIGTERM", t => {
    const client = createClient("ok");
    const calls = [];
    const child = {
      exitCode: null,
      signalCode: null,
      stdin: { end: () => calls.push("stdin.end") },
      kill: signal => {
        calls.push(signal ?? "SIGTERM");
        child.signalCode = "SIGTERM";
      },
    };
    client.child = child;
    t.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      client.close();
      t.mock.timers.tick(2000);
      t.mock.timers.tick(10_000);
      assert.deepEqual(calls, ["stdin.end", "SIGTERM"]);
    } finally {
      t.mock.timers.reset();
      child.signalCode = null;
      child.exitCode = 0;
    }
  });

  it("close() does not touch a child that already exited", t => {
    const client = createClient("ok");
    const calls = [];
    client.child = { exitCode: 0, signalCode: null, stdin: { end: () => calls.push("stdin.end") }, kill: () => calls.push("kill") };
    t.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      client.close();
      t.mock.timers.tick(10_000);
      assert.deepEqual(calls, []);
    } finally {
      t.mock.timers.reset();
    }
  });

  it("close() on a client that never started is safe", () => {
    const client = createClient("ok");
    let closes = 0;
    client.on("close", () => {
      closes += 1;
    });
    client.close();
    assert.equal(client.closed, true);
    assert.equal(closes, 1);
  });

  it(
    "a server request arriving after close does not throw",
    async () => {
      const { client } = await session("ok");
      await client.start();
      const stdout = client.child.stdout;
      client.close();
      const line = `${JSON.stringify({ jsonrpc: "2.0", id: "late1", method: "item/commandExecution/requestApproval", params: {} })}\n`;
      assert.doesNotThrow(() => stdout.emit("data", Buffer.from(line)));
    }
  );

  it(
    "start() after close() does not spawn a child process",
    async () => {
      let spawned = 0;
      const children = [];
      const client = new AppServerClient({
        codexPath: process.execPath,
        args: [FIXTURE],
        clientInfo: CLIENT_INFO,
        spawnImpl: (command, args, options) => {
          spawned += 1;
          const child = spawn(command, args, { ...options, env: { ...options.env, FAKE_SCENARIO: "ok" } });
          children.push(child);
          return child;
        },
      });
      client.close();
      try {
        await client.start().catch(() => {});
        assert.equal(spawned, 0);
      } finally {
        for (const child of children) {
          try {
            child.stdin.end();
            child.kill("SIGKILL");
          } catch {}
        }
        await Promise.all(children.map(child => (child.exitCode === null && child.signalCode === null ? once(child, "exit") : null)));
      }
    }
  );
});

describe("AppServerClient server requests", () => {
  it("declines approval requests and errors on unknown methods", async () => {
    const { client, log } = await session("server_request");
    await client.start();
    const completed = waitForNotification(client, m => m.method === "turn/completed");
    await client.request("turn/start", { threadId: "t1", input: [{ type: "text", text: "hi", text_elements: [] }] });
    const turn = (await completed).params.turn;
    assert.equal(turn.status, "completed");
    assert.equal(turn.error, null);
    const messages = await log();
    const approval = messages.find(m => m.id === "srv1");
    assert.deepEqual(approval, { jsonrpc: "2.0", id: "srv1", result: { decision: "decline" } });
    const unknown = messages.find(m => m.id === "srv2");
    assert.equal(unknown.jsonrpc, "2.0");
    assert.equal(unknown.result, undefined);
    assert.equal(unknown.error.code, -32601);
    assert.match(unknown.error.message, /does not handle "item\/nonexistent\/method"/);
  });

  it("does not surface server requests as notifications", async () => {
    const { client } = await session("server_request");
    await client.start();
    const methods = [];
    client.on("notification", m => methods.push(m.method));
    const completed = waitForNotification(client, m => m.method === "turn/completed");
    await client.request("turn/start", { threadId: "t1", input: [{ type: "text", text: "hi", text_elements: [] }] });
    await completed;
    assert.ok(!methods.includes("item/commandExecution/requestApproval"));
    assert.ok(!methods.includes("item/nonexistent/method"));
  });
});

describe("AppServerClient notifications", () => {
  it("emits notifications with method and params", async () => {
    const { client } = await session("ok");
    await client.start();
    const received = [];
    client.on("notification", m => received.push(m));
    await client.request("test/emit", { notifications: [{ method: "custom/event", params: { a: 1 } }] });
    assert.deepEqual(received, [{ method: "custom/event", params: { a: 1 } }]);
  });

  it("ignores malformed lines and keeps working", async () => {
    const { client } = await session("ok");
    await client.start();
    const received = [];
    client.on("notification", m => received.push(m.method));
    await client.request("test/emit", {
      raw: ["not json at all", "[1,2,3]", "42", "null", "{\"id\":null}"],
      notifications: [{ method: "after/garbage", params: {} }],
    });
    assert.deepEqual(received, ["after/garbage"]);
    assert.equal(client.closed, false);
    assert.match(client.stderrTail(), /not json at all/);
  });

  it("keeps non-JSON stdout lines in the stderr tail with ANSI codes stripped", async () => {
    const { client } = await session("ok");
    await client.start();
    await client.request("test/emit", { raw: ["\u001b[31mred text\u001b[0m"] });
    const tail = client.stderrTail();
    assert.ok(tail.includes("red text"));
    assert.ok(!tail.includes("\u001b"));
  });

  it("collects real stderr output", async () => {
    const { client } = await session("ok");
    await client.start();
    assert.equal(client.stderrTail(), "");
    await client.request("test/stderr", { text: "warning from codex" });
    await waitFor(() => client.stderrTail().includes("warning from codex"), { label: "stderr line" });
    assert.match(client.stderrTail(), /Codex stderr \(last lines\):\nwarning from codex/);
  });

  it("keeps only the last 30 stderr lines and shows the last 10", async () => {
    const { client } = await session("ok");
    await client.start();
    const raw = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    await client.request("test/emit", { raw });
    assert.equal(client.stderrLines.length, 30);
    assert.equal(client.stderrLines[0], "line 10");
    const shown = client.stderrTail().split("\n").filter(l => l.startsWith("line "));
    assert.deepEqual(shown, raw.slice(-10));
  });

  it("survives a throwing notification handler", async () => {
    const { client } = await session("ok");
    await client.start();
    client.on("notification", () => {
      throw new Error("handler blew up");
    });
    await client.request("test/emit", { notifications: [{ method: "custom/event", params: {} }] });
    assert.equal(client.closed, false);
    assert.match(client.stderrTail(), /notification handler error: handler blew up/);
    const models = await client.request("model/list", {});
    assert.equal(models.data.length, 1);
  });
});

describe("AppServerClient rate limits", () => {
  it("stores the snapshot from a rateLimits/updated notification", async () => {
    const { client } = await session("ok");
    await client.start();
    assert.equal(client.rateLimitsUpdatedAt, 0);
    assert.deepEqual(client.rateLimitSnapshots(), []);
    const before = Date.now();
    await client.request("test/emit", {
      notifications: [rateNotification({ limitId: "codex", primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1 }, planType: "plus" })],
    });
    const [snap] = client.rateLimitSnapshots();
    assert.equal(snap.limitId, "codex");
    assert.equal(snap.primary.usedPercent, 10);
    assert.equal(snap.planType, "plus");
    assert.ok(client.rateLimitsUpdatedAt >= before);
  });

  it("merges a sparse update and keeps the previous secondary window", async () => {
    const { client } = await session("ok");
    await client.start();
    await client.request("test/emit", {
      notifications: [
        rateNotification({
          limitId: "codex",
          primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1 },
          secondary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 2 },
          planType: "plus",
        }),
        rateNotification({
          limitId: "codex",
          primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: 3 },
          secondary: null,
          planType: null,
        }),
      ],
    });
    const snaps = client.rateLimitSnapshots();
    assert.equal(snaps.length, 1);
    assert.equal(snaps[0].primary.usedPercent, 50);
    assert.equal(snaps[0].primary.resetsAt, 3);
    assert.equal(snaps[0].secondary.usedPercent, 5);
    assert.equal(snaps[0].secondary.windowDurationMins, 10080);
    assert.equal(snaps[0].planType, "plus");
  });

  it("keeps previous fields when the update omits them", async () => {
    const { client } = await session("ok");
    await client.start();
    await client.request("test/emit", {
      notifications: [
        rateNotification({ limitId: "codex", secondary: { usedPercent: 5, windowDurationMins: 10080 }, planType: "plus" }),
        rateNotification({ limitId: "codex", primary: { usedPercent: 20, windowDurationMins: 300 } }),
      ],
    });
    const [snap] = client.rateLimitSnapshots();
    assert.equal(snap.primary.usedPercent, 20);
    assert.equal(snap.secondary.usedPercent, 5);
    assert.equal(snap.planType, "plus");
  });

  it("keeps separate snapshots per limitId and defaults the key to codex", async () => {
    const { client } = await session("ok");
    await client.start();
    await client.request("test/emit", {
      notifications: [
        rateNotification({ primary: { usedPercent: 1, windowDurationMins: 300 } }),
        rateNotification({ limitId: "images", primary: { usedPercent: 2, windowDurationMins: 1440 } }),
        rateNotification({ limitId: "codex", primary: { usedPercent: 3, windowDurationMins: 300 } }),
      ],
    });
    const snaps = client.rateLimitSnapshots();
    assert.equal(snaps.length, 2);
    assert.equal(snaps.find(s => s.limitId === "images").primary.usedPercent, 2);
    assert.equal(snaps.find(s => s.limitId !== "images").primary.usedPercent, 3);
  });

  it("ignores invalid rateLimits payloads", async () => {
    const { client } = await session("ok");
    await client.start();
    await client.request("test/emit", {
      notifications: [
        { method: "account/rateLimits/updated", params: { rateLimits: null } },
        { method: "account/rateLimits/updated", params: { rateLimits: "garbage" } },
        { method: "account/rateLimits/updated", params: {} },
        { method: "account/rateLimits/updated" },
      ],
    });
    assert.deepEqual(client.rateLimitSnapshots(), []);
    assert.equal(client.rateLimitsUpdatedAt, 0);
    assert.equal(client.closed, false);
  });

  it("also forwards the rateLimits/updated notification to listeners", async () => {
    const { client } = await session("ok");
    await client.start();
    const seen = [];
    client.on("notification", m => seen.push(m.method));
    await client.request("test/emit", { notifications: [rateNotification({ limitId: "codex" })] });
    assert.deepEqual(seen, ["account/rateLimits/updated"]);
  });

  it("readRateLimits returns the snapshot from rateLimits", async () => {
    const { client } = await session("ok");
    await client.start();
    const snaps = await client.readRateLimits();
    assert.equal(snaps.length, 1);
    assert.equal(snaps[0].limitId, "codex");
    assert.equal(snaps[0].primary.usedPercent, 10);
    assert.equal(snaps[0].primary.windowDurationMins, 300);
    assert.equal(snaps[0].secondary.windowDurationMins, 10080);
    assert.equal(snaps[0].planType, "plus");
    assert.deepEqual(client.rateLimitSnapshots(), snaps);
  });

  it("readRateLimits prefers rateLimitsByLimitId when present", async () => {
    const { client } = await session("ok", { FAKE_RL_BY_ID: "1" });
    await client.start();
    const snaps = await client.readRateLimits();
    assert.deepEqual(snaps.map(s => s.limitId).sort(), ["codex", "images"]);
  });

  it("readRateLimits drops stale buckets from earlier notifications", async () => {
    const { client } = await session("ok");
    await client.start();
    await client.request("test/emit", { notifications: [rateNotification({ limitId: "stale", primary: { usedPercent: 99, windowDurationMins: 60 } })] });
    assert.deepEqual(client.rateLimitSnapshots().map(s => s.limitId), ["stale"]);
    const snaps = await client.readRateLimits();
    assert.deepEqual(snaps.map(s => s.limitId), ["codex"]);
  });

  it("readRateLimits discards its result when a rateLimits/updated notification arrived after the request was sent", async () => {
    const { client } = await session("ok", { FAKE_RL_NOTIFY_BEFORE_REPLY: "1" });
    await client.start();
    const snaps = await client.readRateLimits();
    assert.deepEqual(snaps.map(s => s.limitId), ["fresh"]);
    assert.equal(snaps[0].primary.usedPercent, 77);
    assert.deepEqual(client.rateLimitSnapshots(), snaps);
    assert.ok(!client.rateLimitSnapshots().some(s => s.limitId === "codex"));
  });

  it("readRateLimits keeps merging later notifications into the discarded-read result", async () => {
    const { client } = await session("ok", { FAKE_RL_NOTIFY_BEFORE_REPLY: "1" });
    await client.start();
    await client.readRateLimits();
    await client.request("test/emit", {
      notifications: [rateNotification({ limitId: "fresh", secondary: { usedPercent: 3, windowDurationMins: 10080 } })],
    });
    const [snap] = client.rateLimitSnapshots();
    assert.equal(snap.primary.usedPercent, 77);
    assert.equal(snap.secondary.usedPercent, 3);
  });

  it("readRateLimits applies its result when the only notification arrived before the request", async () => {
    const { client } = await session("ok");
    await client.start();
    await client.request("test/emit", { notifications: [rateNotification({ limitId: "older", primary: { usedPercent: 1, windowDurationMins: 60 } })] });
    await new Promise(resolve => setTimeout(resolve, 5));
    const snaps = await client.readRateLimits();
    assert.deepEqual(snaps.map(s => s.limitId), ["codex"]);
  });

  it("readRateLimits leaves the previous snapshots untouched when the request fails", async () => {
    const { client } = await session("ok", { FAKE_RL_ERROR: "1" });
    await client.start();
    await client.request("test/emit", { notifications: [rateNotification({ limitId: "keep", primary: { usedPercent: 12, windowDurationMins: 300 } })] });
    const updatedAt = client.rateLimitsUpdatedAt;
    await assert.rejects(client.readRateLimits(), err => err instanceof CodexRpcError && /rate limits unavailable/.test(err.message));
    assert.deepEqual(client.rateLimitSnapshots().map(s => s.limitId), ["keep"]);
    assert.equal(client.rateLimitSnapshots()[0].primary.usedPercent, 12);
    assert.equal(client.rateLimitsUpdatedAt, updatedAt);
  });

  it("readRateLimits builds a new map instead of mutating the old one", async () => {
    const { client } = await session("ok");
    await client.start();
    await client.request("test/emit", { notifications: [rateNotification({ limitId: "old", primary: { usedPercent: 1, windowDurationMins: 60 } })] });
    const before = client.rateLimits;
    await client.readRateLimits();
    assert.notEqual(client.rateLimits, before);
    assert.deepEqual([...before.keys()], ["old"]);
    assert.deepEqual([...client.rateLimits.keys()], ["codex"]);
  });

  it("readRateLimits updates rateLimitsUpdatedAt", async () => {
    const { client } = await session("ok");
    await client.start();
    const before = Date.now();
    await client.readRateLimits();
    assert.ok(client.rateLimitsUpdatedAt >= before);
  });
});

describe("AppServerClient listModels", () => {
  it("returns the model list", async () => {
    const { client } = await session("ok");
    await client.start();
    const models = await client.listModels();
    assert.equal(models.length, 1);
    assert.equal(models[0].id, "m-default");
    assert.equal(models[0].isDefault, true);
  });

  it("caches the result and sends a single model/list request", async () => {
    const { client, log } = await session("ok");
    await client.start();
    const first = client.listModels();
    const second = client.listModels();
    const third = await client.listModels();
    assert.equal(await first, await second);
    assert.equal(await first, third);
    const requests = (await log()).filter(m => m.method === "model/list");
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].params, { cursor: null, includeHidden: false });
  });

  it("follows nextCursor across pages", async () => {
    const { client, log } = await session("ok", { FAKE_PAGES: "3" });
    await client.start();
    const models = await client.listModels();
    assert.deepEqual(models.map(m => m.id), ["m-default", "m-page2", "m-page3"]);
    const requests = (await log()).filter(m => m.method === "model/list");
    assert.deepEqual(requests.map(r => r.params.cursor), [null, "2", "3"]);
  });

  it("stops when a page comes back empty even though a cursor is returned", async () => {
    const { client, log } = await session("ok", { FAKE_PAGES: "5", FAKE_EMPTY_PAGE: "1" });
    await client.start();
    const models = await client.listModels();
    assert.deepEqual(models, []);
    const requests = (await log()).filter(m => m.method === "model/list");
    assert.equal(requests.length, 1);
  });

  it("keeps the models gathered so far when a later page is empty", async () => {
    const { client, log } = await session("ok", { FAKE_PAGES: "5", FAKE_EMPTY_PAGE: "3" });
    await client.start();
    const models = await client.listModels();
    assert.deepEqual(models.map(m => m.id), ["m-default", "m-page2"]);
    const requests = (await log()).filter(m => m.method === "model/list");
    assert.deepEqual(requests.map(r => r.params.cursor), [null, "2", "3"]);
  });

  it("stops after 50 pages even if the server keeps returning a cursor", async () => {
    const { client, log } = await session("ok", { FAKE_PAGES: "1000", FAKE_DELAY_MS: "1" });
    await client.start();
    const models = await client.listModels();
    assert.equal(models.length, 50);
    assert.equal(models.at(-1).id, "m-page50");
    const requests = (await log()).filter(m => m.method === "model/list");
    assert.equal(requests.length, 50);
    assert.equal(requests.at(-1).params.cursor, "50");
  });

  it("does not cache a failure and retries on the next call", async () => {
    const { client } = await session("ok", { FAKE_MODEL_FAIL_ONCE: "1" });
    await client.start();
    await assert.rejects(client.listModels(), err => err instanceof CodexRpcError && /model list unavailable/.test(err.message));
    const models = await client.listModels();
    assert.equal(models[0].id, "m-default");
  });
});

describe("getAppServer and closeAppServer", () => {
  const savedEnv = {};

  function setEnv(values) {
    for (const [key, value] of Object.entries(values)) {
      if (!(key in savedEnv)) savedEnv[key] = process.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  function restoreEnv() {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
      delete savedEnv[key];
    }
  }

  afterEach(async () => {
    closeAppServer();
    restoreEnv();
  });

  it("starts the located codex, reuses the instance and creates a new one after close", { skip: process.platform === "win32" }, async () => {
    const dir = await makeTmp();
    setEnv({ CODEX_PATH: await makeCodexWrapper(dir), FAKE_SCENARIO: "ok" });
    const first = await getAppServer(CLIENT_INFO);
    assert.equal(first.version, "9.9.9");
    assert.equal(first.closed, false);
    const second = await getAppServer(CLIENT_INFO);
    assert.equal(second, first);
    const child = first.child;
    closeAppServer();
    assert.equal(first.closed, true);
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
    const third = await getAppServer(CLIENT_INFO);
    assert.notEqual(third, first);
    assert.equal(third.closed, false);
    await closeClient(third);
  });

  it("creates a fresh client after the previous one crashed", { skip: process.platform === "win32" }, async () => {
    const dir = await makeTmp();
    setEnv({ CODEX_PATH: await makeCodexWrapper(dir), FAKE_SCENARIO: "crash" });
    const first = await getAppServer(CLIENT_INFO);
    const closed = once(first, "close");
    await assert.rejects(first.request("model/list", {}));
    await closed;
    setEnv({ FAKE_SCENARIO: "ok" });
    const second = await getAppServer(CLIENT_INFO);
    assert.notEqual(second, first);
    const models = await second.listModels();
    assert.equal(models[0].id, "m-default");
    await closeClient(second);
  });

  it("rejects and recovers when the first start fails", { skip: process.platform === "win32" }, async () => {
    const dir = await makeTmp();
    setEnv({ CODEX_PATH: await makeCodexWrapper(dir), FAKE_SCENARIO: "crash_init" });
    await assert.rejects(getAppServer(CLIENT_INFO), /stopped \(exit code 3/);
    setEnv({ FAKE_SCENARIO: "ok" });
    const client = await getAppServer(CLIENT_INFO);
    assert.equal(client.version, "9.9.9");
    await closeClient(client);
  });

  it("rejects with CodexNotFoundError when CODEX_PATH is invalid", async () => {
    setEnv({ CODEX_PATH: path.join(path.sep, "no", "such", "codex") });
    await assert.rejects(getAppServer(CLIENT_INFO), CodexNotFoundError);
  });

  it("closeAppServer is safe with no active client", () => {
    closeAppServer();
    closeAppServer();
  });
});
