# Visual harness

A development preview aid: render plugin UI surfaces against **real Obsidian chrome**, in light and dark,
to PNGs, without launching Obsidian. Useful for eyeballing a component while iterating on its CSS and for
ad-hoc A/B comparison between two `styles.css` builds. It includes lightweight fixture contract
assertions, but it is not a browser interaction or pixel-diff test suite. It is a faster inner loop
than driving the live app.

## Usage

```
npm run build:css                 # produce the styles.css the harness renders
npm run visual                    # all surfaces, current build, both themes
npm run visual -- composer        # just one surface
npm run visual -- --themes dark   # dark only
npm run visual -- --baseline ../some-other-build/styles.css   # A/B a second build
```

Output lands in `dev/visual/out/` (gitignored):

```
out/
  index.html
  manifest.json
  current/
    composer/
      composer-light.png
      composer-dark.png
    ask/
    transcript/
    assistantTurn/
    review/
    settings/
    chrome/
  baseline/             # created when --baseline is used
    composer/
    ask/
    transcript/
    assistantTurn/
    review/
    settings/
    chrome/
```

The family directories mirror the modules under [`surfaces/`](./surfaces/). Current and baseline
builds use the same PNG names under separate directory trees.

Open [`out/index.html`](./out/index.html) directly from disk to review the contact sheet. It groups all
registered surfaces by family and places light and dark renders side by side. Each card shows the
surface ID, source path, and exact PNG dimensions. When baseline renders exist, each theme also places
the current and baseline builds side by side. The sheet has inline CSS, requires no server or network
access, and links each preview to its full-size PNG.

[`out/manifest.json`](./out/manifest.json) records one entry per rendered build, surface, and theme.
Each entry includes the surface ID, source path, PNG dimensions, family, build, theme, relative PNG
path, browser Chromium version, and Obsidian Chromium version.

A targeted render updates only the selected surface's PNGs and manifest entries. Existing entries for
other surfaces, themes, and builds remain intact, and the contact sheet is regenerated from the merged
manifest. This also applies to `--themes`, so a dark-only render preserves the last light render. A
targeted baseline run can leave intentional "Not rendered" placeholders for baseline combinations
that have not been captured yet.

## How it works

Each module in [`surfaces/`](./surfaces/) exports a plain object of surfaces that reconstruct component
DOM from render sources, using the class names emitted by the corresponding `.ts` files. The registry
merges those modules, rejects duplicate IDs, and requires every surface to declare a `source` path that
exists in the repository.

[`run.mjs`](./run.mjs) composes, per theme and build:

1. Obsidian's own `app.css` (so the plugin-vs-Obsidian cascade, native input/button chrome, and theme
   variables are real, the thing a plain browser render misses),
2. the build's `styles.css`,
3. harness-only scaffolding that neutralizes anchored/absolute positioning for element screenshots,

then screenshots the surface element in headless Chrome (your installed Chrome via Playwright's
`channel: "chrome"`, no browser download; falls back to a managed Chromium if none is found).

The harness is arranged as a small project:

```
dev/visual/
  run.mjs                 CLI parsing, orchestration, and reporting
  scaffold.mjs            harness-only CSS and Obsidian view wrappers
  lib/
    appCss.mjs            Obsidian app.css extraction
    browser.mjs           browser launch, viewport policy, and capture
    compose.mjs           document assembly
    iconAudit.mjs         setIcon() literal audit
    lucideIcons.mjs       installed Obsidian icon geometry
    obsidianInstall.mjs   local install discovery
    output.mjs            output paths, manifest merging, and contact sheet
    registry.mjs          surface loading and source validation
    surfaceAudit.mjs      production DOM and state invariants for fixture drift
  fixtures/
    ask.mjs
    chat.mjs
    images.mjs
    icons.mjs
    memory.mjs
    modals.mjs
    primitives.mjs
  surfaces/
    index.mjs
    ask.mjs
    assistantTurn.mjs
    chatStates.mjs
    chrome.mjs
    composer.mjs
    modals.mjs
    review.mjs
    settings.mjs
    settingsCoverage.mjs
    transcript.mjs
    turnMetadata.mjs
```

## Surface inventory

The registry currently contains 66 capture IDs. A full current render writes 132 PNGs, one light and
one dark image for every ID.

- `composer` (12): `composer`, `composerDragOver`, `footerRing`, `modelDropdown`,
  `knowledgePopover`, `reasoningMenu`, `postureMenu`, `contextPopover`,
  `contextPopoverSearch`, `toolPopover`, `overflowMenu`, `profilePopover`.
- `ask` (7): `askSingleIncomplete`, `askOtherReady`, `askMixedReady`, `askMixedNarrow`,
  `askMaximumContract`, `askMaximumContractNarrow`, `askMixedMinimized`.
- `transcript` (4): `emptyState`, `transcript`, `messageAttachments`, `bubbleToolbar`.
- `chatStates` (5): `collapsedChat`, `attachedImageChip`, `modelDropdownEmptyCatalog`,
  `modelDropdownNoSearchMatches`, `chatHeaderPressure`.
- `turnMetadata` (4): `ragSources`, `knowledgeGraphContext`, `usageBadge`,
  `inlineMessageEditor`.
- `chrome` (4): `historyDrawer`, `historyDrawerClosed`, `chatHeader`, `floatingButtons`.
- `settings` (14): `settingsGeneral`, `settingsProviders`, `settingsModelSelector`,
  `settingsBenchmark`, `settingsRag`, `settingsAdvanced`, `settingsMemories`,
  `settingsMemoriesOff`, `settingsKnowledgeGraph`, `settingsCommands`,
  `settingsCommandsEmpty`, `settingsVaultOps`, `settingsBenchmarkPopulated`, `settingsRail`.
