import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";

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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function imageMarkup(entry, label) {
  if (!entry) {
    return `<div class="missing">
      <strong>${escapeHtml(label)}</strong><span>Not rendered</span>
    </div>`;
  }

  const dimensions = `${entry.dimensions.width} x ${entry.dimensions.height} px`;
  return `<figure>
    <figcaption><strong>${escapeHtml(label)}</strong><span>${dimensions}</span></figcaption>
    <a href="${escapeHtml(entry.path)}">
      <img src="${escapeHtml(entry.path)}" alt="${escapeHtml(
        `${entry.id}, ${entry.theme}, ${entry.build}`,
      )}">
    </a>
  </figure>`;
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

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Visual harness contact sheet</title>
  <style>
    :root {
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
    .intro { color: GrayText; margin-bottom: 32px; }
    .family { margin-bottom: 48px; }
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
    }
    figure, .missing { margin: 0; min-width: 0; }
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
    }
    @media (max-width: 900px) {
      body { padding: 16px; }
      .themes { grid-template-columns: 1fr; }
      .theme + .theme { border-left: 0; border-top: 1px solid GrayText; }
      .builds { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <h1>Visual harness contact sheet</h1>
    <p class="intro">
      ${Object.keys(surfaces).length} registered surfaces, grouped by family.
      Light and dark renders are shown side by side.
    </p>
    ${content}
  </main>
</body>
</html>
`;
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
