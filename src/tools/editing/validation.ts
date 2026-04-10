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
// Write tool argument types
// ---------------------------------------------------------------------------

export interface ProposeEditArgs {
  search: string;
  replace: string;
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

export function validateProposeEdit(
  args: Record<string, unknown>,
): ValidationResult<ProposeEditArgs> {
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
