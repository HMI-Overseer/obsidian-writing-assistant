import type { VaultOpDisposition } from "../../vault-ops/disposition";
import { withDeclineGuidance } from "../../vault-ops/disposition";
import { assertNever } from "../../utils";
import type { MemoryMutation } from "./handlers";

function target(mutation: MemoryMutation): string {
  return `"${mutation.kind === "add" ? mutation.memory.name : mutation.name}"`;
}

/**
 * Model-facing outcome for an approved, declined, failed, or cancelled memory proposal.
 * `guidance` is the user's free text from a drawer decline, honoured on that branch only
 * ({@link withDeclineGuidance}).
 */
export function memoryDispositionMessage(
  mutation: MemoryMutation,
  disposition: VaultOpDisposition,
  reason?: string,
  guidance?: string,
): string {
  const name = target(mutation);
  const verb = mutation.kind === "add" ? "Added" : "Forgot";
  const action = mutation.kind === "add" ? "add" : "forget";
  switch (disposition) {
    case "auto-applied":
      return `${verb} memory ${name} (auto-applied).`;
    case "applied":
      return `${verb} memory ${name}.`;
    case "declined":
      return withDeclineGuidance(
        `Declined by user, memory ${name} was not changed.`,
        guidance,
      );
    case "failed":
      return `Error: could not ${action} memory ${name}, ${reason ?? "the mutation failed"}.`;
    case "cancelled":
      return `Generation stopped before you decided, memory proposal ${name} was cancelled and discarded.`;
    case "satisfied":
      return `Memory ${name} already satisfies the proposal; nothing to change.`;
    default:
      return assertNever(disposition);
  }
}
