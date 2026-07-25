import { setIcon } from "obsidian";
import type WritingAssistantChat from "../main";
import type { Memory } from "../shared/types";
import { MemoryModal } from "./modals";
import { createSettingsSection, SettingItem, Toggle } from "./ui";
import { voidAsync } from "../asyncCallbacks";
import { computeMemoryCapacity } from "../memory/capacity";
import type { Gate } from "../vault-ops/gateway";
import type { MemoryMutation } from "../memory/settingsEdits";
import {
  commitMemoryFeatureToggle,
  commitMemoryGate,
  commitMemoryMutation,
} from "../memory/settingsEdits";

const TYPE_LABELS: Record<Memory["type"], string> = {
  rule: "Rule",
  context: "Context",
};

/** The same three positions and wording the vault-op gate dropdowns use. */
const MEMORY_GATE_OPTIONS: ReadonlyArray<{ value: Gate; label: string }> = [
  { value: "ask", label: "Ask" },
  { value: "auto", label: "Auto-apply" },
  { value: "deny", label: "Deny" },
];

/**
 * "Memories" settings (RFC-0005 + RFC-0007), the user-owned half of the feature:
 * the master switch, the memory-mutation approval gate, the always-on index's
 * capacity readout, and CRUD over the stored records.
 *
 * Two things here are deliberate. The gate toggle is this tab's alone: it writes
 * `vaultOpPolicy.memory`, and it is **not** in the Vault operations gate list,
 * because a switch labelled "Edit automatically" must never authorize persisting
 * or deleting a standing instruction. And every mutation persists before it
 * touches a pin, so a failed write leaves both the store and every live session
 * exactly as they were.
 */
export function renderMemoriesTab(container: HTMLElement, plugin: WritingAssistantChat): void {
  const { settings } = plugin;
  const memoryService = plugin.services.memoryService;

  const store = {
    getMemories: () => settings.memories,
    setMemories: (next: Memory[]) => {
      settings.memories = next;
    },
    save: () => plugin.saveSettings(),
    invalidateAll: () => memoryService.invalidateAll(),
    invalidatePinsContaining: (name: string) => memoryService.invalidatePinsContaining(name),
  };

  // ── Feature ────────────────────────────────────────────────────────────

  // Assigned once the records card below exists. The master toggle repaints it,
  // because switching the feature off makes every stored entry undelivered.
  let syncRecordsState = (): void => {};

  const feature = createSettingsSection(container, "Memory", undefined, { icon: "brain" });

  new SettingItem(feature.bodyEl)
    .setName("Enable memories")
    .setDesc("Deliver the memory index with every request and offer the memory tools.")
    .addToggle((toggle) => {
      toggle.setValue(settings.memoriesEnabled);
      toggle.onChange(
        voidAsync(async (value: boolean) => {
          try {
            await commitMemoryFeatureToggle(
              {
                getEnabled: () => settings.memoriesEnabled,
                setEnabled: (next) => {
                  settings.memoriesEnabled = next;
                },
                save: () => plugin.saveSettings(),
                invalidateAll: () => memoryService.invalidateAll(),
              },
              value
            );
          } finally {
            // Follow the stored value, so a rejected save leaves the switch
            // and the records card showing what is actually persisted.
            toggle.setValue(settings.memoriesEnabled);
            syncRecordsState();
          }
        }, "Failed to save the memory setting.")
      );
    });

  new SettingItem(feature.bodyEl)
    .setName("Memory changes")
    .setDesc(
      "How the assistant's add and forget requests are handled. Deny removes both tools. The vault edit posture overrides this, as it does every other approval class."
    )
    .addDropdown((dropdown) => {
      for (const option of MEMORY_GATE_OPTIONS) dropdown.addOption(option.value, option.label);
      dropdown.setValue(settings.vaultOpPolicy.memory);
      dropdown.onChange(
        voidAsync(async (value: string) => {
          try {
            await commitMemoryGate(
              {
                getGate: () => settings.vaultOpPolicy.memory,
                setGate: (gate) => {
                  settings.vaultOpPolicy.memory = gate;
                },
                save: () => plugin.saveSettings(),
              },
              value as Gate
            );
          } finally {
            dropdown.setValue(settings.vaultOpPolicy.memory);
          }
        }, "Failed to save the memory approval setting.")
      );
    });

  // ── Stored records ─────────────────────────────────────────────────────

  const library = createSettingsSection(container, "Stored memories", undefined, {
    icon: "book-open",
  });
  const listEl = library.bodyEl.createDiv({ cls: "lmsa-memory-list" });

  // The budget belongs to the records, not the feature switch: it is what this
  // list costs. It reads as the table's total, so it sits under it.
  const capacity = renderCapacityBar(library.bodyEl, () => memoryService.estimateIndexTokens());

  // The row awaiting delete confirmation, by name. Deleting is two-step in place,
  // the same shape the history drawer and the profile list use.
  let pendingDeleteName: string | null = null;

  /** Persist one mutation, then repaint the table and the capacity readout. */
  const commit = voidAsync(async (mutation: MemoryMutation) => {
    pendingDeleteName = null;
    try {
      await commitMemoryMutation(store, mutation);
    } finally {
      // Repaint from the store either way: after a rollback the rows must show
      // the persisted state, not the one the click implied.
      renderList();
      capacity.refresh();
    }
  }, "Failed to save the memory.");

  const renderList = () => {
    listEl.empty();

    // With the feature off the card states why instead of rendering the table.
    // Locking a table nobody can read is the worst of both: the rows would have
    // to be dimmed to near-invisible for the message to carry, which just makes
    // the card look broken. Replacing the content is the honest form of "off".
    if (!settings.memoriesEnabled) {
      const offEl = listEl.createDiv({ cls: "lmsa-memory-off-state" });
      offEl.createDiv({ cls: "lmsa-memory-off-title", text: "Memories are off" });
      offEl.createDiv({
        cls: "lmsa-memory-off-hint",
        text: "Enable memories above to edit, delete, add and use these entries.",
      });
      return;
    }

    if (settings.memories.length === 0) {
      listEl.createEl("p", { cls: "lmsa-empty-state", text: "No memories yet." });
      return;
    }

    const table = listEl.createEl("table", { cls: "lmsa-memory-table" });
    const headRow = table.createEl("thead").createEl("tr");
    headRow.createEl("th", { cls: "lmsa-memory-col-switch" });
    headRow.createEl("th", { text: "Name" });
    headRow.createEl("th", { text: "Type" });
    headRow.createEl("th", { text: "Description" });
    headRow.createEl("th", { cls: "lmsa-memory-col-actions" });

    const body = table.createEl("tbody");

    for (const memory of settings.memories) {
      const row = body.createEl("tr");
      if (!memory.enabled) row.addClass("is-off");

      const rowToggle = new Toggle(row.createEl("td", { cls: "lmsa-memory-col-switch" }));
      rowToggle.setValue(memory.enabled);
      rowToggle.onChange((value) =>
        commit(
          value ? { kind: "enable", name: memory.name } : { kind: "disable", name: memory.name }
        )
      );

      row.createEl("td", { cls: "lmsa-memory-cell-name", text: memory.name });

      row.createEl("td").createSpan({
        cls: `lmsa-memory-badge is-${memory.type}`,
        text: TYPE_LABELS[memory.type],
      });

      row.createEl("td", { cls: "lmsa-memory-cell-desc", text: memory.description });

      const actions = row.createEl("td", { cls: "lmsa-memory-col-actions" });

      if (pendingDeleteName === memory.name) {
        row.addClass("is-confirming-delete");
        actions
          .createEl("button", {
            cls: "lmsa-ui-compact-btn lmsa-ui-compact-btn-danger",
            text: "Delete",
          })
          .addEventListener("click", () => commit({ kind: "delete", name: memory.name }));
        actions
          .createEl("button", {
            cls: "lmsa-ui-compact-btn lmsa-ui-compact-btn-secondary",
            text: "Cancel",
          })
          .addEventListener("click", () => {
            pendingDeleteName = null;
            renderList();
          });
        continue;
      }

      createIconButton(actions, "pencil", "Edit", "lmsa-ui-btn-secondary", () => {
        new MemoryModal(plugin.app, memory, settings.memories, (updated) =>
          commit({ kind: "edit", previousName: memory.name, memory: updated })
        ).open();
      });
      createIconButton(actions, "trash-2", "Delete", "lmsa-btn-danger", () => {
        pendingDeleteName = memory.name;
        renderList();
      });
    }
  };

  const addButtonEl = library.footerEl.createEl("button", {
    cls: "lmsa-btn-add lmsa-ui-btn lmsa-ui-btn-primary",
    text: "Add memory",
  });
  addButtonEl.addEventListener("click", () => {
    new MemoryModal(plugin.app, null, settings.memories, (memory) =>
      commit({ kind: "add", memory })
    ).open();
  });

  syncRecordsState = () => {
    const off = !settings.memoriesEnabled;
    if (off) pendingDeleteName = null;
    addButtonEl.disabled = off;
    // The budget describes an index that is not delivered while the feature is
    // off, so it goes away with the table rather than quoting a phantom cost.
    capacity.wrapEl.toggleClass("lmsa-hidden", off);
    // Nothing interactive is rendered while off, so the card needs no `inert`
    // and no scrim: the list simply is the message.
    renderList();
    capacity.refresh();
  };

  syncRecordsState();
}

