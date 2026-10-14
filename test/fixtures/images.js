import zlib from "node:zlib";

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function le16(value) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(value);
  return b;
}

function le32(value) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value);
  return b;
}

export function makePng(width = 3, height = 2) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x7f)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export function jpegSegment(marker, payload) {
  const header = Buffer.alloc(4);
  header[0] = 0xff;
  header[1] = marker;
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

export function makeJpeg(width = 4, height = 5, { progressive = false, before = [] } = {}) {
  const soi = Buffer.from([0xff, 0xd8]);
  const app0 = jpegSegment(0xe0, Buffer.from([0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]));
  const sofPayload = Buffer.alloc(15);
  sofPayload[0] = 8;
  sofPayload.writeUInt16BE(height, 1);
  sofPayload.writeUInt16BE(width, 3);
  sofPayload[5] = 3;
  sofPayload.set([1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1], 6);
  const sof = jpegSegment(progressive ? 0xc2 : 0xc0, sofPayload);
  return Buffer.concat([soi, app0, ...before, sof, Buffer.from([0xff, 0xd9])]);
}

export function makeGif(width = 16, height = 12) {
  return Buffer.concat([Buffer.from("GIF89a", "ascii"), le16(width), le16(height), Buffer.from([0x00, 0x00, 0x00, 0x3b])]);
}

export function makeWebp() {
  return Buffer.concat([
    Buffer.from("RIFF", "ascii"),
    le32(22),
    Buffer.from("WEBP", "ascii"),
    Buffer.from("VP8 ", "ascii"),
    le32(10),
    Buffer.alloc(10),
  ]);
}
