import { describe, test, expect } from "vitest";
import {
  validateProposeEdit,
  validateUpdateFrontmatter,
} from "../../../src/tools/editing/validation";

describe("validateProposeEdit", () => {
  test("accepts valid args", () => {
    const result = validateProposeEdit({ search: "old", replace: "new" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args.search).toBe("old");
      expect(result.args.replace).toBe("new");
    }
  });

  test("accepts empty replace for deletions", () => {
    const result = validateProposeEdit({ search: "old", replace: "" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.args.replace).toBe("");
  });

  test("treats undefined replace as empty string", () => {
    const result = validateProposeEdit({ search: "old" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.args.replace).toBe("");
  });

  test("rejects non-string search", () => {
    const result = validateProposeEdit({ search: 123, replace: "new" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("search must be a string");
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
