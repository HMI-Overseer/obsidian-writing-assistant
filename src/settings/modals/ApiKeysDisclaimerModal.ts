import type { App } from "obsidian";
import { Component, MarkdownRenderer, Modal } from "obsidian";
import type WritingAssistantChat from "../../main";

const DISCLAIMER_MD = `\
Hello,

A note on your data and privacy from the developer.

When you connect to a cloud provider **such as OpenAI or Anthropic** your notes \
and prompts are sent to their servers for processing. At that point, your data is \
subject to each provider's own privacy policy and terms of service. I encourage \
you to review them before use.

I have taken steps into offering and implementing as efficient way I could, because \
the moment you engage with these products, you see your money slowly burn. I cannot \
claim that it's a perfect solution, only that I tried my best.

When using Writing Assistant with a local provider **such as Ollama or LM Studio** \
your data never leaves your machine. All processing happens locally, and nothing is \
sent over the internet, and you can engage with the plugin fully offline.

I fully understand not everyone has the hardware that might be required to run the \
environment you might wish for locally, but I encourage you to try local solutions first.

There is **no telemetry** in the Writing Assistant plugin, if you have problems \
or simply want to give feedback simply reach me out.

Writing Assistant itself **never** collects, stores, or transmits your data, everything \
is stored on your machine, inside your vault, deleting the plugin erases your data.`;

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
    acceptBtn.addEventListener("click", async () => {
      this.plugin.settings.apiKeysDisclaimerAccepted = true;
      await this.plugin.saveSettings();
      this.close();
      this.onAccept();
    });
  }

  onClose(): void {
    this.renderChild.unload();
    this.contentEl.empty();
  }
}
