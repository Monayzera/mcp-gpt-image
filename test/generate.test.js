import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { buildInstructions, chooseEffort, generateImages, TURN_TIMEOUT_MS, validateModel } from "../src/generate.js";
import { makeGif, makeJpeg, makePng } from "./fixtures/images.js";
import { cleanup, makeTmp, session, waitFor } from "./support.js";

afterEach(cleanup);

async function setup(scenario, env) {
  const s = await session(scenario, env);
  await s.client.start();
  return s;
}

function gen(s, params, extra = {}) {
  return generateImages({ client: s.client, params, baseDir: s.base, ...extra });
}

async function sentTo(s, method) {
  return (await s.log()).filter(m => m.method === method);
}

async function waitUnsubscribed(s) {
  await waitFor(async () => (await sentTo(s, "thread/unsubscribe")).length > 0, { label: "thread/unsubscribe" });
}

describe("buildInstructions", () => {
  const base = { mode: "exact", count: 1, transparent: false, hasReferences: false };

  it("exact mode demands a verbatim prompt and a single call", () => {
    const text = buildInstructions(base);
    assert.ok(text.includes("verbatim"));
    assert.ok(text.includes("exactly once"));
    assert.ok(text.includes("copied verbatim, character for character"));
    assert.ok(!text.includes("rewrite"));
  });

  it("states the number of calls when count is greater than 1", () => {
    const text = buildInstructions({ ...base, count: 3 });
    assert.ok(text.includes("exactly 3 times"));
    assert.ok(text.includes("one separate call per image"));
    assert.ok(!text.includes("exactly once"));
  });

  it("enhance mode asks for a rewrite and does not demand verbatim copying", () => {
    const text = buildInstructions({ ...base, mode: "enhance" });
    assert.ok(text.includes("rewrite"));
    assert.ok(text.includes("Step 1"));
    assert.ok(text.includes("Step 2"));
    assert.ok(!text.includes("verbatim"));
  });

  it("enhance mode also carries the count wording", () => {
    const text = buildInstructions({ ...base, mode: "enhance", count: 2 });
    assert.ok(text.includes("exactly 2 times"));
  });

  it("sets transparent_background to true or false", () => {
    assert.ok(buildInstructions({ ...base, transparent: true }).includes("transparent_background to true"));
    assert.ok(buildInstructions({ ...base, transparent: false }).includes("transparent_background to false"));
  });

  it("mentions attached images only when references exist", () => {
    const without = buildInstructions(base);
    const withRefs = buildInstructions({ ...base, hasReferences: true });
    assert.ok(!without.includes("attached images"));
    assert.ok(withRefs.includes("attached images"));
    assert.ok(withRefs.includes("Do not describe them"));
  });

  it("always ends with the rules block", () => {
    for (const mode of ["exact", "enhance"]) {
      const text = buildInstructions({ ...base, mode });
      assert.ok(text.includes("Rules:"));
      assert.ok(text.includes("reply with the single word DONE"));
      assert.ok(text.includes("Do not load or follow any skill"));
      assert.ok(text.trimEnd().endsWith("one short sentence explaining why."));
    }
  });

  it("treats an unknown mode as exact", () => {
    assert.ok(buildInstructions({ ...base, mode: "whatever" }).includes("verbatim"));
  });
});

describe("validateModel", () => {
  const models = [
    { id: "a", model: "a", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }] },
    { id: "b-id", model: "b-alias", isDefault: false, supportedReasoningEfforts: ["medium"] },
  ];
  const stub = { listModels: async () => models };

  it("skips the lookup when no model is requested", async () => {
    const client = {
      listModels: async () => {
        throw new Error("must not be called");
      },
    };
    await validateModel(client, undefined);
    await validateModel(client, "");
  });

  it("accepts a known id or model alias", async () => {
    await validateModel(stub, "a");
    await validateModel(stub, "b-id");
    await validateModel(stub, "b-alias");
  });

  it("rejects an unknown model and lists the available ones with efforts", async () => {
    await assert.rejects(validateModel(stub, "zzz"), err => {
      assert.match(err.message, /Unknown Codex model "zzz"/);
      assert.ok(err.message.includes("a (default): low, high"));
      assert.ok(err.message.includes("b-id: medium"));
      return true;
    });
  });

  it("skips validation when listModels fails", async () => {
    let calls = 0;
    const client = {
      listModels: async () => {
        calls += 1;
        throw new Error("list failed");
      },
    };
    await validateModel(client, "anything");
    assert.equal(calls, 1);
  });

  it("skips validation when the model list is empty or missing", async () => {
    await validateModel({ listModels: async () => [] }, "anything");
    await validateModel({ listModels: async () => null }, "anything");
    await validateModel({ listModels: async () => undefined }, "anything");
  });

  it("still rejects an unknown model when the list has a single entry", async () => {
    const single = { listModels: async () => [models[0]] };
    await assert.rejects(validateModel(single, "zzz"), /Unknown Codex model "zzz"[\s\S]*a \(default\): low, high/);
  });
});

