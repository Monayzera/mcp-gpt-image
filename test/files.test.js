import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { detectFormat, expandHome, hasAlpha, imageSize, planTargets, resolveReferenceImages, slugify, timestamp, writeUnique } from "../src/files.js";
import { jpegSegment, makeGif, makeJpeg, makePng, makeWebp, pngChunk } from "./fixtures/images.js";

let tmp;
const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

function restoreHome() {
  for (const [key, value] of Object.entries(savedHome)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function useFakeHome(dir) {
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "files-test-"));
});

afterEach(async () => {
  restoreHome();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("detectFormat", () => {
  it("detects png", () => {
    assert.deepEqual(
      { mime: detectFormat(makePng()).mime, ext: detectFormat(makePng()).ext },
      { mime: "image/png", ext: ".png" }
    );
  });

  it("detects jpeg", () => {
    const format = detectFormat(makeJpeg());
    assert.equal(format.mime, "image/jpeg");
    assert.equal(format.ext, ".jpg");
  });

  it("detects webp", () => {
    const format = detectFormat(makeWebp());
    assert.equal(format.mime, "image/webp");
    assert.equal(format.ext, ".webp");
  });

  it("detects gif", () => {
    const format = detectFormat(makeGif());
    assert.equal(format.mime, "image/gif");
    assert.equal(format.ext, ".gif");
  });

  it("returns null for garbage", () => {
    assert.equal(detectFormat(Buffer.from("this is definitely not an image")), null);
  });

  it("returns null for an empty buffer", () => {
    assert.equal(detectFormat(Buffer.alloc(0)), null);
  });

  it("returns null for a truncated png signature", () => {
    assert.equal(detectFormat(Buffer.from([0x89, 0x50, 0x4e, 0x47])), null);
  });

  it("returns null for a RIFF container that is not webp", () => {
    const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt "), Buffer.alloc(8)]);
    assert.equal(detectFormat(wav), null);
  });

  it("returns null for text that merely contains an image name", () => {
    assert.equal(detectFormat(Buffer.from("PNG image placeholder file")), null);
  });
});

describe("imageSize", () => {
  it("reads png dimensions", () => {
    assert.deepEqual(imageSize(makePng(3, 2)), { width: 3, height: 2 });
    assert.deepEqual(imageSize(makePng(40, 30)), { width: 40, height: 30 });
  });

  it("reads png dimensions from the first 24 bytes only", () => {
    assert.deepEqual(imageSize(makePng(7, 9).subarray(0, 24)), { width: 7, height: 9 });
  });

  it("returns null for a png shorter than the IHDR fields", () => {
    assert.equal(imageSize(makePng().subarray(0, 20)), null);
  });

  it("reads gif dimensions", () => {
    assert.deepEqual(imageSize(makeGif(16, 12)), { width: 16, height: 12 });
    assert.deepEqual(imageSize(makeGif(300, 200)), { width: 300, height: 200 });
  });

  it("reads baseline jpeg dimensions from SOF0", () => {
    assert.deepEqual(imageSize(makeJpeg(123, 456)), { width: 123, height: 456 });
  });

  it("reads progressive jpeg dimensions from SOF2", () => {
    assert.deepEqual(imageSize(makeJpeg(640, 480, { progressive: true })), { width: 640, height: 480 });
  });

  it("does not mistake the DHT marker for a frame header", () => {
    const dht = jpegSegment(0xc4, Buffer.alloc(8));
    assert.deepEqual(imageSize(makeJpeg(50, 60, { before: [dht] })), { width: 50, height: 60 });
  });

  it("skips over other segments before the frame header", () => {
    const comment = jpegSegment(0xfe, Buffer.from("a comment segment"));
    const dqt = jpegSegment(0xdb, Buffer.alloc(65));
    assert.deepEqual(imageSize(makeJpeg(33, 44, { before: [comment, dqt] })), { width: 33, height: 44 });
  });

  it("returns null for a jpeg without a frame header", () => {
    const noSof = Buffer.concat([Buffer.from([0xff, 0xd8]), jpegSegment(0xe0, Buffer.alloc(14)), Buffer.from([0xff, 0xd9, 0x00, 0x00, 0x00, 0x00])]);
    assert.equal(imageSize(noSof), null);
  });

  it("returns null for a corrupt jpeg segment chain", () => {
    const corrupt = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0x00, 0xe0, 0x00, 0x10]), Buffer.alloc(20)]);
    assert.equal(imageSize(corrupt), null);
  });

  it("reads a jpeg whose frame header ends exactly at the end of the buffer", () => {
    const minimal = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x05, 0x00, 0x04])]);
    assert.equal(minimal.length, 11);
    assert.deepEqual(imageSize(minimal), { width: 4, height: 5 });
  });

  it("returns null for a jpeg frame header cut one byte short", () => {
    const cut = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x05, 0x00])]);
    assert.equal(imageSize(cut), null);
  });

  it("returns null for webp, which has no size parser", () => {
    assert.equal(imageSize(makeWebp()), null);
  });

  it("returns null for garbage and empty buffers", () => {
    assert.equal(imageSize(Buffer.from("garbage garbage garbage garbage")), null);
    assert.equal(imageSize(Buffer.alloc(0)), null);
  });
});

