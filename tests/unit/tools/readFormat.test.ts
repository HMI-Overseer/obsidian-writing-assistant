import { describe, test, expect } from "vitest";
import { formatWithLineNumbers } from "../../../src/tools/vault/readFormat";

describe("formatWithLineNumbers", () => {
  test("prefixes each line with a 1-indexed number and a tab", () => {
    expect(formatWithLineNumbers("alpha\nbeta\ngamma")).toBe("1\talpha\n2\tbeta\n3\tgamma");
  });

  test("right-aligns numbers to the width of the largest line number", () => {
    const body = Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join("\n");
    const out = formatWithLineNumbers(body).split("\n");
    // 10 lines -> width 2: line 1 is " 1", line 10 is "10".
    expect(out[0]).toBe(" 1\tL1");
    expect(out[9]).toBe("10\tL10");
  });

  test("drops the phantom final line a trailing newline produces (cat -n)", () => {
    expect(formatWithLineNumbers("one\ntwo\n")).toBe("1\tone\n2\ttwo");
  });

  test("renders an empty note as the empty string (nothing to number)", () => {
    expect(formatWithLineNumbers("")).toBe("");
  });

  test("numbers a single line with no trailing newline", () => {
    expect(formatWithLineNumbers("only line")).toBe("1\tonly line");
  });

  test("starts numbering at startLine so a section read matches read's numbers", () => {
    expect(formatWithLineNumbers("five\nsix", 5)).toBe("5\tfive\n6\tsix");
  });

  test("widths align to the largest absolute line number when offset", () => {
    // startLine 8, two lines -> max line 9, width 1.
    expect(formatWithLineNumbers("a\nb", 8)).toBe("8\ta\n9\tb");
    // startLine 9, two lines -> max line 10, width 2 (the offset line aligns).
    expect(formatWithLineNumbers("a\nb", 9)).toBe(" 9\ta\n10\tb");
  });
});