describe("chooseEffort", () => {
  const object = efforts => efforts.map(reasoningEffort => ({ reasoningEffort, description: "" }));
  const stub = models => ({ listModels: async () => models });
  const lowHigh = stub([{ id: "m", model: "m", supportedReasoningEfforts: object(["low", "high"]) }]);

  it("returns a supported requested effort", async () => {
    assert.equal(await chooseEffort(lowHigh, "m", "high", "exact"), "high");
    assert.equal(await chooseEffort(lowHigh, "m", "low", "enhance"), "low");
  });

  it("rejects an unsupported requested effort and names the supported ones", async () => {
    await assert.rejects(chooseEffort(lowHigh, "m", "xhigh", "exact"), err => {
      assert.match(err.message, /Model "m" does not support reasoning_effort "xhigh"/);
      assert.match(err.message, /Supported: low, high/);
      return true;
    });
  });

  it("defaults to low in exact mode when the model supports it", async () => {
    assert.equal(await chooseEffort(lowHigh, "m", undefined, "exact"), "low");
  });

  it("returns null in exact mode when the model does not support low", async () => {
    const medium = stub([{ id: "m", model: "m", supportedReasoningEfforts: object(["medium", "high"]) }]);
    assert.equal(await chooseEffort(medium, "m", undefined, "exact"), null);
  });

  it("returns null in enhance mode so the Codex default applies", async () => {
    assert.equal(await chooseEffort(lowHigh, "m", undefined, "enhance"), null);
  });

  it("accepts efforts expressed as plain strings", async () => {
    const strings = stub([{ id: "m", model: "m", supportedReasoningEfforts: ["low", "medium"] }]);
    assert.equal(await chooseEffort(strings, "m", undefined, "exact"), "low");
    await assert.rejects(chooseEffort(strings, "m", "high", "exact"), /does not support/);
  });

  it("finds the model through its model alias", async () => {
    const aliased = stub([{ id: "x", model: "alias", supportedReasoningEfforts: object(["low"]) }]);
    await assert.rejects(chooseEffort(aliased, "alias", "high", "exact"), /does not support/);
  });

  it("passes a requested effort through when the model is not in the list", async () => {
    assert.equal(await chooseEffort(lowHigh, "other", "xhigh", "exact"), "xhigh");
    assert.equal(await chooseEffort(lowHigh, null, "high", "exact"), "high");
  });

  it("returns null when the model is unknown and nothing was requested", async () => {
    assert.equal(await chooseEffort(lowHigh, "other", undefined, "exact"), null);
  });

  it("falls back gracefully when the model list cannot be read", async () => {
    const broken = {
      listModels: async () => {
        throw new Error("nope");
      },
    };
    assert.equal(await chooseEffort(broken, "m", "high", "exact"), "high");
    assert.equal(await chooseEffort(broken, "m", undefined, "exact"), null);
  });
});

