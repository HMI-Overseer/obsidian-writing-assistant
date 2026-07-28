import { I } from "../fixtures/icons.mjs";
import { SCENE_IMAGE_URI } from "../fixtures/images.mjs";
import { modalView } from "../fixtures/modals.mjs";

const settingItem = (name, description, control, extra = "", extraClass = "") =>
  `<div class="lmsa-setting-item${extraClass ? ` ${extraClass}` : ""}">
    <div class="lmsa-setting-item-info">
      <div class="lmsa-setting-item-name">${name}</div>
      <div class="lmsa-setting-item-desc">${description}</div>
    </div>
    <div class="lmsa-setting-item-control">${control}</div>
    ${extra}
  </div>`;

const actionRow = () =>
  settingItem(
    "",
    "",
    `<button class="lmsa-ui-btn lmsa-ui-btn-secondary">Cancel</button>
     <button class="lmsa-ui-btn lmsa-ui-btn-primary">Save</button>`,
  );

const commandIcons = [
  I.wand,
  I.scissors,
  I.pencil,
  I.highlighter,
  I.eraser,
  I.spellCheck,
  I.type,
  I.text,
  I.fileText,
  I.bookOpen,
  I.lightbulb,
  I.sparkles,
  I.star,
  I.eye,
  I.messageCircle,
  I.list,
  I.arrowRight,
  I.minimize2,
  I.unfoldVertical,
  I.replace,
  I.brain,
  I.search,
  I.check,
  I.bookmark,
  I.hash,
];

const iconGrid = commandIcons
  .map(
    (icon, index) =>
      `<div class="lmsa-icon-picker-cell${index === 1 ? " is-selected" : ""}">${icon}</div>`,
  )
  .join("");

export const MODAL_SURFACES = {
  // Edit state exercises filled native controls and the full custom SettingItem hierarchy.
  memoryModal: {
    source: "src/settings/modals/MemoryModal.ts",
    shot: ".lmsa-modal-stage",
    html: modalView(
      `<h2>Edit: no-emdashes</h2>
      ${settingItem(
        "Name",
        "Lowercase letters, numbers, and hyphens, such as no-emdashes. This is the memory's identity and the handle the model recalls it by.",
        `<input type="text" value="no-emdashes">`,
      )}
      ${settingItem(
        "Type",
        "A rule carries its instruction in the description and governs every request. A context holds substance the model recalls on demand.",
        `<select><option value="rule" selected>Rule</option><option value="context">Context</option></select>`,
      )}
      ${settingItem(
        "Description",
        "One line, up to 200 characters. It is always in context, so a rule states its constraint here and a context says what it holds and when to recall it.",
        `<input type="text" value="Never use em dashes; use commas for asides and colons before lists." placeholder="Never use em dashes; use commas for asides and colons before lists.">`,
      )}
      ${settingItem(
        "Content",
        "Optional body, up to 4000 characters, returned by recall. A rule often needs none.",
        `<textarea class="lmsa-input-full" rows="8" placeholder="The vault's grimdark tone, its narrators, and the register they share."></textarea>`,
      )}
      ${actionRow()}`,
      {
        contentClass: "lmsa-modal",
        height: 900,
      },
    ),
  },

  // Edit state with the source's full 25-icon curated palette and a selected scissors cell.
  commandModal: {
    source: "src/settings/modals/CommandModal.ts",
    shot: ".lmsa-modal-stage",
    html: modalView(
      `<h2>Edit: Tighten dialogue</h2>
      ${settingItem(
        "Command name",
        "This appears as a quick-action button in the chat view.",
        `<input type="text" value="Tighten dialogue" placeholder="Tighten dialogue">`,
      )}
      ${settingItem(
        "Icon",
        "Displayed in the context menu and command list.",
        "",
        `<div class="lmsa-icon-picker-grid">${iconGrid}</div>`,
        "lmsa-icon-picker-section",
      )}
      ${settingItem(
        "Prompt template",
        "Supports {{selection}} and {{note}} placeholders.",
        `<textarea class="lmsa-input-full" rows="8" placeholder="Rewrite {{selection}} to sound sharper while preserving the meaning.">Rewrite {{selection}} with tighter dialogue while preserving voice and subtext.</textarea>`,
      )}
      ${actionRow()}`,
      {
        contentClass: "lmsa-modal",
        height: 920,
      },
    ),
  },

  // MarkdownRenderer output is represented as its paragraph and strong-element result, followed by
  // the source-owned action row. The outer frame remains Obsidian's Modal chrome.
  apiKeysDisclaimerModal: {
    source: "src/settings/modals/ApiKeysDisclaimerModal.ts",
    shot: ".lmsa-modal-stage",
    html: modalView(
      `<h2>Message from the developer</h2>
      <div class="lmsa-disclaimer-body">
        <p>Hello,</p>
        <p>A note on your data and privacy from the developer.</p>
        <p>When you enable a cloud provider <strong>such as OpenAI or Anthropic</strong> your notes and prompts are sent to their servers for processing. At that point, your data is subject to each provider's own privacy policy and terms of service. I encourage you to review them before use.</p>
        <p>I've tried to implement this as efficiently as I could, because every request to a cloud provider costs you money, and I wanted to keep that overhead low. I cannot claim that it's a perfect solution, only that I tried my best.</p>
        <p>When using Writing Assistant with a local provider <strong>such as LM Studio</strong> your data never leaves your machine. All processing happens locally, nothing is sent over the internet, and you can use the plugin fully offline.</p>
        <p>I fully understand not everyone has the hardware that running a local environment might require, but I encourage you to try local solutions first.</p>
        <p>There is <strong>no telemetry</strong> in Writing Assistant. If you have problems, or simply want to give feedback, reach out to me.</p>
        <p>Writing Assistant itself <strong>never</strong> collects, stores, or transmits your data. Anything it keeps lives on your machine, inside your vault. Removing the plugin clears that plugin data.</p>
      </div>
      <div class="lmsa-disclaimer-buttons">
        <button>Close</button>
        <button class="mod-cta">I understand, continue</button>
      </div>`,
      {
        contentClass: "lmsa-modal lmsa-disclaimer-modal",
        height: 900,
      },
    ),
  },

  // The source strips Obsidian's visible frame, title, and default close button, then places its own
  // close control over the image.
  imagePreviewModal: {
    source: "src/chat/messages/ImagePreviewModal.ts",
    shot: ".lmsa-modal-stage",
    html: modalView(
      `<div class="lmsa-chat-image-lightbox-frame">
        <img class="lmsa-chat-image-lightbox-img" src="${SCENE_IMAGE_URI}" alt="Harbor at dusk">
        <button class="lmsa-chat-image-lightbox-close" type="button">${I.x}</button>
      </div>`,
      {
        contentClass: "lmsa-chat-image-lightbox",
        height: 620,
        modalClass: "lmsa-chat-image-modal-shell",
        width: 900,
      },
    ),
  },
};
