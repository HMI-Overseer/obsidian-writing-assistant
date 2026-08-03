import { describe, expect, it } from "vitest";
import { buildActionEvidence } from "../../../../src/chat/messages/actionLedgerEvidence";
import type {
  ToolActionEvent,
  ToolActionLedgerEntry,
} from "../../../../src/shared/types";
import type { VaultOperation } from "../../../../src/vault-ops/types";

const EXPECT = { mtime: 1, size: 2 };

function placement(family: string): ToolActionLedgerEntry["placement"] {
  return {
    state: "placed",
    anchor: "tool_call",
    itemId: `item-${family}`,
    correlation: { kind: "provider_id", toolCallId: `call-${family}` },
  };
}

function proposed(targetId: string): ToolActionEvent {
  return {
    eventId: `proposed-${targetId}`,
    type: "proposed",
    targetId,
    createdAt: 1,
  };
}

function editEntry(events: ToolActionEvent[] = []): ToolActionLedgerEntry {
  return {
    actionRef: "action-edit",
    revisionId: "revision-1",
    family: "edit",
    placement: placement("edit"),
    payload: {
      proposalId: "proposal-edit",
      targets: [
        {
          targetId: "hunk-1",
          targetFilePath: "Chapters/Chapter 1.md",
          documentSnapshot: "before",
          snapshotTimestamp: 1,
          resolvedEdit: {
            id: "hunk-1",
            editBlock: {
              id: "call-edit",
              searchText: "before",
              replaceText: "after",
              rawBlock: "",
            },
            matchOffset: 0,
            matchLength: 6,
            matchedText: "before",
            startLine: 4,
            endLine: 4,
            contextBefore: ["context"],
            contextAfter: [],
            confidence: 1,
            matchType: "exact",
          },
        },
      ],
    },
    events: [proposed("hunk-1"), ...events],
  };
}

function vaultEntry(
  operation: VaultOperation,
  events: ToolActionEvent[] = [],
): ToolActionLedgerEntry {
  return {
    actionRef: "action-vault",
    revisionId: "revision-1",
    family: "vault_op",
    placement: placement("vault"),
    payload: {
      proposalId: "proposal-vault",
      createdAt: 1,
      targets: [
        {
          targetId: "op-1",
          operation,
          gate: "ask",
          summary: "Write Notes/Draft.md",
        },
      ],
    },
    events: [proposed("op-1"), ...events],
  };
}

function applied(
  targetId: string,
  effect: Extract<ToolActionEvent, { type: "apply_succeeded" }>["effect"],
): ToolActionEvent[] {
  return [
    {
      eventId: `approved-${targetId}`,
      type: "approved",
      targetId,
      createdAt: 2,
    },
    {
      eventId: `applied-${targetId}`,
      type: "apply_succeeded",
      targetId,
      createdAt: 3,
      effect,
    },
  ];
}

const EDIT_EFFECT = {
  family: "edit" as const,
  targetFilePath: "Chapters/Chapter 1.md",
  preApplySnapshot: "before",
  postApplySnapshot: "after",
  appliedAt: 3,
};

