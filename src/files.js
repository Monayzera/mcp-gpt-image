import fs from "node:fs/promises";
import path from "node:path";

const FORMATS = [
  { mime: "image/png", ext: ".png", test: b => b.length > 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a },
  { mime: "image/jpeg", ext: ".jpg", test: b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/webp", ext: ".webp", test: b => b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP" },
  { mime: "image/gif", ext: ".gif", test: b => b.length > 6 && b.toString("ascii", 0, 3) === "GIF" },
];

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

export function detectFormat(buffer) {
  return FORMATS.find(f => f.test(buffer)) ?? null;
}

export function imageSize(buffer) {
  const format = detectFormat(buffer);
  try {
    if (format?.mime === "image/png" && buffer.length >= 24) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if (format?.mime === "image/gif" && buffer.length >= 10) {
      return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    }
    if (format?.mime === "image/jpeg") {
      let i = 2;
      while (i + 9 < buffer.length) {
        if (buffer[i] !== 0xff) return null;
        const marker = buffer[i + 1];
        const len = buffer.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function slugify(text, maxWords = 6, maxLength = 48) {
  const words = String(text ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, maxWords);
  let slug = words.join("-");
  if (slug.length > maxLength) slug = slug.slice(0, maxLength).replace(/-+[^-]*$/, "") || slug.slice(0, maxLength);
  return slug || "image";
}

export function timestamp(date = new Date()) {
  const p = n => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

export function planTargets({ outputPath, baseDir, prompt, count, date = new Date() }) {
  const defaultDir = path.join(baseDir, "generated-images");
  let dir = defaultDir;
  let stem = `${timestamp(date)}_${slugify(prompt)}`;
  if (outputPath) {
    const resolved = path.resolve(baseDir, outputPath);
    const ext = path.extname(resolved).toLowerCase();
    if (IMAGE_EXTS.has(ext)) {
      dir = path.dirname(resolved);
      stem = path.basename(resolved, path.extname(resolved));
    } else {
      dir = resolved;
    }
  }
  return Array.from({ length: count }, (_, i) => ({ dir, stem: count > 1 ? `${stem}_${i + 1}` : stem }));
}

export async function writeUnique(dir, stem, ext, buffer) {
  await fs.mkdir(dir, { recursive: true });
  for (let n = 1; n < 10_000; n++) {
    const file = path.join(dir, `${n === 1 ? stem : `${stem}-${n}`}${ext}`);
    try {
      await fs.writeFile(file, buffer, { flag: "wx" });
      return file;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
  }
  throw new Error(`Could not find a free file name for ${path.join(dir, stem + ext)}`);
}

export async function resolveReferenceImages(paths, baseDir) {
  const resolved = [];
  for (const p of paths ?? []) {
    const abs = path.resolve(baseDir, p);
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      throw new Error(`Reference image not found: ${abs}`);
    }
    if (!stat.isFile()) throw new Error(`Reference image is not a file: ${abs}`);
    const handle = await fs.open(abs, "r");
    let head;
    try {
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(16), 0, 16, 0);
      head = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
    if (!detectFormat(head)) {
      throw new Error(`Reference image must be PNG, JPEG, WebP or GIF: ${abs}`);
    }
    resolved.push(abs);
  }
  return resolved;
}
