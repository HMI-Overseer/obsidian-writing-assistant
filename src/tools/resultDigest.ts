/**
 * Replay-capture helpers for the claudecode cold rebuild (issue
 * docs/work/issues/claude-code-cold-rebuild-fidelity.md, phase 2).
 *
 * At the two tool-result choke points (Claude Code's `callTool` end event and the
 * plugin tool loop) we now record, per {@link ../shared/types.AgenticStep}, what a
 * later rebuild needs but the flat prose transcript never held: the real
 * disposition of a reviewed op, a compact pointers-only digest of a discovery
 * result, and a bounded copy of the full result text. Nothing here is sent to the
 * API this phase; phase 3's replay digest reads these fields.
 *
 * Pure: no Obsidian, no disk, so the four-outcome digest contract (§A.1) is
 * unit-testable string by string.
 */

import type { VaultOpDisposition } from "../vault-ops/disposition";

/**
 * Cline's production `TOOL_RESULT_CHAR_LIMIT` (§6.2.1, issue question 9): the cap on
 * a stored full-result record, so vault content riding the conversation JSON stays a
 * bounded, linear footprint rather than duplicating whole notes.
 */
export const TOOL_RESULT_CHAR_LIMIT = 2000;

/** Appended to a record truncated at {@link TOOL_RESULT_CHAR_LIMIT} so a bounded
 *  record is distinguishable from a complete one. */
export const RESULT_TRUNCATION_MARKER = " …[truncated]";

/** The result fields the choke points hand a step, the input to {@link captureStepFields}. */
export interface ResolvedToolResult {
  /** The tool result text returned to the model. */
  content: string;
  /** Whether the call errored (failed / policy-denied); declines resolve `false`. */
  isError?: boolean;
  /** The reviewed op's real disposition, when this call went through review. */
  disposition?: VaultOpDisposition;
}

/** The phase-2 capture fields merged onto an {@link ../shared/types.AgenticStep}. */
export interface StepCaptureFields {
  resultDigest?: string;
  resultRecord?: string;
  disposition?: VaultOpDisposition;
}

/**
 * Bound a tool result for the stored record. A result over the cap keeps its first
 * {@link TOOL_RESULT_CHAR_LIMIT} chars plus a truncation marker; a shorter one is
 * stored whole.
 */
export function boundToolResult(content: string): string {
  if (content.length <= TOOL_RESULT_CHAR_LIMIT) return content;
  return content.slice(0, TOOL_RESULT_CHAR_LIMIT) + RESULT_TRUNCATION_MARKER;
}

/**
 * Compute every phase-2 capture field for one tool_call step from its resolved
 * result. The single source both choke points call, so neither can drift. Returns
 * only the fields that apply: an empty object for a call with no content, no
 * disposition, and no discovery digest (spreading it then adds nothing, preserving
 * pre-phase behavior for such calls).
 */
export function captureStepFields(
  toolName: string,
  args: Record<string, unknown>,
  result: ResolvedToolResult,
): StepCaptureFields {
  const fields: StepCaptureFields = {};
  const digest = formatResultDigest(toolName, args, result);
  if (digest !== undefined) fields.resultDigest = digest;
  if (result.content) fields.resultRecord = boundToolResult(result.content);
  if (result.disposition !== undefined) fields.disposition = result.disposition;
  return fields;
}

/**
 * Discovery-class tools whose *results* are pointers the args don't already carry
 * (§A.1): the rebuilt model can re-ground any pointer in one cheap call, so replay
 * stays pointers rather than chunk content. Path→content tools (`read_file`,
 * `read_section`) and listing tools (`list_directory`) get no digest, their args
 * are the pointer, or the view is re-derivable.
 */
const DISCOVERY_DIGEST_TOOLS = new Set([
  "semantic_search",
  "search_content",
  "search_files",
  "get_backlinks",
  "find_notes_by_tag",
]);

