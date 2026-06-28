import type { App } from "obsidian";
import { Modal, setIcon } from "obsidian";

/**
 * Frameless image lightbox: the picture itself is the popover. Obsidian's modal
 * chrome (frame, title bar, default close button) is stripped in CSS so only the
 * image and a built-in X in its top-right corner remain. Escape and a backdrop
 * click still dismiss it via the base Modal.
 */
export class ImagePreviewModal extends Modal {
  constructor(
    app: App,
    private readonly imageSrc: string,
    private readonly imageAlt: string
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, modalEl } = this;

    modalEl.addClass("lmsa-chat-image-modal-shell");
    contentEl.addClass("lmsa-chat-image-lightbox");

    const frameEl = contentEl.createDiv({ cls: "lmsa-chat-image-lightbox-frame" });
    frameEl.createEl("img", {
      cls: "lmsa-chat-image-lightbox-img",
      attr: {
        src: this.imageSrc,
        alt: this.imageAlt,
      },
    });

    const closeBtn = frameEl.createEl("button", {
      cls: "lmsa-chat-image-lightbox-close",
      attr: { type: "button" },
    });
    setIcon(closeBtn, "x");
    closeBtn.addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.modalEl.removeClass("lmsa-chat-image-modal-shell");
    this.contentEl.empty();
    this.contentEl.removeClass("lmsa-chat-image-lightbox");
  }
}
