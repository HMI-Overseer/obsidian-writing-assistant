/**
 * Sanitizer and validator for provider-capture protocol fixtures (RFC-0011, phase 0).
 *
 * A raw Claude Code session carries user prose, vault paths, and unbounded tool
 * results. None of that may enter the repository. This module owns the single
 * allow-list both directions depend on:
 *
 *   sanitizeCapture()  raw stream-json / SDK frames -> a bounded fixture
 *   validateFixture()  a repository fixture -> ok, or the first violation
 *
 * The allow-list is per context (frame, message, block, event, delta) and is
 * closed: a key the translator does not read is a key the fixture must not
 * carry. Every retained string is length-bounded, and identity-bearing fields
 * are rewritten to deterministic synthetic values so redelivery of the same raw
 * capture produces byte-identical output.
 *
 * Run as a CLI to convert a capture:
 *   node scripts/captureFixtures.mjs <raw.jsonl> <out.json> <case> <transport>
 */

/** Frame kinds a capture fixture may contain. Anything else is dropped. */
export const ALLOWED_FRAME_TYPES = new Set([
  "stream_event",
  "assistant",
  "user",
  "result",
]);

export const ALLOWED_FRAME_KEYS = new Set([
  "type",
  "uuid",
  "session_id",
  "request_id",
  "parent_tool_use_id",
  "subagent_type",
  "supersedes",
  "message",
  "event",
  "subtype",
  "is_error",
]);

export const ALLOWED_MESSAGE_KEYS = new Set([
  "id",
  "role",
  "model",
  "stop_reason",
  "content",
]);

export const ALLOWED_BLOCK_KEYS = new Set([
  "type",
  "text",
  "thinking",
  "signature",
  "data",
  "id",
  "name",
  "server_name",
  "input",
  "tool_use_id",
  "content",
  "is_error",
]);

export const ALLOWED_EVENT_KEYS = new Set([
  "type",
  "index",
  "message",
  "content_block",
  "delta",
]);

export const ALLOWED_DELTA_KEYS = new Set([
  "type",
  "text",
  "partial_json",
  "thinking",
  "signature",
]);

export const ALLOWED_TRANSPORTS = new Set(["sdk", "legacy-stream-json"]);

/** How the fixture's protocol bytes were obtained. Recorded, never inferred. */
export const ALLOWED_PROVENANCE = new Set([
  /** Converted from a live local capture by {@link sanitizeCapture}. */
  "captured",
  /** Hand-authored from a characterized shape the live capture did not produce. */
  "synthetic",
]);

export const MAX_FRAMES = 200;
export const MAX_STRING_LENGTH = 256;
export const MAX_FIXTURE_BYTES = 64 * 1024;

/**
 * Substrings that would betray a real session even after key filtering. The
 * Windows patterns accept one or two backslashes because the check runs against
 * the serialized fixture, where every separator is JSON-escaped.
 */
const FORBIDDEN_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]+/,
  /[A-Za-z]:\\{1,2}Users\\{1,2}/i,
  /\/Users\/[^/]+\//,
  /\/home\/[^/]+\//,
  /Bearer\s+\S+/i,
];

class CaptureFixtureError extends Error {
  constructor(message) {
    super(message);
    this.name = "CaptureFixtureError";
  }
}

/**
 * Deterministic identity rewriter. The same raw identifier always maps to the
 * same synthetic one within a capture, and the mapping is derived from first
 * appearance order only, so no wall clock or random state enters a fixture.
 */
function createAliaser() {
  const tables = new Map();
  return (kind, raw) => {
    if (raw === null || raw === undefined) return raw;
    if (typeof raw !== "string") return raw;
    let table = tables.get(kind);
    if (!table) {
      table = new Map();
      tables.set(kind, table);
    }
    const existing = table.get(raw);
    if (existing !== undefined) return existing;
    const alias = `${kind}_${table.size + 1}`;
    table.set(raw, alias);
    return alias;
  };
}

