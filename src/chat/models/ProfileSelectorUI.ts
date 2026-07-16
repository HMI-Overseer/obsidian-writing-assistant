import { setIcon } from "obsidian";
import type { ProviderOption, ProviderProfile } from "../../shared/types";

export type ProfileSelectorCallbacks = {
  getProfilesForProvider: (provider: ProviderOption) => ProviderProfile[];
  onProfileSelect: (profileId: string, provider: ProviderOption) => Promise<void>;
  onProfileCreate: (name: string, provider: ProviderOption) => Promise<ProviderProfile>;
  onProfileDelete: (profileId: string) => Promise<void>;
};

/**
 * Profile selector with create/delete actions. The trigger reuses the chat
 * header's model selector look: a subtle text label with a chevron that
 * expands into a dropdown of profiles.
 */
export class ProfileSelectorUI {
  private deleteBtn: HTMLButtonElement | null = null;
  private onRerender: (() => void) | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly callbacks: ProfileSelectorCallbacks,
  ) {}

  /** Call after construction to allow re-rendering of the parent on profile changes. */
  setRerenderCallback(fn: () => void): void {
    this.onRerender = fn;
  }

  render(provider: ProviderOption, activeProfile: ProviderProfile): void {
    const row = this.container.createDiv({ cls: "lmsa-profile-selector-row" });

    const trigger = row.createDiv({ cls: "lmsa-profile-trigger" });
    trigger.createSpan({ cls: "lmsa-profile-trigger-label", text: activeProfile.name });
    const chevron = trigger.createSpan({ cls: "lmsa-profile-trigger-chevron" });
    setIcon(chevron, "chevron-down");

    const menu = row.createDiv({ cls: "lmsa-profile-menu lmsa-hidden" });
    this.renderMenuItems(menu, provider, activeProfile);

    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = menu.hasClass("lmsa-hidden");
      menu.toggleClass("lmsa-hidden", !open);
      trigger.toggleClass("is-open", open);
    });

    const actions = row.createDiv({ cls: "lmsa-profile-selector-actions" });

    const createBtn = actions.createEl("button", {
      cls: "lmsa-profile-action-btn",
      attr: { "aria-label": "Create profile" },
    });
    setIcon(createBtn, "plus");

    createBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.showCreateProfileInline(row, provider);
    });

    this.deleteBtn = actions.createEl("button", {
      cls: "lmsa-profile-action-btn lmsa-profile-action-btn--danger",
      attr: { "aria-label": "Delete profile" },
    });
    setIcon(this.deleteBtn, "trash-2");
    this.deleteBtn.disabled = activeProfile.isDefault;
    if (activeProfile.isDefault) {
      this.deleteBtn.addClass("is-disabled");
    }

    this.deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      // Deleting a profile discards a hand-tuned system prompt and params with no
      // undo, so gate it behind the same lightweight two-step confirm the history
      // drawer and create-profile flows use.
      this.showDeleteConfirmInline(row, activeProfile.id);
    });
  }

  private renderMenuItems(
    menu: HTMLElement,
    provider: ProviderOption,
    activeProfile: ProviderProfile,
  ): void {
    for (const profile of this.callbacks.getProfilesForProvider(provider)) {
      const item = menu.createDiv({ cls: "lmsa-profile-menu-item" });
      const check = item.createSpan({ cls: "lmsa-profile-menu-check" });
      if (profile.id === activeProfile.id) {
        item.addClass("is-active");
        setIcon(check, "check");
      }
      item.createSpan({ cls: "lmsa-profile-menu-name", text: profile.name });

      item.addEventListener("click", (e) => {
        e.stopPropagation();
        if (profile.id === activeProfile.id) {
          menu.addClass("lmsa-hidden");
          return;
        }
        void this.callbacks.onProfileSelect(profile.id, provider).then(() => {
          this.onRerender?.();
        });
      });
    }
  }

  private showDeleteConfirmInline(row: HTMLElement, profileId: string): void {
    const existing = row.parentElement?.querySelector(".lmsa-profile-delete-inline");
    if (existing) return;

    const inline = row.insertAdjacentElement(
      "afterend",
      row.ownerDocument.createElement("div"),
    ) as HTMLElement;
    inline.className = "lmsa-profile-delete-inline";

    inline.createSpan({
      cls: "lmsa-profile-delete-prompt",
      text: "Delete this profile?",
    });

    const confirmBtn = inline.createEl("button", {
      cls: "lmsa-ui-compact-btn lmsa-ui-compact-btn-danger",
      text: "Delete",
    });

    const cancelBtn = inline.createEl("button", {
      cls: "lmsa-ui-compact-btn lmsa-ui-compact-btn-secondary",
      text: "Cancel",
    });

    confirmBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.callbacks.onProfileDelete(profileId).then(() => {
        inline.remove();
        this.onRerender?.();
      });
    });

    cancelBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      inline.remove();
    });
  }

  private showCreateProfileInline(row: HTMLElement, provider: ProviderOption): void {
    const existing = row.parentElement?.querySelector(".lmsa-profile-create-inline");
    if (existing) return;

    const inline = row.insertAdjacentElement(
      "afterend",
      row.ownerDocument.createElement("div"),
    ) as HTMLElement;
    inline.className = "lmsa-profile-create-inline";

    const input = inline.createEl("input", {
      cls: "lmsa-profile-create-input",
      attr: { type: "text", placeholder: "Profile name..." },
    });

    const confirmBtn = inline.createEl("button", {
      cls: "lmsa-profile-action-btn",
      attr: { "aria-label": "Confirm" },
    });
    setIcon(confirmBtn, "check");

    const cancelBtn = inline.createEl("button", {
      cls: "lmsa-profile-action-btn",
      attr: { "aria-label": "Cancel" },
    });
    setIcon(cancelBtn, "x");

    input.focus();

    const doCreate = (): void => {
      const name = input.value.trim();
      if (!name) {
        inline.remove();
        return;
      }
      void this.callbacks.onProfileCreate(name, provider).then(() => {
        inline.remove();
        this.onRerender?.();
      });
    };

    confirmBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      doCreate();
    });

    cancelBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      inline.remove();
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        doCreate();
      } else if (e.key === "Escape") {
        inline.remove();
      }
    });
  }
}
