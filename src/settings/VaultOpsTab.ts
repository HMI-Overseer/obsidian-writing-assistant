import type WritingAssistantChat from "../main";
import type { Gate, VaultOpPolicy } from "../vault-ops/gateway";
import { DEFAULT_VAULT_OP_POLICY } from "../vault-ops/gateway";
import { createSettingsSection, SettingItem } from "./ui";

/**
 * "Vault operations" settings (ADR-0003), the approval policy surface for the
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
export function renderVaultOpsTab(container: HTMLElement, plugin: WritingAssistantChat): void {
  const policy = plugin.settings.vaultOpPolicy;

  const approvals = createSettingsSection(
    container,
    "Approvals",
    "Decide how each kind of vault operation is handled. Deny removes the tool entirely; Ask waits for your review; Auto-apply applies it without a click, but every operation is still shown and can be undone.",
    { icon: "shield-check" }
  );

  renderGateSetting(
    approvals.bodyEl, plugin, "Create file",
    "Writing a brand-new note at a path that doesn't exist yet.",
    "create"
  );
  renderGateSetting(
    approvals.bodyEl, plugin, "Overwrite file",
    "Replacing the entire contents of an existing note. Targeted prose changes go through document edits instead.",
    "overwrite"
  );
  renderGateSetting(
    approvals.bodyEl, plugin, "Move or rename",
    "Moving or renaming a note. Wikilinks and backlinks are rewritten automatically.",
    "move"
  );
  renderGateSetting(
    approvals.bodyEl, plugin, "Trash file",
    "Sending a note to trash (honoring your deleted-files preference). Files only.",
    "trash"
  );
  renderGateSetting(
    approvals.bodyEl, plugin, "Create folder",
    "Creating a folder. Idempotent, does nothing if it already exists.",
    "createDir"
  );
  renderGateSetting(
    approvals.bodyEl, plugin, "Edit document",
    "Targeted in-document changes and frontmatter updates (propose_edit, update_frontmatter). Ask shows the diff and waits; Auto-apply lands the edit without a click, even on a note you don't have open.",
    "edit"
  );

  const limits = createSettingsSection(
    container,
    "Auto-apply limits",
    "Bound what auto-applied operations can touch and how many can run before the rest fall back to Ask.",
    { icon: "git-fork" }
  );

  new SettingItem(limits.bodyEl)
    .setName("Auto-apply scopes")
    .setDesc(
      "Folder prefixes eligible for auto-apply (one per line). When set, operations outside these folders fall back to manual review. Leave empty to allow auto-apply anywhere."
    )
    .addTextArea((textarea) => {
      textarea.inputEl.rows = 4;
      textarea.setValue(policy.scopes.join("\n"));
      textarea.setPlaceholder("e.g. drafts/ai");
      textarea.onChange(async (value) => {
        policy.scopes = value
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
        await plugin.saveSettings();
      });
    });

  new SettingItem(limits.bodyEl)
    .setName("Max auto operations per turn")
    .setDesc(
      `Circuit breaker for the per-class auto-apply policy: once this many operations auto-apply in a single turn, the rest fall back to Ask. "Edit automatically" is unbounded and ignores this. Default: ${DEFAULT_VAULT_OP_POLICY.maxAutoOps}.`
    )
    .addText((text) => {
      text.setPlaceholder(String(DEFAULT_VAULT_OP_POLICY.maxAutoOps));
      text.setValue(String(policy.maxAutoOps));
      text.onChange(async (value) => {
        const parsed = parseInt(value, 10);
        if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= 1000) {
          policy.maxAutoOps = parsed;
          await plugin.saveSettings();
        }
      });
    });
}

type GateClass = keyof Pick<VaultOpPolicy, "create" | "overwrite" | "move" | "trash" | "createDir" | "edit">;

const GATE_OPTIONS: ReadonlyArray<{ value: Gate; label: string }> = [
  { value: "ask", label: "Ask" },
  { value: "auto", label: "Auto-apply" },
  { value: "deny", label: "Deny" },
];

function renderGateSetting(
  container: HTMLElement,
  plugin: WritingAssistantChat,
  name: string,
  desc: string,
  key: GateClass,
): void {
  new SettingItem(container)
    .setName(name)
    .setDesc(desc)
    .addDropdown((dropdown) => {
      for (const opt of GATE_OPTIONS) dropdown.addOption(opt.value, opt.label);
      dropdown.setValue(plugin.settings.vaultOpPolicy[key]);
      dropdown.onChange(async (value) => {
        plugin.settings.vaultOpPolicy[key] = value as Gate;
        await plugin.saveSettings();
      });
    });
}
