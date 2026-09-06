import { Notice, setIcon } from "obsidian";
import type { App } from "obsidian";
import type {
  ApprovalPosture,
  Attachment,
  CompletionModel,
  ImageMimeType,
} from "../../shared/types";
import type WritingAssistantChat from "../../main";
import { shouldUseToolCall } from "../../tools/registry";
import { getActiveFileName } from "../../context/noteContext";
import type { ExtraContextItem } from "../../shared/chatRequest";
import type { ChatLayoutRefs } from "../types";
import { generateId } from "../../utils";
import {
  MAX_IMAGE_SIZE_BYTES,
  MAX_TEXT_ATTACHMENT_BYTES,
  SUPPORTED_IMAGE_TYPES,
} from "../../constants";
import { resolveVisionSupport } from "../../api/ModelAvailabilityService";
import {
  getDraggedVaultMarkdownFiles,
  getDroppedVaultMarkdownFiles,
  isMarkdownDropFile,
} from "./vaultDrag";

type ChatComposerCallbacks = {
  onDraftChange: (draft: string) => void;
  onSendRequest: () => void;
  onStopRequest: () => void;
  onPostureChange: (posture: ApprovalPosture) => void;
  onContextToggle: () => void;
};

export class ChatComposer {
  /**
   * Whether the active note is currently attached to the context.
   * Initialized from `includeNoteContext` setting; can be toggled per-session
   * by the user (remove chip or add via context picker).
   */
  private activeNoteAttached: boolean;
  private extraContextItems: ExtraContextItem[] = [];
  private stagedAttachments: Attachment[] = [];
  private supportsVision = false;
  private isSending = false;
  private currentPosture: ApprovalPosture = "ask";
  private readonly handleKeydown: (event: KeyboardEvent) => void;
  private readonly handleInput: () => void;
  private readonly handleActionClick: () => void;
  private readonly handlePaste: (event: ClipboardEvent) => void;
  private readonly handleDragOver: (event: DragEvent) => void;
  private readonly handleDragLeave: (event: DragEvent) => void;
  private readonly handleDrop: (event: DragEvent) => void;

  constructor(
    private readonly app: App,
    private readonly plugin: WritingAssistantChat,
    private readonly refs: Pick<
      ChatLayoutRefs,
      | "composerPanelEl"
      | "contextChipsEl"
      | "textareaEl"
      | "toolUseIndicatorEl"
      | "toolUsePopoverEl"
      | "knowledgeIndicatorEl"
      | "visionIndicatorEl"
      | "attachmentsEl"
      | "actionBtn"
    >,
    private readonly callbacks: ChatComposerCallbacks
  ) {
    this.activeNoteAttached =
      this.plugin.settings.includeNoteContext && !!this.app.workspace.getActiveFile();

    this.handleKeydown = (event: KeyboardEvent) => {
      if (this.isSending) return;
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        event.preventDefault();
        this.callbacks.onSendRequest();
      }
    };
    this.refs.textareaEl.addEventListener("keydown", this.handleKeydown);

    this.handleInput = () => {
      this.autoResizeTextarea();
      this.callbacks.onDraftChange(this.refs.textareaEl.value);
    };
    this.refs.textareaEl.addEventListener("input", this.handleInput);

    this.handleActionClick = () => {
      if (this.isSending) {
        this.callbacks.onStopRequest();
      } else {
        this.callbacks.onSendRequest();
      }
    };
    this.refs.actionBtn.addEventListener("click", this.handleActionClick);

    // Image attachment handlers
    this.handlePaste = (event: ClipboardEvent) => {
      if (this.isSending) {
        if ((event.clipboardData?.files.length ?? 0) > 0) event.preventDefault();
        return;
      }
      const files = event.clipboardData?.files;
      if (!files || files.length === 0) return;
      const imageFiles = Array.from(files).filter((f) => SUPPORTED_IMAGE_TYPES.has(f.type));
      if (imageFiles.length === 0) return;
      event.preventDefault();
      this.processImageFiles(imageFiles);
    };
    this.refs.textareaEl.addEventListener("paste", this.handlePaste);

