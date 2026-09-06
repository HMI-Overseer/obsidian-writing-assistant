import { describe, test, expect } from "vitest";
import { readImageDimensions } from "../../../src/tools/vault/imageHeader";

// Hand-built headers, byte by byte: the parser reads the four formats the read
// pathway accepts and returns null for anything it does not recognise, so an
// unreadable header omits the dimensions from the stub instead of failing the read
// (RFC-0021 P6).

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function ascii(text: string): Uint8Array {
  return new Uint8Array([...text].map((char) => char.charCodeAt(0)));
}

/** big-endian uint32 */
function be32(value: number): Uint8Array {
  return bytes(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  );
}

/** little-endian uint16 */
function le16(value: number): Uint8Array {
  return bytes(value & 0xff, (value >>> 8) & 0xff);
}

const PNG_SIGNATURE = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

function png(width: number, height: number): Uint8Array {
  return concat(
    PNG_SIGNATURE,
    be32(13),
    ascii("IHDR"),
    be32(width),
    be32(height),
    bytes(8, 6, 0, 0, 0),
  );
}

function gif(width: number, height: number, version = "89a"): Uint8Array {
  return concat(ascii(`GIF${version}`), le16(width), le16(height), bytes(0xf7, 0x00, 0x00));
}

/** A JPEG with a DHT segment before the SOF0, so a naive parser reads the wrong one. */
function jpeg(width: number, height: number, sofMarker = 0xc0): Uint8Array {
  return concat(
    bytes(0xff, 0xd8),
    // APP0/JFIF, length 16.
    bytes(0xff, 0xe0, 0x00, 0x10),
    ascii("JFIF\0"),
    bytes(0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00),
    // DHT, which is 0xC4 and must NOT be read as a start-of-frame.
    bytes(0xff, 0xc4, 0x00, 0x06, 0x00, 0x01, 0x02, 0x03),
    // Start of frame: length, precision, height, width, components.
    bytes(0xff, sofMarker, 0x00, 0x11, 0x08),
    bytes((height >>> 8) & 0xff, height & 0xff),
    bytes((width >>> 8) & 0xff, width & 0xff),
    bytes(0x03),
  );
}

function riff(chunk: Uint8Array): Uint8Array {
  return concat(ascii("RIFF"), le16(chunk.length + 4), le16(0), ascii("WEBP"), chunk);
}

function webpLossy(width: number, height: number): Uint8Array {
  return riff(
    concat(
      ascii("VP8 "),
      be32(0),
      bytes(0x00, 0x00, 0x00),
      bytes(0x9d, 0x01, 0x2a),
      le16(width),
      le16(height),
    ),
  );
}

function webpLossless(width: number, height: number): Uint8Array {
  // 14 bits of (width - 1) then 14 bits of (height - 1), little-endian bit order.
  const packed = (width - 1) | ((height - 1) << 14);
  return riff(
    concat(
      ascii("VP8L"),
      be32(0),
      bytes(0x2f),
      bytes(packed & 0xff, (packed >>> 8) & 0xff, (packed >>> 16) & 0xff, (packed >>> 24) & 0xff),
    ),
  );
}

function webpExtended(width: number, height: number): Uint8Array {
  const w = width - 1;
  const h = height - 1;
  return riff(
    concat(
      ascii("VP8X"),
      be32(10),
      bytes(0x10),
      bytes(0x00, 0x00, 0x00),
      bytes(w & 0xff, (w >>> 8) & 0xff, (w >>> 16) & 0xff),
      bytes(h & 0xff, (h >>> 8) & 0xff, (h >>> 16) & 0xff),
    ),
  );
}

describe("readImageDimensions", () => {
  test("reads a PNG IHDR", () => {
    expect(readImageDimensions(png(1024, 768))).toEqual({ width: 1024, height: 768 });
    expect(readImageDimensions(png(1, 1))).toEqual({ width: 1, height: 1 });
  });

  test("reads a GIF logical screen, little-endian, both versions", () => {
    expect(readImageDimensions(gif(640, 480))).toEqual({ width: 640, height: 480 });
    expect(readImageDimensions(gif(300, 200, "87a"))).toEqual({ width: 300, height: 200 });
  });

  test("walks JPEG markers to the first real start-of-frame", () => {
    expect(readImageDimensions(jpeg(800, 600))).toEqual({ width: 800, height: 600 });
    // Progressive (SOF2) and the arithmetic-coded variants are frames too.
    expect(readImageDimensions(jpeg(320, 240, 0xc2))).toEqual({ width: 320, height: 240 });
    expect(readImageDimensions(jpeg(64, 32, 0xcf))).toEqual({ width: 64, height: 32 });
  });

  test("does not read DHT, JPG or DAC as a start-of-frame", () => {
    // 0xC4 DHT, 0xC8 JPG and 0xCC DAC carry no frame header; a JPEG whose only
    // candidate marker is one of them has no dimensions to report.
    for (const marker of [0xc4, 0xc8, 0xcc]) {
      const noFrame = concat(
        bytes(0xff, 0xd8),
        bytes(0xff, marker, 0x00, 0x11, 0x08),
        bytes(0x02, 0x58, 0x03, 0x20, 0x03),
      );
      expect(readImageDimensions(noFrame)).toBeNull();
    }
  });

  test("reads the three WebP chunk layouts", () => {
    expect(readImageDimensions(webpLossy(1200, 900))).toEqual({ width: 1200, height: 900 });
    expect(readImageDimensions(webpLossless(1200, 900))).toEqual({ width: 1200, height: 900 });
    expect(readImageDimensions(webpExtended(4096, 2048))).toEqual({ width: 4096, height: 2048 });
  });

  test("returns null for truncated headers rather than a guess", () => {
    expect(readImageDimensions(png(1024, 768).subarray(0, 20))).toBeNull();
    expect(readImageDimensions(gif(640, 480).subarray(0, 7))).toBeNull();
    expect(readImageDimensions(webpLossy(100, 100).subarray(0, 25))).toBeNull();
    expect(readImageDimensions(bytes(0xff, 0xd8))).toBeNull();
    expect(readImageDimensions(new Uint8Array(0))).toBeNull();
  });

  test("returns null for garbage and for an unsupported format", () => {
    expect(readImageDimensions(ascii("not an image at all, just prose"))).toBeNull();
    // A BMP: a real image header the pathway does not accept.
    expect(readImageDimensions(concat(ascii("BM"), be32(70), be32(0)))).toBeNull();
    // PNG signature with the wrong chunk name where IHDR must be.
    expect(
      readImageDimensions(concat(PNG_SIGNATURE, be32(13), ascii("IDAT"), be32(9), be32(9))),
    ).toBeNull();
  });
});
