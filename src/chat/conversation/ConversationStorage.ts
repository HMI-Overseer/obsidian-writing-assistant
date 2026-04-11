import type { App } from "obsidian";
import type { Conversation } from "../../shared/types";
import { normalizeConversation } from "./conversationUtils";

const CONVERSATIONS_DIR = "conversations";

/**
 * Adapter-based file storage for individual conversations.
 *
 * Each conversation is stored as `{pluginDir}/conversations/{id}.json`.
 * Follows the same adapter.read/write/exists/remove pattern used by
 * RagService and GraphService.
 */
export class ConversationStorage {
  private dirCreated = false;

  constructor(private readonly app: App) {}

  async load(id: string): Promise<Conversation | null> {
    try {
      const path = this.filePath(id);
      const exists = await this.app.vault.adapter.exists(path);
      if (!exists) return null;

      const raw = await this.app.vault.adapter.read(path);
      const data = JSON.parse(raw);
      return normalizeConversation(data);
    } catch {
      return null;
    }
  }

  async save(conversation: Conversation): Promise<void> {
    await this.ensureDir();
    const path = this.filePath(conversation.id);
    await this.app.vault.adapter.write(path, JSON.stringify(conversation));
  }

  async delete(id: string): Promise<void> {
    try {
      const path = this.filePath(id);
      const exists = await this.app.vault.adapter.exists(path);
      if (exists) {
        await this.app.vault.adapter.remove(path);
      }
    } catch {
      // Non-fatal — orphaned files are harmless.
    }
  }

  private filePath(id: string): string {
    return `${this.dirPath()}/${id}.json`;
  }

  private dirPath(): string {
    return `${this.app.vault.configDir}/plugins/writing-assistant-chat/${CONVERSATIONS_DIR}`;
  }

  private async ensureDir(): Promise<void> {
    if (this.dirCreated) return;

    const dir = this.dirPath();
    const exists = await this.app.vault.adapter.exists(dir);
    if (!exists) {
      await this.app.vault.adapter.mkdir(dir);
    }
    this.dirCreated = true;
  }
}