    this.handleDragOver = (event: DragEvent) => {
      // Only claim drags we can actually accept (vault notes or OS files), so unrelated
      // drags (text selections, tabs) pass through untouched instead of flashing the ring.
      if (!this.canAcceptDrop(event)) return;
      // preventDefault ONLY. Two things we must NOT do: (1) stopPropagation, or Obsidian's
      // document-level dragover stops firing over the composer and its drag ghost (the
      // floating file-name pill) freezes at our border; (2) force dropEffect, since
      // Obsidian's internal file drags advertise their own effectAllowed and an
      // incompatible "copy" makes the browser reject the drop. preventDefault alone marks
      // us a valid drop target; the browser's default effect is always compatible.
      event.preventDefault();
      if (this.isSending) return;
      this.refs.composerPanelEl.addClass("is-dragover");
    };
    this.handleDragLeave = (event: DragEvent) => {
      // dragleave also fires when crossing into a child (chips, textarea, footer); keep the
      // ring lit while the pointer is still anywhere inside the panel.
      const composerPanel = this.refs.composerPanelEl;
      const related = event.relatedTarget as Node | null;
      if (related && composerPanel.contains(related)) return;
      composerPanel.removeClass("is-dragover");
    };
    this.handleDrop = (event: DragEvent) => {
      // preventDefault only: do NOT stopPropagation here. Obsidian removes its drag ghost
      // (the floating file-name pill) in a document-level drop handler; halting the bubble
      // strands that ghost inside the composer. Letting the drop reach the document lets
      // Obsidian finalize the drag while we've already consumed the payload below.
      event.preventDefault();
      this.refs.composerPanelEl.removeClass("is-dragover");
      if (this.isSending) return;

      // Vault file-explorer drag: route markdown notes to context chips, identical to
      // picking them from the context picker (resolved from the vault at send time).
      const vaultFiles = getDroppedVaultMarkdownFiles(this.app, event);
      if (vaultFiles.length > 0) {
        for (const file of vaultFiles) {
          this.addExtraContextItem({ filePath: file.path, fileName: file.name });
        }
        this.refs.textareaEl.focus();
        return;
      }

      // OS file-system drag: images stay image attachments; markdown files become inline
      // context notes captured now (they have no vault path to re-read later).
      const files = event.dataTransfer?.files;
      if (!files || files.length === 0) return;
      const dropped = Array.from(files);
      const imageFiles = dropped.filter((f) => SUPPORTED_IMAGE_TYPES.has(f.type));
      const textFiles = dropped.filter((f) => isMarkdownDropFile(f));
      if (imageFiles.length > 0) this.processImageFiles(imageFiles);
      if (textFiles.length > 0) {
        void this.processExternalTextFiles(textFiles);
        this.refs.textareaEl.focus();
      }
    };
    this.refs.composerPanelEl.addEventListener("dragover", this.handleDragOver);
    this.refs.composerPanelEl.addEventListener("dragleave", this.handleDragLeave);
    this.refs.composerPanelEl.addEventListener("drop", this.handleDrop);
  }

  /**
   * Opens a file picker for the user to select images.
   * Called from the context picker popover's "Attach image" option.
   */
  openImagePicker(): void {
    if (!this.canAttachImages()) {
      new Notice("The active model does not support image input.");
      return;
    }
    // Create the throwaway file input in the view's own document so a popped-out
    // view opens the native picker against its own window (ADR-0024).
    // Raw createElement, not createEl: the helper cannot build a detached element
    // on a non-main document (ADR-0026).
    const input = this.refs.textareaEl.ownerDocument.createElement("input");
    input.type = "file";
    input.accept = "image/jpeg,image/png,image/gif,image/webp";
    input.multiple = true;
    input.addEventListener("change", () => {
      if (input.files && input.files.length > 0) {
        this.processImageFiles(Array.from(input.files));
      }
    });
    input.click();
  }

  getPosture(): ApprovalPosture {
    return this.currentPosture;
  }

  setPosture(posture: ApprovalPosture): void {
    this.currentPosture = posture;
    this.updateContextChips();
    this.callbacks.onPostureChange(posture);
  }

  /**
   * Set the live posture from a restored conversation (switch / branch / load).
   * Unlike {@link setPosture} this fires no change callback and persists nothing:
   * the value is already the conversation's stored posture. The caller refreshes
   * the pill and the root `data-posture`.
   */
  restorePosture(posture: ApprovalPosture): void {
    this.currentPosture = posture;
    this.updateContextChips();
  }

  seedPrompt(text: string): void {
    this.setDraft(text);
    this.refs.textareaEl.focus();
  }

  getDraft(): string {
    return this.refs.textareaEl.value;
  }

  setDraft(text: string): void {
    this.refs.textareaEl.value = text;
    this.autoResizeTextarea();
  }

  clearDraft(): void {
    this.setDraft("");
    this.refs.textareaEl.setCssStyles({ height: "auto" });
  }

  setSendingState(sending: boolean): void {
    this.isSending = sending;
    this.refs.actionBtn.empty();
    setIcon(this.refs.actionBtn, sending ? "square" : "arrow-up");
    this.refs.actionBtn.toggleClass("is-stop", sending);
    this.refs.actionBtn.setAttribute(
      "aria-label",
      sending ? "Stop generation" : "Send message",
    );
    this.refs.textareaEl.disabled = sending;
    if (sending) this.refs.composerPanelEl.removeClass("is-dragover");
  }

  isActiveNoteAttached(): boolean {
    return this.activeNoteAttached;
  }

  getExtraContextItems(): ExtraContextItem[] {
    return [...this.extraContextItems];
  }

  /**
   * Attach the active note manually (used by ContextPickerPopover).
   * Ignored if the active note is already attached.
   */
  attachActiveNote(): void {
    if (this.activeNoteAttached) return;
    this.activeNoteAttached = true;
    this.updateContextChips();
    this.callbacks.onContextToggle();
  }

  /**
   * Add a vault note to the extra context. Deduplicates by filePath.
   * Used by ContextPickerPopover after the user picks a file.
   */
  addExtraContextItem(item: ExtraContextItem): void {
    if (this.extraContextItems.some((i) => i.filePath === item.filePath)) return;
    this.extraContextItems.push(item);
    this.updateContextChips();
  }

  /**
   * Clear the attached notes after a send. Sending freezes a point-in-time snapshot
   * into the sent message (see snapshotNoteAttachments), so the live
   * attachment is consumed once per send, re-attach via the context picker to
   * send an updated snapshot. Does not touch staged images (handled separately).
   */
  clearAttachedNotes(): void {
    this.activeNoteAttached = false;
    this.extraContextItems = [];
    this.updateContextChips();
    this.callbacks.onContextToggle();
  }

  /**
   * Reset context to the default state for a new conversation:
   * re-apply the auto-attach setting, clear manual vault-note items and attachments.
   */
  resetContextForNewConversation(): void {
    this.activeNoteAttached =
      this.plugin.settings.includeNoteContext && !!this.app.workspace.getActiveFile();
    this.extraContextItems = [];
    this.stagedAttachments = [];
    this.updateContextChips();
    this.renderAttachmentPreviews();
  }

  // ---------------------------------------------------------------------------
  // Image attachments
  // ---------------------------------------------------------------------------

  getAttachments(): Attachment[] {
    return [...this.stagedAttachments];
  }

  clearAttachments(): void {
    this.stagedAttachments = [];
    this.renderAttachmentPreviews();
  }

  /**
   * Updates the internal vision-support state based on the active model's capability.
   * Called alongside the vision indicator refresh so image attachment stays in sync.
   */
  refreshVisionSupport(activeModel: CompletionModel | null): void {
    // Gate: treat an unprobed model (capability unknown) as allow-the-attempt rather than a
    // hard block, a never-checked local model would otherwise present as "no vision" and
    // refuse a legitimate image attach. A model known to lack vision (explicit false) still
    // blocks.
    this.supportsVision = activeModel
      ? resolveVisionSupport(activeModel, this.plugin.services.modelAvailability) ?? true
      : false;
  }

  updateContextChips(): void {
    // Preserve the + button (first child) and re-render the rest.
    // Remove all chips except the + button.
    const children = Array.from(this.refs.contextChipsEl.children);
    for (const child of children) {
      if (!child.hasClass("lmsa-chat-composer-add-context-btn")) {
        child.remove();
      }
    }

    const fileName = getActiveFileName(this.app);
    if (fileName && this.activeNoteAttached) {
      this.renderChip(
        this.currentPosture === "auto" ? "file-pen-line" : "file-text",
        fileName,
        () => {
          this.activeNoteAttached = false;
          this.updateContextChips();
          this.callbacks.onContextToggle();
        },
      );
    }

    for (const item of this.extraContextItems) {
      // External (dragged-in) files carry inline content; a distinct icon signals they
      // are a frozen import rather than a live vault note re-read at send.
      const icon = item.content !== undefined ? "file-input" : "file-text";
      this.renderChip(icon, item.fileName, () => {
        this.extraContextItems = this.extraContextItems.filter(
          (i) => i.filePath !== item.filePath,
        );
        this.updateContextChips();
      });
    }
  }

  /**
   * Updates the tool-use indicator state based on agentic mode and model capability.
   * Orange when agentic mode is on and the model supports tool use.
   */
  refreshToolUseIndicator(activeModel: CompletionModel | null): void {
    const el = this.refs.toolUseIndicatorEl;
    el.removeClass("lmsa-hidden");

    if (!activeModel) {
      el.removeClass("is-active");
      el.setAttribute("aria-label", "No model selected");
      return;
    }

    const trainedForToolUse = activeModel.trainedForToolUse
      ?? this.plugin.services.modelAvailability.getTrainedForToolUse(activeModel.modelId);
    const modelCapable = shouldUseToolCall(activeModel.provider, { trainedForToolUse });
    const active = this.plugin.settings.agenticMode && modelCapable;

    el.toggleClass("is-active", active);
    el.setAttribute("aria-label", active
      ? "Agentic mode on, vault search and edit tools available"
      : "Agentic mode off, no tools used");
  }

  /**
   * Updates the knowledge indicator based on RAG and knowledge graph readiness.
   * Cyan when at least one knowledge source is active, gray otherwise, and a
   * muted amber when the retrieval index is out of date (a reindex is pending).
   */
  refreshKnowledgeIndicator(ragReady: boolean, graphReady: boolean, stale = false): void {
    const el = this.refs.knowledgeIndicatorEl;
    const active = ragReady || graphReady;

    el.toggleClass("is-active", active);
    el.toggleClass("is-stale", stale);

    const staleSuffix = stale ? " (index out of date)" : "";
    if (ragReady && graphReady) {
      el.setAttribute("aria-label", `Knowledge active: retrieval + graph${staleSuffix}`);
    } else if (ragReady) {
      el.setAttribute("aria-label", `Knowledge active: retrieval${staleSuffix}`);
    } else if (graphReady) {
      el.setAttribute("aria-label", "Knowledge active: graph");
    } else if (stale) {
      el.setAttribute("aria-label", "Retrieval index out of date");
    } else {
      el.setAttribute("aria-label", "No knowledge sources active");
    }
  }

  /**
   * Updates the vision indicator based on the active model's vision capability.
   * Purple when the model supports vision, gray otherwise.
   */
  refreshVisionIndicator(activeModel: CompletionModel | null): void {
    const el = this.refs.visionIndicatorEl;

    if (!activeModel) {
      el.removeClass("is-active");
      el.setAttribute("aria-label", "No model selected");
      return;
    }

    // Indicator: an unprobed model reads as off rather than promising a capability
    // nobody has checked.
    const supportsVision =
      resolveVisionSupport(activeModel, this.plugin.services.modelAvailability) ?? false;

    el.toggleClass("is-active", supportsVision);
    el.setAttribute("aria-label", supportsVision
      ? "Vision supported, model can process images"
      : "Vision not available");
  }

  destroy(): void {
    this.refs.textareaEl.removeEventListener("keydown", this.handleKeydown);
    this.refs.textareaEl.removeEventListener("input", this.handleInput);
    this.refs.actionBtn.removeEventListener("click", this.handleActionClick);
    this.refs.textareaEl.removeEventListener("paste", this.handlePaste);
    this.refs.composerPanelEl.removeEventListener("dragover", this.handleDragOver);
    this.refs.composerPanelEl.removeEventListener("dragleave", this.handleDragLeave);
    this.refs.composerPanelEl.removeEventListener("drop", this.handleDrop);
  }

  private renderChip(icon: string, label: string, onRemove: () => void): void {
    const chip = this.refs.contextChipsEl.createDiv({ cls: "lmsa-chat-composer-chip" });
    const fileIcon = chip.createSpan({ cls: "lmsa-chat-composer-chip-icon" });
    setIcon(fileIcon, icon);
    chip.createSpan({ cls: "lmsa-chat-composer-chip-label", text: label });
    const removeBtn = chip.createEl("button", {
      cls: "lmsa-chat-composer-chip-remove",
      attr: { "aria-label": "Remove context" },
    });
    setIcon(removeBtn.createSpan(), "x");
    removeBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      onRemove();
    });
  }

  /**
   * Whether the active model supports image attachments.
   * Kept in sync via refreshVisionSupport() using the full vision resolution chain
   * (CompletionModel.vision ?? ModelAvailabilityService).
   */
  canAttachImages(): boolean {
    return this.supportsVision;
  }

  /**
   * Whether the current drag holds content the composer accepts: a vault markdown note
   * (via Obsidian's drag manager) or any OS file (its type is unreadable until drop, so
   * we accept optimistically and filter to images/markdown in the drop handler).
   */
  private canAcceptDrop(event: DragEvent): boolean {
    if (getDraggedVaultMarkdownFiles(this.app).length > 0) return true;
    const types = event.dataTransfer?.types;
    return !!types && Array.from(types).includes("Files");
  }

  /**
   * Read OS-dropped markdown files and stage them as inline context notes. The content is
   * frozen at drop time (there is no vault path to re-read), then flows through the same
   * snapshot pipeline as vault notes via {@link ExtraContextItem.content}.
   */
  private async processExternalTextFiles(files: File[]): Promise<void> {
    for (const file of files) {
      if (file.size > MAX_TEXT_ATTACHMENT_BYTES) {
        new Notice(
          `File too large: ${file.name}. Maximum size is ` +
            `${MAX_TEXT_ATTACHMENT_BYTES / (1024 * 1024)} MB.`,
        );
        continue;
      }
      let content: string;
      try {
        content = await file.text();
      } catch {
        new Notice(`Could not read ${file.name}.`);
        continue;
      }
      this.addExtraContextItem({ filePath: file.name, fileName: file.name, content });
    }
  }

  private processImageFiles(files: File[]): void {
    if (!this.canAttachImages()) {
      new Notice("The active model does not support image input.");
      return;
    }

    for (const file of files) {
      if (!SUPPORTED_IMAGE_TYPES.has(file.type)) {
        new Notice(`Unsupported image format: ${file.type}`);
        continue;
      }
      if (file.size > MAX_IMAGE_SIZE_BYTES) {
        new Notice(`Image too large: ${file.name}. Maximum size is 20 MB.`);
        continue;
      }

      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        // Strip the "data:image/...;base64," prefix
        const base64 = dataUrl.split(",")[1];
        if (!base64) return;

        const attachment: Attachment = {
          type: "image",
          id: generateId(),
          mimeType: file.type as ImageMimeType,
          data: base64,
          fileName: file.name,
        };
        this.stagedAttachments.push(attachment);
        this.renderAttachmentPreviews();
      };
      reader.readAsDataURL(file);
    }
  }

  private renderAttachmentPreviews(): void {
    this.refs.attachmentsEl.empty();
    for (const attachment of this.stagedAttachments) {
      if (attachment.type === "image") {
        const thumbEl = this.refs.attachmentsEl.createDiv({ cls: "lmsa-chat-composer-attachment" });
        thumbEl.createEl("img", {
          cls: "lmsa-chat-composer-attachment-img",
          attr: {
            src: `data:${attachment.mimeType};base64,${attachment.data}`,
            alt: attachment.fileName ?? "Image attachment",
          },
        });
        const removeBtn = thumbEl.createEl("button", {
          cls: "lmsa-chat-composer-attachment-remove",
          attr: { "aria-label": "Remove attachment" },
        });
        setIcon(removeBtn, "x");
        removeBtn.addEventListener("click", () => {
          this.stagedAttachments = this.stagedAttachments.filter((a) => a.id !== attachment.id);
          this.renderAttachmentPreviews();
        });
      }
    }
  }

  /** Re-measure the textarea height after the view's size changes. */
  refreshHeight(): void {
    this.autoResizeTextarea();
  }

  private autoResizeTextarea(): void {
    this.refs.textareaEl.setCssStyles({ height: "auto" });
    // scrollHeight is 0 while the view is not laid out (e.g. hidden sidebar)
    if (this.refs.textareaEl.scrollHeight === 0) return;
    this.refs.textareaEl.setCssStyles({ height: `${this.refs.textareaEl.scrollHeight}px` });
  }
}