/** A square row action: the house button chrome, sized down to the icon. */
function createIconButton(
  container: HTMLElement,
  icon: string,
  label: string,
  variant: string,
  onClick: () => void
): void {
  const button = container.createEl("button", {
    cls: `lmsa-ui-btn ${variant} lmsa-memory-icon-btn`,
    attr: { type: "button", "aria-label": label },
  });
  setIcon(button, icon);
  button.addEventListener("click", onClick);
}

/**
 * The advisory index-budget bar. The index is always-on prompt text, so its cost
 * is a standing tax worth showing; nothing here blocks or evicts past the budget,
 * and the thresholds are the composer context ring's, so both readouts change
 * color at the same fullness. Returns a repaint function.
 */
function renderCapacityBar(
  container: HTMLElement,
  getTokens: () => number
): { wrapEl: HTMLElement; refresh: () => void } {
  const wrapEl = container.createDiv({ cls: "lmsa-memory-capacity" });

  const headerEl = wrapEl.createDiv({ cls: "lmsa-memory-capacity-header" });
  headerEl.createSpan({ cls: "lmsa-memory-capacity-label", text: "Index budget (advisory)" });
  const valueEl = headerEl.createSpan({ cls: "lmsa-memory-capacity-value" });

  const fillEl = wrapEl
    .createDiv({ cls: "lmsa-index-progress-bar" })
    .createDiv({ cls: "lmsa-index-progress-fill" });

  const refresh = () => {
    const capacity = computeMemoryCapacity(getTokens());
    wrapEl.removeClass("is-warning", "is-danger");
    if (capacity.state === "danger") {
      wrapEl.addClass("is-danger");
    } else if (capacity.state === "warning") {
      wrapEl.addClass("is-warning");
    }
    valueEl.setText(capacity.label);
    fillEl.setCssStyles({ width: `${capacity.barPercent}%` });
  };

  return { wrapEl, refresh };
}
