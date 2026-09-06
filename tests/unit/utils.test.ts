import { describe, test, expect } from "vitest";
import { arrayBufferToBase64, formatByteCount } from "../../src/utils";
import { formatBytes } from "../../src/vault-ops/summary";

// Both helpers were lifted out of single-consumer code for the `read` image pathway
// (RFC-0021 P11): the encoder was private to noteImageContext, and the only byte
// formatter measured a string's UTF-8 length instead of taking a count.
describe("formatByteCount", () => {
  test("names bytes, kilobytes and megabytes at one decimal", () => {
    expect(formatByteCount(0)).toBe("0 B");
    expect(formatByteCount(512)).toBe("512 B");
    expect(formatByteCount(1023)).toBe("1023 B");
    expect(formatByteCount(2048)).toBe("2.0 KB");
    expect(formatByteCount(245760)).toBe("240.0 KB");
    expect(formatByteCount(1258291)).toBe("1.2 MB");
  });

  test("formatBytes measures a string and rounds through the same helper", () => {
    // The two surfaces must not round differently, so one is a wrapper over the other.
    expect(formatBytes("x".repeat(2048))).toBe(formatByteCount(2048));
    expect(formatBytes("€")).toBe(formatByteCount(3));
  });
});

describe("arrayBufferToBase64", () => {
  test("round-trips a known buffer", () => {
    expect(arrayBufferToBase64(new Uint8Array([1, 2, 3]).buffer)).toBe("AQID");
    expect(arrayBufferToBase64(new Uint8Array([4, 5, 6]).buffer)).toBe("BAUG");
    expect(arrayBufferToBase64(new Uint8Array(0).buffer)).toBe("");
  });

  test("encodes past the 0x8000 chunk boundary the same way Buffer does", () => {
    const bytes = new Uint8Array(0x8000 * 2 + 7);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) % 256;
    expect(arrayBufferToBase64(bytes.buffer)).toBe(
      Buffer.from(bytes).toString("base64"),
    );
  });
});
