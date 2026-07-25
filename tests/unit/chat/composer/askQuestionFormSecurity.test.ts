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

    expect(form).toContain('role: "tablist"');
    expect(form).toContain('role: "tab"');
    expect(form).toContain('role: "tabpanel"');
    expect(form).toContain('"aria-controls": panelId');
    expect(form).toContain('"aria-selected", active ? "true" : "false"');
    expect(form).toContain('event.key === "ArrowLeft"');
    expect(form).toContain('event.key === "ArrowRight"');
    expect(form).toContain('event.key === "Home"');
    expect(form).toContain('event.key === "End"');
    expect(form).toContain('createEl("fieldset"');
    expect(form).toContain('createEl("legend"');
    expect(form).toContain('question.multiSelect ? "checkbox" : "radio"');
    expect(form).toContain('"aria-describedby": descriptionId');
    expect(form).toContain("attr: { for: inputId }");
    expect(form).toContain("this.questionRefs[0]?.firstControl.focus()");
    expect(form).toContain("this.focusFirstIncomplete()");
  });

  it("shows one question panel at a time and keeps submission global", () => {
    const form = source("src/chat/composer/AskQuestionForm.ts");
    const styles = source("src/chat/composer/AskQuestionForm.css");

    expect(form).toContain("refs.panelEl.hidden = !active");
    expect(form).toContain(
      "this.submitButton.disabled = this.disabled || !completeness.isComplete",
    );
    expect(form).toContain('"aria-label": "Other answer"');
    expect(form).not.toContain("A few details");
    expect(form).not.toContain("Do not enter passwords");
    expect(form).not.toContain("lmsa-ask-form-progress");
    expect(form).not.toContain("lmsa-ask-form-page");
    expect(form).not.toContain("Write a different answer in your own words.");
    expect(form).not.toContain("Your answer");
    expect(form).not.toContain("lmsa-ask-form-question-header");
    expect(form.match(/text: question\.header/gu)).toHaveLength(1);
    expect(form).not.toContain("this.callbacks.onSubmit(question");
    expect(styles).toContain("width: fit-content");
    expect(styles).not.toContain("overflow-x: auto");
    expect(styles).toContain("align-items: center");
    expect(styles).toContain("border-radius: 8px");
  });
});
