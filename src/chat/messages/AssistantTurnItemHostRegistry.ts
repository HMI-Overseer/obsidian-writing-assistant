import type {
  ToolActionLedgerEntry,
} from "../../shared/types";

export interface AssistantTurnItemHost {
  itemEl: HTMLElement;
  contentEl: HTMLElement;
  actionEl: HTMLElement;
}

interface AssistantTurnItemIdentity {
  actionRef?: string;
  toolCallId?: string;
}

export interface AssistantActionView {
  element: HTMLElement;
  /**
   * Full-width evidence (a diff, an affected-file list) for the same action.
   *
   * It cannot live inside {@link element}: on a tool step that host is an inline,
   * content-sized slot sharing the row with the step's name and path, so a diff
   * nested in it would be sized by the words beside it. This is placed as the row's
   * own sibling instead, which is what the live review does with the same content.
   */
  presentationEl?: HTMLElement;
  refresh(entry: ToolActionLedgerEntry): void;
  destroy(): void;
}

export type AssistantActionViewFactory = (
  entry: ToolActionLedgerEntry,
) => AssistantActionView;

interface RegisteredHost {
  host: AssistantTurnItemHost;
  identity: AssistantTurnItemIdentity;
}

/** Stable domain-item registry used by keyed updates and action placement. */
export class AssistantTurnItemHostRegistry {
  private readonly byItemId = new Map<string, RegisteredHost>();
  private readonly itemIdByActionRef = new Map<string, string>();
  private readonly itemIdByToolCallId = new Map<string, string>();

  register(itemId: string, host: AssistantTurnItemHost): void {
    const existing = this.byItemId.get(itemId);
    if (existing) {
      if (existing.host !== host) {
        throw new Error(`Assistant turn item "${itemId}" is already registered.`);
      }
      return;
    }
    this.byItemId.set(itemId, {
      host,
      identity: {},
    });
  }

  unregister(itemId: string): void {
    const registered = this.byItemId.get(itemId);
    if (!registered) return;
    if (registered.identity.actionRef) {
      this.itemIdByActionRef.delete(registered.identity.actionRef);
    }
    if (registered.identity.toolCallId) {
      this.itemIdByToolCallId.delete(registered.identity.toolCallId);
    }
    this.byItemId.delete(itemId);
  }

  bindIdentity(itemId: string, identity: AssistantTurnItemIdentity): void {
    const registered = this.byItemId.get(itemId);
    if (!registered) {
      throw new Error(`Assistant turn item "${itemId}" has no registered host.`);
    }
    this.clearPreviousIdentity(itemId, registered.identity);
    this.assertIdentityAvailable(
      itemId,
      identity.actionRef,
      this.itemIdByActionRef,
      "action reference",
    );
    this.assertIdentityAvailable(
      itemId,
      identity.toolCallId,
      this.itemIdByToolCallId,
      "tool-call ID",
    );
    registered.identity = { ...identity };
    if (identity.actionRef) {
      this.itemIdByActionRef.set(identity.actionRef, itemId);
    }
    if (identity.toolCallId) {
      this.itemIdByToolCallId.set(identity.toolCallId, itemId);
    }
  }

  get(itemId: string): AssistantTurnItemHost | null {
    return this.byItemId.get(itemId)?.host ?? null;
  }

  getByActionRef(actionRef: string): AssistantTurnItemHost | null {
    const itemId = this.itemIdByActionRef.get(actionRef);
    return itemId ? this.get(itemId) : null;
  }

  getByToolCallId(toolCallId: string): AssistantTurnItemHost | null {
    const itemId = this.itemIdByToolCallId.get(toolCallId);
    return itemId ? this.get(itemId) : null;
  }

  getActionRefByToolCallId(toolCallId: string): string | null {
    const itemId = this.itemIdByToolCallId.get(toolCallId);
    if (!itemId) return null;
    return this.byItemId.get(itemId)?.identity.actionRef ?? null;
  }

  clear(): void {
    this.byItemId.clear();
    this.itemIdByActionRef.clear();
    this.itemIdByToolCallId.clear();
  }