describe("generateImages success", () => {
  it("saves one verbatim image under baseDir/generated-images", async () => {
    const s = await setup("ok");
    const result = await gen(s, { prompt: "A red fox" });

    assert.equal(result.images.length, 1);
    assert.equal(result.requested, 1);
    assert.deepEqual(result.failures, []);
    assert.equal(result.model, "m-default");
    assert.equal(result.effort, "low");
    assert.equal(result.mode, "exact");
    assert.equal(result.transparent, false);
    assert.ok(!("turnStatus" in result));
    assert.ok(!("codexPath" in result));
    assert.equal(typeof result.durationMs, "number");
    assert.ok(result.durationMs >= 0);

    const img = result.images[0];
    assert.equal(path.dirname(img.path), path.join(s.base, "generated-images"));
    assert.match(path.basename(img.path), /^\d{4}-\d{2}-\d{2}_\d{6}_a-red-fox\.png$/);
    assert.equal(img.mimeType, "image/png");
    assert.deepEqual(img.size, { width: 3, height: 2 });
    assert.equal(img.verbatim, true);
    assert.equal(img.revisedPrompt, "A red fox");
    assert.equal(img.alpha, false);
    assert.ok(!("codexPath" in img));

    const onDisk = await fs.readFile(img.path);
    assert.deepEqual(onDisk, makePng(3, 2));
    assert.equal(img.bytes, onDisk.length);
    assert.equal(img.data, onDisk.toString("base64"));
  });

  it("sends the expected thread and turn requests", async () => {
    const s = await setup("ok");
    await gen(s, { prompt: "A red fox" });

    const [thread] = await sentTo(s, "thread/start");
    assert.equal(thread.params.ephemeral, true);
    assert.equal(thread.params.sandbox, "read-only");
    assert.equal(thread.params.approvalPolicy, "never");
    assert.equal(thread.params.cwd, os.tmpdir());
    assert.ok(thread.params.developerInstructions.includes("verbatim"));
    assert.ok(thread.params.developerInstructions.includes("exactly once"));
    assert.ok(!("model" in thread.params));

    const [turn] = await sentTo(s, "turn/start");
    assert.equal(turn.params.threadId, "t1");
    assert.deepEqual(turn.params.input, [{ type: "text", text: "A red fox", text_elements: [] }]);
    assert.equal(turn.params.effort, "low");
  });

  it("always unsubscribes the thread afterwards", async () => {
    const s = await setup("ok");
    await gen(s, { prompt: "A red fox" });
    await waitUnsubscribed(s);
    const [unsub] = await sentTo(s, "thread/unsubscribe");
    assert.deepEqual(unsub.params, { threadId: "t1" });
  });

  it("flags a prompt that Codex altered", async () => {
    const s = await setup("altered");
    const result = await gen(s, { prompt: "A red fox" });
    const img = result.images[0];
    assert.equal(img.verbatim, false);
    assert.equal(img.revisedPrompt, "A red fox -- rewritten");
  });

  it("treats a line ending only difference as verbatim", async () => {
    const s = await setup("ok", { FAKE_REVISED: "line one\nline two\nline three" });
    const prompt = "line one\r\nline two\rline three";
    const result = await gen(s, { prompt });
    assert.equal(result.images[0].verbatim, true);
    const [turn] = await sentTo(s, "turn/start");
    assert.equal(turn.params.input[0].text, prompt);
  });

  it("flags a trailing space as a difference", async () => {
    const s = await setup("ok", { FAKE_REVISED: "A red fox" });
    const result = await gen(s, { prompt: "A red fox " });
    assert.equal(result.images[0].verbatim, false);
    assert.equal(result.images[0].revisedPrompt, "A red fox");
  });

  it("flags leading whitespace and a trailing newline as differences", async () => {
    const leading = await setup("ok", { FAKE_REVISED: "A red fox" });
    assert.equal((await gen(leading, { prompt: "  A red fox" })).images[0].verbatim, false);
    const trailing = await setup("ok", { FAKE_REVISED: "A red fox" });
    assert.equal((await gen(trailing, { prompt: "A red fox\n" })).images[0].verbatim, false);
  });

  it("keeps outer whitespace in the prompt sent to Codex and reports verbatim when Codex echoes it", async () => {
    const s = await setup("ok");
    const prompt = "  A red fox \n";
    const result = await gen(s, { prompt });
    assert.equal(result.images[0].verbatim, true);
    const [turn] = await sentTo(s, "turn/start");
    assert.equal(turn.params.input[0].text, prompt);
  });

  it("reports verbatim null when Codex returns no revised prompt", async () => {
    const s = await setup("norevised");
    const result = await gen(s, { prompt: "A red fox" });
    assert.equal(result.images[0].revisedPrompt, null);
    assert.equal(result.images[0].verbatim, null);
  });

  it("saves two images with _1 and _2 suffixes for count 2", async () => {
    const s = await setup("count2");
    const result = await gen(s, { prompt: "Two foxes", count: 2 });
    assert.equal(result.requested, 2);
    assert.equal(result.images.length, 2);
    const names = result.images.map(i => path.basename(i.path));
    assert.match(names[0], /^\d{4}-\d{2}-\d{2}_\d{6}_two-foxes_1\.png$/);
    assert.match(names[1], /^\d{4}-\d{2}-\d{2}_\d{6}_two-foxes_2\.png$/);
    for (const img of result.images) assert.deepEqual(await fs.readFile(img.path), makePng(3, 2));
    const [thread] = await sentTo(s, "thread/start");
    assert.ok(thread.params.developerInstructions.includes("exactly 2 times"));
  });

  it("ignores notifications that belong to another thread", async () => {
    const s = await setup("foreign_thread");
    const result = await gen(s, { prompt: "A red fox" });
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].revisedPrompt, "A red fox");
    assert.ok(!("turnStatus" in result));
  });

  it("declines server requests and still completes", async () => {
    const s = await setup("server_request");
    const result = await gen(s, { prompt: "A red fox" });
    assert.equal(result.images.length, 1);
    const log = await s.log();
    assert.deepEqual(log.find(m => m.id === "srv1").result, { decision: "decline" });
    assert.ok(log.find(m => m.id === "srv2").error);
  });

  it("reads the image from savedPath when the result has no data", async () => {
    const dir = await makeTmp();
    const saved = path.join(dir, "codex-made.png");
    await fs.writeFile(saved, makePng(5, 4));
    const s = await setup("savedpath", { FAKE_SAVED_PATH: saved });
    const result = await gen(s, { prompt: "A red fox" });
    const img = result.images[0];
    assert.ok(!("codexPath" in img));
    assert.deepEqual(img.size, { width: 5, height: 4 });
    assert.equal(img.alpha, false);
    assert.deepEqual(await fs.readFile(img.path), makePng(5, 4));
    assert.notEqual(img.path, saved);
  });

  it("exposes the turn timeout constant", () => {
    assert.equal(TURN_TIMEOUT_MS, 15 * 60_000);
  });
});

