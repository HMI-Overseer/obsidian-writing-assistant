import type { SettingDefinitionRender } from "obsidian";
import type WritingAssistantChat from "../main";
import type { Gate, VaultOpPolicy } from "../vault-ops/gateway";
import { DEFAULT_VAULT_OP_POLICY } from "../vault-ops/gateway";
import type { SettingsSection } from "./definitions/sections";
import { settingRow } from "./definitions/sections";
import { formatLineList, parseLineList } from "./definitions/lineList";

/**
 * "Vault operations" settings (ADR-0023), the approval policy surface for the
 * write channel. One Auto-apply/Ask/Deny control per operation class, a scope
 * list of folder prefixes eligible for auto-apply, and the `maxAutoOps` circuit
 * breaker.
 *
 * Defaults are deliberately timid: every class is "Ask", so a fresh install
 * never writes without a click. A user who wants an autonomous drafting loop
 * sets a class to "Auto-apply" (optionally scoped to a folder). Reversibility
 * (undo via inverses), scope confinement, and the circuit breaker are the
 * defense-in-depth behind any "Auto-apply" choice.
 */
export function vaultOpsTabSections(plugin: WritingAssistantChat): SettingsSection[] {
  return [
    {
      name: "Approvals",
      desc: "Decide how each kind of vault operation is handled. Deny removes the tool entirely; Ask waits for your review; Auto-apply applies it without a click, but every operation is still shown and can be undone.",
      icon: "shield-check",
      rows: [
        gateRow(
          plugin, "Create file",
          "Writing a brand-new note at a path that doesn't exist yet.",
          "create"
        ),
        gateRow(
          plugin, "Overwrite file",
          "Replacing the entire contents of an existing note. Targeted prose changes go through document edits instead.",
          "overwrite"
        ),
        gateRow(
          plugin, "Move or rename",
          "Moving or renaming a note. Wikilinks and backlinks are rewritten automatically.",
          "move"
        ),
        gateRow(
          plugin, "Trash file",
          "Sending a note to trash (honoring your deleted-files preference). Files only.",
          "trash"
        ),
        gateRow(
          plugin, "Create folder",
          "Creating a folder. Idempotent, does nothing if it already exists.",
          "createDir"
        ),
        gateRow(
          plugin, "Edit document",
          "Targeted in-document changes and frontmatter updates (propose_edit, update_frontmatter). Ask shows the diff and waits; Auto-apply lands the edit without a click, even on a note you don't have open.",
          "edit"
        ),
      ],
    },
    {
      name: "Auto-apply limits",
      desc: "Bound what auto-applied operations can touch and how many can run before the rest fall back to Ask.",
      icon: "git-fork",
      rows: [
        settingRow(
          "Auto-apply scopes",
          "Folder prefixes eligible for auto-apply (one per line). When set, operations outside these folders fall back to manual review. Leave empty to allow auto-apply anywhere.",
          (item) => {
            item.addTextArea((textarea) => {
              textarea.inputEl.rows = 4;
              textarea.setValue(formatLineList(plugin.settings.vaultOpPolicy.scopes));
              textarea.setPlaceholder("e.g. drafts/ai");
              textarea.onChange(async (value) => {
                plugin.settings.vaultOpPolicy.scopes = parseLineList(value);
                await plugin.saveSettings();
              });
            });
          }
        ),
        settingRow(
          "Max auto operations per turn",
          `Circuit breaker for the per-class auto-apply policy: once this many operations auto-apply in a single turn, the rest fall back to Ask. "Edit automatically" is unbounded and ignores this. Default: ${DEFAULT_VAULT_OP_POLICY.maxAutoOps}.`,
          (item) => {
            item.addText((text) => {
              text.setPlaceholder(String(DEFAULT_VAULT_OP_POLICY.maxAutoOps));
              text.setValue(String(plugin.settings.vaultOpPolicy.maxAutoOps));
              text.onChange(async (value) => {
                const parsed = parseInt(value, 10);
                if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= 1000) {
                  plugin.settings.vaultOpPolicy.maxAutoOps = parsed;
                  await plugin.saveSettings();
                }
              });
            });
          }
        ),
      ],
    },
  ];
}

type GateClass = keyof Pick<VaultOpPolicy, "create" | "overwrite" | "move" | "trash" | "createDir" | "edit">;

const GATE_OPTIONS: ReadonlyArray<{ value: Gate; label: string }> = [
  { value: "ask", label: "Ask" },
  { value: "auto", label: "Auto-apply" },
  { value: "deny", label: "Deny" },
];

/** One operation class's gate. The six differ only in name, description, and key. */
function gateRow(
  plugin: WritingAssistantChat,
  name: string,
  desc: string,
  key: GateClass,
): SettingDefinitionRender {
  return settingRow(name, desc, (item) => {
    item.addDropdown((dropdown) => {
      for (const opt of GATE_OPTIONS) dropdown.addOption(opt.value, opt.label);
      dropdown.setValue(plugin.settings.vaultOpPolicy[key]);
      dropdown.onChange(async (value) => {
        plugin.settings.vaultOpPolicy[key] = value as Gate;
        await plugin.saveSettings();
      });
    });
  });
}
