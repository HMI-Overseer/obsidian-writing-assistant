/**
 * Tools-layer adapter that turns the pure vault-boundary guard
 * ({@link ../vault-ops/pathSafety.escapesVault}) into a model-facing tool failure.
 *
 * The write channel ({@link ./vault-ops/validation}) already refuses an
 * out-of-vault path up front with {@link ../vault-ops/pathSafety.outsideVaultMessage};
 * this gives the *read* and *edit* channels the same wording from the same source.
 * Without it those channels resolve the path through Obsidian's index lookups
 * (`getFileByPath` / `getAbstractFileByPath`), which only ever return in-vault
 * files, so an out-of-vault path falls through to a generic "not found" and the
 * model is sent to *search* for a path that no in-vault search can ever surface.
 * Naming the boundary instead points it at the real next step (use a vault-relative
 * path). The index lookup stays in place behind this as the security backstop.
 *
 * See docs/work/issues/read-tools-mask-out-of-vault-as-not-found.md.
 */

import { escapesVault, outsideVaultMessage } from "../vault-ops/pathSafety";
import { toolFailure } from "./toolFailure";
import type { ToolResult } from "./types";

/**
 * If `path` escapes the vault, return the shared boundary failure (named cause +
 * vault-relative retry, `kind: invalid-args` to match the write channel);
 * otherwise return null so the caller proceeds to its normal lookup. Pass
 * `isReadOnly: false` on the edit/mutation channel.
 */
export function refuseOutsideVault(path: string, isReadOnly = true): ToolResult | null {
  if (!escapesVault(path)) return null;
  return toolFailure({
    kind: "invalid-args",
    // `content` is used verbatim; the "Error:" prefix is the form the system prompt
    // keys off, and outsideVaultMessage already carries the recovery clause.
    content: `Error: ${outsideVaultMessage(path)}`,
    isReadOnly,
  });
}
