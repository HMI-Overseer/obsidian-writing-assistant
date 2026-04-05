/**
 * Runtime argument validation for edit-mode tool calls.
 *
 * Models can return malformed arguments (wrong types, missing fields).
 * These validators check shape and types before execution, returning
 * an actionable error message that the model can use to self-correct.
 */

// ---------------------------------------------------------------------------
// Validation result type
// ---------------------------------------------------------------------------

type ValidationOk<T> = { ok: true; args: T };
type ValidationErr = { ok: false; error: string };
type ValidationResult<T> = ValidationOk<T> | ValidationErr;

function ok<T>(args: T): ValidationOk<T> {
  return { ok: true, args };
}

function err(error: string): ValidationErr {
  return { ok: false, error };
}

// ---------------------------------------------------------------------------
// Read-only tool argument types
// ---------------------------------------------------------------------------

export interface GetLineRangeArgs {
  start_line: number;
  end_line?: number;
}

// ---------------------------------------------------------------------------
// Write tool argument types
// ---------------------------------------------------------------------------

export interface ApplyEditArgs {
  search: string;
  replace: string;
  explanation?: string;
}

export interface ReplaceSectionArgs {
  heading: string;
  new_content: string;
  explanation?: string;
}

export interface InsertAtPositionArgs {
  text: string;
  after_heading?: string;
  line_number?: number;
  explanation?: string;
}

export interface FrontmatterOperation {
  key: string;
  value?: string;
  action: "set" | "remove";
}

export interface UpdateFrontmatterArgs {
  operations: FrontmatterOperation[];
  explanation?: string;
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

export function validateGetLineRange(
  args: Record<string, unknown>,
): ValidationResult<GetLineRangeArgs> {
  if (typeof args.start_line !== "number" || !Number.isFinite(args.start_line)) {
    return err("start_line must be a finite number (1-indexed). Got: " + JSON.stringify(args.start_line));
  }
  if (args.start_line < 1) {
    return err("start_line must be >= 1 (1-indexed). Got: " + args.start_line);
  }
  if (args.end_line !== undefined && typeof args.end_line !== "number") {
    return err("end_line must be a number or omitted. Got: " + JSON.stringify(args.end_line));
  }
  return ok({
    start_line: args.start_line,
    end_line: args.end_line as number | undefined,
  });
}

export function validateApplyEdit(
  args: Record<string, unknown>,
): ValidationResult<ApplyEditArgs> {
  if (typeof args.search !== "string") {
    return err("search must be a string. Got: " + typeof args.search);
  }
  if (typeof args.replace !== "string" && args.replace !== undefined) {
    return err("replace must be a string. Got: " + typeof args.replace);
  }
  return ok({
    search: args.search,
    replace: typeof args.replace === "string" ? args.replace : "",
    explanation: typeof args.explanation === "string" ? args.explanation : undefined,
  });
}

export function validateReplaceSection(
  args: Record<string, unknown>,
): ValidationResult<ReplaceSectionArgs> {
  if (typeof args.heading !== "string" || args.heading.trim() === "") {
    return err("heading must be a non-empty string. Got: " + JSON.stringify(args.heading));
  }
  if (typeof args.new_content !== "string") {
    return err("new_content must be a string. Got: " + typeof args.new_content);
  }
  return ok({
    heading: args.heading,
    new_content: args.new_content,
    explanation: typeof args.explanation === "string" ? args.explanation : undefined,
  });
}

export function validateInsertAtPosition(
  args: Record<string, unknown>,
): ValidationResult<InsertAtPositionArgs> {
  if (typeof args.text !== "string") {
    return err("text must be a string. Got: " + typeof args.text);
  }
  const hasHeading = args.after_heading !== undefined;
  const hasLine = args.line_number !== undefined;

  if (hasHeading && typeof args.after_heading !== "string") {
    return err("after_heading must be a string. Got: " + typeof args.after_heading);
  }
  if (hasLine && typeof args.line_number !== "number") {
    return err("line_number must be a number. Got: " + typeof args.line_number);
  }
  if (hasHeading && hasLine) {
    return err("Provide either after_heading or line_number, not both.");
  }
  if (!hasHeading && !hasLine) {
    return err("Provide either after_heading or line_number to specify where to insert.");
  }
  return ok({
    text: args.text,
    after_heading: hasHeading ? (args.after_heading as string) : undefined,
    line_number: hasLine ? (args.line_number as number) : undefined,
    explanation: typeof args.explanation === "string" ? args.explanation : undefined,
  });
}

export function validateUpdateFrontmatter(
  args: Record<string, unknown>,
): ValidationResult<UpdateFrontmatterArgs> {
  // Models sometimes flatten the structure, passing {key, action, value}
  // at the top level instead of wrapping in an operations array.
  if (!Array.isArray(args.operations) && typeof args.key === "string" && typeof args.action === "string") {
    args = { ...args, operations: [{ key: args.key, value: args.value, action: args.action }] };
  }

  if (!Array.isArray(args.operations)) {
    return err("operations must be an array. Got: " + typeof args.operations);
  }
  if (args.operations.length === 0) {
    return err("operations array must not be empty.");
  }

  const validated: FrontmatterOperation[] = [];
  for (let i = 0; i < args.operations.length; i++) {
    const op = args.operations[i] as Record<string, unknown>;
    if (!op || typeof op !== "object") {
      return err(`operations[${i}] must be an object.`);
    }
    if (typeof op.key !== "string" || op.key.trim() === "") {
      return err(`operations[${i}].key must be a non-empty string.`);
    }
    if (op.action !== "set" && op.action !== "remove") {
      return err(`operations[${i}].action must be "set" or "remove". Got: ${JSON.stringify(op.action)}`);
    }
    if (op.action === "set" && op.value !== undefined && typeof op.value !== "string") {
      return err(`operations[${i}].value must be a string when action is "set". Got: ${typeof op.value}`);
    }
    validated.push({
      key: op.key,
      value: typeof op.value === "string" ? op.value : undefined,
      action: op.action,
    });
  }

  return ok({
    operations: validated,
    explanation: typeof args.explanation === "string" ? args.explanation : undefined,
  });
}
