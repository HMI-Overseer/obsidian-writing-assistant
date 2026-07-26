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
    expect(view).toContain("planAssistantTurnRenderUpdate");
    expect(view).toContain("AssistantTurnItemHostRegistry");
    expect(view).not.toMatch(
      /\b(?:innerHTML|outerHTML|insertAdjacentHTML|setCssStyles)\b/u,
    );
    expect(view).not.toMatch(/\bstyle\s*:/u);
  });

  it("uses the tool text as the disclosure trigger without a detached chevron button", () => {
    const view = source("src/chat/messages/AssistantTurnView.ts");
    const styles = source("src/chat/messages/AssistantTurnView.css");

    expect(view).toContain("toolSummaryEl");
    expect(view).toContain("toolSummaryEl.after(state.actionEl)");
    expect(view).toContain('"role", "button"');
    expect(view).toContain('"keydown"');
    expect(view).toContain('"aria-expanded"');
    expect(view).not.toContain("disclosureButtonEl");
    expect(view).not.toContain('"chevron-down"');
    expect(view).not.toContain('"chevron-up"');
    expect(styles).toContain(
      ".lmsa-assistant-turn-item--tool_call",
    );
    expect(styles).toContain("flex: 0 0 auto;");
    expect(styles).toContain("gap: 0.2rem 0.45rem;");
  });

  it("keeps terminal state accessible without a hover tooltip on the turn", () => {
    const view = source("src/chat/messages/AssistantTurnView.ts");
    const styles = source("src/chat/messages/AssistantTurnView.css");

    expect(view).toContain("item.accessibleState");
    expect(view).toContain('"aria-label"');
    expect(view).toContain('markerEl.setAttribute("aria-hidden", "true")');
    expect(view).toContain("emptyState.announce");
    expect(view).not.toContain("stateEl");
    expect(styles).not.toContain(".lmsa-assistant-turn-tool-state");
    expect(view).not.toContain('"aria-label": "Assistant response"');
  });

  it("keeps the avatar above the rail and tool copy close to its marker", () => {
    const styles = source("src/chat/messages/AssistantTurnView.css");

    expect(styles).toMatch(
      /\.lmsa-chat-window-message--assistant\s*>\s*\.lmsa-chat-window-message-avatar[\s\S]*z-index:\s*1;/u,
    );
    expect(styles).toContain(
      "margin-left: calc(-1 * var(--lmsa-turn-rail-gap));",
    );
    expect(styles).toContain(
      ".lmsa-assistant-turn-tool-summary.is-expandable:hover",
    );
    expect(styles).not.toContain(".lmsa-assistant-turn-disclosure");
  });

  it("keeps timeline connectors on an isolated layer behind their markers", () => {
    const styles = source("src/chat/messages/AssistantTurnView.css");

    expect(styles).toMatch(
      /\.lmsa-assistant-turn-item\s*\{[\s\S]*isolation:\s*isolate;/u,
    );
    expect(styles).toMatch(
      /\.lmsa-assistant-turn-item::before,\s*\.lmsa-assistant-turn-item::after\s*\{[\s\S]*z-index:\s*-1;/u,
    );
    expect(styles).toMatch(
      /\.lmsa-assistant-turn-marker\s*\{[\s\S]*z-index:\s*1;/u,
    );
  });

  it("fades only the incoming connector selected by the render model", () => {
    const view = source("src/chat/messages/AssistantTurnView.ts");
    const styles = source("src/chat/messages/AssistantTurnView.css");

    expect(view).toContain('"has-fading-endpoint"');
    expect(view).toContain("item.fadeIncomingConnector");
    expect(styles).toMatch(
      /\.lmsa-assistant-turn-item\.has-fading-endpoint::before[\s\S]*linear-gradient/u,
    );
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
    const editReview = source(
      "src/chat/messages/editReviewTimeline.ts",
    );
    const vaultReview = source(
      "src/chat/messages/vaultReviewTimeline.ts",
    );
    const vaultStyles = source(
      "src/chat/messages/vaultReviewTimeline.css",
    );

    expect(view).toContain("item.actionRef");
    expect(view).toContain("item.toolCallId");
    expect(view).toContain("actionCoordinator.reconcile");
    expect(registry).toContain("getByActionRef");
    expect(registry).toContain("getActionRefByToolCallId");
    expect(registry).not.toContain("toolName");
    expect(registry).not.toContain("FIFO");
    expect(editReview).toContain("resolveEditReviewMounts");
    expect(editReview).toContain("controlsHostEl.createDiv");
    expect(editReview).toContain("presentationHostEl.createDiv");
    expect(editReview).toContain("controlsHostEl.after(hunkWrap)");
    expect(vaultReview).toContain("resolveVaultReviewMounts");
    expect(vaultReview).toContain("controlsHostEl.createDiv");
    expect(vaultReview).toContain(
      "this.ensurePreview(presentationHostEl, op)",
    );
    expect(vaultReview).toMatch(
      /this\.ensureReplaceList\(\s*presentationHostEl,\s*op,\s*\)/u,
    );
    expect(vaultReview).toContain("controlsHostEl.after(presentationEl)");
    expect(vaultStyles).toContain(
      ".lmsa-assistant-turn-item.is-vault-awaiting",
    );
  });

  it("keeps edit in the canonical action bar and off the item hosts", () => {
    const view = source("src/chat/messages/AssistantTurnView.ts");
    const styles = source("src/chat/messages/AssistantTurnView.css");
    const toolbar = source(
      "src/chat/messages/BubbleActionToolbar.ts",
    );
    const handler = source("src/chat/ChatBubbleActionHandler.ts");
    const assistantActions =
      toolbar.match(
        /const ASSISTANT_ACTIONS: ActionDef\[\] = \[([\s\S]*?)\];/u,
      )?.[1] ?? "";

    expect(assistantActions).toContain('action: "edit"');
    expect(assistantActions.indexOf('action: "edit"')).toBeGreaterThan(
      assistantActions.indexOf('action: "copy"'),
    );
    expect(assistantActions.indexOf('action: "edit"')).toBeLessThan(
      assistantActions.indexOf('action: "delete"'),
    );
    expect(toolbar).not.toContain("activeRevisionId");

    expect(view).not.toContain("setProseEditHandler");
    expect(view).not.toContain('"Edit this prose block"');
    expect(view).not.toContain("lmsa-assistant-turn-prose-edit");
    expect(styles).not.toContain("lmsa-assistant-turn-prose-edit");
    expect(styles).not.toContain("justify-content: flex-end;");

    expect(view).toContain("getProseHost");
    expect(view).toContain("buildActionLedgerReviewModel");
    expect(view).toContain("setActionReviewContext");
    expect(handler).toContain("editAssistantTurnProse");
    expect(handler).toContain("executeMessageAction");
  });

  it("leaves the original edit hunk in place without a generic summary", () => {
    const view = source("src/chat/messages/AssistantTurnView.ts");

    expect(view).toContain("actionLedgerSummaryEntries");
    expect(view).not.toContain("EditActionLedgerView");
    expect(view).not.toContain('return "Edit review"');
  });
});
