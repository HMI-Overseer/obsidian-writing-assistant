import { setIcon } from "obsidian";
import type WritingAssistantChat from "../main";
import type { Memory } from "../shared/types";
import { MemoryModal } from "./modals";
import { Toggle } from "./ui";
import type { SettingsSection } from "./definitions/sections";
import { blockRow, settingRow } from "./definitions/sections";
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
 * Handles between rows of one page build. The master switch lives in the feature card and acts on
 * two rows of the records card: switching memories off makes every stored entry undelivered, so the
 * table becomes a message and the add button goes inert. Each handle is set by the row that owns
 * the thing and nulled by that row's cleanup.
 */
interface MemoriesPageRefs {
  /** Repaints the records card: the budget readout and the table or its off-state. */
  syncRecords: (() => void) | null;
  setAddEnabled: ((enabled: boolean) => void) | null;
}

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
export function memoriesTabSections(plugin: WritingAssistantChat): SettingsSection[] {
  const refs: MemoriesPageRefs = { syncRecords: null, setAddEnabled: null };

  return [
    {
      name: "Memory",
      desc: "",
      icon: "brain",
      rows: [
        settingRow(
          "Enable memories",
          "Deliver the memory index with every request and offer the memory tools.",
          (item) => {
            item.addToggle((toggle) => {
              toggle.setValue(plugin.settings.memoriesEnabled);
              toggle.onChange(
                voidAsync(async (value: boolean) => {
                  try {
                    await commitMemoryFeatureToggle(
                      {
                        getEnabled: () => plugin.settings.memoriesEnabled,
                        setEnabled: (next) => {
                          plugin.settings.memoriesEnabled = next;
                        },
                        save: () => plugin.saveSettings(),
                        invalidateAll: () => plugin.services.memoryService.invalidateAll(),
                      },
                      value
                    );
                  } finally {
                    // Follow the stored value, so a rejected save leaves the switch
                    // and the records card showing what is actually persisted.
                    toggle.setValue(plugin.settings.memoriesEnabled);
                    refs.syncRecords?.();
                    refs.setAddEnabled?.(plugin.settings.memoriesEnabled);
                  }
                }, "Failed to save the memory setting.")
              );
            });
          }
        ),
        settingRow(
          "Memory changes",
          "How the assistant's add and forget requests are handled. Deny removes both tools. The vault edit posture overrides this, as it does every other approval class.",
          (item) => {
            item.addDropdown((dropdown) => {
              for (const option of MEMORY_GATE_OPTIONS) {
                dropdown.addOption(option.value, option.label);
              }
              dropdown.setValue(plugin.settings.vaultOpPolicy.memory);
              dropdown.onChange(
                voidAsync(async (value: string) => {
                  try {
                    await commitMemoryGate(
                      {
                        getGate: () => plugin.settings.vaultOpPolicy.memory,
                        setGate: (gate) => {
                          plugin.settings.vaultOpPolicy.memory = gate;
                        },
                        save: () => plugin.saveSettings(),
                      },
                      value as Gate
                    );
                  } finally {
                    dropdown.setValue(plugin.settings.vaultOpPolicy.memory);
                  }
                }, "Failed to save the memory approval setting.")
              );
            });
          }
        ),
      ],
    },
    {
      name: "Stored memories",
      desc: "",
      icon: "book-open",
      rows: [
        // The budget and the table share one row: the budget belongs to the records, not the
        // feature switch, it is what this list costs, and it heads the row so the cost is read
        // before the entries.
        blockRow("Index budget", "", "lmsa-settings-section-block", (el) =>
          renderRecords(el, plugin, refs)
        ),
        blockRow("Add memory", "", "lmsa-settings-section-footer", (el) => {
          const addButtonEl = el.createEl("button", {
            cls: "lmsa-btn-add lmsa-ui-btn lmsa-ui-btn-primary",
            text: "Add memory",
          });
          addButtonEl.disabled = !plugin.settings.memoriesEnabled;
          addButtonEl.addEventListener("click", () => {
            // The footer row persists on its own and asks the records row only for the repaint, so
            // an add still lands if that row is torn down while the modal is open.
            const save = voidAsync(async (memory: Memory) => {
              try {
                await commitMemoryMutation(memoryStore(plugin), { kind: "add", memory });
              } finally {
                refs.syncRecords?.();
              }
            }, "Failed to save the memory.");
            new MemoryModal(plugin.app, null, plugin.settings.memories, save).open();
          });
          refs.setAddEnabled = (enabled) => {
            addButtonEl.disabled = !enabled;
          };
          return () => {
            refs.setAddEnabled = null;
          };
        }),
      ],
    },
  ];
}

/** The budget readout and the records table, the whole body of the "Stored memories" card. */
function renderRecords(
  el: HTMLElement,
  plugin: WritingAssistantChat,
  refs: MemoriesPageRefs
): () => void {
  const capacity = renderCapacityBar(el, () =>
    plugin.services.memoryService.estimateIndexTokens()
  );

  const listEl = el.createDiv({ cls: "lmsa-memory-list" });

  // The row awaiting delete confirmation, by name. Deleting is two-step in place,
  // the same shape the history drawer and the profile list use.
  let pendingDeleteName: string | null = null;

  /** Persist one mutation, then repaint the table and the capacity readout. */
  const commit = voidAsync(async (mutation: MemoryMutation) => {
    pendingDeleteName = null;
    try {
      await commitMemoryMutation(memoryStore(plugin), mutation);
    } finally {
      // Repaint from the store either way: after a rollback the rows must show
      // the persisted state, not the one the click implied.
      renderList();
      capacity.refresh();
    }
  }, "Failed to save the memory.");

  const renderList = () => {
    const { settings } = plugin;
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

  const syncRecords = () => {
    if (!plugin.settings.memoriesEnabled) pendingDeleteName = null;
    // The budget describes an index that is not delivered while the feature is
    // off, so it goes away with the table rather than quoting a phantom cost.
    capacity.wrapEl.toggleClass("lmsa-hidden", !plugin.settings.memoriesEnabled);
    // Nothing interactive is rendered while off, so the card needs no `inert`
    // and no scrim: the list simply is the message.
    renderList();
    capacity.refresh();
  };

  syncRecords();
  refs.syncRecords = syncRecords;
  return () => {
    refs.syncRecords = null;
  };
}

/** The persistence surface {@link commitMemoryMutation} writes through. */
function memoryStore(plugin: WritingAssistantChat) {
  const memoryService = plugin.services.memoryService;
  return {
    getMemories: () => plugin.settings.memories,
    setMemories: (next: Memory[]) => {
      plugin.settings.memories = next;
    },
    save: () => plugin.saveSettings(),
    invalidateAll: () => memoryService.invalidateAll(),
    invalidatePinsContaining: (name: string) => memoryService.invalidatePinsContaining(name),
  };
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
