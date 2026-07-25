import { describe, it, expect } from "vitest";
import { ChatComposer } from "../../../../src/chat/composer/ChatComposer";

/**
 * Tripwire for plan decision 11: the composer knowledge dot is a two-source
 * indicator (retrieval and graph, plus a staleness tint). Memories deliberately
 * do not light it; their visibility surface is the popover section's own toggle
 * and status line. A future change that feeds a memory signal into this dot has
 * to edit this test on purpose.
 *
 * The method touches only `refs.knowledgeIndicatorEl`, so it is exercised
 * against a stand-in element rather than a real composer (the test environment
 * is Node, with no DOM).
 */
function createIndicator() {
  const classes = new Map<string, boolean>();
  const attributes = new Map<string, string>();
  const el = {
    toggleClass: (name: string, on: boolean) => classes.set(name, on),
    setAttribute: (name: string, value: string) => attributes.set(name, value),
  };
  const refresh = (ragReady: boolean, graphReady: boolean, stale?: boolean) => {
    const method = ChatComposer.prototype.refreshKnowledgeIndicator as (
      this: { refs: { knowledgeIndicatorEl: typeof el } },
      ragReady: boolean,
      graphReady: boolean,
      stale?: boolean,
    ) => void;
    method.call({ refs: { knowledgeIndicatorEl: el } }, ragReady, graphReady, stale);
  };
  return { classes, attributes, refresh };
}

describe("refreshKnowledgeIndicator", () => {
  it("stays dark when neither retrieval nor the graph is ready", () => {
    const indicator = createIndicator();
    indicator.refresh(false, false);
    expect(indicator.classes.get("is-active")).toBe(false);
    expect(indicator.attributes.get("aria-label")).toBe("No knowledge sources active");
  });

  it("lights for retrieval, for the graph, and for both", () => {
    const indicator = createIndicator();

    indicator.refresh(true, false);
    expect(indicator.classes.get("is-active")).toBe(true);
    expect(indicator.attributes.get("aria-label")).toBe("Knowledge active: retrieval");

    indicator.refresh(false, true);
    expect(indicator.classes.get("is-active")).toBe(true);
    expect(indicator.attributes.get("aria-label")).toBe("Knowledge active: graph");

    indicator.refresh(true, true);
    expect(indicator.attributes.get("aria-label")).toBe("Knowledge active: retrieval + graph");
  });

  it("treats staleness as a tint, never as an active source", () => {
    const indicator = createIndicator();
    indicator.refresh(false, false, true);
    expect(indicator.classes.get("is-active")).toBe(false);
    expect(indicator.classes.get("is-stale")).toBe(true);
    expect(indicator.attributes.get("aria-label")).toBe("Retrieval index out of date");
  });

  it("takes exactly the two readiness sources, so no memory signal can reach it", () => {
    // `stale` is optional, so the declared arity is the two knowledge sources.
    expect(ChatComposer.prototype.refreshKnowledgeIndicator.length).toBe(2);
  });
});
