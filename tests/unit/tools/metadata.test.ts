import { describe, test, expect } from "vitest";
import {
  extractToolInput,
  isMutatingTool,
  MUTATING_TOOL_NAMES,
  TOOL_ICONS,
  TOOL_LABELS,
  TOOL_NAME_BY_OP_KIND,
  TOOL_PENDING_LABELS,
  TOOL_STATUS_LABELS,
  opKindIcon,
  pendingToolLabel,
  toolIcon,
  toolLabel,
} from "../../../src/tools/metadata";
import { VAULT_TOOL_NAMES } from "../../../src/tools/vault/definition";
import { EDIT_TOOL_NAMES } from "../../../src/tools/editing/definition";
import { VAULT_OPS_TOOL_NAMES } from "../../../src/tools/vault-ops/definition";
import {
  MEMORY_MUTATION_TOOL_NAMES,
  MEMORY_TOOL_NAMES,
} from "../../../src/tools/memory/definition";
import { ASK_TOOL_NAMES } from "../../../src/tools/ask/definition";
import { THINK_TOOL_NAME } from "../../../src/tools/think/definition";

describe("isMutatingTool", () => {
  test("every vault-op, edit, and memory mutation tool is classified as mutating", () => {
    for (const name of [
      ...VAULT_OPS_TOOL_NAMES,
      ...EDIT_TOOL_NAMES,
      ...MEMORY_MUTATION_TOOL_NAMES,
    ]) {
      expect(isMutatingTool(name)).toBe(true);
    }
  });

  test("read-only vault tools are not mutating", () => {
    for (const name of VAULT_TOOL_NAMES) {
      expect(isMutatingTool(name)).toBe(false);
    }
    expect(isMutatingTool("recall_memory")).toBe(false);
    expect(isMutatingTool("ask_user")).toBe(false);
  });

  // Drift guard: if a new vault-op / edit tool is added, it must be classified here
  // too, or its timeline step would render as a read-only (cyan) call.
  test("the mutating set is exactly the vault-op, edit, and memory mutation tools", () => {
    expect([...MUTATING_TOOL_NAMES].sort()).toEqual(
      [
        ...VAULT_OPS_TOOL_NAMES,
        ...EDIT_TOOL_NAMES,
        ...MEMORY_MUTATION_TOOL_NAMES,
      ].sort(),
    );
  });

  test("undefined and unknown tools are not mutating", () => {
    expect(isMutatingTool(undefined)).toBe(false);
    expect(isMutatingTool("think")).toBe(false);
    expect(isMutatingTool("nonexistent_tool")).toBe(false);
  });
});

