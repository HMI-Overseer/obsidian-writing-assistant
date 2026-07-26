import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("AssistantTurnView architecture", () => {
  it("uses one ordered semantic item host with safe Obsidian DOM operations", () => {
    const view = source("src/chat/messages/AssistantTurnView.ts");

    expect(view).toContain('createEl("ol"');
    expect(view).toContain('createEl("li"');
    expect(view).toContain("planAssistantTurnKeyedUpdate");
    expect(view).toContain("AssistantTurnItemHostRegistry");
    expect(view).not.toMatch(
      /\b(?:innerHTML|outerHTML|insertAdjacentHTML|setCssStyles)\b/u,
    );
    expect(view).not.toMatch(/\bstyle\s*:/u);
  });

  it("keeps tool disclosures and terminal state accessible without color alone", () => {
    const view = source("src/chat/messages/AssistantTurnView.ts");

    expect(view).toContain('"aria-label": `Show details for ${item.label}`');
    expect(view).toContain('"aria-expanded"');
    expect(view).toContain('type: "button"');
    expect(view).toContain("item.accessibleState");
    expect(view).toContain('markerEl.setAttribute("aria-hidden", "true")');
    expect(view).toContain("emptyState.announce");
  });

  it("cleans item listeners, markdown work, action views, and detached hosts", () => {
    const view = source("src/chat/messages/AssistantTurnView.ts");

    expect(view).toContain("this.markdownRenderer.clear");
    expect(view).toContain("this.renderSequencer.invalidate");
    expect(view).toContain("state.destroy()");
    expect(view).toContain("this.actionCoordinator.destroy()");
    expect(view).toContain("this.registry.clear()");
  });

  it("removes the assistant timeline and flat body as competing render truth", () => {
    const transcript = source("src/chat/messages/ChatTranscript.ts");
    const types = source("src/chat/types.ts");
    const generation = source("src/chat/actions/generateLlmResponse.ts");
    const revisions = source("src/chat/conversation/assistantRevisions.ts");

    expect(transcript).toContain("selectAssistantMessageRenderSource");
    expect(transcript).toContain("bubble.turnView.refresh");
    expect(transcript).not.toContain("AgenticTimeline");
    expect(transcript).not.toContain("assistantToolStepProjection");
    expect(types).not.toContain("timelineEl: HTMLElement");
    expect(generation).not.toContain('from "../streaming/StreamingRenderer"');
    expect(generation).not.toContain('from "../messages/AgenticTimeline"');
    expect(generation).toContain("onTurnSnapshot");
    expect(revisions).not.toContain("assistantToolStepProjection");
  });

  it("keeps canonical review placement on item and action identity", () => {
    const view = source("src/chat/messages/AssistantTurnView.ts");
    const registry = source(
      "src/chat/messages/AssistantTurnItemHostRegistry.ts",
    );

    expect(view).toContain("item.actionRef");
    expect(view).toContain("item.toolCallId");
    expect(view).toContain("actionCoordinator.reconcile");
    expect(registry).toContain("getByActionRef");
    expect(registry).toContain("getActionRefByToolCallId");
    expect(registry).not.toContain("toolName");
    expect(registry).not.toContain("FIFO");
  });
});
