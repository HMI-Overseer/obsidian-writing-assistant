import { setIcon } from "obsidian";
import type { ProviderOption, ProviderProfile } from "../../shared/types";

export type ProfileSelectorCallbacks = {
  getProfilesForProvider: (provider: ProviderOption) => ProviderProfile[];
  onProfileSelect: (profileId: string) => Promise<void>;
  onProfileCreate: (name: string, provider: ProviderOption) => Promise<ProviderProfile>;
  onProfileDelete: (profileId: string) => Promise<void>;
};

/**
 * Profile selector dropdown with create/delete actions.
 */
export class ProfileSelectorUI {
  private selectEl: HTMLSelectElement | null = null;
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

    this.selectEl = row.createEl("select", {
      cls: "lmsa-profile-selector-select",
    }) as HTMLSelectElement;

    const profiles = this.callbacks.getProfilesForProvider(provider);
    for (const p of profiles) {
      this.selectEl.createEl("option", {
        text: p.name,
        attr: { value: p.id },
      });
    }
    this.selectEl.value = activeProfile.id;

    this.selectEl.addEventListener("change", () => {
      if (!this.selectEl) return;
      void this.callbacks.onProfileSelect(this.selectEl.value).then(() => {
        this.onRerender?.();
      });
    });

    const createBtn = row.createEl("button", {
      cls: "lmsa-profile-action-btn",
      attr: { "aria-label": "Create profile" },
    }) as HTMLButtonElement;
    setIcon(createBtn, "plus");

    createBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.showCreateProfileInline(row, provider);
    });

    this.deleteBtn = row.createEl("button", {
      cls: "lmsa-profile-action-btn lmsa-profile-action-btn--danger",
      attr: { "aria-label": "Delete profile" },
    }) as HTMLButtonElement;
    setIcon(this.deleteBtn, "trash-2");
    this.deleteBtn.disabled = activeProfile.isDefault;
    if (activeProfile.isDefault) {
      this.deleteBtn.addClass("is-disabled");
    }

    this.deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!this.selectEl) return;
      const selectedId = this.selectEl.value;
      void this.callbacks.onProfileDelete(selectedId).then(() => {
        this.onRerender?.();
      });
    });
  }

  private showCreateProfileInline(row: HTMLElement, provider: ProviderOption): void {
    const existing = row.parentElement?.querySelector(".lmsa-profile-create-inline");
    if (existing) return;

    const inline = row.insertAdjacentElement(
      "afterend",
      document.createElement("div"),
    ) as HTMLElement;
    inline.className = "lmsa-profile-create-inline";

    const input = inline.createEl("input", {
      cls: "lmsa-profile-create-input",
      attr: { type: "text", placeholder: "Profile name..." },
    }) as HTMLInputElement;

    const confirmBtn = inline.createEl("button", {
      cls: "lmsa-profile-action-btn",
      attr: { "aria-label": "Confirm" },
    }) as HTMLButtonElement;
    setIcon(confirmBtn, "check");

    const cancelBtn = inline.createEl("button", {
      cls: "lmsa-profile-action-btn",
      attr: { "aria-label": "Cancel" },
    }) as HTMLButtonElement;
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
