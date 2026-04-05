import { describe, test, expect } from "vitest";
import {
  validateGetLineRange,
  validateApplyEdit,
  validateReplaceSection,
  validateInsertAtPosition,
  validateUpdateFrontmatter,
} from "../../../src/tools/editing/validation";

describe("validateGetLineRange", () => {
  test("accepts valid args", () => {
    const result = validateGetLineRange({ start_line: 1, end_line: 10 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args.start_line).toBe(1);
      expect(result.args.end_line).toBe(10);
    }
  });

  test("accepts without end_line", () => {
    const result = validateGetLineRange({ start_line: 5 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args.end_line).toBeUndefined();
    }
  });

  test("rejects non-number start_line", () => {
    const result = validateGetLineRange({ start_line: "5" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("start_line must be a finite number");
  });

  test("rejects missing start_line", () => {
    const result = validateGetLineRange({});
    expect(result.ok).toBe(false);
  });

  test("rejects start_line < 1", () => {
    const result = validateGetLineRange({ start_line: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(">= 1");
  });

  test("rejects non-number end_line", () => {
    const result = validateGetLineRange({ start_line: 1, end_line: "10" });
    expect(result.ok).toBe(false);
  });
});

describe("validateApplyEdit", () => {
  test("accepts valid args", () => {
    const result = validateApplyEdit({ search: "old", replace: "new" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args.search).toBe("old");
      expect(result.args.replace).toBe("new");
    }
  });

  test("accepts empty replace for deletions", () => {
    const result = validateApplyEdit({ search: "old", replace: "" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.args.replace).toBe("");
  });

  test("treats undefined replace as empty string", () => {
    const result = validateApplyEdit({ search: "old" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.args.replace).toBe("");
  });

  test("rejects non-string search", () => {
    const result = validateApplyEdit({ search: 123, replace: "new" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("search must be a string");
  });
});

describe("validateReplaceSection", () => {
  test("accepts valid args", () => {
    const result = validateReplaceSection({ heading: "Intro", new_content: "New text" });
    expect(result.ok).toBe(true);
  });

  test("rejects empty heading", () => {
    const result = validateReplaceSection({ heading: "", new_content: "text" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("non-empty string");
  });

  test("rejects non-string new_content", () => {
    const result = validateReplaceSection({ heading: "H", new_content: 42 });
    expect(result.ok).toBe(false);
  });
});

describe("validateInsertAtPosition", () => {
  test("accepts with after_heading", () => {
    const result = validateInsertAtPosition({ text: "new", after_heading: "H1" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args.after_heading).toBe("H1");
      expect(result.args.line_number).toBeUndefined();
    }
  });

  test("accepts with line_number", () => {
    const result = validateInsertAtPosition({ text: "new", line_number: 5 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args.line_number).toBe(5);
      expect(result.args.after_heading).toBeUndefined();
    }
  });

  test("accepts line_number -1 (end of file)", () => {
    const result = validateInsertAtPosition({ text: "new", line_number: -1 });
    expect(result.ok).toBe(true);
  });

  test("accepts line_number 0 (beginning of file)", () => {
    const result = validateInsertAtPosition({ text: "new", line_number: 0 });
    expect(result.ok).toBe(true);
  });

  test("rejects both after_heading and line_number", () => {
    const result = validateInsertAtPosition({ text: "new", after_heading: "H", line_number: 5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not both");
  });

  test("rejects neither after_heading nor line_number", () => {
    const result = validateInsertAtPosition({ text: "new" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Provide either");
  });

  test("rejects non-string text", () => {
    const result = validateInsertAtPosition({ text: 42, line_number: 1 });
    expect(result.ok).toBe(false);
  });
});

describe("validateUpdateFrontmatter", () => {
  test("accepts valid operations", () => {
    const result = validateUpdateFrontmatter({
      operations: [
        { key: "tags", value: "test", action: "set" },
        { key: "draft", action: "remove" },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args.operations).toHaveLength(2);
      expect(result.args.operations[0].action).toBe("set");
      expect(result.args.operations[1].action).toBe("remove");
    }
  });

  test("auto-wraps flat key/action/value args into operations array", () => {
    const result = validateUpdateFrontmatter({
      key: "status",
      value: "published",
      action: "set",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args.operations).toHaveLength(1);
      expect(result.args.operations[0]).toEqual({
        key: "status",
        value: "published",
        action: "set",
      });
    }
  });

  test("auto-wraps flat remove operation", () => {
    const result = validateUpdateFrontmatter({
      key: "draft",
      action: "remove",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args.operations).toHaveLength(1);
      expect(result.args.operations[0].action).toBe("remove");
    }
  });

  test("rejects non-array operations", () => {
    const result = validateUpdateFrontmatter({ operations: "not an array" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("must be an array");
  });

  test("rejects empty operations", () => {
    const result = validateUpdateFrontmatter({ operations: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("must not be empty");
  });

  test("rejects operation with invalid action", () => {
    const result = validateUpdateFrontmatter({
      operations: [{ key: "tags", action: "update" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('"set" or "remove"');
  });

  test("rejects operation with empty key", () => {
    const result = validateUpdateFrontmatter({
      operations: [{ key: "", action: "set" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("non-empty string");
  });

  test("rejects operation with non-string value for set", () => {
    const result = validateUpdateFrontmatter({
      operations: [{ key: "count", value: 42, action: "set" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("must be a string");
  });
});
