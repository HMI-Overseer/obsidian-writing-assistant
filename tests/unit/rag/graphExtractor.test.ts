import { describe, test, expect } from "vitest";
import { parseExtractionResponse } from "../../../src/rag/graph/extractor";

describe("parseExtractionResponse", () => {
  test("parses valid JSON response", () => {
    const input = JSON.stringify({
      entities: [
        { name: "Alice", type: "character", description: "A knight" },
      ],
      relationships: [
        { source: "Alice", target: "Bob", type: "allies with", description: "Old friends" },
      ],
    });

    const result = parseExtractionResponse(input);
    expect(result).not.toBeNull();
    expect(result!.entities).toHaveLength(1);
    expect(result!.entities[0].name).toBe("Alice");
    expect(result!.relationships).toHaveLength(1);
    expect(result!.relationships[0].type).toBe("allies with");
  });

  test("handles markdown code fences", () => {
    const input = `\`\`\`json
{
  "entities": [
    { "name": "Alice", "type": "character", "description": "A knight" }
  ],
  "relationships": []
}
\`\`\``;

    const result = parseExtractionResponse(input);
    expect(result).not.toBeNull();
    expect(result!.entities).toHaveLength(1);
  });

  test("handles leading/trailing text around JSON", () => {
    const input = `Here are the extracted entities:
{
  "entities": [{ "name": "Bob", "type": "character", "description": "A wizard" }],
  "relationships": []
}
That's all I found.`;

    const result = parseExtractionResponse(input);
    expect(result).not.toBeNull();
    expect(result!.entities).toHaveLength(1);
    expect(result!.entities[0].name).toBe("Bob");
  });

  test("returns null for completely invalid input", () => {
    expect(parseExtractionResponse("no json here")).toBeNull();
    expect(parseExtractionResponse("")).toBeNull();
    expect(parseExtractionResponse("{{bad json}}")).toBeNull();
  });

  test("returns null for JSON without braces", () => {
    expect(parseExtractionResponse("[1, 2, 3]")).toBeNull();
  });

  test("filters out malformed entities", () => {
    const input = JSON.stringify({
      entities: [
        { name: "Alice", type: "character", description: "Valid" },
        { name: 123, type: "character", description: "Invalid name type" },
        { name: "Bob" }, // Missing required fields
        { name: "Charlie", type: "character", description: "Also valid" },
      ],
      relationships: [],
    });

    const result = parseExtractionResponse(input);
    expect(result).not.toBeNull();
    expect(result!.entities).toHaveLength(2);
    expect(result!.entities[0].name).toBe("Alice");
    expect(result!.entities[1].name).toBe("Charlie");
  });

  test("filters out malformed relationships", () => {
    const input = JSON.stringify({
      entities: [],
      relationships: [
        { source: "Alice", target: "Bob", type: "knows", description: "Valid" },
        { source: "Alice", target: 123, type: "invalid", description: "Bad target" },
        { source: "Alice" }, // Missing fields
      ],
    });

    const result = parseExtractionResponse(input);
    expect(result).not.toBeNull();
    expect(result!.relationships).toHaveLength(1);
    expect(result!.relationships[0].source).toBe("Alice");
  });

  test("handles empty entities and relationships", () => {
    const input = JSON.stringify({
      entities: [],
      relationships: [],
    });

    const result = parseExtractionResponse(input);
    expect(result).not.toBeNull();
    expect(result!.entities).toHaveLength(0);
    expect(result!.relationships).toHaveLength(0);
  });

  test("handles missing entities or relationships keys", () => {
    const input = JSON.stringify({ foo: "bar" });
    const result = parseExtractionResponse(input);
    expect(result).not.toBeNull();
    expect(result!.entities).toHaveLength(0);
    expect(result!.relationships).toHaveLength(0);
  });
});
