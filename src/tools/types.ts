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
  /**
   * One-line hint used in the exploration strategy section of the system prompt.
   * Describes *when* to reach for this tool relative to others.
   * Not sent to the API — system-prompt generation only.
   */
  strategyHint?: string;
  /**
   * What to do when this tool returns an error result.
   * Shown in the error handling section of the system prompt.
   * Not sent to the API — system-prompt generation only.
   */
  errorGuidance?: string;
}

/** A parsed tool call from a model response. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Result returned by a tool handler. */
export interface ToolResult {
  /** Text content returned to the model. */
  content: string;
  /** Whether this tool only reads data (true) or proposes document changes (false). */
  isReadOnly: boolean;
  /** Whether the tool execution failed. */
  isError?: boolean;
}
