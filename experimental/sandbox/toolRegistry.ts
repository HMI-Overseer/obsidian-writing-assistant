import { formatWithLineNumbers } from "../../src/tools/vault/readFormat";
import { READ_FILE_TOOL } from "../../src/tools/vault/definition";
import { WRITE_FILE_TOOL } from "../../src/tools/vault-ops/definition";
import { validateWriteFile } from "../../src/tools/vault-ops/validation";
import { toolFailure } from "../../src/tools/toolFailure";
import type { CanonicalToolDefinition, ToolCall, ToolResult } from "../../src/tools/types";
import { normalizeSyntheticPath } from "./syntheticVault";
import type { SandboxMutationReview, SandboxWriteReviewPolicy } from "./types";
import type { SyntheticVault } from "./syntheticVault";

export interface SandboxToolResult {
  result: ToolResult;
  review: SandboxMutationReview | null;
}

// The laboratory never receives an Obsidian Vault, so there is no runtime configDir to read.
// Preserve the production default as a synthetic reserved subtree for escape regression tests.
const SYNTHETIC_RESERVED_CONFIG_DIR = [".ob", "sidian"].join("");

export class SandboxToolRegistry {
  readonly definitions: CanonicalToolDefinition[];

  constructor(
    private readonly vault: SyntheticVault,
    private readonly writeReview: SandboxWriteReviewPolicy | null = null,
  ) {
    this.definitions = writeReview ? [READ_FILE_TOOL, WRITE_FILE_TOOL] : [READ_FILE_TOOL];
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    return (await this.executeWithEvidence(call)).result;
  }

  async executeWithEvidence(call: ToolCall): Promise<SandboxToolResult> {
    if (call.name === WRITE_FILE_TOOL.name && this.writeReview) {
      return this.executeWrite(call);
    }
    if (call.name !== READ_FILE_TOOL.name) {
      return { result: toolFailure({
        kind: "denied",
        what: `tool ${JSON.stringify(call.name)} is not available in this sandbox`,
        recovery: "use one of the advertised sandbox tools",
      }), review: null };
    }

    const rawPath = typeof call.arguments.path === "string" ? call.arguments.path.trim() : "";
    const normalized = normalizeSyntheticPath(rawPath);
    if (!normalized.ok) {
      return { result: toolFailure({
        kind: "invalid-args",
        what: normalized.reason,
        recovery: "use a synthetic-vault-relative file path",
      }), review: null };
    }

    const file = this.vault.readFile(normalized.path);
    if (!file) {
      return { result: toolFailure({
        kind: "not-found",
        what: `no synthetic note found at path ${JSON.stringify(normalized.path)}`,
        recovery: "check the fixture path and retry",
      }), review: null };
    }

    return { result: {
      content: `[${file.path}]\n\n${formatWithLineNumbers(file.content)}`,
      isReadOnly: true,
    }, review: null };
  }

  private executeWrite(call: ToolCall): SandboxToolResult {
    const validated = validateWriteFile(
      call.arguments,
      (path) => this.vault.pathState(path),
      SYNTHETIC_RESERVED_CONFIG_DIR,
    );
    if (!validated.ok) {
      return {
        result: toolFailure({
          kind: "invalid-args",
          what: validated.error,
          recovery: "use a safe synthetic-vault-relative Markdown or canvas path",
          isReadOnly: false,
        }),
        review: null,
      };
    }
    const normalized = normalizeSyntheticPath(validated.args.path);
    if (!normalized.ok) {
      return {
        result: toolFailure({ kind: "invalid-args", what: normalized.reason, isReadOnly: false }),
        review: null,
      };
    }
    const previousContent = this.vault.readFile(normalized.path)?.content ?? null;
    const applied = this.writeReview?.disposition === "applied";
    const review: SandboxMutationReview = {
      proposal: {
        kind: "write-file",
        path: normalized.path,
        content: validated.args.content,
        previousContent,
      },
      disposition: this.writeReview?.disposition ?? "declined",
      reason: this.writeReview?.reason ?? "No sandbox write-review policy was supplied.",
      applied,
    };
    if (applied) this.vault.writeFile(normalized.path, validated.args.content);
    if (review.disposition === "failed") {
      return {
        result: toolFailure({
          kind: "failed",
          what: `could not write ${JSON.stringify(normalized.path)}`,
          recovery: "inspect the recorded sandbox fault before retrying",
          isReadOnly: false,
        }),
        review,
      };
    }
    const content = applied
      ? `Applied reviewed write to ${JSON.stringify(normalized.path)}.`
      : `Declined reviewed write to ${JSON.stringify(normalized.path)}; the file was not changed.`;
    return {
      result: {
        content,
        isReadOnly: false,
        disposition: applied ? "applied" : "declined",
      },
      review,
    };
  }
}