describe("generateImages alpha and transparent", () => {
  it("echoes transparent true and detects an RGBA png", async () => {
    const s = await setup("ok", { FAKE_PNG_COLOR_TYPE: "6" });
    const result = await gen(s, { prompt: "x", transparent_background: true });
    assert.equal(result.transparent, true);
    assert.equal(result.images[0].alpha, true);
    assert.deepEqual(await fs.readFile(result.images[0].path), makePng(3, 2, { colorType: 6 }));
  });

  it("detects a missing alpha channel on an RGB png", async () => {
    const s = await setup("ok");
    const result = await gen(s, { prompt: "x", transparent_background: true });
    assert.equal(result.transparent, true);
    assert.equal(result.images[0].alpha, false);
  });

  it("detects alpha from a tRNS chunk on an RGB png", async () => {
    const s = await setup("ok", { FAKE_PNG_TRNS: "1" });
    const result = await gen(s, { prompt: "x", transparent_background: true });
    assert.equal(result.images[0].alpha, true);
  });

  it("reports alpha null for a jpeg and saves it with the jpg extension", async () => {
    const s = await setup("ok", { FAKE_IMAGE_FORMAT: "jpeg" });
    const result = await gen(s, { prompt: "x", transparent_background: true });
    const img = result.images[0];
    assert.equal(img.alpha, null);
    assert.equal(img.mimeType, "image/jpeg");
    assert.equal(path.extname(img.path), ".jpg");
    assert.deepEqual(img.size, { width: 3, height: 2 });
    assert.deepEqual(await fs.readFile(img.path), makeJpeg(3, 2));
  });

  it("reports transparent false by default", async () => {
    const s = await setup("ok", { FAKE_PNG_COLOR_TYPE: "6" });
    const result = await gen(s, { prompt: "x" });
    assert.equal(result.transparent, false);
    assert.equal(result.images[0].alpha, true);
  });

  it("reads alpha from the image taken from savedPath", async () => {
    const dir = await makeTmp();
    const saved = path.join(dir, "codex-made.png");
    await fs.writeFile(saved, makePng(5, 4, { colorType: 4 }));
    const s = await setup("savedpath", { FAKE_SAVED_PATH: saved });
    const result = await gen(s, { prompt: "x", transparent_background: true });
    assert.equal(result.images[0].alpha, true);
  });
});

describe("generateImages duplicate notifications", () => {
  it("ignores a repeated completed notification with the same item id", async () => {
    const s = await setup("ok", { FAKE_DUPLICATE: "1" });
    const events = [];
    const result = await gen(s, { prompt: "A red fox" }, { onProgress: e => events.push(e) });
    assert.equal(result.images.length, 1);
    assert.deepEqual(result.failures, []);
    assert.equal((await fs.readdir(path.join(s.base, "generated-images"))).length, 1);
    assert.equal(events.filter(e => e.message === "Image 1 of 1 ready").length, 1);
    assert.ok(!events.some(e => /Image 2 of/.test(e.message)));
  });

  it("dedupes per item id for count 2", async () => {
    const s = await setup("count2", { FAKE_DUPLICATE: "1" });
    const result = await gen(s, { prompt: "Two foxes", count: 2 });
    assert.equal(result.images.length, 2);
    assert.equal((await fs.readdir(path.join(s.base, "generated-images"))).length, 2);
  });

  it("records a repeated failed item once", async () => {
    const s = await setup("fail_limit", { FAKE_DUPLICATE: "1" });
    await assert.rejects(gen(s, { prompt: "x" }), err => {
      assert.equal(err.message.match(/usage limit reached/g).length, 1);
      return true;
    });
  });
});

