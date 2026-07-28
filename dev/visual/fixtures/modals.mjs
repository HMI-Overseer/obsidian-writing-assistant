import { I } from "./icons.mjs";

/**
 * Reconstructs the desktop Obsidian Modal shell around component-owned content.
 * The hierarchy is based on the installed app.css contract because no live-app
 * outerHTML dump is available in this workspace.
 */
export const modalView = (
  content,
  {
    contentClass = "",
    height = 820,
    modalClass = "",
    width = 820,
  } = {},
) => `<div class="lmsa-harness-stage">
  <div class="lmsa-modal-stage" style="position:relative;width:${width}px;height:${height}px;overflow:hidden">
    <div class="modal-container mod-dim">
      <div class="modal-bg"></div>
      <div class="modal${modalClass ? ` ${modalClass}` : ""}">
        <div class="modal-close-button" aria-label="Close">${I.x}</div>
        <div class="modal-title"></div>
        <div class="modal-content${contentClass ? ` ${contentClass}` : ""}">${content}</div>
      </div>
    </div>
  </div>
</div>`;
