/**
 * Apply planning: pre-flight, dependency ordering, and inverse derivation
 * (ADR-0006). Pure, disk state is injected as plain data, so
 * every correctness decision is unit-testable without a vault.
 */

import type { PathState, TargetFingerprint, VaultOperation } from "./types";
import { targetPaths } from "./gateway";
import { escapesVault, outsideVaultMessage } from "./pathSafety";

/** Live disk, injected as data. The apply executor backs this with the real vault. */
export interface DiskSnapshot {
  state: (path: string) => PathState;
  fingerprint: (path: string) => TargetFingerprint | null;
}

export interface Conflict {
  index: number;
  op: VaultOperation;
  reason: string;
}

export interface PreflightResult {
  ok: boolean;
  conflicts: Conflict[];
}

export function fingerprintsMatch(live: TargetFingerprint | null, expect: TargetFingerprint): boolean {
  return live !== null && live.mtime === expect.mtime && live.size === expect.size;
}

/**
 * Authoritative pre-flight: re-resolve every op against live disk.
 * Any conflict ⇒ the batch aborts and nothing is written. This is the real
 * safety guarantee; in-loop validation is only a courtesy to the model.
 */
export function preflight(ops: VaultOperation[], disk: DiskSnapshot): PreflightResult {
  const conflicts: Conflict[] = [];
  ops.forEach((op, index) => {
    const add = (reason: string) => conflicts.push({ index, op, reason });
    // Vault-boundary guard (authoritative): refuse any op whose path escapes the
    // vault, so an out-of-vault write can never reach disk even if it slipped past
    // the in-loop validator. A violation aborts the whole batch, nothing is written.
    const escaping = targetPaths(op).find((p) => escapesVault(p));
    if (escaping !== undefined) add(outsideVaultMessage(escaping));
    switch (op.kind) {
      case "create":
        if (disk.state(op.path) !== "absent") add(`"${op.path}" already exists.`);
        break;
      case "createDir": {
        // absent ⇒ create; dir ⇒ idempotent no-op; file ⇒ conflict.
        if (disk.state(op.path) === "file") add(`"${op.path}" is a file, not a folder.`);
        break;
      }
      case "overwrite":
        if (disk.state(op.path) !== "file") add(`"${op.path}" no longer exists.`);
        else if (!fingerprintsMatch(disk.fingerprint(op.path), op.expect))
          add(`"${op.path}" changed on disk since it was proposed.`);
        break;
      case "move":
        if (disk.state(op.from) !== "file") add(`source "${op.from}" no longer exists.`);
        else if (!fingerprintsMatch(disk.fingerprint(op.from), op.expect))
          add(`source "${op.from}" changed on disk since it was proposed.`);
        if (disk.state(op.to) !== "absent") add(`destination "${op.to}" already exists.`);
        break;
      case "trash":
        if (disk.state(op.path) !== "file") add(`"${op.path}" no longer exists.`);
        else if (!fingerprintsMatch(disk.fingerprint(op.path), op.expect))
          add(`"${op.path}" changed on disk since it was proposed.`);
        break;
      case "replaceInVault":
        // Each target must still be a file and match the fingerprint captured at scan
        // time; any drift means the precomputed replacement is stale, abort the batch.
        for (const t of op.targets) {
          if (disk.state(t.path) !== "file") add(`"${t.path}" no longer exists.`);
          else if (!fingerprintsMatch(disk.fingerprint(t.path), t.expect))
            add(`"${t.path}" changed on disk since the replacement was prepared.`);
        }
        break;
      case "moveFolder":
        // Existence-based guard (a folder has no mtime/size fingerprint): the source
        // must still be a folder and the destination free.
        if (disk.state(op.from) !== "dir") add(`source folder "${op.from}" no longer exists.`);
        if (disk.state(op.to) !== "absent") add(`destination "${op.to}" already exists.`);
        break;
      case "trashFolder":
        // Existence only here. Emptiness is enforced authoritatively at apply
        // (folderIsEmpty), not at pre-flight, so a same-batch move that empties this
        // folder first (moves are ordered before folder trashes) is not false-flagged
        // as a conflict against the pre-move disk snapshot.
        if (disk.state(op.path) !== "dir") add(`"${op.path}" is not a folder, or no longer exists.`);
        break;
    }
  });
  return { ok: conflicts.length === 0, conflicts };
}

const KIND_PRIORITY: Record<VaultOperation["kind"], number> = {
  createDir: 0,
  create: 1,
  overwrite: 1,
  // A replace rewrites existing files' content, same tier as overwrite/create.
  replaceInVault: 1,
  move: 2,
  // A folder move sits in the move tier; a folder trash in the trash tier, so a
  // husk-emptying move/moveFolder always applies before the trashFolder that removes it.
  moveFolder: 2,
  trash: 3,
  trashFolder: 3,
};

