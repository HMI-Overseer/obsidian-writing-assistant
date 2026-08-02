import { SettingPage } from "obsidian";

/**
 * Renders a tab's content into the page container and optionally returns a teardown function.
 * Every `renderXxxTab` helper already matches this shape: four return a cleanup, five return void.
 */
export type TabPageRenderer = (
  container: HTMLElement,
  refresh: () => void
) => (() => void) | void;

/**
 * Adapts one imperative tab renderer to a settings sub-page.
 *
 * The renderers build their own DOM, so the declarative `control` vocabulary cannot express them.
 * A page hands each one a container and a refresh callback, unchanged in meaning from the callback
 * the tab used to pass. Cleanup is tracked here rather than on the tab because Obsidian calls
 * {@link hide} on navigate-away, tab switch, and settings-modal close.
 */
export class ImperativeTabPage extends SettingPage {
  private cleanup: (() => void) | null = null;

  constructor(
    title: string,
    slug: string,
    private readonly renderContent: TabPageRenderer
  ) {
    super();
    this.title = title;
    // The renderers' styling hangs off these two hooks: `lmsa-settings-root` carries the design
    // tokens and the form-control skin, and `lmsa-tab-<slug>` selects the per-tab accent. Obsidian
    // builds `rootEl` as its own `.vertical-tab-content`, the element that used to carry both.
    this.rootEl.addClasses(["lmsa-settings-root", `lmsa-tab-${slug}`]);
  }

  display(): void {
    this.runCleanup();
    this.containerEl.empty();
    const panel = this.containerEl.createDiv({ cls: "lmsa-settings-panel lmsa-ui-panel" });
    const content = panel.createDiv({ cls: "lmsa-settings-content" });
    const cleanup = this.renderContent(content, () => this.display());
    this.cleanup = typeof cleanup === "function" ? cleanup : null;
  }

  hide(): void {
    this.runCleanup();
  }

  private runCleanup(): void {
    this.cleanup?.();
    this.cleanup = null;
  }
}
