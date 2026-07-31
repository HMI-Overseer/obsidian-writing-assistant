import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import {
  escapeHtml,
  figureMarkup,
  missingMarkup,
  sheetDocument,
  sheetResponsiveCss,
  SHEET_CARD_CSS,
  SHEET_FRAME_CSS,
} from "../../lib/contactSheet.mjs";

const MANIFEST_VERSION = 1;
const BUILD_ORDER = ["current", "baseline"];
const THEME_ORDER = ["light", "dark"];

function renderKey(render) {
  return `${render.id}\0${render.build}\0${render.theme}`;
}

function manifestPath(outDir) {
  return join(outDir, "manifest.json");
}

function readManifest(outDir) {
  const path = manifestPath(outDir);
  if (!existsSync(path)) {
    return { version: MANIFEST_VERSION, renders: [] };
  }

  try {
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    if (manifest.version !== MANIFEST_VERSION || !Array.isArray(manifest.renders)) {
      return { version: MANIFEST_VERSION, renders: [] };
    }
    return manifest;
  } catch {
    return { version: MANIFEST_VERSION, renders: [] };
  }
}

function compareByOrder(value, other, order) {
  const valueIndex = order.indexOf(value);
  const otherIndex = order.indexOf(other);
  return (
    (valueIndex < 0 ? order.length : valueIndex) -
    (otherIndex < 0 ? order.length : otherIndex)
  );
}

function sortRenders(renders, surfaces, familyById) {
  const surfaceOrder = Object.keys(surfaces);
  const familyOrder = [...new Set(surfaceOrder.map((id) => familyById[id]))];

  return renders.sort((left, right) => {
    const familyDifference = compareByOrder(
      familyById[left.id],
      familyById[right.id],
      familyOrder,
    );
    if (familyDifference !== 0) return familyDifference;

    const surfaceDifference = compareByOrder(left.id, right.id, surfaceOrder);
    if (surfaceDifference !== 0) return surfaceDifference;

    const buildDifference = compareByOrder(left.build, right.build, BUILD_ORDER);
    if (buildDifference !== 0) return buildDifference;

    return compareByOrder(left.theme, right.theme, THEME_ORDER);
  });
}

function mergeRenders(existing, updates, surfaces, familyById) {
  const byKey = new Map(existing.map((render) => [renderKey(render), render]));
  for (const render of updates) {
    byKey.set(renderKey(render), render);
  }
  return sortRenders([...byKey.values()], surfaces, familyById);
}

function imageMarkup(entry, label) {
  if (!entry) {
    return missingMarkup({ label, note: "Not rendered" });
  }

  return figureMarkup({
    label,
    meta: `${entry.dimensions.width} x ${entry.dimensions.height} px`,
    href: entry.path,
    src: entry.path,
    alt: `${entry.id}, ${entry.theme}, ${entry.build}`,
  });
}

function themeMarkup(id, theme, builds, renderByKey) {
  const images = builds
    .map((build) =>
      imageMarkup(renderByKey.get(`${id}\0${build}\0${theme}`), build),
    )
    .join("");

  return `<div class="theme">
    <h4>${escapeHtml(theme)}</h4>
    <div class="builds">${images}</div>
  </div>`;
}

function surfaceMarkup(id, surface, builds, renderByKey) {
  const themes = THEME_ORDER.map((theme) =>
    themeMarkup(id, theme, builds, renderByKey),
  ).join("");

  return `<article class="surface">
    <header>
      <h3>${escapeHtml(id)}</h3>
      <code>${escapeHtml(surface.source)}</code>
    </header>
    <div class="themes">${themes}</div>
  </article>`;
}

function familyMarkup(family, ids, surfaces, builds, renderByKey) {
  const cards = ids
    .map((id) => surfaceMarkup(id, surfaces[id], builds, renderByKey))
    .join("");
  return `<section class="family" data-family="${escapeHtml(family)}">
    <h2>${escapeHtml(family)}</h2>
    ${cards}
  </section>`;
}

/** This harness's own subject: families, surfaces, and the theme pair beside each other. */
function surfaceCss(builds) {
  return `    .family { margin-bottom: 48px; }
    .family > h2 { border-bottom: 2px solid GrayText; padding-bottom: 8px; }
    .surface {
      border: 1px solid GrayText;
      border-radius: 8px;
      margin: 20px 0;
      overflow: hidden;
    }
    .surface > header { border-bottom: 1px solid GrayText; padding: 16px; }
    .surface h3 { margin-bottom: 6px; }
    code { color: GrayText; overflow-wrap: anywhere; }
    .themes { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .theme { min-width: 0; padding: 16px; }
    .theme + .theme { border-left: 1px solid GrayText; }
    .theme h4 { text-transform: capitalize; }
    .builds {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(${builds.length}, minmax(0, 1fr));
    }`;
}

const RESPONSIVE_CSS = sheetResponsiveCss(`      .themes { grid-template-columns: 1fr; }
      .theme + .theme { border-left: 0; border-top: 1px solid GrayText; }
      .builds { grid-template-columns: 1fr; }`);

function contactSheet(manifest, surfaces, familyById) {
  const renderByKey = new Map(
    manifest.renders.map((render) => [renderKey(render), render]),
  );
  const hasBaseline = manifest.renders.some((render) => render.build === "baseline");
  const builds = hasBaseline ? BUILD_ORDER : ["current"];
  const familyOrder = [...new Set(Object.values(familyById))];
  const content = familyOrder
    .map((family) => {
      const ids = Object.keys(surfaces).filter((id) => familyById[id] === family);
      return familyMarkup(family, ids, surfaces, builds, renderByKey);
    })
    .join("");

  return sheetDocument({
    title: "Visual harness contact sheet",
    heading: "Visual harness contact sheet",
    intro: `${Object.keys(surfaces).length} registered surfaces, grouped by family.
      Light and dark renders are shown side by side.`,
    css: [SHEET_FRAME_CSS, surfaceCss(builds), SHEET_CARD_CSS, RESPONSIVE_CSS].join("\n"),
    body: content,
  });
}

export function renderOutputPath(build, family, id, theme) {
  return posix.join(build, family, `${id}-${theme}.png`);
}

export function updateOutput(outDir, updates, surfaces, familyById) {
  const existing = readManifest(outDir);
  const manifest = {
    version: MANIFEST_VERSION,
    renders: mergeRenders(existing.renders, updates, surfaces, familyById),
  };
  writeFileSync(manifestPath(outDir), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    join(outDir, "index.html"),
    contactSheet(manifest, surfaces, familyById),
  );
  return manifest;
}
