import type { App } from "obsidian";
import { Component, MarkdownRenderer, Modal } from "obsidian";
import type WritingAssistantChat from "../../main";
import { voidAsync } from "../../asyncCallbacks";

const DISCLAIMER_MD = `\
Hello,

A note on your data and privacy from the developer.

When you enable a cloud provider **such as OpenAI or Anthropic** your notes and \
prompts are sent to their servers for processing. At that point, your data is \
subject to each provider's own privacy policy and terms of service. I encourage \
you to review them before use.

I've tried to implement this as efficiently as I could, because every request \
to a cloud provider costs you money, and I wanted to keep that overhead low. \
I cannot claim that it's a perfect solution, only that I tried my best.

When using Writing Assistant with a local provider **such as LM Studio** your data \
never leaves your machine. All processing happens locally, nothing is sent over the \
internet, and you can use the plugin fully offline.

I fully understand not everyone has the hardware that running a local environment \
might require, but I encourage you to try local solutions first.

There is **no telemetry** in Writing Assistant. If you have problems, or simply want \
to give feedback, reach out to me.

Writing Assistant itself **never** collects, stores, or transmits your data. Anything \
it keeps lives on your machine, inside your vault. Removing the plugin clears that \
plugin data.`;

/**
 * One-time privacy disclaimer shown before the user can access API key management.
 * Once accepted, the flag is persisted and the modal never appears again.
 */
export class ApiKeysDisclaimerModal extends Modal {
  private renderChild = new Component();

  constructor(
    app: App,
    private plugin: WritingAssistantChat,
    private onAccept: () => void
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;

    contentEl.addClass("lmsa-modal", "lmsa-disclaimer-modal");
    contentEl.createEl("h2", { text: "Message from the developer" });

    const bodyEl = contentEl.createDiv({ cls: "lmsa-disclaimer-body" });
    this.renderChild.load();
    await MarkdownRenderer.render(this.app, DISCLAIMER_MD, bodyEl, "", this.renderChild);

    // ── Action buttons ────────────────────────────────────────────────
    const buttonRow = contentEl.createDiv({ cls: "lmsa-disclaimer-buttons" });

    const closeBtn = buttonRow.createEl("button", { text: "Close" });
    closeBtn.addEventListener("click", () => this.close());

    const acceptBtn = buttonRow.createEl("button", {
      text: "I understand, continue",
      cls: "mod-cta",
    });
    acceptBtn.addEventListener("click", voidAsync(async () => {
      this.plugin.settings.apiKeysDisclaimerAccepted = true;
      await this.plugin.saveSettings();
      this.close();
      this.onAccept();
    }, "Failed to save your preference."));
  }

  onClose(): void {
    this.renderChild.unload();
    this.contentEl.empty();
  }
}
