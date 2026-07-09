import { describe, it, expect } from "vitest";
import {
  resolveWriteTools,
  resolveLocalToolSet,
  cloudAllowedToolSet,
  cloudAllowedToolNames,
  CLOUD_STABLE_TOOL_SET,
  CLAUDE_CODE_STABLE_TOOL_SET,
  CORE_READ_TOOLS,
  CORE_READ_TOOL_NAMES,
  isCoreReadTool,
  anthropicNonDeferredToolNames,
  anthropicLayer2ToolSet,
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

describe("Layer 2 progressive-disclosure core (ADR-0009 / section 6.2.5)", () => {
  // Layer 2 shipped. The long tail (the extra reads + every write) now defers behind the
  // native tool-search entry (anthropic) and the SDK `alwaysLoad` split (Claude Code), so
  // the OLD tripwire (whole catalogue must stay < 40) is obsolete: catalogue growth is now
  // cheap because deferred tools sit outside the cached prefix. What must stay bounded
  // instead is the NON-DEFERRED CORE. It is the only part of the tool block that lives in
  // the cached prefix turn over turn, so each tool kept there is a permanent always-on tax
  // and a permanent draw on tool-selection quality; growing it re-bloats exactly the prefix
  // Layer 2 exists to shrink. Crossing this guard should force the section 6.2.5 "does this
  // primitive earn a non-deferred slot" conversation (the get_outline / read_section
  // watch-item), not a silent bump.
  // See docs/03-decisions/ADR-0009-layer-2-progressive-disclosure-deferred.md.
  const NON_DEFERRED_CORE_MAX = 8;

  it("keeps the core read set to the six section 6.2.5 primitives", () => {
    expect(names(CORE_READ_TOOLS)).toEqual([
      "list_directory",
      "semantic_search",
      "search_content",
      "read_file",
      "get_outline",
      "read_section",
    ]);
    expect(CORE_READ_TOOL_NAMES.size).toBe(6);
  });

  it("holds the anthropic non-deferred core (core reads + think) small", () => {
    // 6 core reads + think. The native tool-search entry is non-deferred at the wire
    // layer but is not a canonical tool, so it is not counted here.
    const nonDeferred = anthropicNonDeferredToolNames();
    expect(nonDeferred.size).toBeLessThanOrEqual(NON_DEFERRED_CORE_MAX);
    expect(nonDeferred.size).toBe(7);
    expect(nonDeferred.has("think")).toBe(true);
  });

  it("classifies only the six core reads as non-deferred, never writes or tail reads", () => {
    expect(isCoreReadTool("read_file")).toBe(true);
    expect(isCoreReadTool("semantic_search")).toBe(true);
    // Tail reads defer.
    expect(isCoreReadTool("directory_tree")).toBe(false);
    expect(isCoreReadTool("get_frontmatter")).toBe(false);
    // Writes always defer.
    expect(isCoreReadTool("propose_edit")).toBe(false);
    expect(isCoreReadTool("write_file")).toBe(false);
    // think is core only on the native path, added separately, not a "read".
    expect(isCoreReadTool("think")).toBe(false);
  });
});

describe("anthropicLayer2ToolSet (the direct-API L2 emission)", () => {
  it("emits the non-deferred core (core reads + think) then the deferred tail", () => {
    const got = names(anthropicLayer2ToolSet(opts()));
    // Core reads first (CORE_READ_TOOLS order), then think.
    expect(got.slice(0, 6)).toEqual([
      "list_directory",
      "semantic_search",
      "search_content",
      "read_file",
      "get_outline",
      "read_section",
    ]);
    expect(got[6]).toBe("think");
    // Then the six deferred tail reads, then the posture/policy-permitted writes.
    expect(got.slice(7)).toEqual([
      "directory_tree",
      "search_files",
      "find_notes_by_tag",
      "get_backlinks",
      "get_outgoing_links",
      "get_frontmatter",
      ...EDIT_NAMES,
      ...VAULT_OP_NAMES,
    ]);
  });

  it("includes every read tool exactly once (core + tail = the full read suite)", () => {
    const got = names(anthropicLayer2ToolSet(opts()));
    for (const readName of VAULT_TOOL_NAMES) {
      expect(got.filter((n) => n === readName)).toHaveLength(1);
    }
  });

  it("omits think when the think tool is not offered", () => {
    expect(names(anthropicLayer2ToolSet(opts({ useThinkTool: false })))).not.toContain("think");
  });

  it("excludes a deny-classed write from the catalogue (open seam closes at discovery)", () => {
    // The deferred catalogue is what tool search can discover. A deny-classed write must be
    // absent from it entirely (ADR-0009 open seam), not merely refused at execution.
    const policy: VaultOpPolicy = { ...DEFAULT_VAULT_OP_POLICY, trash: "deny" };
    const got = names(anthropicLayer2ToolSet(opts({ policy })));
    expect(got).not.toContain("trash_file");
    expect(got).not.toContain("trash_folder");
    // A non-denied write is still present (and will be deferred at the wire layer).
    expect(got).toContain("move_file");
  });

  it("read-only (deny-all policy) emits core reads + think + tail reads, no writes", () => {
    const got = names(anthropicLayer2ToolSet(opts({ policy: DENY_ALL })));
    expect(got.some((n) => EDIT_TOOL_NAMES.has(n) || VAULT_OPS_TOOL_NAMES.has(n))).toBe(false);
    expect(got).toContain("think");
    expect(got).toContain("read_file"); // a core read
    expect(got).toContain("get_frontmatter"); // a tail read still offered
  });

  it("defers exactly the names outside the non-deferred core (disjoint, non-empty tail)", () => {
    // The wire layer defers every emitted name not in anthropicNonDeferredToolNames, so the
    // two sets partition the catalogue: the tail must be non-empty and disjoint from the core.
    const nonDeferred = anthropicNonDeferredToolNames();
    const deferred = names(anthropicLayer2ToolSet(opts())).filter((n) => !nonDeferred.has(n));
    expect(deferred.length).toBeGreaterThan(0);
    for (const n of deferred) expect(nonDeferred.has(n)).toBe(false);
    // And the non-deferred core stays exactly the six reads + think (held small, section 6.2.5).
    expect([...nonDeferred].sort()).toEqual(
      [
        "get_outline",
        "list_directory",
        "read_file",
        "read_section",
        "search_content",
        "semantic_search",
        "think",
      ],
    );
  });
});