describe("hasAlpha", () => {
  it("is true for an RGBA png", () => {
    assert.equal(hasAlpha(makePng(3, 2, { colorType: 6 })), true);
  });

  it("is true for a grayscale png with alpha", () => {
    assert.equal(hasAlpha(makePng(3, 2, { colorType: 4 })), true);
  });

  it("is false for an RGB png", () => {
    assert.equal(hasAlpha(makePng(3, 2)), false);
    assert.equal(hasAlpha(makePng()), false);
  });

  it("is false for a grayscale png and for a palette png without tRNS", () => {
    assert.equal(hasAlpha(makePng(3, 2, { colorType: 0 })), false);
    assert.equal(hasAlpha(makePng(3, 2, { colorType: 3 })), false);
  });

  it("is true for an RGB png with a tRNS chunk before the image data", () => {
    assert.equal(hasAlpha(makePng(3, 2, { colorType: 2, trns: true })), true);
  });

  it("is true for a palette or grayscale png with a tRNS chunk", () => {
    assert.equal(hasAlpha(makePng(3, 2, { colorType: 3, trns: true })), true);
    assert.equal(hasAlpha(makePng(3, 2, { colorType: 0, trns: true })), true);
  });

  it("is false when a tRNS chunk only appears after the image data", () => {
    const png = makePng(3, 2);
    const iend = png.subarray(png.length - 12);
    const late = Buffer.concat([png.subarray(0, png.length - 12), pngChunk("tRNS", Buffer.alloc(6)), iend]);
    assert.equal(hasAlpha(late), false);
  });

  it("finds tRNS after other ancillary chunks that precede the image data", () => {
    const png = makePng(3, 2);
    const idatStart = 8 + 12 + 13;
    const withChunks = Buffer.concat([
      png.subarray(0, idatStart),
      pngChunk("gAMA", Buffer.alloc(4)),
      pngChunk("tEXt", Buffer.from("Comment\0hello")),
      pngChunk("tRNS", Buffer.alloc(6)),
      png.subarray(idatStart),
    ]);
    assert.equal(hasAlpha(withChunks), true);
  });

  it("is false for a png cut off before the image data", () => {
    assert.equal(hasAlpha(makePng().subarray(0, 40)), false);
  });

  it("is false for a png whose chunk length points past the buffer", () => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(0x7fffffff);
    const broken = Buffer.concat([makePng().subarray(0, 8 + 12 + 13), length, Buffer.from("tEXt", "ascii")]);
    assert.equal(hasAlpha(broken), false);
  });

  it("is null for a png too short to hold the color type", () => {
    assert.equal(hasAlpha(makePng().subarray(0, 25)), null);
  });

  it("is null for jpeg, gif, webp, garbage and empty buffers", () => {
    assert.equal(hasAlpha(makeJpeg()), null);
    assert.equal(hasAlpha(makeGif()), null);
    assert.equal(hasAlpha(makeWebp()), null);
    assert.equal(hasAlpha(Buffer.from("not an image at all, just text")), null);
    assert.equal(hasAlpha(Buffer.alloc(0)), null);
  });
});

describe("expandHome", () => {
  it("expands a lone tilde to the home directory", () => {
    assert.equal(expandHome("~"), os.homedir());
  });

  it("expands ~/x with a forward slash", () => {
    assert.equal(expandHome("~/x"), path.join(os.homedir(), "x"));
    assert.equal(expandHome("~/a/b/c.png"), path.join(os.homedir(), "a", "b", "c.png"));
  });

  it("expands ~\\x with a backslash", () => {
    assert.equal(expandHome("~\\x"), path.join(os.homedir(), "x"));
  });

  it("expands ~/ to the home directory", () => {
    assert.equal(expandHome("~/"), os.homedir());
  });

  it("leaves other paths unchanged", () => {
    for (const p of ["/abs/path", "rel/path", "./rel", "", "~user/x", "~x", "a/~/b", "C:\\Users\\x"]) {
      assert.equal(expandHome(p), p, p);
    }
  });

  it("follows the current home directory", () => {
    useFakeHome(tmp);
    assert.equal(expandHome("~/x"), path.join(tmp, "x"));
    assert.equal(expandHome("~"), tmp);
  });
});