  private clearPreviousIdentity(
    itemId: string,
    identity: AssistantTurnItemIdentity,
  ): void {
    if (
      identity.actionRef &&
      this.itemIdByActionRef.get(identity.actionRef) === itemId
    ) {
      this.itemIdByActionRef.delete(identity.actionRef);
    }
    if (
      identity.toolCallId &&
      this.itemIdByToolCallId.get(identity.toolCallId) === itemId
    ) {
      this.itemIdByToolCallId.delete(identity.toolCallId);
    }
  }

  private assertIdentityAvailable(
    itemId: string,
    value: string | undefined,
    index: Map<string, string>,
    label: string,
  ): void {
    if (!value) return;
    const owner = index.get(value);
    if (owner && owner !== itemId) {
      throw new Error(
        `Assistant turn ${label} "${value}" already belongs to item "${owner}".`,
      );
    }
  }
}

interface ActionViewHosts {
  controlsEl: HTMLElement;
  /**
   * What the evidence follows. On a step that is the inline action host itself, so
   * the evidence lands beside it in the step body instead of inside it; in the
   * stacked sections there is no such row, so it simply follows the controls.
   */
  presentationAnchorEl: HTMLElement | null;
}

/**
 * Moves one action view between provisional, placed, and safety-audit hosts.
 *
 * Reconciliation is keyed by actionRef, so placement never duplicates controls
 * or listeners when a structured declaration arrives after the review.
 */
export class AssistantActionHostCoordinator {
  private readonly views = new Map<string, AssistantActionView>();

  constructor(
    private readonly registry: AssistantTurnItemHostRegistry,
    private readonly provisionalHostEl: HTMLElement,
    private readonly auditHostEl: HTMLElement,
    private readonly createView: AssistantActionViewFactory,
  ) {}

  reconcile(entries: readonly ToolActionLedgerEntry[]): void {
    const activeRefs = new Set(entries.map((entry) => entry.actionRef));
    for (const [actionRef, view] of this.views) {
      if (activeRefs.has(actionRef)) continue;
      view.element.remove();
      view.presentationEl?.remove();
      view.destroy();
      this.views.delete(actionRef);
    }

    for (const entry of entries) {
      const host = this.hostFor(entry);
      if (!host) continue;
      let view = this.views.get(entry.actionRef);
      if (!view) {
        view = this.createView(entry);
        this.views.set(entry.actionRef, view);
      }
      view.refresh(entry);
      if (view.element.parentElement !== host.controlsEl) {
        host.controlsEl.appendChild(view.element);
      }
      // Directly after the row the controls sit on, so the evidence reads as
      // belonging to that step rather than to whatever the turn renders next.
      const anchorEl = host.presentationAnchorEl ?? view.element;
      if (
        view.presentationEl &&
        view.presentationEl.previousElementSibling !== anchorEl
      ) {
        anchorEl.after(view.presentationEl);
      }
    }
  }

  destroy(): void {
    for (const view of this.views.values()) {
      view.element.remove();
      view.presentationEl?.remove();
      view.destroy();
    }
    this.views.clear();
  }

  /**
   * Where one entry's controls and evidence belong.
   *
   * A placed entry splits them: controls into the step's inline action host, evidence
   * into the step body that host sits in, so a diff is sized by the whole row. The
   * provisional and audit sections are plain stacks, so both go in the one host.
   */
  private hostFor(entry: ToolActionLedgerEntry): ActionViewHosts | null {
    if (entry.placement.state === "provisional") {
      return { controlsEl: this.provisionalHostEl, presentationAnchorEl: null };
    }
    if (entry.placement.state === "unplaced") {
      return { controlsEl: this.auditHostEl, presentationAnchorEl: null };
    }
    const host =
      this.registry.getByActionRef(entry.actionRef) ??
      this.registry.get(entry.placement.itemId);
    return host
      ? { controlsEl: host.actionEl, presentationAnchorEl: host.actionEl }
      : null;
  }
}