describe("generateImages parameters", () => {
  it("defaults to low effort in exact mode and uses the effort the caller requests", async () => {
    const s = await setup("ok");
    const exact = await gen(s, { prompt: "x" });
    assert.equal(exact.effort, "low");
    const high = await gen(s, { prompt: "x", reasoning_effort: "high" });
    assert.equal(high.effort, "high");
    const turns = await sentTo(s, "turn/start");
    assert.deepEqual(turns.map(t => t.params.effort), ["low", "high"]);
  });

  it("enhance mode sends the rewrite instructions and no default effort", async () => {
    const s = await setup("ok");
    const result = await gen(s, { prompt: "a fox", prompt_mode: "enhance" });
    assert.equal(result.mode, "enhance");
    assert.equal(result.effort, null);
    const [thread] = await sentTo(s, "thread/start");
    assert.ok(thread.params.developerInstructions.includes("rewrite"));
    assert.ok(!thread.params.developerInstructions.includes("verbatim"));
    const [turn] = await sentTo(s, "turn/start");
    assert.ok(!("effort" in turn.params));
  });

  it("passes a valid model through to thread/start", async () => {
    const s = await setup("ok");
    const result = await gen(s, { prompt: "x", model: "m-default" });
    assert.equal(result.model, "m-default");
    const [thread] = await sentTo(s, "thread/start");
    assert.equal(thread.params.model, "m-default");
  });

  it("rejects an unknown model before starting a thread and lists the available ones", async () => {
    const s = await setup("ok");
    await assert.rejects(gen(s, { prompt: "x", model: "gpt-nope" }), err => {
      assert.match(err.message, /Unknown Codex model "gpt-nope"/);
      assert.ok(err.message.includes("m-default"));
      assert.ok(err.message.includes("m-default (default): low, high"));
      return true;
    });
    assert.equal((await sentTo(s, "thread/start")).length, 0);
  });

  it("rejects an unsupported reasoning effort", async () => {
    const s = await setup("ok");
    await assert.rejects(gen(s, { prompt: "x", reasoning_effort: "xhigh" }), err => {
      assert.match(err.message, /does not support/);
      assert.match(err.message, /"xhigh"/);
      assert.match(err.message, /low, high/);
      return true;
    });
    assert.equal((await sentTo(s, "turn/start")).length, 0);
  });

  it("unsubscribes the thread after an unsupported effort error", async () => {
    const s = await setup("ok");
    await assert.rejects(gen(s, { prompt: "x", reasoning_effort: "xhigh" }), /does not support/);
    await waitUnsubscribed(s);
  });

  it("asks for a transparent background when requested", async () => {
    const s = await setup("ok");
    await gen(s, { prompt: "x", transparent_background: true });
    const [thread] = await sentTo(s, "thread/start");
    assert.ok(thread.params.developerInstructions.includes("transparent_background to true"));
  });

  it("attaches reference images as localImage inputs", async () => {
    const s = await setup("ok");
    const ref = path.join(s.base, "refs", "ref.png");
    await fs.mkdir(path.dirname(ref), { recursive: true });
    await fs.writeFile(ref, makePng());
    const gif = path.join(s.base, "anim.gif");
    await fs.writeFile(gif, makeGif());
    await gen(s, { prompt: "edit it", reference_images: ["refs/ref.png", gif] });
    const [thread] = await sentTo(s, "thread/start");
    assert.ok(thread.params.developerInstructions.includes("attached images"));
    const [turn] = await sentTo(s, "turn/start");
    assert.deepEqual(turn.params.input, [
      { type: "text", text: "edit it", text_elements: [] },
      { type: "localImage", path: ref },
      { type: "localImage", path: gif },
    ]);
  });

  it("does not mention attached images without references", async () => {
    const s = await setup("ok");
    await gen(s, { prompt: "x" });
    const [thread] = await sentTo(s, "thread/start");
    assert.ok(!thread.params.developerInstructions.includes("attached images"));
  });

  it("fails on a missing reference image before touching Codex", async () => {
    const s = await setup("ok");
    await assert.rejects(gen(s, { prompt: "x", reference_images: ["missing.png"] }), /not found/);
    assert.equal((await sentTo(s, "thread/start")).length, 0);
  });

  it("fails on a reference that is not an image", async () => {
    const s = await setup("ok");
    await fs.writeFile(path.join(s.base, "notes.txt"), "plain text");
    await assert.rejects(gen(s, { prompt: "x", reference_images: ["notes.txt"] }), /must be PNG, JPEG, WebP or GIF/);
    assert.equal((await sentTo(s, "thread/start")).length, 0);
  });

  it("saves to an output_path file relative to baseDir and never overwrites it", async () => {
    const s = await setup("ok");
    const first = await gen(s, { prompt: "x", output_path: "out/pic.png" });
    assert.equal(first.images[0].path, path.join(s.base, "out", "pic.png"));
    const second = await gen(s, { prompt: "x", output_path: "out/pic.png" });
    assert.equal(second.images[0].path, path.join(s.base, "out", "pic-2.png"));
    assert.deepEqual(await fs.readFile(first.images[0].path), makePng(3, 2));
    assert.deepEqual(await fs.readFile(second.images[0].path), makePng(3, 2));
  });

  it("saves into an output_path directory with a timestamped name", async () => {
    const s = await setup("ok");
    const result = await gen(s, { prompt: "A red fox", output_path: "my-images" });
    assert.equal(path.dirname(result.images[0].path), path.join(s.base, "my-images"));
    assert.match(path.basename(result.images[0].path), /^\d{4}-\d{2}-\d{2}_\d{6}_a-red-fox\.png$/);
  });

  it("saves into an absolute output_path outside baseDir", async () => {
    const s = await setup("ok");
    const elsewhere = await makeTmp();
    const target = path.join(elsewhere, "abs.png");
    const result = await gen(s, { prompt: "x", output_path: target });
    assert.equal(result.images[0].path, target);
  });

  it("suffixes an output_path file with _1 and _2 for count 2", async () => {
    const s = await setup("count2");
    const result = await gen(s, { prompt: "x", count: 2, output_path: "pair.png" });
    assert.deepEqual(result.images.map(i => path.basename(i.path)), ["pair_1.png", "pair_2.png"]);
  });
});

