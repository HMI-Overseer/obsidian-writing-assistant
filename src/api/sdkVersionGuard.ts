/**
 * SDK↔CLI version coupling guard.
 *
 * The Agent SDK (pinned in `package.json`) drives the user's *separately
 * installed* `claude` CLI, and the two are version-coupled. The SDK exposes no
 * programmatic CLI version, so the expected CLI version is pinned here and must
 * be re-validated whenever the SDK pin is bumped (see
 * `docs/architecture/claude-code-sdk-refactor-plan.md` §5/§9).
 *
 * Pure module — no SDK import, no I/O — so it is unit-testable without the CLI.
 */

/**
 * CLI version the bundled SDK was validated against. SDK `0.3.177` vendors
 * Claude Code `2.1.177`. Keep this in lockstep with the `@anthropic-ai/
 * claude-agent-sdk` pin in `package.json`.
 */
export const EXPECTED_CLAUDE_CLI_VERSION = "2.1.177";

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Extracts the first `major.minor.patch` triple from a version string. Tolerates
 * the CLI's decorated output (e.g. `"2.1.177 (Claude Code)"`). Returns null when
 * no semver-shaped triple is present.
 */
export function parseVersion(raw: string | undefined): ParsedVersion | null {
  if (!raw) return null;
  const match = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/**
 * Whether the installed CLI is compatible with the bundled SDK.
 *
 * Coupling is enforced at **major.minor**; the patch level may drift (the CLI
 * auto-updates patches independently of the SDK pin). An unparseable or missing
 * version is treated as incompatible — the SDK path is an optimization on a
 * floor that always works, so ambiguity degrades to the legacy one-shot path.
 */
export function isCliVersionCompatible(
  installed: string | undefined,
  expected: string = EXPECTED_CLAUDE_CLI_VERSION,
): boolean {
  const got = parseVersion(installed);
  const want = parseVersion(expected);
  if (!got || !want) return false;
  return got.major === want.major && got.minor === want.minor;
}
