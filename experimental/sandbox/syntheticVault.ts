import { createHash } from "node:crypto";
import { escapesVault } from "../../src/vault-ops/pathSafety";
import type {
  SyntheticVaultFixture,
  SyntheticVaultDiff,
  SyntheticVaultSnapshot,
} from "./types";

export type SyntheticPathResult =
  | { ok: true; path: string }
  | { ok: false; reason: string };

export function normalizeSyntheticPath(rawPath: string): SyntheticPathResult {
  if (rawPath.includes("\0")) {
    return { ok: false, reason: "path contains a null character" };
  }
  const slashed = rawPath.trim().replace(/\\/g, "/");
  if (!slashed) return { ok: false, reason: "path is required" };
  if (escapesVault(slashed)) {
    return { ok: false, reason: `path ${JSON.stringify(rawPath)} is outside the synthetic vault` };
  }

  const segments: string[] = [];
  for (const segment of slashed.replace(/^\/+/, "").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
    } else {
      segments.push(segment.normalize("NFC"));
    }
  }
  if (segments.length === 0) {
    return { ok: false, reason: "path must identify a file" };
  }
  return { ok: true, path: segments.join("/") };
}

function hash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export class SyntheticVault {
  private readonly files = new Map<string, string>();

  constructor(private readonly fixture: SyntheticVaultFixture) {
    if (fixture.schemaVersion !== 1) {
      throw new Error(`Unsupported synthetic fixture schema version ${fixture.schemaVersion}.`);
    }
    if (!fixture.id.trim()) throw new Error("Synthetic fixture ID is required.");
    if (!Number.isInteger(fixture.version) || fixture.version < 1) {
      throw new Error("Synthetic fixture version must be a positive integer.");
    }

    for (const file of fixture.files) {
      const normalized = normalizeSyntheticPath(file.path);
      if (!normalized.ok) {
        throw new Error(`Invalid synthetic fixture path ${JSON.stringify(file.path)}: ${normalized.reason}.`);
      }
      if (this.files.has(normalized.path)) {
        throw new Error(`Duplicate synthetic fixture path ${JSON.stringify(normalized.path)}.`);
      }
      this.files.set(normalized.path, file.content);
    }
  }

  readFile(rawPath: string): { path: string; content: string } | null {
    const normalized = normalizeSyntheticPath(rawPath);
    if (!normalized.ok) return null;
    const content = this.files.get(normalized.path);
    return content === undefined ? null : { path: normalized.path, content };
  }

  pathState(rawPath: string): "file" | "dir" | "absent" {
    const normalized = normalizeSyntheticPath(rawPath);
    if (!normalized.ok) return "absent";
    if (this.files.has(normalized.path)) return "file";
    const prefix = `${normalized.path}/`;
    return [...this.files.keys()].some((path) => path.startsWith(prefix)) ? "dir" : "absent";
  }

  writeFile(rawPath: string, content: string): { path: string; previousContent: string | null } {
    const normalized = normalizeSyntheticPath(rawPath);
    if (!normalized.ok) throw new Error(normalized.reason);
    const previousContent = this.files.get(normalized.path) ?? null;
    this.files.set(normalized.path, content);
    return { path: normalized.path, previousContent };
  }

  snapshot(): SyntheticVaultSnapshot {
    const files = [...this.files.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, content]) => ({ path, content, sha256: hash(content) }));
    return {
      fixtureId: this.fixture.id,
      fixtureVersion: this.fixture.version,
      files,
    };
  }
}

export function diffSyntheticSnapshots(
  initial: SyntheticVaultSnapshot,
  final: SyntheticVaultSnapshot,
): SyntheticVaultDiff {
  const before = new Map(initial.files.map((file) => [file.path, file]));
  const after = new Map(final.files.map((file) => [file.path, file]));
  const created = final.files.filter((file) => !before.has(file.path));
  const deleted = initial.files.filter((file) => !after.has(file.path));
  const modified = final.files.flatMap((file) => {
    const prior = before.get(file.path);
    return prior && prior.sha256 !== file.sha256 ? [{ before: prior, after: file }] : [];
  });
  return { created, modified, deleted };
}
