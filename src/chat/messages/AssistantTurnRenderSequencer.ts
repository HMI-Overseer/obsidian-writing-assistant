export interface AssistantTurnRenderToken {
  itemId: string;
  version: number;
  generation: number;
}

/** Tracks item-local async render versions so stale markdown cannot commit. */
export class AssistantTurnRenderSequencer {
  private readonly versions = new Map<string, number>();
  private generation = 0;
  private destroyed = false;

  begin(itemId: string): AssistantTurnRenderToken {
    if (this.destroyed) {
      throw new Error("The assistant turn render sequencer is destroyed.");
    }
    const version = (this.versions.get(itemId) ?? 0) + 1;
    this.versions.set(itemId, version);
    return {
      itemId,
      version,
      generation: this.generation,
    };
  }

  isCurrent(token: AssistantTurnRenderToken): boolean {
    return (
      !this.destroyed &&
      token.generation === this.generation &&
      this.versions.get(token.itemId) === token.version
    );
  }

  invalidate(itemId: string): void {
    this.versions.delete(itemId);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.generation += 1;
    this.versions.clear();
  }
}
