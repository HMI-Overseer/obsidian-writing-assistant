import { describe, expect, it, vi } from "vitest";
import type {
  ToolActionLedgerEntry,
} from "../../../../src/shared/types";
import {
  appendActionEvent,
  attachProvisionalAction,
  createProvisionalAction,
  finalizeUndeclaredAction,
} from "../../../../src/chat/conversation/actionLedger";
import {
  AssistantActionHostCoordinator,
  AssistantTurnItemHostRegistry,
  type AssistantActionView,
} from "../../../../src/chat/messages/AssistantTurnItemHostRegistry";

class FakeNode {
  parent: FakeNode | null = null;
  children: FakeNode[] = [];

  appendChild(child: FakeNode): FakeNode {
    child.parent?.removeChild(child);
    this.children.push(child);
    child.parent = this;
    return child;
  }

  removeChild(child: FakeNode): FakeNode {
    this.children = this.children.filter((candidate) => candidate !== child);
    child.parent = null;
    return child;
  }

  remove(): void {
    this.parent?.removeChild(this);
  }

  get parentElement(): FakeNode | null {
    return this.parent;
  }
}

function host() {
  return {
    itemEl: new FakeNode() as unknown as HTMLElement,
    contentEl: new FakeNode() as unknown as HTMLElement,
    actionEl: new FakeNode() as unknown as HTMLElement,
  };
}

function provisional(): ToolActionLedgerEntry {
  return createProvisionalAction({
    actionRef: "action-1",
    revisionId: "revision-1",
    family: "memory",
    correlation: { kind: "provider_id", toolCallId: "call-1" },
    payload: {
      targets: [
        {
          targetId: "target-1",
          mutation: {
            kind: "forget",
            name: "Old detail",
          },
        },
      ],
    },
    proposedEvents: [
      {
        eventId: "event-1",
        type: "proposed",
        targetId: "target-1",
        createdAt: 1,
      },
    ],
  });
}

describe("AssistantTurnItemHostRegistry", () => {
  it("keeps one stable host per domain item ID across live updates", () => {
    const registry = new AssistantTurnItemHostRegistry();
    const first = host();
    const second = host();

    registry.register("item-1", first);
    registry.bindIdentity("item-1", {
      actionRef: "action-1",
      toolCallId: "call-1",
    });
    registry.register("item-1", first);

    expect(registry.get("item-1")).toBe(first);
    expect(registry.getByActionRef("action-1")).toBe(first);
    expect(registry.getByToolCallId("call-1")).toBe(first);
    expect(() => registry.register("item-1", second)).toThrow(
      /already registered/u,
    );
  });

  it("removes identity lookups when a keyed item leaves the snapshot", () => {
    const registry = new AssistantTurnItemHostRegistry();
    registry.register("item-1", host());
    registry.bindIdentity("item-1", {
      actionRef: "action-1",
      toolCallId: "call-1",
    });

    registry.unregister("item-1");

    expect(registry.get("item-1")).toBeNull();
    expect(registry.getByActionRef("action-1")).toBeNull();
    expect(registry.getByToolCallId("call-1")).toBeNull();
  });
});

describe("AssistantActionHostCoordinator", () => {
  it("moves one provisional review instance to its declared actionRef host", () => {
    const registry = new AssistantTurnItemHostRegistry();
    const itemHost = host();
    registry.register("item-1", itemHost);
    registry.bindIdentity("item-1", {
      actionRef: "action-1",
      toolCallId: "call-1",
    });
    const provisionalHost = new FakeNode();
    const auditHost = new FakeNode();
    const destroy = vi.fn();
    const refresh = vi.fn();
    const root = new FakeNode();
    const factory = vi.fn(
      (): AssistantActionView => ({
        element: root as unknown as HTMLElement,
        refresh,
        destroy,
      }),
    );
    const coordinator = new AssistantActionHostCoordinator(
      registry,
      provisionalHost as unknown as HTMLElement,
      auditHost as unknown as HTMLElement,
      factory,
    );
    const before = provisional();

    coordinator.reconcile([before]);
    const placed = attachProvisionalAction(before, "item-1");
    coordinator.reconcile([placed]);

    expect(factory).toHaveBeenCalledOnce();
    expect(root.parent).toBe(itemHost.actionEl as unknown as FakeNode);
    expect(provisionalHost.children).toEqual([]);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("keeps consequential unplaced evidence in the audit host", () => {
    const declined = appendActionEvent(provisional(), {
      eventId: "event-2",
      type: "declined",
      targetId: "target-1",
      createdAt: 2,
      reason: "User declined",
    });
    const unplaced = finalizeUndeclaredAction(declined);
    if (!unplaced) throw new Error("Expected consequential action.");
    const registry = new AssistantTurnItemHostRegistry();
    const provisionalHost = new FakeNode();
    const auditHost = new FakeNode();
    const root = new FakeNode();
    const coordinator = new AssistantActionHostCoordinator(
      registry,
      provisionalHost as unknown as HTMLElement,
      auditHost as unknown as HTMLElement,
      () => ({
        element: root as unknown as HTMLElement,
        refresh: vi.fn(),
        destroy: vi.fn(),
      }),
    );

    coordinator.reconcile([unplaced]);

    expect(root.parent).toBe(auditHost);
  });

  it("destroys an inconsequential provisional view when the ledger discards it", () => {
    const registry = new AssistantTurnItemHostRegistry();
    const destroy = vi.fn();
    const coordinator = new AssistantActionHostCoordinator(
      registry,
      new FakeNode() as unknown as HTMLElement,
      new FakeNode() as unknown as HTMLElement,
      () => ({
        element: new FakeNode() as unknown as HTMLElement,
        refresh: vi.fn(),
        destroy,
      }),
    );

    coordinator.reconcile([provisional()]);
    coordinator.reconcile([]);

    expect(destroy).toHaveBeenCalledOnce();
  });
});
