// Visual harness: render plugin surfaces against real Obsidian chrome, in light and dark, to PNGs.
// A development preview aid (not a test suite). See ./README.md.
//
//   npm run visual                       # all surfaces, current build, both themes
//   npm run visual -- composer           # one surface
//   npm run visual -- --themes dark      # dark only
//   npm run visual -- --baseline ../wa-tw3-baseline/styles.css   # A/B vs another build
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCAFFOLD } from "./scaffold.mjs";
import { getAppCss } from "./lib/appCss.mjs";
import { captureElement, launchBrowser, reportEngine } from "./lib/browser.mjs";
import { composeDocument } from "./lib/compose.mjs";
import { auditIconNames } from "./lib/iconAudit.mjs";
import { getObsidianChromiumVersion } from "./lib/obsidianInstall.mjs";
import { SURFACES } from "./lib/registry.mjs";

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
const builds = [{ tag: "", css: currentCss }];
if (baselineCss) builds.push({ tag: "-baseline", css: baselineCss });

mkdirSync(OUT, { recursive: true });
const browser = await launchBrowser();
reportEngine(browser, getObsidianChromiumVersion());

for (const id of targets) {
  const surface = SURFACES[id];
  for (const build of builds) {
    const pluginCss = readFileSync(build.css, "utf8");
    for (const theme of themes) {
      const html = composeDocument(theme, APP_CSS, pluginCss, SCAFFOLD, surface.html);
      const out = join(OUT, `${id}-${theme}${build.tag}.png`);
      await captureElement(browser, html, surface.shot, out);
      console.log("wrote", out.replace(REPO + "\\", "").replace(REPO + "/", ""));
    }
  }
}
await browser.close();
