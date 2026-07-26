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

## What comes from the installed Obsidian (not committed)

[`obsidianInstall.mjs`](./obsidianInstall.mjs) locates the local app and reads out of it into a
gitignored `dev/visual/.cache/`. All of it is **Obsidian's proprietary asset** and must not be committed
or redistributed:

- **`app.css`**, via [`appCss.mjs`](./appCss.mjs), for the cascade described above.
- **Lucide icon geometry**, via [`lucideIcons.mjs`](./lucideIcons.mjs). Obsidian draws every `setIcon()`
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

Read the component's render `.ts`, mirror the element/class structure into a new entry in `SURFACES`
(`shot` is the CSS selector to screenshot, `w` an optional stage width), and re-run. Use the icon names
the component passes to `setIcon()`; `I` in `surfaces.mjs` maps the surfaces' shorthand onto those names,
and an unknown name throws rather than rendering nothing.

`w` is the width of the **component under test**: the stage is `content-box`, so its own padding sits
outside that number. This matters because width-sensitive components read it: the composer footer is a
`@container`, and a surface 50px narrower than intended silently renders a different responsive variant.

The DOM is a faithful model of the live app, not the live DOM: Obsidian-chrome-heavy surfaces (settings
modal) are worth a final glance in the running app.

## Limitations

**Static appearance only:** no runtime state transitions, and reconstructed DOM can drift from the live
app if a component's markup changes. Keep surfaces in step with their render source.

**A different browser engine:** the harness renders in whatever Chromium is on this machine, while
Obsidian renders in the one its Electron bundles, and the two are usually several majors apart. CSS
newer than Obsidian's engine looks correct here and does nothing in the app. `render.mjs` prints both
versions on every run so the gap stays visible; when a surface hinges on a recent CSS feature, confirm it
in the running app.

**Obsidian's bundled fonts do not load:** its `@font-face` rules point at paths inside the asar. Low
impact in practice, because `--font-default` and `--font-monospace` both lead with `ui-sans-serif` /
`ui-monospace`, which resolve to the same system fonts in both engines.
