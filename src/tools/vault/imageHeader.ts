/**
 * Pixel dimensions from an image's header bytes, for the four formats `read`'s image
 * pathway accepts (RFC-0021 P6, ADR-0041). Pure, no Obsidian, no disk, no codec: it
 * reads the few fields each container puts near the front and nothing else, so it
 * cannot decode, resize, or validate a picture, only measure one.
 *
 * Every unrecognised or truncated input returns `null`, which omits the dimensions
 * from the result stub rather than failing the read. Dimensions are reported, never
 * gated (RFC-0021 D8), so a `null` costs the model one line of description and
 * nothing else.
 */

export interface ImageDimensions {
  width: number;
  height: number;
}

/** The PNG signature, then the first chunk must be IHDR for a valid file. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function readImageDimensions(bytes: Uint8Array): ImageDimensions | null {
  return (
    readPng(bytes) ?? readGif(bytes) ?? readJpeg(bytes) ?? readWebp(bytes) ?? null
  );
}

/** PNG: IHDR's width and height are two big-endian uint32s at offset 16. */
function readPng(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 24 || !startsWith(bytes, PNG_SIGNATURE, 0)) return null;
  if (!matchesAscii(bytes, "IHDR", 12)) return null;
  return dimensions(readUint32BE(bytes, 16), readUint32BE(bytes, 20));
}

/** GIF: the logical screen descriptor's two little-endian uint16s at offset 6. */
function readGif(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 10 || !matchesAscii(bytes, "GIF", 0)) return null;
  if (!matchesAscii(bytes, "87a", 3) && !matchesAscii(bytes, "89a", 3)) return null;
  return dimensions(readUint16LE(bytes, 6), readUint16LE(bytes, 8));
}

/**
 * JPEG carries no size at a fixed offset: the frame header sits in one of the
 * segments after SOI, so the marker chain is walked until a start-of-frame appears.
 * The three markers inside the SOF numeric range that are NOT frames (DHT 0xC4,
 * JPG 0xC8, DAC 0xCC) are skipped like any other segment, and a segment whose
 * declared length would run past the end ends the walk.
 */
function readJpeg(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    // Fill bytes: any run of 0xFF before a marker is padding.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // Standalone markers carry no length: the restart markers and SOI / EOI / TEM.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    const segmentLength = readUint16BE(bytes, offset + 2);
    if (segmentLength < 2) return null;
    if (isStartOfFrame(marker)) {
      // Length, then one precision byte, then height and width as uint16s.
      if (offset + 8 >= bytes.length) return null;
      return dimensions(readUint16BE(bytes, offset + 7), readUint16BE(bytes, offset + 5));
    }
    offset += 2 + segmentLength;
  }
  return null;
}

/** SOF0 to SOF15, minus the three markers in that range that are not frames. */
function isStartOfFrame(marker: number): boolean {
  if (marker < 0xc0 || marker > 0xcf) return false;
  return marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/**
 * WebP: a RIFF container whose first chunk decides the layout. Lossy (`VP8 `) puts
 * two 14-bit values after the sync code; lossless (`VP8L`) packs two 14-bit
 * values minus one into a bit stream; extended (`VP8X`) carries the canvas size as
 * two 24-bit values minus one, which is the one to trust when it is present, since
 * an animation's frames may be smaller than the canvas.
 */
function readWebp(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 16 || !matchesAscii(bytes, "RIFF", 0) || !matchesAscii(bytes, "WEBP", 8)) {
    return null;
  }
  if (matchesAscii(bytes, "VP8X", 12)) {
    if (bytes.length < 30) return null;
    return dimensions(readUint24LE(bytes, 24) + 1, readUint24LE(bytes, 27) + 1);
  }
  if (matchesAscii(bytes, "VP8L", 12)) {
    if (bytes.length < 25) return null;
    const packed =
      bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
    return dimensions((packed & 0x3fff) + 1, ((packed >>> 14) & 0x3fff) + 1);
  }
  if (matchesAscii(bytes, "VP8 ", 12)) {
    if (bytes.length < 30) return null;
    // The 3-byte sync code must be there, or the frame header is not where it looks.
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return dimensions(readUint16LE(bytes, 26) & 0x3fff, readUint16LE(bytes, 28) & 0x3fff);
  }
  return null;
}

/** A pair is reported only when both edges are real pixels. */
function dimensions(width: number, height: number): ImageDimensions | null {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

function startsWith(bytes: Uint8Array, expected: number[], offset: number): boolean {
  if (bytes.length < offset + expected.length) return false;
  return expected.every((value, index) => bytes[offset + index] === value);
}

function matchesAscii(bytes: Uint8Array, text: string, offset: number): boolean {
  return startsWith(
    bytes,
    [...text].map((char) => char.charCodeAt(0)),
    offset,
  );
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000 +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  );
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}