describe("display-metadata coverage", () => {
  // Every tool the timeline can render: vault ops + edit tools + read tools. Unlike
  // MUTATING_TOOL_NAMES, the four display maps below are hand-maintained, so a new
  // tool must be added to each by hand. These drift guards fail loudly when it isn't
  // (the gap that left the retired folder ops showing a raw tool name and the generic
  // wrench icon; docs/review/reviews 2026-07-08-edit-tool-review-display F3).
  const ALL_TOOL_NAMES = [
    ...VAULT_OPS_TOOL_NAMES,
    ...EDIT_TOOL_NAMES,
    ...VAULT_TOOL_NAMES,
    ...MEMORY_TOOL_NAMES,
    ...ASK_TOOL_NAMES,
  ];

  // A single args object carrying every key any tool reads, so extractToolInput
  // returns a value for a covered tool and undefined only for an unhandled one.
  const KITCHEN_SINK_ARGS: Record<string, unknown> = {
    query: "q",
    path: "Notes/A.md",
    headingPath: "Section",
    pattern: "*.md",
    tag: "lore",
    paths: ["Notes/A.md"],
    explanation: "why",
    from: "Notes/A.md",
    to: "Notes/B.md",
    search: "old",
    replace: "new",
    where: "append",
    anchor: "line",
    thought: "hmm",
    name: "vault-tone",
    names: ["vault-tone"],
    description: "Tone guide",
    content: "Restrained and uncanny",
    questions: [{ question: "Which format?" }],
  };

  test("TOOL_ICONS covers every tool", () => {
    for (const name of ALL_TOOL_NAMES) {
      expect(TOOL_ICONS[name], `TOOL_ICONS missing "${name}"`).toBeDefined();
    }
  });

  test("TOOL_LABELS covers every tool", () => {
    for (const name of ALL_TOOL_NAMES) {
      expect(TOOL_LABELS[name], `TOOL_LABELS missing "${name}"`).toBeDefined();
    }
  });

  test("TOOL_STATUS_LABELS covers every tool", () => {
    for (const name of ALL_TOOL_NAMES) {
      expect(TOOL_STATUS_LABELS[name], `TOOL_STATUS_LABELS missing "${name}"`).toBeDefined();
    }
  });

  test("extractToolInput returns a detail for every tool", () => {
    for (const name of ALL_TOOL_NAMES) {
      const input = extractToolInput({ name, arguments: KITCHEN_SINK_ARGS });
      expect(input, `extractToolInput has no case for "${name}"`).toBeDefined();
    }
  });

  // The three coverage loops above assert in one direction only, so they catch a name
  // the surface *gained* and never one it lost: a merge that adds `get_links` and leaves
  // `get_backlinks` behind passes all three. That leftover is not harmless, it is a live
  // display row for a tool nothing can call, sitting where D2's RETIRED_TOOL_DISPLAY is
  // supposed to be the only home for a retired name. SNAP_TOOL_KEYS and
  // DISCOVERY_DIGEST_TOOLS already assert both directions; these did not.
  test("no display map holds a name the surface does not advertise", () => {
    const advertised = new Set([...ALL_TOOL_NAMES, THINK_TOOL_NAME]);
    const maps: [string, Record<string, string>][] = [
      ["TOOL_ICONS", TOOL_ICONS],
      ["TOOL_LABELS", TOOL_LABELS],
      ["TOOL_STATUS_LABELS", TOOL_STATUS_LABELS],
      ["TOOL_PENDING_LABELS", TOOL_PENDING_LABELS],
    ];
    for (const [label, map] of maps) {
      for (const name of Object.keys(map)) {
        expect(
          advertised.has(name),
          `${label} has an entry for "${name}", which is not an advertised tool; a retired name belongs in RETIRED_TOOL_DISPLAY`,
        ).toBe(true);
      }
    }
  });

  test("uses the blocking pending label for ask_user", () => {
    expect(pendingToolLabel("ask_user")).toBe("Waiting for your answer");
  });

  // TOOL_PENDING_LABELS is the one display map with a *silent* fallback: a missing key
  // falls through to the past-tense TOOL_LABELS, so a pending write row reads "Trashed
  // file" next to its own approve button rather than "Trash file". That is exactly the
  // F4 defect the map was added to fix, and nothing else catches its regression.
  test("TOOL_PENDING_LABELS covers every mutating tool, in the present tense", () => {
    for (const name of [
      ...VAULT_OPS_TOOL_NAMES,
      ...MEMORY_MUTATION_TOOL_NAMES,
    ]) {
      const pending = TOOL_PENDING_LABELS[name];
      expect(pending, `TOOL_PENDING_LABELS missing "${name}"`).toBeDefined();
      // A present-tense label must not be the past-tense one; the fallback would have
      // produced exactly that, so this is what distinguishes a real entry from a gap.
      expect(pending, `TOOL_PENDING_LABELS["${name}"] repeats the past-tense label`).not.toBe(
        TOOL_LABELS[name],
      );
    }
  });

  // The edit tools are deliberately exempt: their past-tense labels already phrase
  // themselves as proposals ("Proposed edit"), so they read correctly while pending.
  test("the edit tools carry no pending label, and read correctly without one", () => {
    for (const name of EDIT_TOOL_NAMES) {
      expect(TOOL_PENDING_LABELS[name]).toBeUndefined();
      expect(pendingToolLabel(name)).toBe(TOOL_LABELS[name]);
    }
  });
});