describe("slugify", () => {
  it("strips accents", () => {
    assert.equal(slugify("Ação Café"), "acao-cafe");
  });

  it("lowercases and joins words with hyphens", () => {
    assert.equal(slugify("Hello, World!"), "hello-world");
  });

  it("returns image for empty or non-text input", () => {
    assert.equal(slugify(""), "image");
    assert.equal(slugify("   "), "image");
    assert.equal(slugify(null), "image");
    assert.equal(slugify(undefined), "image");
    assert.equal(slugify("!!! ???"), "image");
  });

  it("returns image when every character is outside a-z0-9 after normalization", () => {
    assert.equal(slugify("猫の絵"), "image");
  });

  it("stringifies numbers", () => {
    assert.equal(slugify(123), "123");
  });

  it("keeps at most 6 words by default", () => {
    assert.equal(slugify("a b c d e f g h i"), "a-b-c-d-e-f");
  });

  it("honors a custom maxWords", () => {
    assert.equal(slugify("a b c d", 2), "a-b");
  });

  it("truncates long slugs to 48 characters or fewer on a word boundary", () => {
    const word = "abcdefghij";
    const slug = slugify(Array(6).fill(word).join(" "));
    assert.ok(slug.length <= 48);
    assert.equal(slug, Array(4).fill(word).join("-"));
  });

  it("truncates a single very long word to the maximum length", () => {
    const slug = slugify("a".repeat(100));
    assert.equal(slug.length, 48);
  });

  it("honors a custom maxLength", () => {
    const slug = slugify("alpha beta gamma", 6, 10);
    assert.ok(slug.length <= 10);
    assert.ok(slug.startsWith("alpha"));
    assert.ok(!slug.endsWith("-"));
  });

  it("never produces characters unsafe for file names", () => {
    const slug = slugify("a/b\\c:d*e?f\"g<h>i|j");
    assert.match(slug, /^[a-z0-9-]+$/);
  });
});

describe("timestamp", () => {
  it("formats local time as YYYY-MM-DD_HHMMSS", () => {
    assert.equal(timestamp(new Date(2024, 0, 5, 3, 4, 5)), "2024-01-05_030405");
    assert.equal(timestamp(new Date(2024, 11, 31, 23, 59, 59)), "2024-12-31_235959");
  });

  it("defaults to the current time", () => {
    assert.match(timestamp(), /^\d{4}-\d{2}-\d{2}_\d{6}$/);
  });
});

