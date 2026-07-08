import { z } from "zod";
import type { ZodTypeAny } from "zod";
import type { CanonicalToolDefinition, JsonSchemaProperty } from "../tools/types";

/**
 * A Zod "raw shape", the object of per-field Zod validators the Agent SDK's
 * `tool()` helper expects as its input schema. The SDK converts it back to JSON
 * Schema for the model and validates tool arguments against it.
 */
export type ZodRawShape = Record<string, ZodTypeAny>;

/**
 * Converts a provider-agnostic {@link CanonicalToolDefinition} parameter block
 * into a Zod raw shape for the SDK's `tool()`. Sibling to
 * {@link ../mcp/toolSchema.ts toMcpToolSchema}, same source of truth, different
 * wire format, so the SDK-bridged toolstack stays identical to the one the API
 * providers and the legacy HTTP MCP server advertise.
 *
 * Pure (only depends on `zod`) so it is unit-testable without the SDK.
 */
export function jsonSchemaToZodShape(
  parameters: CanonicalToolDefinition["parameters"],
): ZodRawShape {
  return propertiesToShape(parameters.properties, parameters.required);
}

function propertiesToShape(
  properties: Record<string, JsonSchemaProperty>,
  required: string[] | undefined,
): ZodRawShape {
  const requiredKeys = new Set(required ?? []);
  const shape: ZodRawShape = {};
  for (const [key, property] of Object.entries(properties)) {
    const field = propertyToZod(property);
    shape[key] = requiredKeys.has(key) ? field : field.optional();
  }
  return shape;
}

function propertyToZod(property: JsonSchemaProperty): ZodTypeAny {
  let schema = baseSchema(property);
  if (property.description) schema = schema.describe(property.description);
  return schema;
}

function baseSchema(property: JsonSchemaProperty): ZodTypeAny {
  if (property.anyOf && property.anyOf.length > 0) {
    const variants = property.anyOf.map((sub) => propertyToZod(sub));
    return variants.length === 1
      ? variants[0]
      : z.union(variants as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
  }
  switch (property.type) {
    case "string":
      return property.enum && property.enum.length > 0
        ? z.enum(property.enum as [string, ...string[]])
        : z.string();
    case "number":
      return z.number();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(property.items ? propertyToZod(property.items) : z.unknown());
    case "object":
      return property.properties
        ? z.object(propertiesToShape(property.properties, property.required))
        : z.record(z.string(), z.unknown());
    default:
      return z.unknown();
  }
}
