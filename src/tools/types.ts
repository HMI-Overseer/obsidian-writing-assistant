/** JSON Schema subset for tool parameter definitions. */
export interface JsonSchemaProperty {
  type: "string" | "number" | "boolean" | "array" | "object";
  description?: string;
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  enum?: string[];
}

/** Provider-agnostic tool definition. */
export interface CanonicalToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, JsonSchemaProperty>;
    required: string[];
  };
}

/** A parsed tool call from a model response. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
