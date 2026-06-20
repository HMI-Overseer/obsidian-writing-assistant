import { StateEffect, StateField, type Extension, type Range, type Text } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

/**
 * Maximum character drift tolerated between a hunk's snapshot offset and where
 * its text is found in the live document before the hunk is treated as no longer
 * anchorable. Mirrors the guard in {@link applyHunksLive}.
 */
const MAX_OFFSET_DRIFT = 500;

/**
 * A pending edit, flattened from a `DiffHunk` into just what the overlay needs.
 * The accept / reject callbacks are bound to the owning `EditReviewController`,
 * so the overlay never mutates the document itself.
 */
export interface InlineHunk {
  id: string;
  matchedText: string;
  replaceText: string;
  /** Snapshot offset where the match started, used to re-anchor against drift. */
  matchOffset: number;
  onAccept: () => void;
  onReject: () => void;
}

/** Replace the editor's pending inline hunks. */
export const setInlineHunks = StateEffect.define<InlineHunk[]>();
/** Remove all inline hunks from the editor. */
export const clearInlineHunks = StateEffect.define<null>();

interface InlineDiffState {
  hunks: InlineHunk[];
  deco: DecorationSet;
}

/**
 * Find the occurrence of `text` closest to `expected`, or null when absent or
 * drifted beyond {@link MAX_OFFSET_DRIFT}. Re-anchoring (rather than trusting the
 * raw snapshot offset) is what keeps the strike/insert over the right range as
 * the document moves underneath the proposal.
 */
function findAnchor(doc: string, hunk: InlineHunk): number | null {
  if (hunk.matchedText.length === 0) {
    return hunk.matchOffset >= 0 && hunk.matchOffset <= doc.length ? hunk.matchOffset : null;
  }

  let idx = doc.indexOf(hunk.matchedText);
  if (idx === -1) return null;

  let best = idx;
  let bestDist = Math.abs(idx - hunk.matchOffset);
  while ((idx = doc.indexOf(hunk.matchedText, idx + 1)) !== -1) {
    const dist = Math.abs(idx - hunk.matchOffset);
    if (dist < bestDist) {
      best = idx;
      bestDist = dist;
    }
  }

  if (hunk.matchOffset >= 0 && bestDist > MAX_OFFSET_DRIFT) return null;
  return best;
}

/**
 * A block widget rendered on its own line beneath the struck range: the proposed
 * replacement (which may span multiple lines) plus inline accept / reject
 * controls. Block layout keeps multi-line replacements readable rather than
 * cramming them inline after the original text.
 */
class InlineReplacementWidget extends WidgetType {
  constructor(private readonly hunk: InlineHunk) {
    super();
  }

  eq(other: InlineReplacementWidget): boolean {
    return other.hunk.id === this.hunk.id && other.hunk.replaceText === this.hunk.replaceText;
  }

  toDOM(): HTMLElement {
    const block = document.createElement("div");
    block.addClass("lmsa-inline-diff-block");

    const added = block.createDiv({ cls: "lmsa-inline-diff-added" });
    added.setText(this.hunk.replaceText);

    const actions = block.createDiv({ cls: "lmsa-inline-diff-actions" });
    this.addButton(actions, "Accept", "lmsa-inline-diff-btn--accept", this.hunk.onAccept);
    this.addButton(actions, "Reject", "lmsa-inline-diff-btn--reject", this.hunk.onReject);

    return block;
  }

  private addButton(parent: HTMLElement, label: string, cls: string, onClick: () => void): void {
    const btn = parent.createEl("button", {
      cls: `lmsa-inline-diff-btn ${cls}`,
      attr: { "aria-label": `${label} change`, type: "button" },
      text: label,
    });
    // mousedown + preventDefault so the click doesn't move the editor selection
    // or steal focus before the handler runs.
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
  }

  /** Let the widget's own DOM handle clicks rather than the editor. */
  ignoreEvent(): boolean {
    return true;
  }
}

function buildDecorations(hunks: InlineHunk[], doc: Text): DecorationSet {
  const docStr = doc.toString();
  const ranges: Range<Decoration>[] = [];

  for (const hunk of hunks) {
    const at = findAnchor(docStr, hunk);
    if (at === null) continue;
    const end = at + hunk.matchedText.length;

    if (end > at) {
      ranges.push(Decoration.mark({ class: "lmsa-inline-diff-removed" }).range(at, end));
    }

    // Block widgets must sit on a line boundary: anchor it after the line
    // holding the last matched character (or the insertion point for a pure add).
    const lineRefPos = end > at ? end - 1 : at;
    const blockPos = doc.lineAt(Math.min(lineRefPos, doc.length)).to;
    ranges.push(
      Decoration.widget({
        widget: new InlineReplacementWidget(hunk),
        block: true,
        side: 1,
      }).range(blockPos)
    );
  }

  // sort=true lets CodeMirror order the mixed mark/block ranges correctly.
  return Decoration.set(ranges, true);
}

const inlineDiffField = StateField.define<InlineDiffState>({
  create() {
    return { hunks: [], deco: Decoration.none };
  },
  update(value, tr) {
    let hunks = value.hunks;
    let replaced = false;

    for (const effect of tr.effects) {
      if (effect.is(setInlineHunks)) {
        hunks = effect.value;
        replaced = true;
      } else if (effect.is(clearInlineHunks)) {
        hunks = [];
        replaced = true;
      }
    }

    // Rebuild (re-anchor) whenever the hunk set is replaced or the document
    // moves underneath an active overlay. Note-scale documents make a full
    // rebuild per change cheap enough; batching is a future optimization.
    if (replaced || (tr.docChanged && hunks.length > 0)) {
      return { hunks, deco: buildDecorations(hunks, tr.state.doc) };
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field, (v) => v.deco),
});

/** The editor extension to register once via `Plugin.registerEditorExtension`. */
export const inlineDiffExtension: Extension = [inlineDiffField];
