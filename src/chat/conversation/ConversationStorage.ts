import { Notice, type App } from "obsidian";
import type { Conversation } from "../../shared/types";
import { normalizeConversation } from "./conversationUtils";

const CONVERSATIONS_DIR = "conversations";

/**
 * Adapter-based file storage for individual conversations.
 *
 * Each conversation is stored as `{pluginDir}/conversations/{id}.json`. These are
 * plugin-internal JSON under the config dir (reached through `app.vault.adapter`, no
 * `TFile`), so `Vault.process()` does not apply; atomicity is provided here at the
 * adapter level: {@link save} writes a temp file then swaps it over the target, so a
 * crash mid-write can never leave the live file half-written, and {@link load}
 * recovers from a leftover temp and distinguishes a corrupt file from a missing one.
 */
export class ConversationStorage {
  private dirCreated = false;

  constructor(
    private readonly app: App,
    private readonly pluginDir: string,
  ) {}

  async load(id: string): Promise<Conversation | null> {
    const path = this.filePath(id);
    const tmpPath = this.tmpPath(id);

    const fromMain = await this.tryRead(path);
    if (fromMain) return fromMain;

    // The main file is missing or corrupt. A leftover temp file means a crash interrupted
    // the atomic swap; if it parses it is the newest good copy, so recover and promote it.
    const fromTmp = await this.tryRead(tmpPath);
    if (fromTmp) {
      try {
        await this.swap(tmpPath, path);
      } catch {
        // Promotion is best-effort; the recovered data is still returned.
      }
      return fromTmp;
    }

    // Distinguish a genuinely corrupt file (present but unreadable) from a missing one, so a
    // damaged conversation surfaces instead of silently vanishing on next load.
    if (await this.exists(path)) {
      console.error(
        `[conversation] Could not load conversation ${id}: the file is unreadable or corrupt.`,
      );
      new Notice("A saved conversation could not be loaded (the file may be corrupt).");
    }
    return null;
  }

  async save(conversation: Conversation): Promise<void> {
    await this.ensureDir();
    const path = this.filePath(conversation.id);
    const tmpPath = this.tmpPath(conversation.id);

    // Atomic write: fully write a temp file, then swap it over the target, so a crash
    // mid-write never leaves the live file truncated. The temp is the recovery source if
    // the swap itself is interrupted (see load()).
    await this.app.vault.adapter.write(tmpPath, JSON.stringify(conversation));
    await this.swap(tmpPath, path);
  }

  async delete(id: string): Promise<void> {
    await this.removeIfExists(this.filePath(id));
    await this.removeIfExists(this.tmpPath(id));
  }

  /** Read + parse a conversation file, or null if it is missing or unparseable. */
  private async tryRead(path: string): Promise<Conversation | null> {
    try {
      if (!(await this.exists(path))) return null;
      const raw = await this.app.vault.adapter.read(path);
      return normalizeConversation(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  /**
   * Move `tmpPath` onto `targetPath`. The adapter's rename does not overwrite, so the
   * target is cleared first; the gap is covered by load()'s temp-recovery if a crash
   * lands between the remove and the rename (target missing, temp present).
   */
  private async swap(tmpPath: string, targetPath: string): Promise<void> {
    await this.removeIfExists(targetPath);
    await this.app.vault.adapter.rename(tmpPath, targetPath);
  }

  private async removeIfExists(path: string): Promise<void> {
    try {
      if (await this.exists(path)) await this.app.vault.adapter.remove(path);
    } catch {
      // Non-fatal, orphaned files are harmless.
    }
  }

  private async exists(path: string): Promise<boolean> {
    try {
      return await this.app.vault.adapter.exists(path);
    } catch {
      return false;
    }
  }

  private filePath(id: string): string {
    return `${this.dirPath()}/${id}.json`;
  }

  private tmpPath(id: string): string {
    return `${this.filePath(id)}.tmp`;
  }

  private dirPath(): string {
    return `${this.pluginDir}/${CONVERSATIONS_DIR}`;
  }

  private async ensureDir(): Promise<void> {
    if (this.dirCreated) return;

    const dir = this.dirPath();
    if (!(await this.exists(dir))) {
      await this.app.vault.adapter.mkdir(dir);
    }
    this.dirCreated = true;
  }
}
