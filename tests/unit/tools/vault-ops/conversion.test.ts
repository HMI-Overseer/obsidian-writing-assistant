import { describe, test, expect } from "vitest";
import { toVaultOperations } from "../../../../src/tools/vault-ops/conversion";
import type { ConversionProbes } from "../../../../src/tools/vault-ops/conversion";
import type { PathState, TargetFingerprint } from "../../../../src/vault-ops/types";
import type { ToolCall } from "../../../../src/tools/types";

const FP: TargetFingerprint = { mtime: 100, size: 50 };

function probes(
  states: Record<string, PathState> = {},
  content: Record<string, string> = {},
  replaceTargets: ConversionProbes["replaceTargets"] = () => null,
): ConversionProbes {
  return {
    resolve: (p) => states[p] ?? "absent",
    fingerprint: (p) => (states[p] && states[p] !== "absent" ? FP : null),
    readContent: (p) => content[p] ?? null,
    configDir: ".obsidian",
    replaceTargets,
  };
}

const call = (name: string, args: Record<string, unknown>, id = "t1"): ToolCall => ({
  id,
  name,
  arguments: args,
});

describe("toVaultOperations", () => {
  test("write_file to a new path → create", () => {
    const { ops, errors } = toVaultOperations(
      [call("write_file", { path: "a.md", content: "hi" })],
      probes(),
    );
    expect(errors).toHaveLength(0);
    expect(ops).toEqual([{ kind: "create", path: "a.md", content: "hi" }]);
  });

  test("write_file to an existing path → overwrite with fingerprint", () => {
    const { ops } = toVaultOperations(
      [call("write_file", { path: "a.md", content: "hi" })],
      probes({ "a.md": "file" }),
    );
    expect(ops).toEqual([{ kind: "overwrite", path: "a.md", content: "hi", expect: FP }]);
  });

  test("move_file captures the source fingerprint", () => {
    const { ops } = toVaultOperations(
      [call("move_file", { from: "a.md", to: "b.md" })],
      probes({ "a.md": "file" }),
    );
    expect(ops).toEqual([{ kind: "move", from: "a.md", to: "b.md", expect: FP }]);
  });

  test("trash_file captures fingerprint and content snapshot", () => {
    const { ops } = toVaultOperations(
      [call("trash_file", { path: "a.md" })],
      probes({ "a.md": "file" }, { "a.md": "body" }),
    );
    expect(ops).toEqual([{ kind: "trash", path: "a.md", expect: FP, snapshot: "body" }]);
  });

  test("create_directory → createDir", () => {
    const { ops } = toVaultOperations([call("create_directory", { path: "Dir" })], probes());
    expect(ops).toEqual([{ kind: "createDir", path: "Dir" }]);
  });

  test("move_folder → moveFolder, no fingerprint (existence guard)", () => {
    const { ops, errors } = toVaultOperations(
      [call("move_folder", { from: "Drafts/Act II", to: "Manuscript/Act II" })],
      probes({ "Drafts/Act II": "dir" }),
    );
    expect(errors).toHaveLength(0);
    expect(ops).toEqual([{ kind: "moveFolder", from: "Drafts/Act II", to: "Manuscript/Act II" }]);
  });

  test("trash_folder → trashFolder, no snapshot (empty-only, inverse is createDir)", () => {
    const { ops, errors } = toVaultOperations(
      [call("trash_folder", { path: "Drafts/Act II" })],
      probes({ "Drafts/Act II": "dir" }),
    );
    expect(errors).toHaveLength(0);
    expect(ops).toEqual([{ kind: "trashFolder", path: "Drafts/Act II" }]);
  });

  test("a move_folder whose source is a file is an error, not an op (steers to move_file)", () => {
    const { ops, errors } = toVaultOperations(
      [call("move_folder", { from: "note.md", to: "Archive" })],
      probes({ "note.md": "file" }),
    );
    expect(ops).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toContain("move_file");
  });

  test("create_directory on an existing folder → flagged no-op, no error (idempotent)", () => {
    const { ops, satisfied, errors } = toVaultOperations(
      [call("create_directory", { path: "Dir" })],
      probes({ Dir: "dir" }),
    );
    // Emitted (so the timeline can show "already exists") but flagged satisfied
    // so finalization marks it informational and it is never applied.
    expect(ops).toEqual([{ kind: "createDir", path: "Dir" }]);
    expect(satisfied).toEqual([true]);
    expect(errors).toHaveLength(0);
  });

  test("validation failures become self-correcting errors, not ops", () => {
    const { ops, errors } = toVaultOperations(
      [call("move_file", { from: "missing.md", to: "b.md" })],
      probes(),
    );
    expect(ops).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].toolName).toBe("move_file");
  });

  test("unknown tool name is an error", () => {
    const { errors } = toVaultOperations([call("delete_everything", {})], probes());
    expect(errors).toHaveLength(1);
  });

  describe("replace_in_vault", () => {
    const scan = {
      targets: [
        { path: "Lore/A.md", content: "new A", expect: { mtime: 1, size: 5 }, count: 2 },
        { path: "Lore/B.md", content: "new B", expect: { mtime: 2, size: 5 }, count: 1 },
      ],
      occurrences: 3,
    };

    test("one call → one composite replaceInVault op from the scan probe", () => {
      const { ops, errors } = toVaultOperations(
        [call("replace_in_vault", { search: "old", replace: "new" }, "r1")],
        probes({}, {}, (id) => (id === "r1" ? scan : null)),
      );
      expect(errors).toHaveLength(0);
      expect(ops).toEqual([
        {
          kind: "replaceInVault",
          search: "old",
          replace: "new",
          caseSensitive: false,
          wholeWord: false,
          targets: scan.targets,
          occurrences: 3,
        },
      ]);
    });

    test("threads the flags through to the op", () => {
      const { ops } = toVaultOperations(
        [
          call(
            "replace_in_vault",
            { search: "old", replace: "new", caseSensitive: true, wholeWord: true },
            "r1",
          ),
        ],
        probes({}, {}, () => scan),
      );
      expect(ops[0]).toMatchObject({ caseSensitive: true, wholeWord: true });
    });

    test("no matches (probe returns null) → no op, no error", () => {
      const { ops, errors } = toVaultOperations(
        [call("replace_in_vault", { search: "absent", replace: "x" })],
        probes({}, {}, () => null),
      );
      expect(ops).toHaveLength(0);
      expect(errors).toHaveLength(0);
    });

    test("empty search is a self-correcting error, not an op", () => {
      const { ops, errors } = toVaultOperations(
        [call("replace_in_vault", { search: "", replace: "x" })],
        probes({}, {}, () => scan),
      );
      expect(ops).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(errors[0].error).toMatch(/search/i);
    });
  });

  test("sources are index-aligned with ops, skipping dropped calls", () => {
    // t2 (missing move source) drops out; sources must still line up with ops so
    // each op links back to the tool call (and timeline step) it came from.
    const { ops, sources } = toVaultOperations(
      [
        call("write_file", { path: "a.md", content: "x" }, "t1"),
        call("move_file", { from: "missing.md", to: "b.md" }, "t2"),
        call("create_directory", { path: "Dir" }, "t3"),
      ],
      probes(),
    );
    expect(ops.map((o) => o.kind)).toEqual(["create", "createDir"]);
    expect(sources).toEqual(["t1", "t3"]);
  });

  describe("truncation guard (§6 1a)", () => {
    test("refuses a trailing write_file when generation hit max_tokens", () => {
      const { ops, errors } = toVaultOperations(
        [call("write_file", { path: "a.md", content: "partial..." })],
        probes(),
        { stoppedForMaxTokens: true },
      );
      expect(ops).toHaveLength(0);
      expect(errors[0].error).toMatch(/cut off|incomplete/i);
    });

    test("only the final call is suspect, earlier write_files still convert", () => {
      const { ops, errors } = toVaultOperations(
        [
          call("write_file", { path: "a.md", content: "complete" }, "t1"),
          call("write_file", { path: "b.md", content: "partial" }, "t2"),
        ],
        probes(),
        { stoppedForMaxTokens: true },
      );
      expect(ops).toEqual([{ kind: "create", path: "a.md", content: "complete" }]);
      expect(errors).toHaveLength(1);
      expect(errors[0].toolCallId).toBe("t2");
    });

    test("no guard when generation stopped normally", () => {
      const { ops, errors } = toVaultOperations(
        [call("write_file", { path: "a.md", content: "done" })],
        probes(),
        { stoppedForMaxTokens: false },
      );
      expect(errors).toHaveLength(0);
      expect(ops).toHaveLength(1);
    });
  });
});