describe("generateImages failures", () => {
  it("fails with the Codex message when no image was generated", async () => {
    const s = await setup("noimage");
    await assert.rejects(gen(s, { prompt: "x" }), err => {
      assert.match(err.message, /without generating/);
      assert.match(err.message, /policy refusal/);
      assert.match(err.message, /Codex said: policy refusal/);
      return true;
    });
    await waitUnsubscribed(s);
  });

  it("reports an image usage limit with its reset time", async () => {
    const s = await setup("fail_limit");
    await assert.rejects(gen(s, { prompt: "x" }), err => {
      assert.match(err.message, /without generating/);
      assert.match(err.message, /usage limit/);
      assert.match(err.message, /\(images\)/);
      assert.match(err.message, /resets at \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(UTC[+-]\d{2}:\d{2}\)/);
      return true;
    });
  });

  it("surfaces a failed turn and the login hint for unauthorized errors", async () => {
    const s = await setup("turn_error");
    await assert.rejects(gen(s, { prompt: "x" }), err => {
      assert.match(err.message, /without generating/);
      assert.match(err.message, /boom/);
      assert.match(err.message, /codex login/);
      return true;
    });
  });

  it("adds the usage limit hint when the error info is an object", async () => {
    const s = await setup("turn_error", { FAKE_ERROR_INFO: JSON.stringify({ usageLimitExceeded: {} }), FAKE_ERROR_DETAILS: "plan exhausted" });
    await assert.rejects(gen(s, { prompt: "x" }), err => {
      assert.match(err.message, /boom/);
      assert.match(err.message, /plan exhausted/);
      assert.match(err.message, /usage limit was reached/);
      assert.match(err.message, /codex_status/);
      assert.doesNotMatch(err.message, /codex login/);
      return true;
    });
  });

  it("adds no hint for an unknown error kind", async () => {
    const s = await setup("turn_error", { FAKE_ERROR_INFO: JSON.stringify("somethingNew") });
    await assert.rejects(gen(s, { prompt: "x" }), err => {
      assert.match(err.message, /boom/);
      assert.doesNotMatch(err.message, /codex login|usage limit|overloaded|rate limited/);
      return true;
    });
  });

  it("uses the last non-retryable error notification when the turn itself has no error", async () => {
    const s = await setup("error_notice", { FAKE_ERROR_INFO: JSON.stringify("serverOverloaded") });
    await assert.rejects(gen(s, { prompt: "x" }), err => {
      assert.match(err.message, /without generating/);
      assert.match(err.message, /stream failed/);
      assert.match(err.message, /overloaded/);
      assert.doesNotMatch(err.message, /retrying transient failure/);
      return true;
    });
  });

  it("describes a failed image item without failure details by its status", async () => {
    const s = await setup("fail_limit", { FAKE_FAILURE: "null" });
    await assert.rejects(gen(s, { prompt: "x" }), /Image generation ended with status "failed"/);
  });

  it("omits the reset time when the usage limit failure has none", async () => {
    const s = await setup("fail_limit", { FAKE_FAILURE: JSON.stringify({ type: "usageLimitExceeded", limitId: "images" }) });
    await assert.rejects(gen(s, { prompt: "x" }), err => {
      assert.match(err.message, /usage limit reached \(images\)\./);
      assert.doesNotMatch(err.message, /resets at/);
      return true;
    });
  });

  it("returns the images that succeeded and reports the ones that failed", async () => {
    const s = await setup("partial");
    const result = await gen(s, { prompt: "Two foxes", count: 2 });
    assert.equal(result.requested, 2);
    assert.equal(result.images.length, 1);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0], /usage limit reached \(images\)/);
    assert.ok(!("turnStatus" in result));
    assert.deepEqual(await fs.readFile(result.images[0].path), makePng(3, 2));
  });

  it("rejects with the failure lines when the image data cannot be decoded", async () => {
    const s = await setup("badimage");
    await assert.rejects(gen(s, { prompt: "x" }), err => {
      assert.equal(err.message, "No image could be saved.\nImage 1: the image data could not be decoded.");
      return true;
    });
    const files = await fs.readdir(s.base);
    assert.ok(!files.includes("generated-images"));
  });

  it("reports an imageless completed item", async () => {
    const s = await setup("imageless");
    await assert.rejects(gen(s, { prompt: "x" }), err => {
      assert.equal(err.message, "Codex finished without generating an image.\nCodex reported an image without any image data.");
      return true;
    });
  });

  it("returns the good image and lists an imageless one as a failure", async () => {
    const s = await setup("imageless", { FAKE_COUNT: "2", FAKE_BAD_ONLY_FIRST: "1" });
    const result = await gen(s, { prompt: "Two foxes", count: 2 });
    assert.equal(result.requested, 2);
    assert.equal(result.images.length, 1);
    assert.deepEqual(result.failures, ["Codex reported an image without any image data."]);
    assert.deepEqual(await fs.readFile(result.images[0].path), makePng(3, 2));
  });

  it("returns the good image and numbers the undecodable one in the failures", async () => {
    const s = await setup("badimage", { FAKE_COUNT: "2", FAKE_BAD_ONLY_FIRST: "1" });
    const result = await gen(s, { prompt: "Two foxes", count: 2 });
    assert.equal(result.images.length, 1);
    assert.deepEqual(result.failures, ["Image 1: the image data could not be decoded."]);
    assert.match(path.basename(result.images[0].path), /_two-foxes_2\.png$/);
  });

  it("falls back to savedPath when the inline data is not an image", async () => {
    const dir = await makeTmp();
    const saved = path.join(dir, "codex-made.png");
    await fs.writeFile(saved, makePng(5, 4, { colorType: 6 }));
    const s = await setup("badimage_savedpath", { FAKE_SAVED_PATH: saved });
    const result = await gen(s, { prompt: "x" });
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.images[0].size, { width: 5, height: 4 });
    assert.equal(result.images[0].alpha, true);
    assert.deepEqual(await fs.readFile(result.images[0].path), makePng(5, 4, { colorType: 6 }));
  });

  it("reports the decode failure when the inline data is not an image and savedPath is not either", async () => {
    const dir = await makeTmp();
    const saved = path.join(dir, "not-an-image.png");
    await fs.writeFile(saved, "plain text");
    const s = await setup("badimage_savedpath", { FAKE_SAVED_PATH: saved });
    await assert.rejects(gen(s, { prompt: "x" }), err => {
      assert.equal(err.message, "No image could be saved.\nImage 1: the image data could not be decoded.");
      return true;
    });
  });

  it("returns the second image when the first savedPath cannot be read", async () => {
    const dir = await makeTmp();
    const missing = path.join(dir, "gone.png");
    const s = await setup("savedpath", { FAKE_COUNT: "2", FAKE_BAD_ONLY_FIRST: "1", FAKE_SAVED_PATH: missing });
    const result = await gen(s, { prompt: "Two foxes", count: 2 });
    assert.equal(result.requested, 2);
    assert.equal(result.images.length, 1);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0], /^Image 1 could not be saved: /);
    assert.match(result.failures[0], /ENOENT/);
    assert.match(path.basename(result.images[0].path), /_two-foxes_2\.png$/);
    assert.deepEqual(await fs.readFile(result.images[0].path), makePng(3, 2));
    assert.equal((await fs.readdir(path.join(s.base, "generated-images"))).length, 1);
  });

  it("throws No image could be saved with every failure line when nothing was saved", async () => {
    const dir = await makeTmp();
    const missing = path.join(dir, "gone.png");
    const s = await setup("savedpath", { FAKE_COUNT: "2", FAKE_SAVED_PATH: missing });
    await assert.rejects(gen(s, { prompt: "Two foxes", count: 2 }), err => {
      const lines = err.message.split("\n");
      assert.equal(lines[0], "No image could be saved.");
      assert.equal(lines.length, 3);
      assert.match(lines[1], /^Image 1 could not be saved: .*ENOENT/);
      assert.match(lines[2], /^Image 2 could not be saved: .*ENOENT/);
      return true;
    });
    await waitUnsubscribed(s);
  });

  it("reports a save error caused by an unwritable output directory", async () => {
    const s = await setup("ok");
    await fs.writeFile(path.join(s.base, "blocked"), "a file, not a directory");
    await assert.rejects(gen(s, { prompt: "x", output_path: "blocked/sub" }), err => {
      assert.match(err.message, /^No image could be saved\.\nImage 1 could not be saved: /);
      return true;
    });
  });

  it("rejects when the server dies on thread/start", async () => {
    const s = await setup("crash");
    await assert.rejects(gen(s, { prompt: "x" }), /Codex app-server stopped/);
  });

  it("rejects when the server dies in the middle of a turn", async () => {
    const s = await setup("crash_midturn");
    await assert.rejects(gen(s, { prompt: "x" }), /Codex app-server stopped \(exit code 3/);
  });
});

