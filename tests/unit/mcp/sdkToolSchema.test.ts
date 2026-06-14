import { describe, it, expect } from "vitest";
import { jsonSchemaToZodShape } from "../../../src/mcp/sdkToolSchema";
import type { CanonicalToolDefinition } from "../../../src/tools/types";

function shapeFor(parameters: CanonicalToolDefinition["parameters"]) {
  return jsonSchemaToZodShape(parameters);
}

describe("jsonSchemaToZodShape", () => {
  it("marks required fields as required and others as optional", () => {
    const shape = shapeFor({
      type: "object",
      properties: {
        query: { type: "string" },
        top_k: { type: "number" },
      },
      required: ["query"],
    });

    expect(shape.query.safeParse(undefined).success).toBe(false);
    expect(shape.top_k.safeParse(undefined).success).toBe(true);
    expect(shape.query.safeParse("hello").success).toBe(true);
    expect(shape.top_k.safeParse(5).success).toBe(true);
  });

  it("validates primitive types", () => {
    const shape = shapeFor({
      type: "object",
      properties: {
        name: { type: "string" },
        count: { type: "number" },
        flag: { type: "boolean" },
      },
      required: ["name", "count", "flag"],
    });

    expect(shape.name.safeParse(1).success).toBe(false);
    expect(shape.count.safeParse("nope").success).toBe(false);
    expect(shape.flag.safeParse(true).success).toBe(true);
  });

  it("restricts string enums to their allowed values", () => {
    const shape = shapeFor({
      type: "object",
      properties: {
        action: { type: "string", enum: ["set", "remove"] },
      },
      required: ["action"],
    });

    expect(shape.action.safeParse("set").success).toBe(true);
    expect(shape.action.safeParse("delete").success).toBe(false);
  });

  it("validates arrays of a primitive item type", () => {
    const shape = shapeFor({
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" } },
      },
      required: ["paths"],
    });

    expect(shape.paths.safeParse(["a", "b"]).success).toBe(true);
    expect(shape.paths.safeParse([1]).success).toBe(false);
  });

  it("validates nested arrays of objects with their own required fields", () => {
    const shape = shapeFor({
      type: "object",
      properties: {
        operations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              key: { type: "string" },
              value: { type: "string" },
              action: { type: "string", enum: ["set", "remove"] },
            },
            required: ["key", "action"],
          },
        },
      },
      required: ["operations"],
    });

    expect(
      shape.operations.safeParse([{ key: "title", action: "set", value: "x" }]).success,
    ).toBe(true);
    // Missing the required nested `action`.
    expect(shape.operations.safeParse([{ key: "title" }]).success).toBe(false);
    // `value` is optional, so omitting it is fine.
    expect(shape.operations.safeParse([{ key: "title", action: "remove" }]).success).toBe(true);
  });
});
