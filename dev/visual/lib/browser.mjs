import { chromium } from "playwright";

// Playwright defaults to 1280x720, which is both too short and load-bearing here. Two separate
// things depend on viewport height: an element screenshot paints BLANK wherever the element extends
// below the fold, and vh-based CSS resolves against it (the ask form is `max-height: calc(100vh -
// 190px)`), so a short viewport clips the shot AND lays the surface out differently than the app.
// Size it like a real Obsidian window, then grow it per surface so nothing is ever silently lost.
const VIEWPORT = { width: 1280, height: 1000 };

export async function launchBrowser() {
  try {
    return await chromium.launch({ channel: "chrome" });
  } catch {
    // No system Chrome: fall back to a Playwright-managed Chromium.
    // Run `npx playwright install chromium` if the fallback is not installed.
    return chromium.launch();
  }
}

export function reportEngine(browser, obsidianEngine) {
  // The harness renders in whatever Chromium is on this machine; Obsidian renders in the one its
  // Electron bundles. Where they diverge, CSS newer than Obsidian's engine looks fine here and does
  // nothing in the app, so state both rather than letting the gap stay invisible.
  const engine = browser.version();
  const major = (version) => Number.parseInt(version, 10);
  if (obsidianEngine && major(engine) !== major(obsidianEngine)) {
    console.log(
      `engine: Chromium ${engine}, Obsidian renders on ${obsidianEngine}. ` +
        "Features newer than Obsidian's engine will look right here and fail in the app.",
    );
  } else {
    console.log(`engine: Chromium ${engine}${obsidianEngine ? " (matches Obsidian)" : ""}`);
  }
}

export async function captureElement(browser, html, shot, out) {
  const page = await browser.newPage({ deviceScaleFactor: 2, viewport: VIEWPORT });
  await page.setContent(html, { waitUntil: "networkidle" });
  let el = await page.$(shot);
  const box = await el.boundingBox();
  const needed = Math.ceil(box.y + box.height) + 40;
  if (needed > VIEWPORT.height) {
    // Growing the viewport re-resolves vh, so re-read the element rather than reusing the box.
    await page.setViewportSize({ width: VIEWPORT.width, height: needed });
    el = await page.$(shot);
  }
  await el.screenshot({ path: out });
  await page.close();
}
