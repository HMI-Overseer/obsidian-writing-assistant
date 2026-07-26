// Visual harness: render plugin surfaces against real Obsidian chrome, in light and dark, to PNGs.
// A development preview aid (not a test suite). See ./README.md.
//
//   npm run visual                       # all surfaces, current build, both themes
//   npm run visual -- composer           # one surface
//   npm run visual -- --themes dark      # dark only
//   npm run visual -- --baseline ../wa-tw3-baseline/styles.css   # A/B vs another build
import { chromium } from "playwright";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAppCss } from "./appCss.mjs";
import { getObsidianChromiumVersion } from "./obsidianInstall.mjs";
import { SCAFFOLD, SURFACES } from "./surfaces.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const OUT = join(HERE, "out");

// --- args
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const currentCss = resolve(REPO, "styles.css");
const baselineCss = opt("baseline") ? resolve(process.cwd(), opt("baseline")) : null;
const themes = opt("themes", "light,dark").split(",");
const ids = argv.filter((a) => SURFACES[a]);
const targets = ids.length ? ids : Object.keys(SURFACES);

if (!existsSync(currentCss)) {
  console.error(`No styles.css at ${currentCss}. Run \`npm run build:css\` first.`);
  process.exit(1);
}

const APP_CSS = getAppCss();
const builds = [{ tag: "", css: currentCss }];
if (baselineCss) builds.push({ tag: "-baseline", css: baselineCss });

mkdirSync(OUT, { recursive: true });
let browser;
try {
  browser = await chromium.launch({ channel: "chrome" });
} catch {
  // No system Chrome: fall back to a Playwright-managed Chromium (run `npx playwright install chromium`).
  browser = await chromium.launch();
}

// The harness renders in whatever Chromium is on this machine; Obsidian renders in the one its
// Electron bundles. Where they diverge, CSS newer than Obsidian's engine looks fine here and does
// nothing in the app, so state both rather than letting the gap stay invisible.
const engine = browser.version();
const obsidianEngine = getObsidianChromiumVersion();
const major = (v) => Number.parseInt(v, 10);
if (obsidianEngine && major(engine) !== major(obsidianEngine)) {
  console.log(
    `engine: Chromium ${engine}, Obsidian renders on ${obsidianEngine}. ` +
      "Features newer than Obsidian's engine will look right here and fail in the app.",
  );
} else {
  console.log(`engine: Chromium ${engine}${obsidianEngine ? " (matches Obsidian)" : ""}`);
}

for (const id of targets) {
  const s = SURFACES[id];
  for (const build of builds) {
    const pluginCss = readFileSync(build.css, "utf8");
    for (const theme of themes) {
      const page = await browser.newPage({ deviceScaleFactor: 2 });
      const html = `<!doctype html><html class="theme-${theme}"><head>
        <style>${APP_CSS}</style><style>${pluginCss}</style><style>${SCAFFOLD}</style></head>
        <body class="theme-${theme} mod-windows is-focused">${s.html}</body></html>`;
      await page.setContent(html, { waitUntil: "networkidle" });
      const el = await page.$(s.shot);
      const out = join(OUT, `${id}-${theme}${build.tag}.png`);
      await el.screenshot({ path: out });
      console.log("wrote", out.replace(REPO + "\\", "").replace(REPO + "/", ""));
      await page.close();
    }
  }
}
await browser.close();