/**
 * Deterministic dependency order: createDir → create/overwrite → move →
 * trash, with explicit edges where one op's path is under another's created
 * folder, or a move's source is a freshly created/overwritten file. A small
 * topological sort (Kahn's) with a (priority, index) tiebreak for determinism.
 */
export function orderOps(ops: VaultOperation[]): VaultOperation[] {
  const n = ops.length;
  const indeg = new Array<number>(n).fill(0);
  const adj: number[][] = Array.from({ length: n }, () => []);

  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) {
      if (a !== b && dependsBefore(ops[a], ops[b])) {
        adj[a].push(b);
        indeg[b]++;
      }
    }
  }

  const ready: number[] = [];
  for (let i = 0; i < n; i++) if (indeg[i] === 0) ready.push(i);

  const ordered: VaultOperation[] = [];
  while (ready.length > 0) {
    ready.sort((x, y) => {
      const byKind = KIND_PRIORITY[ops[x].kind] - KIND_PRIORITY[ops[y].kind];
      return byKind !== 0 ? byKind : x - y;
    });
    const i = ready.shift() as number;
    ordered.push(ops[i]);
    for (const j of adj[i]) {
      if (--indeg[j] === 0) ready.push(j);
    }
  }

  // Defensive: a cycle (not reachable for well-formed plans) leaves nodes out;
  // append them in original order so output length always matches input.
  if (ordered.length < n) {
    const seen = new Set(ordered);
    for (const op of ops) if (!seen.has(op)) ordered.push(op);
  }
  return ordered;
}

/** True if op A must apply before op B. */
function dependsBefore(a: VaultOperation, b: VaultOperation): boolean {
  // A folder must exist before anything lands under it.
  if (a.kind === "createDir" && targetPaths(b).some((p) => isUnder(p, a.path))) {
    return true;
  }
  // A file must be written before a move that uses it as its source.
  if ((a.kind === "create" || a.kind === "overwrite") && b.kind === "move" && b.from === a.path) {
    return true;
  }
  return false;
}

function isUnder(path: string, folder: string): boolean {
  const p = trimSlashes(path);
  const f = trimSlashes(folder);
  return f !== "" && p.startsWith(f + "/");
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

/**
 * Data captured at apply time that an inverse needs, provided by the executor,
 * kept out of the pure mapping so `inverseOf` stays trivially testable.
 */
export interface InverseContext {
  /** overwrite: file content before the overwrite was applied. */
  preContent?: string;
  /** createDir: whether the folder already existed (⇒ the create was a no-op). */
  dirPreExisted?: boolean;
  /** Conflict guard embedded in the inverse, captured from post-apply state. */
  fingerprint?: TargetFingerprint;
  /**
   * replaceInVault: per-target prior content + post-apply fingerprint, gathered by
   * the executor so the inverse can restore every rewritten file and drift-guard it.
   */
  replaceTargets?: Array<{ path: string; preContent: string; fingerprint: TargetFingerprint }>;
}

const ZERO_FINGERPRINT: TargetFingerprint = { mtime: 0, size: 0 };

/**
 * Each op's inverse is itself a VaultOperation (ADR-0005); undo applies inverses in
 * reverse. Returns null when there is nothing to undo (idempotent createDir
 * that found the folder already present).
 */
export function inverseOf(op: VaultOperation, ctx: InverseContext = {}): VaultOperation | null {
  const expect = ctx.fingerprint ?? ZERO_FINGERPRINT;
  switch (op.kind) {
    case "create":
      return { kind: "trash", path: op.path, expect, snapshot: op.content };
    case "overwrite":
      return { kind: "overwrite", path: op.path, content: ctx.preContent ?? "", expect };
    case "createDir":
      return ctx.dirPreExisted ? null : { kind: "trash", path: op.path, expect, snapshot: "" };
    case "move":
      return { kind: "move", from: op.to, to: op.from, expect };
    case "trash":
      return { kind: "create", path: op.path, content: op.snapshot };
    case "moveFolder":
      // Symmetric: move the folder back. No fingerprint, existence guard suffices.
      return { kind: "moveFolder", from: op.to, to: op.from };
    case "trashFolder":
      // The folder was empty when trashed (apply enforces folderIsEmpty), so undo is a
      // plain re-create of an empty folder, no recursive content snapshot to restore.
      return { kind: "createDir", path: op.path };
    case "replaceInVault": {
      // Restore each rewritten file to its prior content. The inverse is itself a
      // replaceInVault whose targets carry the pre-content as their `content`, so
      // applying it overwrites every file back. The search/replace fields are
      // vestigial for the inverse (apply writes `content` directly), kept reversed
      // only so a summary, if ever shown, reads sensibly.
      const targets = (ctx.replaceTargets ?? []).map((t) => ({
        path: t.path,
        content: t.preContent,
        expect: t.fingerprint,
      }));
      return {
        kind: "replaceInVault",
        search: op.replace,
        replace: op.search,
        caseSensitive: op.caseSensitive,
        wholeWord: op.wholeWord,
        targets,
        occurrences: op.occurrences,
      };
    }
  }
}
