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
    expect(allowed).not.toContain("move_file");
    expect(allowed).not.toContain("trash_file");
    expect(allowed).toContain("write_file");
    expect(allowed).toContain("create_directory");
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

  test("returned tools carry annotations (the gateway reads them)", () => {
    for (const tool of allowedVaultOpsTools(DEFAULT_VAULT_OP_POLICY)) {
      expect(VAULT_OPS_TOOL_NAMES.has(tool.name)).toBe(true);
      expect(tool.annotations).toBeDefined();
    }
  });
});
