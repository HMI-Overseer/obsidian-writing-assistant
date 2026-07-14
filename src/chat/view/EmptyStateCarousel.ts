import { setIcon } from "obsidian";

/** Writing prompts shown in the empty state. Order is the slide order. */
const EMPTY_STATE_PROMPTS = [
  "Ask a question, paste a passage, or run a quick command on your draft.",
  "Select a line in your note and ask for a few ways to phrase it.",
  "Paste a paragraph and I'll tighten it without losing your voice.",
  "Describe where a scene is headed and we'll find the next line together.",
];

/** Auto-advance cadence. Slow on purpose: the empty state is ambient, not a call to action. */
const ADVANCE_INTERVAL_MS = 10_000;

/**
 * The empty-state writing-prompt carousel. Prompts slide horizontally on a slow auto-advance loop;
 * hovering reveals prev/next controls for manual navigation and pauses the auto-advance so a reader is
 * never carried off a prompt mid-read. Honors prefers-reduced-motion: no auto-advance and no slide
 * transition (manual nav still jumps between prompts). The controller builds all of its own DOM inside
 * the host (like ChatHistoryDrawer) and drives position through the `--lmsa-carousel-index` custom
 * property so the styling stays in CSS. destroy() clears the timer and listeners (from ChatView.onClose).
 */
export class EmptyStateCarousel {
  private index = 0;
  private timer: number | null = null;
  private readonly count = EMPTY_STATE_PROMPTS.length;
  private readonly reduceMotion: boolean;
  private readonly rootEl: HTMLElement;
  private readonly trackEl: HTMLElement;
  private readonly prevBtn: HTMLButtonElement;
  private readonly nextBtn: HTMLButtonElement;
  private readonly onPrev: () => void;
  private readonly onNext: () => void;
  private readonly onEnter: () => void;
  private readonly onLeave: () => void;

  constructor(hostEl: HTMLElement) {
    this.reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    this.rootEl = hostEl.createDiv({ cls: "lmsa-empty-carousel" });
    const viewportEl = this.rootEl.createDiv({ cls: "lmsa-empty-carousel-viewport" });
    this.trackEl = viewportEl.createDiv({ cls: "lmsa-empty-carousel-track" });
    for (const prompt of EMPTY_STATE_PROMPTS) {
      this.trackEl.createDiv({ cls: "lmsa-empty-carousel-slide", text: prompt });
    }

    this.prevBtn = this.rootEl.createEl("button", {
      cls: "lmsa-empty-carousel-nav lmsa-empty-carousel-nav--prev",
      attr: { "aria-label": "Previous prompt", type: "button" },
    });
    setIcon(this.prevBtn, "chevron-left");
    this.nextBtn = this.rootEl.createEl("button", {
      cls: "lmsa-empty-carousel-nav lmsa-empty-carousel-nav--next",
      attr: { "aria-label": "Next prompt", type: "button" },
    });
    setIcon(this.nextBtn, "chevron-right");

    this.onPrev = () => this.go(this.index - 1, true);
    this.onNext = () => this.go(this.index + 1, true);
    this.onEnter = () => this.stop();
    this.onLeave = () => this.start();

    this.prevBtn.addEventListener("click", this.onPrev);
    this.nextBtn.addEventListener("click", this.onNext);
    this.rootEl.addEventListener("mouseenter", this.onEnter);
    this.rootEl.addEventListener("mouseleave", this.onLeave);

    this.render();
    this.start();
  }

  /** Move to a (wrapped) index. `manual` restarts the clock so a click grants a full dwell on the pick. */
  private go(next: number, manual: boolean): void {
    this.index = ((next % this.count) + this.count) % this.count;
    this.render();
    if (manual) this.start();
  }

  private render(): void {
    this.trackEl.style.setProperty("--lmsa-carousel-index", String(this.index));
  }

  private start(): void {
    this.stop();
    if (this.reduceMotion) return;
    this.timer = window.setInterval(() => this.go(this.index + 1, false), ADVANCE_INTERVAL_MS);
  }

  private stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  destroy(): void {
    this.stop();
    this.prevBtn.removeEventListener("click", this.onPrev);
    this.nextBtn.removeEventListener("click", this.onNext);
    this.rootEl.removeEventListener("mouseenter", this.onEnter);
    this.rootEl.removeEventListener("mouseleave", this.onLeave);
  }
}
