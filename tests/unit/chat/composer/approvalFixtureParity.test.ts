import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

const FORM = source("src/chat/composer/ApprovalForm.ts");
const FIXTURE = source("dev/visual/fixtures/approval.mjs");

/**
 * Pull the `label:` / `description:` strings out of a file's CHOICES array, in order.
 * Deliberately narrow: it only matches a single string literal, so a concatenated one
 * yields a partial value and the count assertion below fails loudly rather than the
 * comparison silently passing on a prefix.
 */
function choiceCopy(fileSource: string): string[] {
  const start = fileSource.indexOf("CHOICES");
  const end = fileSource.indexOf("];", start);
  const block = fileSource.slice(start, end);
  return [
    ...block.matchAll(/(?:label|description):\s*\n?\s*"((?:[^"\\]|\\.)*)",/gu),
  ].map((match) => match[1]);
}

function channelLabels(fileSource: string): string[] {
  const start = fileSource.indexOf("CHANNEL_LABELS");
  const end = fileSource.indexOf("};", start);
  const block = fileSource.slice(start, end);
  return [...block.matchAll(/:\s*"((?:[^"\\]|\\.)*)"/gu)].map((match) => match[1]);
}

/**
 * The visual harness reconstructs the approval drawer's DOM from a fixture rather than
 * mounting the real component, so every surface review of that drawer rests on the
 * fixture's copy being the component's copy. That was an assumption; this makes it a
 * check. A copy edit in one file and not the other now fails here instead of silently
 * invalidating the next review.
 *
 * The harness is a development aid, not a test suite, so this asserts only the strings a
 * reader would compare, not the whole markup.
 */
describe("approval drawer fixture copy matches the component", () => {
  it("renders the same three labels and descriptions, in the same order", () => {
    const fromForm = choiceCopy(FORM);
    const fromFixture = choiceCopy(FIXTURE);

    expect(fromForm).toHaveLength(6);
    expect(fromFixture).toEqual(fromForm);
  });

  it("names the channels identically", () => {
    const fromForm = channelLabels(FORM);

    expect(fromForm).toHaveLength(3);
    expect(channelLabels(FIXTURE)).toEqual(fromForm);
  });

  it("shares every other visible string in the drawer", () => {
    const shared = [
      ", waiting for you",
      "Submit decision",
      "Optional: what should it do instead?",
      "Minimize approval",
      "Expand approval",
    ];
    for (const text of shared) {
      expect(FORM, `component is missing "${text}"`).toContain(text);
      expect(FIXTURE, `fixture is missing "${text}"`).toContain(text);
    }
  });

  it("uses the same guidance bound the component clamps at", () => {
    // The component binds maxlength from APPROVAL_LIMITS; the fixture hard-codes the
    // number, so pin them together rather than letting the rendered field drift.
    const limit = source("src/chat/composer/approvalDecisionState.ts").match(
      /guidance:\s*(\d+)/u,
    );
    expect(limit?.[1]).toBeDefined();
    expect(FIXTURE).toContain(`maxlength="${limit?.[1]}"`);
    expect(FORM).toContain("maxlength: String(APPROVAL_LIMITS.guidance)");
  });

  it("reconstructs the collapsing shell the component actually builds", () => {
    for (const cls of [
      "lmsa-interaction-form",
      "lmsa-interaction-toolbar",
      "lmsa-interaction-body",
      "lmsa-interaction-collapse",
      "lmsa-approval-form-eyebrow",
      "lmsa-approval-form-summary",
    ]) {
      expect(FORM, `component is missing ${cls}`).toContain(cls);
      expect(FIXTURE, `fixture is missing ${cls}`).toContain(cls);
    }
  });
});
