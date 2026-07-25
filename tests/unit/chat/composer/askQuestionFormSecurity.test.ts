import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("ask question rendering security", () => {
  it("keeps the form and completed audit renderer on text-only DOM paths", () => {
    const form = source("src/chat/composer/AskQuestionForm.ts");
    const timeline = source("src/chat/messages/AgenticTimeline.ts");
    const rendering = `${form}\n${timeline}`;

    expect(rendering).not.toMatch(/\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b/u);
    expect(form).not.toContain("MarkdownRenderer");
    expect(form).not.toMatch(/createEl\(\s*["']a["']/u);
    expect(form).not.toMatch(/\b(?:href|src)\s*:/u);
    expect(form).not.toMatch(/\bstyle\s*:/u);
    expect(form).toContain("text: question.question");
    expect(form).toContain("text: option.label");
    expect(form).toContain("text: option.description");
    expect(form).toContain("maxlength: String(ASK_USER_LIMITS.otherText)");
    expect(timeline).toContain("text: `${row.question}\\n${row.answers.join(\"\\n\")}`");
    expect(timeline).not.toContain("AskQuestionForm");
  });

  it("retains native controls, accessible descriptions, and focus handling", () => {
    const form = source("src/chat/composer/AskQuestionForm.ts");

    expect(form).toContain('createEl("fieldset"');
    expect(form).toContain('createEl("legend"');
    expect(form).toContain('question.multiSelect ? "checkbox" : "radio"');
    expect(form).toContain('"aria-describedby": descriptionId');
    expect(form).toContain("attr: { for: inputId }");
    expect(form).toContain("this.questionRefs[0]?.firstControl.focus()");
    expect(form).toContain("this.focusFirstIncomplete()");
  });
});