function boundedText(value, label) {
  if (typeof value !== "string") return value;
  if (value.length <= MAX_STRING_LENGTH) return value;
  throw new CaptureFixtureError(
    `${label} is ${value.length} characters, over the ${MAX_STRING_LENGTH} bound.`,
  );
}

/** Replaces model prose with bounded synthetic text of the same shape. */
function syntheticText(kind, ordinal) {
  return `${kind} fixture text ${ordinal}`;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Converts one raw frame into its sanitized form, or null when the frame kind
 * carries no protocol evidence the assembler reads.
 */
function sanitizeFrame(raw, alias, counters) {
  if (!isRecord(raw) || !ALLOWED_FRAME_TYPES.has(raw.type)) return null;

  const frame = { type: raw.type };
  if (typeof raw.uuid === "string") frame.uuid = alias("frame", raw.uuid);
  if (typeof raw.session_id === "string") {
    frame.session_id = alias("sess", raw.session_id);
  }
  if (typeof raw.request_id === "string") {
    frame.request_id = alias("req", raw.request_id);
  }
  if (raw.parent_tool_use_id === null) {
    frame.parent_tool_use_id = null;
  } else if (typeof raw.parent_tool_use_id === "string") {
    frame.parent_tool_use_id = alias("toolu", raw.parent_tool_use_id);
  }
  if (typeof raw.subagent_type === "string") {
    frame.subagent_type = boundedText(raw.subagent_type, "subagent_type");
  }
  if (Array.isArray(raw.supersedes)) {
    frame.supersedes = raw.supersedes
      .filter((entry) => typeof entry === "string")
      .map((entry) => alias("frame", entry));
  }
  if (typeof raw.subtype === "string") frame.subtype = raw.subtype;
  if (typeof raw.is_error === "boolean") frame.is_error = raw.is_error;
  if (isRecord(raw.message)) {
    frame.message = sanitizeMessage(raw.message, alias, counters);
  }
  if (isRecord(raw.event)) {
    frame.event = sanitizeEvent(raw.event, alias, counters);
  }
  return frame;
}

function sanitizeMessage(raw, alias, counters) {
  const message = {};
  if (typeof raw.id === "string") message.id = alias("msg", raw.id);
  if (typeof raw.role === "string") message.role = raw.role;
  if (typeof raw.model === "string") message.model = "fixture-model";
  if (raw.stop_reason === null || typeof raw.stop_reason === "string") {
    message.stop_reason = raw.stop_reason;
  }
  if (Array.isArray(raw.content)) {
    message.content = raw.content
      .map((block) => sanitizeBlock(block, alias, counters))
      .filter((block) => block !== null);
  }
  return message;
}

function sanitizeBlock(raw, alias, counters) {
  if (!isRecord(raw) || typeof raw.type !== "string") return null;
  const block = { type: raw.type };
  if (typeof raw.id === "string") block.id = alias("toolu", raw.id);
  if (typeof raw.tool_use_id === "string") {
    block.tool_use_id = alias("toolu", raw.tool_use_id);
  }
  if (typeof raw.name === "string") block.name = raw.name;
  if (typeof raw.server_name === "string") block.server_name = raw.server_name;
  if (typeof raw.is_error === "boolean") block.is_error = raw.is_error;
  if (typeof raw.text === "string") {
    counters.text += 1;
    block.text = syntheticText("prose", counters.text);
  }
  if (typeof raw.thinking === "string") {
    counters.thinking += 1;
    block.thinking = syntheticText("thinking", counters.thinking);
  }
  if (typeof raw.signature === "string") block.signature = "fixture-signature";
  if (typeof raw.data === "string") block.data = "fixture-redacted";
  if (isRecord(raw.input)) block.input = sanitizeArguments(raw.input);
  if (Array.isArray(raw.content)) {
    block.content = raw.content
      .map((entry) => sanitizeBlock(entry, alias, counters))
      .filter((entry) => entry !== null);
  } else if (typeof raw.content === "string") {
    counters.result += 1;
    block.content = syntheticText("result", counters.result);
  }
  return block;
}

/**
 * Tool arguments are the model's own words about the vault. Only the key shape
 * is protocol evidence, so every value becomes a bounded placeholder.
 */
function sanitizeArguments(raw) {
  const args = {};
  for (const key of Object.keys(raw).sort()) {
    args[key] = `fixture-${key}`;
  }
  return args;
}

function sanitizeEvent(raw, alias, counters) {
  const event = {};
  if (typeof raw.type === "string") event.type = raw.type;
  if (Number.isInteger(raw.index)) event.index = raw.index;
  if (isRecord(raw.message)) {
    event.message = sanitizeMessage(raw.message, alias, counters);
  }
  if (isRecord(raw.content_block)) {
    event.content_block = sanitizeBlock(raw.content_block, alias, counters);
  }
  if (isRecord(raw.delta)) {
    event.delta = sanitizeDelta(raw.delta, counters);
  }
  return event;
}

function sanitizeDelta(raw, counters) {
  const delta = {};
  if (typeof raw.type === "string") delta.type = raw.type;
  if (typeof raw.text === "string") {
    counters.text += 1;
    delta.text = syntheticText("prose", counters.text);
  }
  if (typeof raw.partial_json === "string") {
    counters.args += 1;
    delta.partial_json = `{"fixture":${counters.args}}`;
  }
  if (typeof raw.thinking === "string") {
    counters.thinking += 1;
    delta.thinking = syntheticText("thinking", counters.thinking);
  }
  if (typeof raw.signature === "string") delta.signature = "fixture-signature";
  return delta;
}

/**
 * Converts a raw capture into a fixture body. `frames` are the parsed raw
 * protocol objects in arrival order; everything the allow-list does not name is
 * dropped rather than redacted, so a future protocol field cannot leak by
 * being unrecognized.
 */
export function sanitizeCapture(frames, meta) {
  const alias = createAliaser();
  const counters = { text: 0, thinking: 0, args: 0, result: 0 };
  const sanitized = [];
  for (const raw of frames) {
    const frame = sanitizeFrame(raw, alias, counters);
    if (frame) sanitized.push(frame);
  }
  return {
    fixtureVersion: 1,
    case: meta.case,
    transport: meta.transport,
    sdkVersion: meta.sdkVersion,
    cliVersion: meta.cliVersion,
    provenance: meta.provenance ?? "captured",
    description: meta.description,
    frames: sanitized,
  };
}

/**
 * Validates one fixture against the allow-list and the bounds. Returns null when
 * the fixture is acceptable, or a human-readable first violation.
 */
export function validateFixture(fixture, name = "fixture") {
  const problem = (message) => `${name}: ${message}`;
  if (!isRecord(fixture)) return problem("is not an object");
  if (fixture.fixtureVersion !== 1) return problem("has an unknown fixtureVersion");
  for (const field of ["case", "sdkVersion", "cliVersion", "description"]) {
    if (typeof fixture[field] !== "string" || fixture[field].length === 0) {
      return problem(`is missing "${field}"`);
    }
  }
  if (!ALLOWED_TRANSPORTS.has(fixture.transport)) {
    return problem(`has an unknown transport "${String(fixture.transport)}"`);
  }
  if (!ALLOWED_PROVENANCE.has(fixture.provenance)) {
    return problem(`has an unknown provenance "${String(fixture.provenance)}"`);
  }
  if (!Array.isArray(fixture.frames) || fixture.frames.length === 0) {
    return problem("has no frames");
  }
  if (fixture.frames.length > MAX_FRAMES) {
    return problem(`has ${fixture.frames.length} frames, over the ${MAX_FRAMES} bound`);
  }

  const serialized = JSON.stringify(fixture);
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(serialized)) {
      return problem(`matches the forbidden pattern ${pattern.source}`);
    }
  }

  for (const [index, frame] of fixture.frames.entries()) {
    const violation = validateNode(
      frame,
      ALLOWED_FRAME_KEYS,
      `${name}.frames[${index}]`,
    );
    if (violation) return violation;
    if (!ALLOWED_FRAME_TYPES.has(frame.type)) {
      return problem(`frames[${index}] has type "${String(frame.type)}"`);
    }
  }
  return null;
}