describe("planTargets", () => {
  const date = new Date(2024, 4, 6, 7, 8, 9);
  const stamp = "2024-05-06_070809";

  it("defaults to <base>/generated-images with a timestamp and slug stem", () => {
    const targets = planTargets({ baseDir: "/proj", prompt: "A red fox", count: 1, date });
    assert.deepEqual(targets, [{ dir: path.join("/proj", "generated-images"), stem: `${stamp}_a-red-fox` }]);
  });

  it("adds _1.._n suffixes when count is greater than 1", () => {
    const targets = planTargets({ baseDir: "/proj", prompt: "A red fox", count: 3, date });
    assert.deepEqual(
      targets.map(t => t.stem),
      [`${stamp}_a-red-fox_1`, `${stamp}_a-red-fox_2`, `${stamp}_a-red-fox_3`]
    );
    assert.ok(targets.every(t => t.dir === path.join("/proj", "generated-images")));
  });

  it("uses image as the slug for an empty prompt", () => {
    assert.equal(planTargets({ baseDir: "/proj", prompt: "", count: 1, date })[0].stem, `${stamp}_image`);
  });

  it("returns one target per requested count", () => {
    assert.equal(planTargets({ baseDir: "/proj", prompt: "x", count: 4, date }).length, 4);
    assert.equal(planTargets({ baseDir: "/proj", prompt: "x", count: 0, date }).length, 0);
  });

  it("resolves a relative output_path file against baseDir", () => {
    const targets = planTargets({ outputPath: "out/pic.png", baseDir: "/proj", prompt: "x", count: 1, date });
    assert.deepEqual(targets, [{ dir: path.join("/proj", "out"), stem: "pic" }]);
  });

  it("keeps an absolute output_path file as is", () => {
    const abs = path.join(path.sep, "elsewhere", "pic.png");
    const targets = planTargets({ outputPath: abs, baseDir: "/proj", prompt: "x", count: 1, date });
    assert.deepEqual(targets, [{ dir: path.join(path.sep, "elsewhere"), stem: "pic" }]);
  });

  it("recognizes other image extensions regardless of case", () => {
    for (const name of ["a.PNG", "a.jpg", "a.JPEG", "a.webp", "a.gif"]) {
      const [target] = planTargets({ outputPath: name, baseDir: "/proj", prompt: "x", count: 1, date });
      assert.deepEqual(target, { dir: path.resolve("/proj"), stem: "a" }, name);
    }
  });

  it("suffixes the stem of an output_path file when count is greater than 1", () => {
    const targets = planTargets({ outputPath: "pic.png", baseDir: "/proj", prompt: "x", count: 2, date });
    assert.deepEqual(targets.map(t => t.stem), ["pic_1", "pic_2"]);
    assert.ok(targets.every(t => t.dir === path.resolve("/proj")));
  });

  it("treats an output_path without an image extension as a directory", () => {
    const targets = planTargets({ outputPath: "out/dir", baseDir: "/proj", prompt: "A red fox", count: 1, date });
    assert.deepEqual(targets, [{ dir: path.join("/proj", "out", "dir"), stem: `${stamp}_a-red-fox` }]);
  });

  it("treats a dotted directory name as a directory", () => {
    const [target] = planTargets({ outputPath: "out.v2", baseDir: "/proj", prompt: "x", count: 1, date });
    assert.equal(target.dir, path.join("/proj", "out.v2"));
    assert.equal(target.stem, `${stamp}_x`);
  });

  it("expands ~/x.png in output_path to a file in the home directory", () => {
    const [target] = planTargets({ outputPath: "~/x.png", baseDir: "/proj", prompt: "x", count: 1, date });
    assert.deepEqual(target, { dir: os.homedir(), stem: "x" });
  });

  it("expands a ~ directory in output_path and keeps the timestamp stem", () => {
    const [target] = planTargets({ outputPath: "~/imgs/sub", baseDir: "/proj", prompt: "A red fox", count: 1, date });
    assert.deepEqual(target, { dir: path.join(os.homedir(), "imgs", "sub"), stem: `${stamp}_a-red-fox` });
  });

  it("expands a lone ~ in output_path as a directory", () => {
    const [target] = planTargets({ outputPath: "~", baseDir: "/proj", prompt: "fox", count: 1, date });
    assert.deepEqual(target, { dir: os.homedir(), stem: `${stamp}_fox` });
  });

  it("suffixes the stem of an expanded ~ file when count is greater than 1", () => {
    const targets = planTargets({ outputPath: "~/x.png", baseDir: "/proj", prompt: "x", count: 2, date });
    assert.deepEqual(targets, [
      { dir: os.homedir(), stem: "x_1" },
      { dir: os.homedir(), stem: "x_2" },
    ]);
  });

  it("uses the current home directory for ~ in output_path", () => {
    useFakeHome(tmp);
    const [target] = planTargets({ outputPath: "~/out/pic.png", baseDir: "/proj", prompt: "x", count: 1, date });
    assert.deepEqual(target, { dir: path.join(tmp, "out"), stem: "pic" });
  });

  it("keeps the timestamp stem and suffixes it for an output_path directory with count 2", () => {
    const targets = planTargets({ outputPath: "imgs", baseDir: "/proj", prompt: "fox", count: 2, date });
    assert.deepEqual(targets.map(t => t.stem), [`${stamp}_fox_1`, `${stamp}_fox_2`]);
    assert.ok(targets.every(t => t.dir === path.join("/proj", "imgs")));
  });
});

