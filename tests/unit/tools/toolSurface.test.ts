import { describe, it, expect } from "vitest";
import {
  resolveModeWriteTools,
  resolveLocalToolSet,
  cloudAllowedToolSet,
  cloudAllowedToolNames,
  CLOUD_STABLE_TOOL_SET,
  CLAUDE_CODE_STABLE_TOOL_SET,
  modeNotAllowedFailure,
  type ToolSurfaceOptions,
} from "../../../src/tools/toolSurface";
import { DEFAULT_VAULT_OP_POLICY, type VaultOpPolicy } from "../../../src/vault-ops/gateway";
import { VAULT_TOOL_NAMES } from "../../../src/tools/vault/definition";
import { EDIT_TOOL_NAMES } from "../../../src/tools/editing/definition";
import { VAULT_OPS_TOOL_NAMES } from "../../../src/tools/vault-ops/definition";

const CORE_READ_NAMES = ["list_directory", "semantic_search", "search_content", "read_file"];
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

function opts(overrides: Partial<ToolSurfaceOptions> = {}): ToolSurfaceOptions {
  return {
    editMode: false,
    preferToolUse: true,
    policy: DEFAULT_VAULT_OP_POLICY,
    useThinkTool: true,
    ...overrides,
  };
}

function names(tools: { name: string }[]): string[] {
  return tools.map((t) => t.name);
}

describe("resolveModeWriteTools (the single-source write gate)", () => {
  it("has no writes outside the edit surface (plan/conversation)", () => {
    expect(resolveModeWriteTools(opts({ editMode: false }))).toEqual([]);
  });

  it("has no writes in edit mode when tool-based editing is off", () => {
    expect(resolveModeWriteTools(opts({ editMode: true, preferToolUse: false }))).toEqual([]);
  });

  it("permits edit tools + the vault-op superset in the edit surface", () => {
    expect(names(resolveModeWriteTools(opts({ editMode: true })))).toEqual([
      ...EDIT_NAMES,
      ...VAULT_OP_NAMES,
    ]);
  });

  it("drops edit tools when the edit class is denied", () => {
    const policy: VaultOpPolicy = { ...DEFAULT_VAULT_OP_POLICY, edit: "deny" };
    const got = names(resolveModeWriteTools(opts({ editMode: true, policy })));
    expect(got.some((n) => EDIT_TOOL_NAMES.has(n))).toBe(false);
    expect(got).toEqual(VAULT_OP_NAMES);
  });

  it("drops a vault-op whose every class is denied", () => {
    const policy: VaultOpPolicy = { ...DEFAULT_VAULT_OP_POLICY, trash: "deny" };
    const got = names(resolveModeWriteTools(opts({ editMode: true, policy })));
    expect(got).not.toContain("trash_file");
    expect(got).not.toContain("trash_folder");
    expect(got).toContain("move_file");
  });
});

describe("resolveLocalToolSet (lean per-mode materialization, unchanged)", () => {
  it("emits the core read tier + writes + think in the edit surface", () => {
    expect(names(resolveLocalToolSet(opts({ editMode: true })))).toEqual([
      ...CORE_READ_NAMES,
      ...EDIT_NAMES,
      ...VAULT_OP_NAMES,
      "think",
    ]);
  });

  it("emits the full read suite + think outside the edit surface", () => {
    const got = names(resolveLocalToolSet(opts({ editMode: false })));
    // The read suite is all vault tools (in the ALL_VAULT_TOOLS order), then think.
    expect(got[got.length - 1]).toBe("think");
    expect(got.slice(0, -1).every((n) => VAULT_TOOL_NAMES.has(n))).toBe(true);
    expect(got.slice(0, -1).length).toBe(VAULT_TOOL_NAMES.size);
    expect(got.some((n) => EDIT_TOOL_NAMES.has(n) || VAULT_OPS_TOOL_NAMES.has(n))).toBe(false);
  });

  it("omits think when the think tool is not offered (LM Studio)", () => {
    const got = names(resolveLocalToolSet(opts({ editMode: false, useThinkTool: false })));
    expect(got).not.toContain("think");
  });
});

describe("cloudAllowedToolSet (reads unrestricted, writes mode-gated)", () => {
  it("allows every read tool in plan/conversation (no read shrink)", () => {
    const got = cloudAllowedToolNames(opts({ editMode: false }));
    for (const readName of VAULT_TOOL_NAMES) expect(got).toContain(readName);
  });

  it("allows every read tool in the edit surface too (no read shrink)", () => {
    const got = cloudAllowedToolNames(opts({ editMode: true }));
    for (const readName of VAULT_TOOL_NAMES) expect(got).toContain(readName);
  });

  it("permits no writes outside the edit surface", () => {
    const got = cloudAllowedToolNames(opts({ editMode: false }));
    expect(got.some((n) => EDIT_TOOL_NAMES.has(n) || VAULT_OPS_TOOL_NAMES.has(n))).toBe(false);
  });

  it("permits the mode's writes inside the edit surface", () => {
    const got = cloudAllowedToolNames(opts({ editMode: true }));
    for (const w of [...EDIT_NAMES, ...VAULT_OP_NAMES]) expect(got).toContain(w);
  });

  it("matches the local write gate exactly (single source)", () => {
    const o = opts({ editMode: true });
    const cloudWrites = cloudAllowedToolNames(o).filter(
      (n) => EDIT_TOOL_NAMES.has(n) || VAULT_OPS_TOOL_NAMES.has(n),
    );
    const localWrites = names(resolveModeWriteTools(o));
    expect(cloudWrites).toEqual(localWrites);
  });
});

describe("stable cloud surfaces (Layer 1 superset)", () => {
  it("the Anthropic superset is a superset of the allow-list in every mode", () => {
    const superset = new Set(CLOUD_STABLE_TOOL_SET.map((t) => t.name));
    for (const editMode of [false, true]) {
      for (const preferToolUse of [false, true]) {
        for (const name of cloudAllowedToolNames(opts({ editMode, preferToolUse }))) {
          expect(superset.has(name)).toBe(true);
        }
      }
    }
  });

  it("the Claude Code superset covers the allow-list minus think (think is never bridged)", () => {
    const superset = new Set(CLAUDE_CODE_STABLE_TOOL_SET.map((t) => t.name));
    expect(superset.has("think")).toBe(false);
    for (const editMode of [false, true]) {
      for (const name of cloudAllowedToolNames(opts({ editMode, useThinkTool: false }))) {
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

describe("modeNotAllowedFailure", () => {
  it("is a recovery-shaped precondition error", () => {
    const result = modeNotAllowedFailure("write_file");
    expect(result.isError).toBe(true);
    expect(result.failure?.kind).toBe("precondition");
    expect(result.content).toContain("write_file");
    expect(result.isReadOnly).toBe(false);
  });
});
