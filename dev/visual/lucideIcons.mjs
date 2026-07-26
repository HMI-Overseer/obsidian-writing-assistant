// Real icon geometry for the visual harness, read out of the installed Obsidian.
//
// Obsidian draws every `setIcon()` glyph from a lucide table bundled in its `app.js`, wraps it in a
// fixed set of <svg> attributes, and tags it `class="svg-icon lucide-<name>"`. That class is
// load-bearing: `app.css` carries `svg.svg-icon { width/height: var(--icon-size); stroke-width:
// var(--icon-stroke) }` (18px / 1.75px by default) and the plugin's own CSS never sets stroke-width,
// so an icon without the class renders at the wrong weight everywhere it appears.
//
// Reproducing the glyphs by hand drifts from what the app draws, so the harness reads the same table
// the app reads. Like app.css, it lands in a gitignored cache and must not be committed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CACHE_DIR, extractObsidianFile } from "./obsidianInstall.mjs";

const CACHE = join(CACHE_DIR, "lucide.json");

// Each table entry is a list of element tuples whose leading integer is the element kind; the
// remaining slots are its attributes, in this order. Mirrors Obsidian's own element builder.
const ELEMENTS = {
  0: ["line", ["x1", "y1", "x2", "y2"]],
  1: ["circle", ["cx", "cy", "r"]],
  2: ["polyline", ["points"]],
  3: ["polygon", ["points"]],
  4: ["ellipse", ["cx", "cy", "rx", "ry"]],
  5: ["rect", ["x", "y", "width", "height", "rx", "ry", "transform"]],
  6: ["path", ["d"]],
};

// The <svg> attributes Obsidian puts on a lucide icon. width/height are always 24: the rendered
// size comes from the `svg.svg-icon` rule, never from these, which is why hardcoding a pixel size
// on the element (as a hand-written stand-in would) is wrong even when the number looks right.
const LUCIDE_SVG_ATTRS = {
  xmlns: "http://www.w3.org/2000/svg",
  width: 24,
  height: 24,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": 2,
  "stroke-linecap": "round",
  "stroke-linejoin": "round",
};

// Icons registered through `addIcon` (the provider brand marks) get only a viewBox; they are
// authored against 0 0 100 100 rather than lucide's 24.
const ADDED_ICON_VIEWBOX = "0 0 100 100";

// Reads the object literal that starts at `from`, tracking strings so a brace inside path data
// cannot end it early.
function objectLiteralAt(source, from) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let quote = "";
  let i = from;
  for (; i < source.length; i++) {
    const c = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === quote) inString = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      quote = c;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  // A data literal out of the local install, evaluated to avoid hand-rolling a JS object parser.
  return new Function(`return ${source.slice(from, i)}`)();
}

// Anchored on content rather than on the minified variable names, which change between releases.
function parseFromAppJs() {
  const js = extractObsidianFile("app.js");
  const tableAt = js.indexOf('{"a-arrow-down":');
  const aliasesAt = js.indexOf('{"create-new":"edit"');
  if (tableAt < 0 || aliasesAt < 0) {
    throw new Error(
      "Could not find the icon table in Obsidian's app.js. Its shape likely changed in this release; " +
        "re-anchor the lookups in dev/visual/lucideIcons.mjs.",
    );
  }
  return {
    icons: objectLiteralAt(js, tableAt),
    // Legacy name map applied before the table lookup: `pencil` draws lucide `edit-3`, `trash`
    // draws `trash-2`, `gear` draws `settings`. Resolving through it is what keeps the harness
    // drawing the glyph the app draws rather than the one the name suggests.
    aliases: objectLiteralAt(js, aliasesAt),
  };
}

function load() {
  if (existsSync(CACHE)) return JSON.parse(readFileSync(CACHE, "utf8"));
  const parsed = parseFromAppJs();
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE, JSON.stringify(parsed));
  return parsed;
}

const { icons, aliases } = load();

const attrs = (pairs) =>
  Object.entries(pairs)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}="${v}"`)
    .join("");

/** Resolves a `setIcon` name the way Obsidian does: legacy alias first, then the lucide table. */
export function resolveIconName(name) {
  return Object.prototype.hasOwnProperty.call(aliases, name) ? aliases[name] : name;
}

/**
 * The markup Obsidian's `setIcon(el, name)` produces, for any name the plugin passes.
 * Throws on an unknown name: a silently missing glyph is the failure this module exists to prevent.
 */
export function icon(name) {
  const resolved = resolveIconName(name);
  const parts = icons[resolved];
  if (!parts) {
    throw new Error(
      `Unknown icon "${name}"${resolved === name ? "" : ` (resolved to "${resolved}")`}. ` +
        "Use the same name the plugin passes to setIcon().",
    );
  }
  const children = parts
    .map(([kind, ...values]) => {
      const [tag, names] = ELEMENTS[kind];
      const pairs = {};
      names.forEach((attr, i) => {
        if (values[i] !== undefined && values[i] !== null) pairs[attr] = values[i];
      });
      return `<${tag}${attrs(pairs)}/>`;
    })
    .join("");
  return `<svg${attrs(LUCIDE_SVG_ATTRS)} class="svg-icon lucide-${resolved}">${children}</svg>`;
}

/**
 * The markup an `addIcon`-registered glyph produces. `content` is the registered inner markup,
 * verbatim from the plugin's own registration so the harness inherits any transform it applies.
 */
export function addedIcon(id, content) {
  return `<svg viewBox="${ADDED_ICON_VIEWBOX}" class="svg-icon ${id}">${content}</svg>`;
}