/** Max pointers a hits digest lists, and its char budget (§A.1). */
const MAX_DIGEST_POINTERS = 8;
const MAX_DIGEST_CHARS = 500;

/**
 * A compact, pointers-only digest of a discovery-tool result for phase-3 replay
 * (§A.1's four-outcome contract), or `undefined` for any non-discovery tool. Never
 * carries scores or chunk content, both non-reproducible and decision-irrelevant on
 * replay.
 */
export function formatResultDigest(
  toolName: string,
  args: Record<string, unknown>,
  result: { content: string; isError?: boolean },
): string | undefined {
  if (!DISCOVERY_DIGEST_TOOLS.has(toolName)) return undefined;

  const head = `${toolName}: "${digestKeyArg(toolName, args)}"`;

  // invalid-args + unavailable: replay the failure so the rebuilt model knows why it
  // historically fell back (e.g. to search_content).
  if (result.isError) {
    return `[${head}, FAILED: ${firstSentence(result.content)}]`;
  }

  // Empty result: ran fine, found nothing. Every handler's empty message opens "No ";
  // a hit result never does. Load-bearing on replay: without it the model can neither
  // trust nor rule out its own earlier retrieval.
  if (result.content.trimStart().startsWith("No ")) {
    return `[${head}, no results]`;
  }

  const pointers = extractPointers(toolName, result.content);
  if (pointers.length === 0) return `[${head}, no results]`;
  return `[${head}, surfaced: ${boundPointers(pointers)}]`;
}

/** The key argument a discovery tool digests under (its query / pattern / path / tag). */
function digestKeyArg(toolName: string, args: Record<string, unknown>): string {
  const raw =
    toolName === "search_files"
      ? args.pattern
      : toolName === "get_backlinks"
        ? args.path
        : toolName === "find_notes_by_tag"
          ? args.tag
          : args.query; // semantic_search, search_content
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * The first sentence of an error result, "Error:" prefix stripped, for the FAILED
 * digest line. A sentence boundary is a period followed by whitespace or end.
 */
function firstSentence(text: string): string {
  const body = text.trim().replace(/^Error:\s*/, "");
  const boundary = body.search(/\.(?:\s|$)/);
  return (boundary >= 0 ? body.slice(0, boundary) : body).trim();
}

/**
 * Extract the pointer list from a hit result, per tool. `semantic_search` yields
 * `path > heading` (exactly `read_section`'s args); the lexical / link / tag tools
 * yield vault paths the model can `read_file`. Never chunk content.
 */
function extractPointers(toolName: string, content: string): string[] {
  if (toolName === "semantic_search") {
    // Header + per chunk `[filePath > headingPath] (score) \n <chunk content>`.
    const pointers: string[] = [];
    const re = /^\[([^\]]+)\] \(score:/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) pointers.push(m[1].trim());
    return pointers;
  }

  if (toolName === "search_content") {
    // `path:line: snippet` (no context) or `[path]` block headers (with context);
    // collect the distinct file paths, first-seen order.
    const seen = new Set<string>();
    for (const line of content.split("\n")) {
      const bracket = /^\[(.+)\]$/.exec(line);
      const grep = /^(.+?):\d+: /.exec(line);
      const path = bracket ? bracket[1] : grep ? grep[1] : null;
      if (path) seen.add(path.trim());
    }
    return [...seen];
  }

  // search_files / get_backlinks / find_notes_by_tag share one shape: a `… (N):`
  // header line, then one vault path per line.
  return content
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Cap a pointer list to {@link MAX_DIGEST_POINTERS} entries and {@link MAX_DIGEST_CHARS}. */
function boundPointers(pointers: string[]): string {
  const shown = pointers.slice(0, MAX_DIGEST_POINTERS);
  let joined = shown.join("; ");
  if (joined.length > MAX_DIGEST_CHARS) {
    joined = joined.slice(0, MAX_DIGEST_CHARS - 1) + "…";
  } else if (pointers.length > shown.length) {
    joined += "; …";
  }
  return joined;
}
