import { describe, it, expect } from "vitest";
import { jsonSchemaToZodShape } from "../../../src/mcp/sdkToolSchema";
import type { CanonicalToolDefinition } from "../../../src/tools/types";
import { ASK_USER_TOOL } from "../../../src/tools/ask/definition";
import { RECALL_MEMORY_TOOL } from "../../../src/tools/memory/definition";

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

  it("converts the recall_memory names array without losing its item schema", () => {
    const shape = shapeFor(RECALL_MEMORY_TOOL.parameters);
    expect(shape.names.safeParse(["vault-tone", "project-state"]).success).toBe(true);
    expect(shape.names.safeParse("vault-tone").success).toBe(false);
    expect(shape.names.safeParse(["vault-tone", 2]).success).toBe(false);
  });

  it("accepts either alternative of an anyOf union (string or array of strings)", () => {
    const shape = shapeFor({
      type: "object",
      properties: {
        value: {
          anyOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
        },
      },
      required: ["value"],
    });

    expect(shape.value.safeParse("scalar").success).toBe(true);
    expect(shape.value.safeParse(["a", "b"]).success).toBe(true);
    expect(shape.value.safeParse([1, 2]).success).toBe(false);
    expect(shape.value.safeParse(42).success).toBe(false);
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

  it("round-trips the ask_user array of questions and nested option arrays", () => {
    const shape = shapeFor(ASK_USER_TOOL.parameters);
    const valid = [{
      question: "Which output shape?",
      header: "Output",
      options: [
        { label: "Concise", description: "Keep it short." },
        { label: "Detailed", description: "Include rationale." },
      ],
      multiSelect: false,
    }];

    expect(shape.questions.safeParse(valid).success).toBe(true);
    expect(shape.questions.safeParse([{ ...valid[0], multiSelect: "false" }]).success).toBe(false);
    expect(shape.questions.safeParse([{
      ...valid[0],
      options: [{ label: "Concise" }, valid[0].options[1]],
    }]).success).toBe(false);
    expect(shape.questions.safeParse([{ ...valid[0], options: "Concise" }]).success).toBe(false);
  });
});
