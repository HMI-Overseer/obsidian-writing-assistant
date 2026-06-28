import { describe, it, expect } from "vitest";
import {
  resolveWriteTools,
  resolveLocalToolSet,
  cloudAllowedToolSet,
  cloudAllowedToolNames,
  CLOUD_STABLE_TOOL_SET,
  CLAUDE_CODE_STABLE_TOOL_SET,
  toolNotAllowedFailure,
  type ToolSurfaceOptions,
} from "../../../src/tools/toolSurface";
import { DEFAULT_VAULT_OP_POLICY, type VaultOpPolicy } from "../../../src/vault-ops/gateway";
import { VAULT_TOOL_NAMES } from "../../../src/tools/vault/definition";
import { EDIT_TOOL_NAMES } from "../../../src/tools/editing/definition";
import { VAULT_OPS_TOOL_NAMES } from "../../../src/tools/vault-ops/definition";

const EDIT_NAMES = ["propose_edit", "insert_into_note", "update_frontmatter"];
const VAULT_OP_NAMES = [
  "write_file",
  "create_directory",
  "move_file",
  "move_folder",
  "trash_file",
  "trash_folder",
  "replace_in_vault",
];

const DENY_ALL: VaultOpPolicy = {
  ...DEFAULT_VAULT_OP_POLICY,
  create: "deny",
  overwrite: "deny",
  move: "deny",
  trash: "deny",
  createDir: "deny",
  edit: "deny",
};

function opts(overrides: Partial<ToolSurfaceOptions> = {}): ToolSurfaceOptions {
  return {
    posture: "ask",
    policy: DEFAULT_VAULT_OP_POLICY,
    useThinkTool: true,
    ...overrides,
  };
}

function names(tools: { name: string }[]): string[] {
  return tools.map((t) => t.name);
}

describe("resolveWriteTools (the single-source write gate)", () => {
  it("offers edit tools + the vault-op superset under the default policy (ask posture)", () => {
    // DEFAULT_VAULT_OP_POLICY is all "ask" (no deny), so every write is offered.
    expect(names(resolveWriteTools(opts()))).toEqual([...EDIT_NAMES, ...VAULT_OP_NAMES]);
  });

  it("drops edit tools when the edit class is denied (ask posture)", () => {
    const policy: VaultOpPolicy = { ...DEFAULT_VAULT_OP_POLICY, edit: "deny" };
    const got = names(resolveWriteTools(opts({ policy })));
    expect(got.some((n) => EDIT_TOOL_NAMES.has(n))).toBe(false);
    expect(got).toEqual(VAULT_OP_NAMES);
  });

  it("drops a deny-classed vault-op (ask posture)", () => {
    const policy: VaultOpPolicy = { ...DEFAULT_VAULT_OP_POLICY, trash: "deny" };
    const got = names(resolveWriteTools(opts({ policy })));
    expect(got).not.toContain("trash_file");
    expect(got).not.toContain("trash_folder");
    expect(got).toContain("move_file");
  });

  it("read-only is a deny-all policy: no writes offered (ask posture)", () => {
    expect(resolveWriteTools(opts({ policy: DENY_ALL }))).toEqual([]);
  });

  it("the 'auto' posture re-offers every write, overriding deny", () => {
    // Under "auto" ("Edit automatically") the per-class policy is overruled.
    expect(names(resolveWriteTools(opts({ posture: "auto", policy: DENY_ALL })))).toEqual([
      ...EDIT_NAMES,
      ...VAULT_OP_NAMES,
    ]);
  });
});

describe("resolveLocalToolSet (full reads + permitted writes + think)", () => {
  it("emits the full read suite + permitted writes + think", () => {
    const got = names(resolveLocalToolSet(opts()));
    const readPart = got.slice(0, VAULT_TOOL_NAMES.size);
    expect(readPart.every((n) => VAULT_TOOL_NAMES.has(n))).toBe(true);
    expect(readPart.length).toBe(VAULT_TOOL_NAMES.size);
    expect(got).toEqual([...readPart, ...EDIT_NAMES, ...VAULT_OP_NAMES, "think"]);
  });

  it("read-only (deny-all policy) emits the read suite + think, no writes", () => {
    const got = names(resolveLocalToolSet(opts({ policy: DENY_ALL })));
    expect(got[got.length - 1]).toBe("think");
    expect(got.some((n) => EDIT_TOOL_NAMES.has(n) || VAULT_OPS_TOOL_NAMES.has(n))).toBe(false);
  });

  it("omits think when the think tool is not offered (LM Studio)", () => {
    const got = names(resolveLocalToolSet(opts({ useThinkTool: false })));
    expect(got).not.toContain("think");
  });
});

describe("cloudAllowedToolSet (reads unrestricted, writes posture/policy-gated)", () => {
  it("allows every read tool (no read shrink)", () => {
    const got = cloudAllowedToolNames(opts());
    for (const readName of VAULT_TOOL_NAMES) expect(got).toContain(readName);
  });

  it("permits no writes under a deny-all policy (read-only)", () => {
    const got = cloudAllowedToolNames(opts({ policy: DENY_ALL }));
    expect(got.some((n) => EDIT_TOOL_NAMES.has(n) || VAULT_OPS_TOOL_NAMES.has(n))).toBe(false);
  });

  it("permits the policy's writes under the default policy", () => {
    const got = cloudAllowedToolNames(opts());
    for (const w of [...EDIT_NAMES, ...VAULT_OP_NAMES]) expect(got).toContain(w);
  });

  it("matches the local write gate exactly (single source)", () => {
    const o = opts();
    const cloudWrites = cloudAllowedToolNames(o).filter(
      (n) => EDIT_TOOL_NAMES.has(n) || VAULT_OPS_TOOL_NAMES.has(n),
    );
    const localWrites = names(resolveWriteTools(o));
    expect(cloudWrites).toEqual(localWrites);
  });
});

describe("stable cloud surfaces (Layer 1 superset)", () => {
  it("the Anthropic superset is a superset of the allow-list in every posture", () => {
    const superset = new Set(CLOUD_STABLE_TOOL_SET.map((t) => t.name));
    for (const posture of ["ask", "auto"] as const) {
      for (const name of cloudAllowedToolNames(opts({ posture }))) {
        expect(superset.has(name)).toBe(true);
      }
    }
  });

  it("the Claude Code superset covers the allow-list minus think (think is never bridged)", () => {
    const superset = new Set(CLAUDE_CODE_STABLE_TOOL_SET.map((t) => t.name));
    expect(superset.has("think")).toBe(false);
    for (const posture of ["ask", "auto"] as const) {
      for (const name of cloudAllowedToolNames(opts({ posture, useThinkTool: false }))) {
        expect(superset.has(name)).toBe(true);
      }
    }
  });

  it("the Anthropic superset adds think over the Claude Code superset", () => {
    expect(CLOUD_STABLE_TOOL_SET.map((t) => t.name)).toEqual([
      ...CLAUDE_CODE_STABLE_TOOL_SET.map((t) => t.name),
      "think",
    ]);
  });
});

describe("toolNotAllowedFailure", () => {
  it("is a recovery-shaped precondition error", () => {
    const result = toolNotAllowedFailure("write_file");
    expect(result.isError).toBe(true);
    expect(result.failure?.kind).toBe("precondition");
    expect(result.content).toContain("write_file");
    expect(result.isReadOnly).toBe(false);
  });
});
