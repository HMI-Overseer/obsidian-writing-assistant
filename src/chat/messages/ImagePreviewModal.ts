import type { App } from "obsidian";
import { Modal } from "obsidian";

export class ImagePreviewModal extends Modal {
  constructor(
    app: App,
    private readonly imageSrc: string,
    private readonly imageAlt: string,
    private readonly fileName?: string
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, modalEl } = this;

    modalEl.addClass("lmsa-chat-image-modal-shell");
    contentEl.addClass("lmsa-chat-image-modal");
    this.setTitle(this.fileName ?? "Image preview");

    contentEl.createEl("img", {
      cls: "lmsa-chat-image-modal-img",
      attr: {
        src: this.imageSrc,
        alt: this.imageAlt,
      },
    });
  }

  onClose(): void {
    this.modalEl.removeClass("lmsa-chat-image-modal-shell");
    this.contentEl.empty();
    this.contentEl.removeClass("lmsa-chat-image-modal");
  }
}