/** Recursively checks one node's keys and string bounds against its context. */
function validateNode(node, allowed, path) {
  if (!isRecord(node)) return `${path} is not an object`;
  for (const [key, value] of Object.entries(node)) {
    if (!allowed.has(key)) return `${path}.${key} is not allow-listed`;
    const childPath = `${path}.${key}`;
    if (typeof value === "string" && value.length > MAX_STRING_LENGTH) {
      return `${childPath} is ${value.length} characters, over the bound`;
    }
    if (key === "message") {
      const violation = validateNode(value, ALLOWED_MESSAGE_KEYS, childPath);
      if (violation) return violation;
      const content = value.content;
      if (content !== undefined) {
        if (!Array.isArray(content)) return `${childPath}.content is not an array`;
        for (const [index, block] of content.entries()) {
          const blockViolation = validateBlock(block, `${childPath}.content[${index}]`);
          if (blockViolation) return blockViolation;
        }
      }
      continue;
    }
    if (key === "event") {
      const violation = validateNode(value, ALLOWED_EVENT_KEYS, childPath);
      if (violation) return violation;
      if (value.content_block !== undefined) {
        const blockViolation = validateBlock(
          value.content_block,
          `${childPath}.content_block`,
        );
        if (blockViolation) return blockViolation;
      }
      if (value.delta !== undefined) {
        const deltaViolation = validateNode(
          value.delta,
          ALLOWED_DELTA_KEYS,
          `${childPath}.delta`,
        );
        if (deltaViolation) return deltaViolation;
      }
      continue;
    }
    if (key === "content_block") {
      const blockViolation = validateBlock(value, childPath);
      if (blockViolation) return blockViolation;
    }
  }
  return null;
}

