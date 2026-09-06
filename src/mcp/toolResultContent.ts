import type { ToolResult } from "../tools/types";

/**
 * One MCP `content` array for one tool result, shared by both bridges (the in-process
 * SDK server and the legacy loopback server) so the two cannot drift on what a result
 * looks like on the wire.
 *
 * MCP carries only content items and `isError`, so a structured
 * {@link ../tools/types.ToolFailure} is flattened to its sentence by the caller: the
 * recovery contract still reaches the model through the text, and the typed kind stays
 * plugin-loop-only.
 *
 * Images ride as `image` items after the text (RFC-0021 D5, ADR-0041), which the MCP
 * 2025-06-18 schema admits beside text in the same array. The text item is emitted
 * unconditionally and first: it is the stub that names each picture, and on the Claude
 * Code path it is also the byte-identical value the SDK echoes back for the step's
 * record, so it is never rewritten or dropped when an image is present.
 */
export function toMcpContent(
  result: ToolResult,
): Array<
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
> {
  return [
    { type: "text" as const, text: result.content },
    ...(result.images ?? []).map((image) => ({
      type: "image" as const,
      data: image.data,
      mimeType: image.mimeType,
    })),
  ];
}
