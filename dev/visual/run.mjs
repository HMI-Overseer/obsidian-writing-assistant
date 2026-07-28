// Visual harness: render plugin surfaces against real Obsidian chrome, in light and dark, to PNGs.
// A development preview aid (not a test suite). See ./README.md.
//
//   npm run visual                       # all surfaces, current build, both themes
//   npm run visual -- composer           # one surface
//   npm run visual -- --themes dark      # dark only
//   npm run visual -- --baseline ../wa-tw3-baseline/styles.css   # A/B vs another build
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { SCAFFOLD } from "./scaffold.mjs";
import { getAppCss } from "./lib/appCss.mjs";
import { captureElement, launchBrowser, reportEngine } from "./lib/browser.mjs";
import { composeDocument } from "./lib/compose.mjs";
import { auditIconNames } from "./lib/iconAudit.mjs";
import { getObsidianChromiumVersion } from "./lib/obsidianInstall.mjs";
import { renderOutputPath, updateOutput } from "./lib/output.mjs";
import { SURFACE_FAMILIES, SURFACES } from "./lib/registry.mjs";
import { auditSurfaceContracts } from "./lib/surfaceAudit.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const OUT = join(HERE, "out");

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const currentCss = resolve(REPO, "styles.css");
const baselineCss = opt("baseline") ? resolve(process.cwd(), opt("baseline")) : null;
const themes = opt("themes", "light,dark").split(",");
const ids = argv.filter((arg) => SURFACES[arg]);
const targets = ids.length ? ids : Object.keys(SURFACES);

if (!existsSync(currentCss)) {
  console.error(`No styles.css at ${currentCss}. Run \`npm run build:css\` first.`);
  process.exit(1);
}

console.log(`surface audit: ${auditSurfaceContracts(SURFACES)} fixture contract(s) covered`);

const iconAudit = auditIconNames(join(REPO, "src"));
if (iconAudit.missing.length > 0) {
  console.warn(
    `icon audit: ${iconAudit.missing.length} setIcon() literal name(s) absent from ICON_NAMES: ` +
      iconAudit.missing.join(", "),
  );
} else {
  console.log(`icon audit: ${iconAudit.names.length} setIcon() literal name(s) covered`);
}

const APP_CSS = getAppCss();
const builds = [{ name: "current", css: currentCss }];
if (baselineCss) builds.push({ name: "baseline", css: baselineCss });

mkdirSync(OUT, { recursive: true });
const browser = await launchBrowser();
const obsidianChromium = getObsidianChromiumVersion();
reportEngine(browser, obsidianChromium);
const engines = {
  chromium: browser.version(),
  obsidianChromium,
};
const updates = [];

try {
  for (const id of targets) {
    const surface = SURFACES[id];
    const family = SURFACE_FAMILIES[id];
    for (const build of builds) {
      const pluginCss = readFileSync(build.css, "utf8");
      for (const theme of themes) {
        const html = composeDocument(theme, APP_CSS, pluginCss, SCAFFOLD, surface.html);
        const outputPath = renderOutputPath(build.name, family, id, theme);
        const out = join(OUT, ...outputPath.split("/"));
        mkdirSync(dirname(out), { recursive: true });
        const dimensions = await captureElement(browser, html, surface.shot, out);
        updates.push({
          id,
          source: surface.source,
          dimensions,
          family,
          build: build.name,
          theme,
          path: outputPath,
          engines,
        });
        console.log("wrote", out.replace(`${REPO}${sep}`, ""));
      }
    }
  }
} finally {
  await browser.close();
}

const manifest = updateOutput(OUT, updates, SURFACES, SURFACE_FAMILIES);
console.log(
  `wrote dev${sep}visual${sep}out${sep}manifest.json (${manifest.renders.length} entries)`,
);
console.log(`wrote dev${sep}visual${sep}out${sep}index.html`);
