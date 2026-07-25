import type { Memory } from "../shared/types";
import { estimateStringTokens } from "../shared/tokenEstimation";
import { renderMemoryIndex } from "./indexRender";
import { normalizeMemoryName } from "./validation";

interface PinnedMemoryIndex {
  bytes: string;
  pinnedNames: Set<string>;
}

/**
 * Owns the runtime memory-index pins and provides current-store reads.
 *
 * Pins contain only rendered index bytes and enabled memory names. The source
 * records remain settings-owned, so recall and capacity estimates always read
 * the latest store.
 */
export class MemoryService {
  private readonly pins = new Map<string, PinnedMemoryIndex>();

  constructor(private readonly getRecords: () => readonly Memory[]) {}

  /**
   * Return the conversation's byte-stable index, rendering it on first access.
   * A missing conversation id cannot be pinned safely, so it receives a current
   * render without adding a shared fallback entry to the pin map.
   */
  getPinnedIndex(conversationId: string | null): string {
    if (conversationId === null) {
      return renderMemoryIndex(this.getRecords());
    }

    const existing = this.pins.get(conversationId);
    if (existing) return existing.bytes;

    const records = this.getRecords();
    const pin: PinnedMemoryIndex = {
      bytes: renderMemoryIndex(records),
      pinnedNames: new Set(
        records
          .filter((record) => record.enabled)
          .map((record) => normalizeMemoryName(record.name)),
      ),
    };
    this.pins.set(conversationId, pin);
    return pin.bytes;
  }

  /** Drop only indexes that contained the named memory when they were pinned. */
  invalidatePinsContaining(name: string): void {
    const normalizedName = normalizeMemoryName(name);
    for (const [conversationId, pin] of this.pins) {
      if (pin.pinnedNames.has(normalizedName)) {
        this.pins.delete(conversationId);
      }
    }
  }

  /** Drop every active conversation pin. */
  invalidateAll(): void {
    this.pins.clear();
  }

  /**
   * Read matching records from the current settings store in requested order.
   * Disabled records are included so recall can distinguish them from unknown
   * names. Returned copies cannot mutate the settings-owned records.
   */
  readRecords(names: readonly string[]): Memory[] {
    const recordsByName = new Map(
      this.getRecords().map((record) => [normalizeMemoryName(record.name), record]),
    );
    return names.flatMap((name) => {
      const record = recordsByName.get(normalizeMemoryName(name));
      return record ? [{ ...record }] : [];
    });
  }

  /** Estimate the latest enabled index for the settings capacity indicator. */
  estimateIndexTokens(): number {
    return estimateStringTokens(renderMemoryIndex(this.getRecords()));
  }

  /** Release all runtime-only state on plugin unload. */
  destroy(): void {
    this.invalidateAll();
  }
}
