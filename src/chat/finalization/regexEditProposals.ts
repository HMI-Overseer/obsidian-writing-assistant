import type { App } from "obsidian";
import type WritingAssistantChat from "../../main";
import { buildHunks, resolveEdits } from "../../editing/diffEngine";
import type {
  EditBlock,
  EditProposal,
} from "../../editing/editTypes";
import { parseEditBlocks } from "../../editing/parseEditBlocks";
import { resolveStructuralEditBlocks } from "../../tools/editing/handlers";
import { generateId } from "../../utils";

/** Resolve regex edit blocks for chain-backed action-ledger capture. */
export async function buildRegexEditProposals(
  app: App,
  plugin: WritingAssistantChat,
  response: string,
): Promise<EditProposal[]> {
  const parsed = parseEditBlocks(response);
  if (parsed.blocks.length === 0) return [];
  const proposals: EditProposal[] = [];
  const groups = groupBlocksByTarget(
    parsed.blocks,
    app.workspace.getActiveFile()?.path,
  );
  for (const [path, blocks] of groups) {
    const proposal = await buildEditProposal(
      app,
      plugin,
      path,
      blocks,
      proposals.length === 0 ? parsed.prose : "",
    );
    if (proposal) proposals.push(proposal);
  }
  return proposals;
}

function groupBlocksByTarget(
  blocks: EditBlock[],
  activeFilePath: string | undefined,
): Map<string, EditBlock[]> {
  const groups = new Map<string, EditBlock[]>();
  for (const block of blocks) {
    const path = block.targetPath ?? activeFilePath;
    if (!path) continue;
    const existing = groups.get(path);
    if (existing) existing.push(block);
    else groups.set(path, [block]);
  }
  return groups;
}

async function buildEditProposal(
  app: App,
  plugin: WritingAssistantChat,
  filePath: string,
  blocks: EditBlock[],
  prose: string,
): Promise<EditProposal | null> {
  let resolved = blocks;
  if (blocks.some((block) => block.toolName)) {
    resolved = await resolveStructuralEditBlocks(blocks, {
      app,
      filePath,
    });
  }

  const file = app.vault.getFileByPath(filePath);
  if (!file) return null;
  const documentText = await app.vault.read(file);
  const resolvedEdits = resolveEdits(resolved, documentText, {
    contextLines: plugin.settings.diffContextLines,
    minConfidence: plugin.settings.diffMinMatchConfidence,
  });
  const hunks = buildHunks(resolvedEdits);
  if (hunks.length === 0) return null;

  return {
    id: generateId(),
    targetFilePath: filePath,
    documentSnapshot: documentText,
    snapshotTimestamp: Date.now(),
    hunks,
    prose,
  };
}
