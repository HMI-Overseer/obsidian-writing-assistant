# Visual harness

A development preview aid: render plugin UI surfaces against **real Obsidian chrome**, in light and dark,
to PNGs, without launching Obsidian. Useful for eyeballing a component while iterating on its CSS and for
ad-hoc A/B comparison between two `styles.css` builds. It is **not** an automated test suite (no
assertions, no CI gate); it is a faster inner loop than driving the live app.

## Usage

```
npm run build:css                 # produce the styles.css the harness renders
npm run visual                    # all surfaces, current build, both themes -> dev/visual/out/
npm run visual -- composer        # just one surface
npm run visual -- --themes dark   # dark only
npm run visual -- --baseline ../some-other-build/styles.css   # A/B a second build (…-baseline.png)
```

Output PNGs land in `dev/visual/out/` (gitignored).

## How it works

Each surface in [`surfaces.mjs`](./surfaces.mjs) reconstructs a component's DOM from its render source
(the class names the `.ts` emits). [`render.mjs`](./render.mjs) composes, per theme and build:

1. Obsidian's own `app.css` (so the plugin-vs-Obsidian cascade, native input/button chrome, and theme
   variables are real, the thing a plain browser render misses),
2. the build's `styles.css`,
3. harness-only scaffolding that neutralizes anchored/absolute positioning for element screenshots,

then screenshots the surface element in headless Chrome (your installed Chrome via Playwright's
`channel: "chrome"`, no browser download; falls back to a managed Chromium if none is found).

## Obsidian app.css (not committed)

The harness needs Obsidian's `app.css`, which is **Obsidian's proprietary asset**. It is extracted from
your locally installed app into `dev/visual/.cache/app.css` (gitignored) on first run and must not be
committed or redistributed. Auto-located on Windows at `%APPDATA%/obsidian/obsidian-<version>.asar`; set
`OBSIDIAN_ASAR=<full path to the asar>` to override on other platforms or non-standard installs.

## Adding a surface

Read the component's render `.ts`, mirror the element/class structure into a new entry in `SURFACES`
(`shot` is the CSS selector to screenshot, `w` an optional stage width), and re-run. The DOM is a faithful
model of the live app, not the live DOM: Obsidian-chrome-heavy surfaces (settings modal) are worth a final
glance in the running app.

## Limitation

Static appearance only: no runtime state transitions, and reconstructed DOM can drift from the live app if
a component's markup changes. Keep surfaces in step with their render source.
