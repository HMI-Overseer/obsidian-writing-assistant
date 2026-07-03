import { describe, it, expect } from "vitest";
import { supersedePriorProposals } from "../../../../src/chat/actions/supersedePriorProposals";
import type { ConversationMessage } from "../../../../src/shared/types";
import type { EditProposal, EditStatus } from "../../../../src/editing/editTypes";
import type { ReviewableVaultOp, VaultOperationProposal } from "../../../../src/vault-ops/types";

function editMsg(...statuses: EditStatus[]): ConversationMessage {
  const proposal = {
    id: "e1",
    targetFilePath: "Note.md",
    documentSnapshot: "",
    snapshotTimestamp: 0,
    prose: "",
    hunks: statuses.map((status, i) => ({ id: `h${i}`, status })),
  } as unknown as EditProposal;
  return { id: "m1", role: "assistant", content: "", editProposal: proposal };
}

function vaultMsg(
  ops: Array<ReviewableVaultOp["status"]>,
  historical = false,
): ConversationMessage {
  const proposal: VaultOperationProposal = {
    id: "v1",
    createdAt: 0,
    historical,
    ops: ops.map(
      (status, i) =>
        ({
          id: `o${i}`,
          status,
          gate: "ask",
          summary: "",
          op: { kind: "create", path: `F${i}.md`, content: "" },
        }) as ReviewableVaultOp,
    ),
  };
  return { id: "m2", role: "assistant", content: "", vaultOpProposal: proposal };
}

describe("supersedePriorProposals", () => {
  it("rejects pending edit hunks and reports a change", () => {
    const msg = editMsg("pending", "accepted", "rejected");
    const changed = supersedePriorProposals([msg]);

    expect(changed).toBe(true);
    expect(msg.editProposal?.hunks.map((h) => h.status)).toEqual([
      "rejected",
      "accepted",
      "rejected",
    ]);
  });

  it("rejects pending hunks across ALL of a turn's edit proposals (ADR-0010 multi-file)", () => {
    const a = {
      id: "eA", targetFilePath: "A.md", documentSnapshot: "", snapshotTimestamp: 0, prose: "",
      hunks: [{ id: "a0", status: "pending" }],
    } as unknown as EditProposal;
    const b = {
      id: "eB", targetFilePath: "B.md", documentSnapshot: "", snapshotTimestamp: 0, prose: "",
      hunks: [{ id: "b0", status: "pending" }, { id: "b1", status: "accepted" }],
    } as unknown as EditProposal;
    const msg: ConversationMessage = {
      id: "m1", role: "assistant", content: "", editProposals: [a, b],
    };

    const changed = supersedePriorProposals([msg]);

    expect(changed).toBe(true);
    // Every file's pending hunk is superseded, not just the first proposal's.
    expect(a.hunks.map((h) => h.status)).toEqual(["rejected"]);
    expect(b.hunks.map((h) => h.status)).toEqual(["rejected", "accepted"]);
  });

  it("rejects pending and accepted vault ops, leaving applied ones", () => {
    const msg = vaultMsg(["pending", "accepted", "applied"]);
    supersedePriorProposals([msg]);

    expect(msg.vaultOpProposal?.ops.map((o) => o.status)).toEqual([
      "rejected",
      "rejected",
      "applied",
    ]);
  });

  it("marks vault proposals historical so the panel renders the locked variant", () => {
    const msg = vaultMsg(["applied"]);
    supersedePriorProposals([msg]);

    expect(msg.vaultOpProposal?.historical).toBe(true);
  });

  it("reports no change when there is nothing live to supersede", () => {
    const msg = vaultMsg(["applied", "rejected"], true);
    const changed = supersedePriorProposals([msg]);

    expect(changed).toBe(false);
  });

  it("supersedes both channels in one pass", () => {
    const history = [editMsg("pending"), vaultMsg(["pending"])];
    const changed = supersedePriorProposals(history);

    expect(changed).toBe(true);
    expect(history[0].editProposal?.hunks[0].status).toBe("rejected");
    expect(history[1].vaultOpProposal?.ops[0].status).toBe("rejected");
    expect(history[1].vaultOpProposal?.historical).toBe(true);
  });
});