- `assistantTurn` (7): `assistantTurnInterleaved`, `assistantTurnStates`,
  `assistantTurnActionPlacement`, `assistantTurnEditSession`, `assistantTurnNarrow`,
  `assistantTurnCaptureFailure`, `assistantTurnCaptureFailureNarrow`.
- `review` (5): `diffTimeline`, `vaultReviewTimeline`, `editReviewTimeline`,
  `editReviewDeclined`, `inlineDiff`.
- `modals` (4): `memoryModal`, `commandModal`, `apiKeysDisclaimerModal`,
  `imagePreviewModal`.

`settingsCoverage.mjs` contributes to the existing `settings` output family so settings surfaces stay
together in the manifest and contact sheet.

## What comes from the installed Obsidian (not committed)

[`lib/obsidianInstall.mjs`](./lib/obsidianInstall.mjs) locates the local app and reads out of it into a
gitignored `dev/visual/.cache/`. All of it is **Obsidian's proprietary asset** and must not be committed
or redistributed:

- **`app.css`**, via [`lib/appCss.mjs`](./lib/appCss.mjs), for the cascade described above.
- **Lucide icon geometry**, via [`lib/lucideIcons.mjs`](./lib/lucideIcons.mjs). Obsidian draws every `setIcon()`
  glyph from a table in its `app.js` and tags the result `class="svg-icon lucide-<name>"`. That class is
  load-bearing: `app.css` sizes and strokes icons through it (`var(--icon-size)` / `var(--icon-stroke)`,
  18px / 1.75px by default) and the plugin's own CSS never sets `stroke-width`. Reading the real table
  also picks up Obsidian's legacy name aliasing, which is not cosmetic: `setIcon(el, "pencil")` draws
  lucide `edit-3`, not lucide `pencil`.
- **The Chromium version** Obsidian's Electron bundles, scanned out of the binary. Advisory only, see
  below.

The asar is auto-located on Windows at `%APPDATA%/obsidian/obsidian-<version>.asar`; set
`OBSIDIAN_ASAR=<full path>` to override on other platforms or non-standard installs, and `OBSIDIAN_EXE`
for the executable.

## Adding a surface

Read the component's render `.ts`, then add an entry to the matching module in
[`surfaces/`](./surfaces/). Each entry requires:

- `source`: the repository-relative path to the component `.ts` file being reconstructed.
- `shot`: the CSS selector to screenshot.
- `html`: the reconstructed markup.
- `w`: an optional stage width.

[`lib/registry.mjs`](./lib/registry.mjs) throws when `source` is missing or does not exist. Add the
surface module to [`surfaces/index.mjs`](./surfaces/index.mjs) if it is new; the index throws on
duplicate IDs. [`lib/surfaceAudit.mjs`](./lib/surfaceAudit.mjs) checks shared production contracts,
including settings chrome, composer sibling order, provider rails, and tool timeline identifiers.

Use the icon names the component passes to `setIcon()`. `I` in
[`fixtures/icons.mjs`](./fixtures/icons.mjs) maps fixture shorthand onto those names, and an unknown
name throws rather than rendering nothing. Every visual run also audits literal `setIcon(el, "name")`
calls under `src/` against `ICON_NAMES` and reports missing names at startup.

`w` is the width of the **component under test**: the stage is `content-box`, so its own padding sits
outside that number. This matters because width-sensitive components read it: the composer footer is a
`@container`, and a surface 50px narrower than intended silently renders a different responsive variant.

The DOM is a faithful model of the live app, not the live DOM: Obsidian-chrome-heavy surfaces (settings
modal) are worth a final glance in the running app.

For modal work, first capture a live `outerHTML` dump of the opened Obsidian modal when the app is
available. Reconstruct both the component content and Obsidian's surrounding `modal-container`,
`modal-bg`, `modal`, `modal-close-button`, `modal-title`, and `modal-content` hierarchy. The current
`memoryModal`, `commandModal`, `apiKeysDisclaimerModal`, and `imagePreviewModal` fixtures were built
from component render sources and the installed `app.css` contract because no trustworthy live dump
was available. They remain provisional until compared with the running app.

After adding or changing surfaces:

1. Run the affected IDs first in both themes and open `out/index.html`.
2. Confirm each card is in the intended family, both images load, and its source and dimensions are
   present.
3. Read both images directly. For tall surfaces, inspect the whole card rather than only its top.
4. Run one targeted ID again and confirm unrelated PNG and manifest digests remain unchanged.
5. Run the full visual command, then lint and tests.

## Limitations

**Static appearance only:** no streaming, typing, hover, focus, or active-state coverage, and no
runtime state transitions. Reconstructed DOM can drift from the live app if a component's markup
changes. Keep surfaces in step with their render source.

**Animated captures are not byte-stable:** the composer, ask, and progress surfaces contain live CSS
animations or transitions. The harness does not freeze them or change screenshot timing, so unchanged
runs can capture different frames and produce different PNG hashes. Use successful rendering,
manifest completeness, contact-sheet inspection, and other structural checks as evidence for these
surfaces. Do not treat byte equality as a reliable gate until animation timing is addressed in a
separate harness-hardening change.

**A different browser engine:** the harness renders in whatever Chromium is on this machine, while
Obsidian renders in the one its Electron bundles, and the two are usually several majors apart. CSS
newer than Obsidian's engine looks correct here and does nothing in the app. `run.mjs` prints both
versions on every run so the gap stays visible; when a surface hinges on a recent CSS feature, confirm it
in the running app.

**Obsidian's bundled fonts do not load:** its `@font-face` rules point at paths inside the asar. Low
impact in practice, because `--font-default` and `--font-monospace` both lead with `ui-sans-serif` /
`ui-monospace`, which resolve to the same system fonts in both engines.