describe("durable review evidence", () => {
  it("rebuilds an edit's diff from the ledger, not from the live review", () => {
    const [evidence, ...rest] = buildActionEvidence(editEntry());

    expect(rest).toEqual([]);
    expect(evidence).toEqual({
      kind: "edit_diff",
      targetId: "hunk-1",
      status: "pending",
      filePath: "Chapters/Chapter 1.md",
      resolvedEdit: expect.objectContaining({
        matchedText: "before",
        startLine: 4,
        editBlock: expect.objectContaining({ replaceText: "after" }),
      }),
    });
  });

  it("tints an edit card by whether the change is in the file", () => {
    expect(
      buildActionEvidence(editEntry(applied("hunk-1", EDIT_EFFECT)))[0].status,
    ).toBe("accepted");
    expect(
      buildActionEvidence(
        editEntry([
          {
            eventId: "declined-hunk-1",
            type: "declined",
            targetId: "hunk-1",
            createdAt: 2,
            reason: "rejected",
          },
        ]),
      )[0].status,
    ).toBe("rejected");
  });

  it("previews a create as an all-add write with nothing to read from disk", () => {
    const evidence = buildActionEvidence(
      vaultEntry({
        kind: "create",
        path: "Notes/Draft.md",
        content: "First line.",
      }),
    );

    expect(evidence).toEqual([
      {
        kind: "write_diff",
        targetId: "op-1",
        status: "pending",
        path: "Notes/Draft.md",
        content: "First line.",
        before: null,
        beforeIsRecorded: true,
      },
    ]);
  });

  it("takes an applied overwrite's before from its own undo inverse", () => {
    const operation: VaultOperation = {
      kind: "overwrite",
      path: "Notes/Draft.md",
      content: "New body.",
      expect: EXPECT,
    };
    const evidence = buildActionEvidence(
      vaultEntry(
        operation,
        applied("op-1", {
          family: "vault_op",
          operation,
          inverse: {
            kind: "overwrite",
            path: "Notes/Draft.md",
            content: "Old body.",
            expect: EXPECT,
          },
          appliedAt: 3,
        }),
      ),
    );

    expect(evidence[0]).toMatchObject({
      kind: "write_diff",
      status: "accepted",
      content: "New body.",
      before: "Old body.",
      beforeIsRecorded: true,
    });
  });

  it("leaves an unapplied overwrite's before to the file still holding it", () => {
    const evidence = buildActionEvidence(
      vaultEntry({
        kind: "overwrite",
        path: "Notes/Draft.md",
        content: "New body.",
        expect: EXPECT,
      }),
    );

    expect(evidence[0]).toMatchObject({
      before: null,
      beforeIsRecorded: false,
    });
  });

  it("returns an undone overwrite to reading the file it restored", () => {
    const operation: VaultOperation = {
      kind: "overwrite",
      path: "Notes/Draft.md",
      content: "New body.",
      expect: EXPECT,
    };
    const inverse: VaultOperation = {
      kind: "overwrite",
      path: "Notes/Draft.md",
      content: "Old body.",
      expect: EXPECT,
    };
    const evidence = buildActionEvidence(
      vaultEntry(operation, [
        ...applied("op-1", {
          family: "vault_op",
          operation,
          inverse,
          appliedAt: 3,
        }),
        {
          eventId: "undone-op-1",
          type: "undo_succeeded",
          targetId: "op-1",
          createdAt: 4,
          undo: { family: "vault_op", inverse, undoneAt: 4 },
        },
      ]),
    );

    expect(evidence[0]).toMatchObject({
      status: "pending",
      before: null,
      beforeIsRecorded: false,
    });
  });

  it("keeps a vault-wide replace's blast radius as its affected-file list", () => {
    const evidence = buildActionEvidence(
      vaultEntry({
        kind: "replaceInVault",
        search: "Alise",
        replace: "Alice",
        caseSensitive: true,
        wholeWord: false,
        occurrences: 3,
        targets: [
          { path: "A.md", content: "a", expect: EXPECT, count: 2 },
          { path: "B.md", content: "b", expect: EXPECT },
        ],
      }),
    );

    expect(evidence).toEqual([
      {
        kind: "replace_files",
        targetId: "op-1",
        status: "pending",
        files: [{ path: "A.md", count: 2 }, { path: "B.md" }],
      },
    ]);
  });

  it.each([
    ["move", { kind: "move", from: "A.md", to: "B.md", expect: EXPECT }],
    ["trash", { kind: "trash", path: "A.md", expect: EXPECT, snapshot: "a" }],
    ["createDir", { kind: "createDir", path: "Folder" }],
    ["trashFolder", { kind: "trashFolder", path: "Folder" }],
  ] as const)(
    "shows no card for %s, whose whole change is the path on the step",
    (_kind, operation) => {
      expect(buildActionEvidence(vaultEntry(operation))).toEqual([]);
    },
  );

  it("keeps an added memory's record and drops a forget with nothing to show", () => {
    const memoryEntry = (
      mutation: Extract<
        ToolActionLedgerEntry,
        { family: "memory" }
      >["payload"]["targets"][number]["mutation"],
    ): ToolActionLedgerEntry => ({
      actionRef: "action-memory",
      revisionId: "revision-1",
      family: "memory",
      placement: placement("memory"),
      payload: { targets: [{ targetId: "memory-1", mutation }] },
      events: [proposed("memory-1")],
    });

    expect(
      buildActionEvidence(
        memoryEntry({
          kind: "add",
          memory: {
            name: "narrative-voice",
            type: "user",
            description: "Prefers restrained narration.",
            content: "Concrete images over adjectives.",
          },
        }),
      ),
    ).toEqual([
      {
        kind: "memory_record",
        targetId: "memory-1",
        status: "pending",
        description: "Prefers restrained narration.",
        content: "Concrete images over adjectives.",
      },
    ]);
    expect(
      buildActionEvidence(
        memoryEntry({ kind: "forget", name: "narrative-voice" }),
      ),
    ).toEqual([]);
  });

  it("shows nothing for a question already written out on its own step", () => {
    expect(
      buildActionEvidence({
        actionRef: "action-interaction",
        revisionId: "revision-1",
        family: "interaction",
        placement: placement("interaction"),
        payload: {
          kind: "ask_user",
          targets: [
            {
              targetId: "question-0",
              question: "Continue?",
              header: "Choice",
              options: ["Yes", "No"],
              multiSelect: false,
            },
          ],
        },
        events: [proposed("question-0")],
      }),
    ).toEqual([]);
  });

  it("hands the renderer a copy, so a card can never write back to the record", () => {
    const entry = editEntry();
    const evidence = buildActionEvidence(entry);

    if (evidence[0].kind !== "edit_diff") throw new Error("expected a diff");
    evidence[0].resolvedEdit.matchedText = "mutated";

    expect(entry.payload.targets[0].resolvedEdit.matchedText).toBe("before");
  });
});