// A conversation recorded before RFC-0015 holds the tool name that turn really called,
// and nothing rewrites it. The two lookups that read a *persisted* name (the timeline
// step label and the rail icon) therefore have to answer for a retired name, or the
// saved turn degrades to the raw string and the generic wrench the moment the rename
// lands. Every stage that retires a name adds its case here.
describe("retired tool names still render", () => {
  test("propose_edit keeps its label and icon after becoming edit", () => {
    expect(toolLabel("propose_edit")).toBe("Proposed edit");
    expect(toolIcon("propose_edit")).toBe("pencil");
  });

  test("a retired name is not advertised, and its pending label is the retired one", () => {
    expect(EDIT_TOOL_NAMES.has("propose_edit")).toBe(false);
    expect(pendingToolLabel("propose_edit")).toBe("Proposed edit");
  });

  test("the absorbed read tools keep the label and icon they were recorded under", () => {
    expect(toolLabel("directory_tree")).toBe("Explored tree");
    expect(toolIcon("directory_tree")).toBe("folder-tree");
    expect(toolLabel("get_backlinks")).toBe("Found backlinks");
    expect(toolIcon("get_backlinks")).toBe("link");
    expect(toolLabel("get_outgoing_links")).toBe("Found outgoing links");
    expect(toolIcon("get_outgoing_links")).toBe("external-link");
  });

  // A merge is where the retired entry stops being cosmetic: the absorbing tool's own
  // label is a different sentence ("Listed folder", "Found links"), so without these
  // rows a saved turn would either read the wrong thing or fall to the raw name.
  test("an absorbed name keeps its own wording, not the absorbing tool's", () => {
    for (const name of ["directory_tree", "get_backlinks", "get_outgoing_links"]) {
      expect(VAULT_TOOL_NAMES.has(name)).toBe(false);
      expect(toolLabel(name)).not.toBe(name);
    }
    expect(toolLabel("directory_tree")).not.toBe(TOOL_LABELS.list_directory);
    expect(toolLabel("get_backlinks")).not.toBe(TOOL_LABELS.get_links);
    expect(toolLabel("get_outgoing_links")).not.toBe(TOOL_LABELS.get_links);
  });

  test("a saved call to an absorbed tool still shows its target as the detail line", () => {
    for (const name of [
      "directory_tree",
      "get_backlinks",
      "get_outgoing_links",
      "read_file",
      "read_section",
    ]) {
      expect(
        extractToolInput({ name, arguments: { path: "Characters/Will.md" } }),
        `extractToolInput lost the retired case for "${name}"`,
      ).toBe("Characters/Will.md");
    }
  });

  test("the two absorbed reads keep the label and icon they were recorded under", () => {
    expect(toolLabel("read_file")).toBe("Read note");
    expect(toolIcon("read_file")).toBe("file-text");
    expect(toolLabel("read_section")).toBe("Read section");
    expect(toolIcon("read_section")).toBe("text-select");
  });

  // read_file is the case where the two halves of D2 pull apart. Its display vocabulary
  // survived the merge unchanged, so its retired row reads exactly like `read`'s live
  // one; read_section's did not, and a saved section read would otherwise claim to have
  // been a whole-note read.
  test("read_section keeps its own wording where read_file shares the absorbing tool's", () => {
    for (const name of ["read_file", "read_section"]) {
      expect(VAULT_TOOL_NAMES.has(name)).toBe(false);
      expect(toolLabel(name)).not.toBe(name);
    }
    expect(toolLabel("read_file")).toBe(TOOL_LABELS.read);
    expect(toolLabel("read_section")).not.toBe(TOOL_LABELS.read);
  });

  // The composition is read_section's and it now has to serve both retired names plus
  // the absorbing tool, on both of `read`'s pathways.
  test("a saved section read still composes path and headingPath", () => {
    for (const name of ["read_section", "read"]) {
      expect(
        extractToolInput({
          name,
          arguments: { path: "Book.md", headingPath: "Act I > Chapter 1" },
        }),
      ).toBe("Book.md > Act I > Chapter 1");
    }
  });

  // The gated merges, where a retired display row is at its most load-bearing: both of
  // each pair's labels are distinct sentences from the merged tool's, so a saved turn
  // without these rows would lose the file/folder distinction entirely and fall to the
  // raw name and the generic wrench beside it.
  test("the four retired write siblings keep the label and icon they were recorded under", () => {
    expect(toolLabel("move_file")).toBe("Moved file");
    expect(toolIcon("move_file")).toBe("file-symlink");
    expect(toolLabel("move_folder")).toBe("Moved folder");
    expect(toolIcon("move_folder")).toBe("folder-symlink");
    expect(toolLabel("trash_file")).toBe("Trashed file");
    expect(toolIcon("trash_file")).toBe("trash-2");
    expect(toolLabel("trash_folder")).toBe("Trashed folder");
    expect(toolIcon("trash_folder")).toBe("folder-x");
  });

  test("a merged write tool's retired names keep their own wording", () => {
    for (const name of ["move_file", "move_folder"]) {
      expect(VAULT_OPS_TOOL_NAMES.has(name)).toBe(false);
      expect(toolLabel(name)).not.toBe(name);
      expect(toolLabel(name)).not.toBe(TOOL_LABELS.move);
    }
    for (const name of ["trash_file", "trash_folder"]) {
      expect(VAULT_OPS_TOOL_NAMES.has(name)).toBe(false);
      expect(toolLabel(name)).not.toBe(name);
      expect(toolLabel(name)).not.toBe(TOOL_LABELS.trash);
    }
  });

  // A retired *mutating* name reaches the pending row too, through pendingToolLabel's
  // fallback chain. Without the retired entry it would read the raw tool name beside a
  // live approve button; with it, it reads the past-tense label, which is correct for a
  // saved turn because that turn is over.
  test("a retired write name has no pending label of its own and falls to its retired one", () => {
    for (const name of ["move_file", "move_folder", "trash_file", "trash_folder"]) {
      expect(TOOL_PENDING_LABELS[name]).toBeUndefined();
      expect(pendingToolLabel(name)).toBe(toolLabel(name));
      expect(pendingToolLabel(name)).not.toBe(name);
    }
  });

  test("a saved call to a retired write sibling still shows its target as the detail line", () => {
    expect(
      extractToolInput({ name: "move_file", arguments: { from: "A.md", to: "B.md" } }),
      "extractToolInput lost the retired case for \"move_file\"",
    ).toBe("A.md → B.md");
    expect(
      extractToolInput({ name: "move_folder", arguments: { from: "A", to: "B" } }),
      "extractToolInput lost the retired case for \"move_folder\"",
    ).toBe("A → B");
    for (const name of ["trash_file", "trash_folder"]) {
      expect(
        extractToolInput({ name, arguments: { path: "Inbox/Obsolete.md" } }),
        `extractToolInput lost the retired case for "${name}"`,
      ).toBe("Inbox/Obsolete.md");
    }
  });

  test("a name that never existed still falls back to the raw name and the wrench", () => {
    expect(toolLabel("nonexistent_tool")).toBe("nonexistent_tool");
    expect(toolIcon("nonexistent_tool")).toBe("wrench");
  });
});

describe("operation-kind display metadata", () => {
  // Keys are typechecked against VaultOperation["kind"]; the values are tool-name
  // strings nothing checks. A rename that misses one leaves a historical vault-op row
  // labelling itself from a tool that no longer exists, which degrades to a raw string.
  test("every TOOL_NAME_BY_OP_KIND value is an advertised vault-op tool", () => {
    for (const [kind, toolName] of Object.entries(TOOL_NAME_BY_OP_KIND)) {
      expect(
        VAULT_OPS_TOOL_NAMES.has(toolName),
        `TOOL_NAME_BY_OP_KIND["${kind}"] names "${toolName}", which is not a vault-op tool`,
      ).toBe(true);
    }
  });

  test("every op kind resolves to a label and an icon through its tool", () => {
    for (const kind of Object.keys(TOOL_NAME_BY_OP_KIND) as Array<
      keyof typeof TOOL_NAME_BY_OP_KIND
    >) {
      expect(TOOL_LABELS[TOOL_NAME_BY_OP_KIND[kind]], `no label for kind "${kind}"`).toBeDefined();
      expect(opKindIcon(kind), `no icon for kind "${kind}"`).toBeDefined();
    }
  });
});