function validateBlock(block, path) {
  if (!isRecord(block)) return `${path} is not an object`;
  for (const [key, value] of Object.entries(block)) {
    if (!ALLOWED_BLOCK_KEYS.has(key)) return `${path}.${key} is not allow-listed`;
    if (typeof value === "string" && value.length > MAX_STRING_LENGTH) {
      return `${path}.${key} is ${value.length} characters, over the bound`;
    }
    if (key === "input") {
      if (!isRecord(value)) return `${path}.input is not an object`;
      for (const [argKey, argValue] of Object.entries(value)) {
        if (typeof argValue === "string" && argValue.length > MAX_STRING_LENGTH) {
          return `${path}.input.${argKey} is over the bound`;
        }
      }
    }
    if (key === "content" && Array.isArray(value)) {
      for (const [index, entry] of value.entries()) {
        const violation = validateBlock(entry, `${path}.content[${index}]`);
        if (violation) return violation;
      }
    }
  }
  return null;
}

/** CLI entry: convert one raw capture into a sanitized fixture on disk. */
async function main(argv) {
  const [input, output, caseName, transport] = argv;
  if (!input || !output || !caseName || !transport) {
    throw new CaptureFixtureError(
      "usage: captureFixtures.mjs <raw.jsonl> <out.json> <case> <transport>",
    );
  }
  const { readFileSync, writeFileSync } = await import("node:fs");
  const frames = readFileSync(input, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
  const fixture = sanitizeCapture(frames, {
    case: caseName,
    transport,
    sdkVersion: process.env.FIXTURE_SDK_VERSION ?? "0.3.207",
    cliVersion: process.env.FIXTURE_CLI_VERSION ?? "2.1.218",
    provenance: "captured",
    description: process.env.FIXTURE_DESCRIPTION ?? `Sanitized ${caseName} capture.`,
  });
  const violation = validateFixture(fixture, caseName);
  if (violation) throw new CaptureFixtureError(violation);
  writeFileSync(output, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  process.stdout.write(`wrote ${output} (${fixture.frames.length} frames)\n`);
}

if (process.argv[1] && process.argv[1].endsWith("captureFixtures.mjs")) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${String(error.message ?? error)}\n`);
    process.exitCode = 1;
  });
}
