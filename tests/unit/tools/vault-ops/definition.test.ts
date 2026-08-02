import { describe, test, expect } from "vitest";
import {
  allowedVaultOpsTools,
  ALL_VAULT_OPS_TOOLS,
  VAULT_OPS_TOOL_NAMES,
} from "../../../../src/tools/vault-ops/definition";
import { DEFAULT_VAULT_OP_POLICY, type VaultOpPolicy } from "../../../../src/vault-ops/gateway";

const names = (tools: { name: string }[]): string[] => tools.map((t) => t.name).sort();

describe("allowedVaultOpsTools", () => {
  test("default policy (nothing denied) keeps every tool", () => {
    expect(names(allowedVaultOpsTools(DEFAULT_VAULT_OP_POLICY))).toEqual(
      names(ALL_VAULT_OPS_TOOLS),
    );
  });

  test("a denied class detaches its tool", () => {
    const policy: VaultOpPolicy = { ...DEFAULT_VAULT_OP_POLICY, move: "deny", trash: "deny" };
    const allowed = names(allowedVaultOpsTools(policy));
    expect(allowed).not.toContain("move");
    expect(allowed).not.toContain("trash");
    expect(allowed).toContain("write_file");
    expect(allowed).toContain("create_directory");
  });

  test("denying one class leaves the other's tool, and takes its folder pathway with it", () => {
    // A merged tool carries both pathways, and the folder kinds gate as their file
    // siblings (moveFolder→move, trashFolder→trash, see classOf), so denying a class
    // removes the whole tool. There is no longer a separate folder tool that could be
    // left behind holding a capability whose underlying class is denied.
    const noMove: VaultOpPolicy = { ...DEFAULT_VAULT_OP_POLICY, move: "deny" };
    expect(names(allowedVaultOpsTools(noMove))).not.toContain("move");
    expect(names(allowedVaultOpsTools(noMove))).toContain("trash");

    const noTrash: VaultOpPolicy = { ...DEFAULT_VAULT_OP_POLICY, trash: "deny" };
    expect(names(allowedVaultOpsTools(noTrash))).not.toContain("trash");
    expect(names(allowedVaultOpsTools(noTrash))).toContain("move");
  });

  test("write_file survives while either create or overwrite is allowed", () => {
    const createOnly: VaultOpPolicy = { ...DEFAULT_VAULT_OP_POLICY, overwrite: "deny" };
    expect(names(allowedVaultOpsTools(createOnly))).toContain("write_file");

    const overwriteOnly: VaultOpPolicy = { ...DEFAULT_VAULT_OP_POLICY, create: "deny" };
    expect(names(allowedVaultOpsTools(overwriteOnly))).toContain("write_file");
  });

  test("write_file is dropped only when both create and overwrite are denied", () => {
    const policy: VaultOpPolicy = { ...DEFAULT_VAULT_OP_POLICY, create: "deny", overwrite: "deny" };
    expect(names(allowedVaultOpsTools(policy))).not.toContain("write_file");
  });

  test("denying every class detaches all tools", () => {
    const policy: VaultOpPolicy = {
      ...DEFAULT_VAULT_OP_POLICY,
      create: "deny",
      overwrite: "deny",
      move: "deny",
      trash: "deny",
      createDir: "deny",
    };
    expect(allowedVaultOpsTools(policy)).toHaveLength(0);
  });

  test("the retired file/folder siblings are gone from the surface", () => {
    const all = names(ALL_VAULT_OPS_TOOLS);
    for (const retired of ["move_file", "move_folder", "trash_file", "trash_folder"]) {
      expect(all).not.toContain(retired);
      expect(VAULT_OPS_TOOL_NAMES.has(retired)).toBe(false);
    }
  });

  test("no vault-op guidance names a retired sibling (the wrong-sibling text is gone)", () => {
    // A merged tool cannot be told it picked the wrong sibling, because the distinction
    // is no longer the model's to make (RFC-0015). Model-facing text is what the compiler
    // never sees, so the absence is asserted rather than assumed.
    const text = ALL_VAULT_OPS_TOOLS.map(
      (t) => `${t.description} ${t.strategyHint ?? ""} ${t.errorGuidance ?? ""}`,
    ).join(" ");
    for (const retired of ["move_file", "move_folder", "trash_file", "trash_folder"]) {
      expect(text).not.toContain(retired);
    }
  });

  test("returned tools carry declarative MCP annotations", () => {
    for (const tool of allowedVaultOpsTools(DEFAULT_VAULT_OP_POLICY)) {
      expect(VAULT_OPS_TOOL_NAMES.has(tool.name)).toBe(true);
      expect(tool.annotations).toBeDefined();
    }
  });
});
