import { describe, test, expect } from "vitest";
import { isMutatingTool, MUTATING_TOOL_NAMES } from "../../../src/tools/metadata";
import { VAULT_TOOL_NAMES } from "../../../src/tools/vault/definition";
import { EDIT_TOOL_NAMES } from "../../../src/tools/editing/definition";
import { VAULT_OPS_TOOL_NAMES } from "../../../src/tools/vault-ops/definition";

describe("isMutatingTool", () => {
  test("every vault-op and edit tool is classified as mutating", () => {
    for (const name of [...VAULT_OPS_TOOL_NAMES, ...EDIT_TOOL_NAMES]) {
      expect(isMutatingTool(name)).toBe(true);
    }
  });

  test("read-only vault tools are not mutating", () => {
    for (const name of VAULT_TOOL_NAMES) {
      expect(isMutatingTool(name)).toBe(false);
    }
  });

  // Drift guard: if a new vault-op / edit tool is added, it must be classified here
  // too, or its timeline step would render as a read-only (cyan) call.
  test("the mutating set is exactly the vault-op + edit tools", () => {
    expect([...MUTATING_TOOL_NAMES].sort()).toEqual(
      [...VAULT_OPS_TOOL_NAMES, ...EDIT_TOOL_NAMES].sort(),
    );
  });

  test("undefined and unknown tools are not mutating", () => {
    expect(isMutatingTool(undefined)).toBe(false);
    expect(isMutatingTool("think")).toBe(false);
    expect(isMutatingTool("nonexistent_tool")).toBe(false);
  });
});