describe("generateImages cancellation and timeout", () => {
  it("rejects immediately when the signal is already aborted", async () => {
    const s = await setup("hang");
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(gen(s, { prompt: "x" }, { signal: controller.signal }), /Cancelled/);
    assert.equal((await sentTo(s, "thread/start")).length, 0);
  });

  it("aborting right after Codex is ready rejects before turn/start is ever sent", async () => {
    const s = await setup("hang");
    const controller = new AbortController();
    const before = { notification: s.client.listenerCount("notification"), close: s.client.listenerCount("close") };
    const onProgress = ({ message }) => {
      if (/Codex ready/.test(message)) controller.abort();
    };
    await assert.rejects(gen(s, { prompt: "x" }, { signal: controller.signal, onProgress }), err => {
      assert.equal(err.message, "Cancelled before Codex started generating.");
      return true;
    });
    await waitUnsubscribed(s);
    assert.equal((await sentTo(s, "thread/start")).length, 1);
    assert.equal((await sentTo(s, "turn/start")).length, 0);
    assert.equal((await sentTo(s, "turn/interrupt")).length, 0);
    assert.equal(s.client.listenerCount("notification"), before.notification);
    assert.equal(s.client.listenerCount("close"), before.close);
  });

  it("aborting while the effort lookup is running never sends turn/start", async () => {
    const controller = new AbortController();
    const requests = [];
    const client = new EventEmitter();
    client.listModels = async () => {
      controller.abort();
      return [{ id: "m", model: "m", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low" }] }];
    };
    client.request = async method => {
      requests.push(method);
      if (method === "thread/start") return { thread: { id: "t1" }, model: "m" };
      return {};
    };
    await assert.rejects(
      generateImages({ client, params: { prompt: "x" }, baseDir: await makeTmp(), signal: controller.signal }),
      /^Error: Cancelled before Codex started generating\.$/
    );
    assert.deepEqual(requests, ["thread/start", "thread/unsubscribe"]);
    assert.equal(client.listenerCount("notification"), 0);
    assert.equal(client.listenerCount("close"), 0);
  });

  it("an abort that arrives before thread/start returns is also caught before turn/start", async () => {
    const controller = new AbortController();
    const requests = [];
    const client = new EventEmitter();
    client.listModels = async () => [];
    client.request = async method => {
      requests.push(method);
      if (method === "thread/start") {
        controller.abort();
        return { thread: { id: "t1" }, model: "m" };
      }
      return {};
    };
    await assert.rejects(
      generateImages({ client, params: { prompt: "x" }, baseDir: await makeTmp(), signal: controller.signal }),
      /Cancelled before Codex started generating\./
    );
    assert.deepEqual(requests, ["thread/start", "thread/unsubscribe"]);
  });

  it("aborting mid-turn rejects with Cancelled and interrupts the turn", async () => {
    const s = await setup("hang");
    const controller = new AbortController();
    const onProgress = ({ message }) => {
      if (/Generating image/.test(message)) controller.abort();
    };
    await assert.rejects(gen(s, { prompt: "x" }, { signal: controller.signal, onProgress }), /Cancelled/);
    const [interrupt] = await waitFor(async () => {
      const found = await sentTo(s, "turn/interrupt");
      return found.length ? found : null;
    }, { label: "turn/interrupt" });
    assert.deepEqual(interrupt.params, { threadId: "t1", turnId: "u1" });
    await waitUnsubscribed(s);
  });

  it("aborting before the turn id is known still stops the turn", async () => {
    const s = await setup("hang", { FAKE_DELAY_MS: "200" });
    const controller = new AbortController();
    const onProgress = ({ message }) => {
      if (/Codex ready/.test(message)) setTimeout(() => controller.abort(), 0);
    };
    await assert.rejects(gen(s, { prompt: "x" }, { signal: controller.signal, onProgress }), /Cancelled/);
    await waitFor(async () => (await sentTo(s, "turn/interrupt")).length > 0, { label: "turn/interrupt" });
  });

  it("rejects with Timed out and interrupts the turn when Codex never finishes", async () => {
    const s = await setup("hang");
    await assert.rejects(gen(s, { prompt: "x" }, { timeoutMs: 250 }), /Timed out/);
    await waitFor(async () => (await sentTo(s, "turn/interrupt")).length > 0, { label: "turn/interrupt" });
    await waitUnsubscribed(s);
  });

  it("leaves no notification or close listeners behind after finishing", async () => {
    const s = await setup("ok");
    const before = { notification: s.client.listenerCount("notification"), close: s.client.listenerCount("close") };
    await gen(s, { prompt: "x" });
    assert.equal(s.client.listenerCount("notification"), before.notification);
    assert.equal(s.client.listenerCount("close"), before.close);
  });

  it("leaves no listeners behind after a timeout", async () => {
    const s = await setup("hang");
    const before = { notification: s.client.listenerCount("notification"), close: s.client.listenerCount("close") };
    await assert.rejects(gen(s, { prompt: "x" }, { timeoutMs: 100 }), /Timed out/);
    assert.equal(s.client.listenerCount("notification"), before.notification);
    assert.equal(s.client.listenerCount("close"), before.close);
  });
});

describe("generateImages progress", () => {
  it("reports strictly increasing progress values with the requested total", async () => {
    const s = await setup("ok");
    const events = [];
    await gen(s, { prompt: "x" }, { onProgress: e => events.push(e) });
    assert.ok(events.length >= 3);
    for (let i = 1; i < events.length; i++) assert.ok(events[i].progress > events[i - 1].progress, `${events[i - 1].progress} -> ${events[i].progress}`);
    assert.ok(events.every(e => e.total === 1));
    assert.match(events[0].message, /^Codex ready \(m-default, effort low\)$/);
    assert.ok(events.some(e => e.message === "Generating image 1 of 1"));
    assert.ok(events.some(e => e.message === "Image 1 of 1 ready"));
    assert.equal(events.at(-1).progress, 1);
  });

  it("stays strictly increasing and ends at the count for two images", async () => {
    const s = await setup("count2");
    const events = [];
    await gen(s, { prompt: "x", count: 2 }, { onProgress: e => events.push(e) });
    for (let i = 1; i < events.length; i++) assert.ok(events[i].progress > events[i - 1].progress);
    assert.ok(events.every(e => e.total === 2));
    assert.equal(events.at(-1).progress, 2);
    assert.ok(events.some(e => e.message === "Generating image 2 of 2"));
  });

  it("is not affected by an onProgress callback that throws", async () => {
    const s = await setup("ok");
    const result = await gen(s, {
      prompt: "x",
    }, {
      onProgress: () => {
        throw new Error("progress sink broke");
      },
    });
    assert.equal(result.images.length, 1);
  });

  it("works without an onProgress callback", async () => {
    const s = await setup("ok");
    const result = await gen(s, { prompt: "x" });
    assert.equal(result.images.length, 1);
  });
});
