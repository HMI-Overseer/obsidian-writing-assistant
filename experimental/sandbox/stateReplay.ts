import { createHash } from "node:crypto";
import type {
  SandboxEpisodeRound,
  SyntheticVaultSnapshot,
  SyntheticVaultSnapshotFile,
} from "./types";

function hash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function replaySandboxState(
  initial: SyntheticVaultSnapshot,
  rounds: SandboxEpisodeRound[],
): SyntheticVaultSnapshot {
  const files = new Map<string, SyntheticVaultSnapshotFile>(
    initial.files.map((file) => [file.path, structuredClone(file)]),
  );
  for (const execution of rounds.flatMap((round) => round.toolExecutions)) {
    const review = execution.review;
    if (!review?.applied) continue;
    const { path, content } = review.proposal;
    files.set(path, { path, content, sha256: hash(content) });
  }
  return {
    fixtureId: initial.fixtureId,
    fixtureVersion: initial.fixtureVersion,
    files: [...files.values()].sort((left, right) => left.path.localeCompare(right.path)),
  };
}
