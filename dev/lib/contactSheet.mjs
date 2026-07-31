// The contact sheet both development instruments write (RFC-0013 plan decision D10).
//
// `dev/visual` has written a versioned manifest and an inline-CSS, no-server, no-network contact
// sheet since the visual harness split, and it is already how this project's visual evidence is
// read. `dev/driver` writes the same kind of artifact about a different subject: a run of the
// real application rather than a render of static fixtures. Sharing the frame is what keeps the
// two reading as one instrument rather than two that happen to emit HTML.
//
// What is shared is the frame and the cards, not the layout. Each harness keeps the CSS that
// describes its own subject (families and themes there, steps and checkpoints here), because a
// stylesheet spliced out of many imported fragments is harder to read than the duplication it
// removes. The split is at the seam where the two genuinely agree: the document, the typography,
// the figure, and the responsive breakpoint.
//
// The extraction is gated: `dev/visual/out/index.html` must be byte-unchanged for an unchanged
// input manifest. A shared renderer that quietly restyles the harness the maintainer already
// reads would be a worse outcome than two renderers.

/** Shared by both sheets: the document frame, typography, and the intro line. */
export const SHEET_FRAME_CSS = `    :root {
      color-scheme: light dark;
      font-family: ui-sans-serif, system-ui, sans-serif;
      background: Canvas;
      color: CanvasText;
    }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 32px; }
    main { margin: 0 auto; max-width: 1800px; }
    h1, h2, h3, h4, p { margin-top: 0; }
    h1 { margin-bottom: 8px; }
    .intro { color: GrayText; margin-bottom: 32px; }`;

/**
 * Shared by both sheets: one captured image, and the placeholder that stands where an image is
 * absent.
 *
 * The placeholder is the load-bearing half. A sheet that omits what it could not capture reads
 * as complete, which is the failure both instruments exist to remove, so `.missing` is styled to
 * be seen rather than skipped past.
 */
export const SHEET_CARD_CSS = `    figure, .missing { margin: 0; min-width: 0; }
    figcaption, .missing {
      align-items: baseline;
      display: flex;
      gap: 12px;
      justify-content: space-between;
      margin-bottom: 6px;
      text-transform: capitalize;
    }
    figcaption span, .missing span { color: GrayText; font-size: 0.85rem; }
    img {
      background: ButtonFace;
      border: 1px solid GrayText;
      display: block;
      height: auto;
      max-width: 100%;
    }
    .missing {
      border: 1px dashed GrayText;
      min-height: 120px;
      padding: 12px;
    }`;

/** The one breakpoint both sheets use, with each harness's own collapses folded in. */
export function sheetResponsiveCss(extra) {
  return `    @media (max-width: 900px) {
      body { padding: 16px; }
${extra}
    }`;
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/**
 * One captured image, linked to itself so a click opens it full size.
 *
 * @param meta the short right-hand caption: pixel dimensions in the visual harness, the
 *   checkpoint a shot followed in the driver.
 */
export function figureMarkup({ label, meta, href, src, alt }) {
  return `<figure>
    <figcaption><strong>${escapeHtml(label)}</strong><span>${escapeHtml(meta)}</span></figcaption>
    <a href="${escapeHtml(href)}">
      <img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}">
    </a>
  </figure>`;
}

/**
 * The placeholder for something a sheet cannot show.
 *
 * @param tone an extra class for harnesses that distinguish kinds of absence. The driver marks a
 *   checkpoint that never arrived with `is-gap`, because a step that did not happen is a finding
 *   rather than a blank.
 */
export function missingMarkup({ label, note, tone }) {
  const className = tone ? `missing ${tone}` : "missing";
  return `<div class="${className}">
      <strong>${escapeHtml(label)}</strong><span>${escapeHtml(note)}</span>
    </div>`;
}

/**
 * The document both sheets are poured into: inline CSS, no server, no network.
 *
 * @param intro already-escaped inner HTML, because both harnesses put counts and emphasis in it.
 * @param css the full stylesheet, composed from the fragments above plus the harness's own.
 * @param body already-escaped section markup.
 */
export function sheetDocument({ title, heading, intro, css, body }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
${css}
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(heading)}</h1>
    <p class="intro">
      ${intro}
    </p>
    ${body}
  </main>
</body>
</html>
`;
}