describe("writeUnique", () => {
  it("creates missing directories and writes the buffer", async () => {
    const dir = path.join(tmp, "a", "b", "c");
    const file = await writeUnique(dir, "pic", ".png", Buffer.from("one"));
    assert.equal(file, path.join(dir, "pic.png"));
    assert.equal(await fs.readFile(file, "utf8"), "one");
  });

  it("never overwrites an existing file and appends -2, -3", async () => {
    const first = await writeUnique(tmp, "pic", ".png", Buffer.from("one"));
    const second = await writeUnique(tmp, "pic", ".png", Buffer.from("two"));
    const third = await writeUnique(tmp, "pic", ".png", Buffer.from("three"));
    assert.equal(first, path.join(tmp, "pic.png"));
    assert.equal(second, path.join(tmp, "pic-2.png"));
    assert.equal(third, path.join(tmp, "pic-3.png"));
    assert.equal(await fs.readFile(first, "utf8"), "one");
    assert.equal(await fs.readFile(second, "utf8"), "two");
    assert.equal(await fs.readFile(third, "utf8"), "three");
  });

  it("keeps different extensions independent", async () => {
    const png = await writeUnique(tmp, "pic", ".png", Buffer.from("p"));
    const jpg = await writeUnique(tmp, "pic", ".jpg", Buffer.from("j"));
    assert.equal(png, path.join(tmp, "pic.png"));
    assert.equal(jpg, path.join(tmp, "pic.jpg"));
  });

  it("produces distinct files under concurrent writes", async () => {
    const files = await Promise.all(
      Array.from({ length: 6 }, (_, i) => writeUnique(tmp, "race", ".png", Buffer.from(`content-${i}`)))
    );
    assert.equal(new Set(files).size, 6);
    const contents = await Promise.all(files.map(f => fs.readFile(f, "utf8")));
    assert.equal(new Set(contents).size, 6);
  });

  it("rejects with the underlying error when the directory cannot be created", async () => {
    const blocker = path.join(tmp, "blocker");
    await fs.writeFile(blocker, "x");
    await assert.rejects(writeUnique(path.join(blocker, "sub"), "pic", ".png", Buffer.from("x")));
  });
});

describe("resolveReferenceImages", () => {
  async function write(name, buffer) {
    const file = path.join(tmp, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, buffer);
    return file;
  }

  it("returns an empty list for no paths", async () => {
    assert.deepEqual(await resolveReferenceImages(undefined, tmp), []);
    assert.deepEqual(await resolveReferenceImages(null, tmp), []);
    assert.deepEqual(await resolveReferenceImages([], tmp), []);
  });

  it("resolves a relative path against baseDir to an absolute path", async () => {
    const file = await write("refs/a.png", makePng());
    const [resolved] = await resolveReferenceImages(["refs/a.png"], tmp);
    assert.equal(resolved, file);
    assert.ok(path.isAbsolute(resolved));
  });

  it("accepts absolute paths and keeps the order", async () => {
    const a = await write("a.png", makePng());
    const b = await write("b.jpg", makeJpeg());
    const c = await write("c.gif", makeGif());
    const d = await write("d.webp", makeWebp());
    assert.deepEqual(await resolveReferenceImages([d, "c.gif", b, a], tmp), [d, c, b, a]);
  });

  it("expands ~/ against the home directory", async () => {
    const home = path.join(tmp, "home");
    await fs.mkdir(home);
    useFakeHome(home);
    const file = path.join(home, "pics", "ref.png");
    await fs.mkdir(path.dirname(file));
    await fs.writeFile(file, makePng());
    assert.deepEqual(await resolveReferenceImages(["~/pics/ref.png"], tmp), [file]);
  });

  it("names the expanded absolute path when a ~ reference is missing", async () => {
    const home = path.join(tmp, "home");
    await fs.mkdir(home);
    useFakeHome(home);
    await assert.rejects(resolveReferenceImages(["~/nope.png"], tmp), err => {
      assert.match(err.message, /not found/);
      assert.ok(err.message.includes(path.join(home, "nope.png")));
      return true;
    });
  });

  it("accepts images regardless of their file extension", async () => {
    const file = await write("photo.dat", makePng());
    assert.deepEqual(await resolveReferenceImages([file], tmp), [file]);
  });

  it("throws not found for a missing file and names the absolute path", async () => {
    await assert.rejects(resolveReferenceImages(["missing.png"], tmp), err => {
      assert.match(err.message, /not found/);
      assert.ok(err.message.includes(path.join(tmp, "missing.png")));
      return true;
    });
  });

  it("throws for a directory", async () => {
    await fs.mkdir(path.join(tmp, "folder"));
    await assert.rejects(resolveReferenceImages(["folder"], tmp), /not a file/);
  });

  it("throws for a non-image file", async () => {
    await write("notes.png", Buffer.from("just some text pretending to be a png"));
    await assert.rejects(resolveReferenceImages(["notes.png"], tmp), /must be PNG, JPEG, WebP or GIF/);
  });

  it("throws for an empty file", async () => {
    await write("empty.png", Buffer.alloc(0));
    await assert.rejects(resolveReferenceImages(["empty.png"], tmp), /must be PNG, JPEG, WebP or GIF/);
  });

  it("fails on the first invalid entry without returning partial results", async () => {
    await write("ok.png", makePng());
    await assert.rejects(resolveReferenceImages(["ok.png", "missing.png"], tmp), /not found/);
  });
});
