// The README's pictures, taken from the running application (RFC-0013).
//
// Four scripted turns in one conversation, in the order a reader meets them: a chapter checked
// against the research notes it is meant to respect, an edit that brings it in line and stops for
// review, a synthesis note that stops at the same gate, and a comparison table the theme pictures
// are taken on. The first turn is also recorded frame by frame, for the README's animation. `dev/readme/assemble.mjs` turns the newest run of this into `assets/readme`.
//
// Two things here go beyond what other scenarios do, and both are for the picture, not the walk:
//
//   - The window is resized and the layout staged before anything is typed. A fresh profile
//     opens at 1024x800 with the explorer collapsed and no note open, which is not what the
//     plugin looks like on anyone's desk. Staging goes through Obsidian's own API from the page,
//     which is setup, not interaction, so the bridge rule holds.
//   - The scripted client is built per generation and its round cursor starts again with it
//     (see regenerate-settled-turn), so a second turn replays the first turn's script. Each turn
//     therefore re-arms its own frames through the bridge, validated in Node first like the
//     runner does.
//
//   - The finished conversation is shot again under Obsidian's light theme and three community
//     themes, for the README's theme pictures. The themes are copied at run time from the vault
//     this repository is installed in and are never committed: a theme's CSS is its author's, and
//     it only ever lives in the scratch vault for the length of the run.
//
// The prose is scripted. What is not scripted is everything the plugin does with it: the reads
// run against the fixture vault, the edit is applied to the open editor through the review
// pipeline, and the new note is created on disk after approval.

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VIEW_TYPE } from "../lib/bridge.mjs";
import {
  APPROVAL_APPROVE,
  APPROVAL_SUBMIT,
  CHAT_ROOT,
  COMPOSER_SEND,
  COMPOSER_TEXTAREA,
} from "../lib/scenarioApi.mjs";
import { validateDriverScript } from "../lib/script.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FRAMES = resolve(HERE, "..", "frames");
/**
 * Where the community themes come from: `.obsidian/themes` of the vault this repository is
 * installed in, two directories above the plugin. The same reasoning live mode uses for the
 * installed plugin's own data.json: this repository *is* the installed plugin.
 */
const THEMES_SOURCE = resolve(HERE, "..", "..", "..", "..", "..", "themes");

/** The note the story is about, open in the editor for every picture. */
const CHAPTER = "Story/Chapters/01 Outbound.md";
const WINDOW = { width: 1440, height: 960 };
const SIDEBAR_WIDTH = 560;

/**
 * The finished conversation under other themes. `base` is Obsidian's own light (moonstone) or
 * dark (obsidian) theme; `css` is a community theme by folder name, or none.
 */
const THEME_SHOTS = [
  { label: "the conversation in Obsidian's light theme", base: "moonstone", css: "" },
  { label: "the conversation in Minimal", base: "obsidian", css: "Minimal" },
  { label: "the conversation in Things", base: "obsidian", css: "Things" },
  { label: "the conversation in Obsidian gruvbox", base: "obsidian", css: "Obsidian gruvbox" },
];

async function arm(app, id) {
  const script = validateDriverScript(JSON.parse(readFileSync(join(FRAMES, `${id}.json`), "utf8")), id);
  await app.page.evaluate((armed) => window.__lmsaDriver.arm(armed), script);
}

/**
 * The window at README size.
 *
 * `Browser.setWindowBounds` is the CDP way and works from a page session in Chromium; Electron's
 * remote module is the fallback, because Obsidian's renderer exposes it. Both failing is a
 * finding about the instrument, so it is thrown rather than shot at the wrong size.
 */
async function resizeWindow(app) {
  const cdp = await app.page.context().newCDPSession(app.page);
  try {
    const { windowId } = await cdp.send("Browser.getWindowForTarget");
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: "normal", left: 40, top: 40, ...WINDOW },
    });
    return;
  } catch (cdpError) {
    try {
      await app.page.evaluate((size) => {
        const remote = window.require("@electron/remote");
        remote.getCurrentWindow().setSize(size.width, size.height);
      }, WINDOW);
      return;
    } catch (remoteError) {
      throw new Error(
        `readme-showcase could not resize the window. CDP: ${cdpError.message}. ` +
          `Electron remote: ${remoteError.message}.`,
      );
    }
  } finally {
    await cdp.detach();
  }
}

async function stage(app) {
  await resizeWindow(app);

  // The chapter first, then the chat view again. The composer decides once, when the view is
  // constructed, whether the active note rides on the next message, and the driver opened the
  // view before any note was open, so the chip every real session starts with was absent from
  // the first run of this. Closing and reopening the view is the order a reader has anyway: a note
  // open, then the chat beside it.
  await app.page.evaluate(
    async ({ path, viewType }) => {
      const workspace = window.app.workspace;
      const file = window.app.vault.getFileByPath(path);
      if (!file) throw new Error(`readme-showcase: the fixture has no note at ${path}.`);
      const leaf = workspace.getMostRecentLeaf(workspace.rootSplit) ?? workspace.getLeaf(true);
      await leaf.openFile(file, { active: true });
      for (const chat of workspace.getLeavesOfType(viewType)) chat.detach();
      await window.__lmsaDriver.openChat();
    },
    { path: CHAPTER, viewType: VIEW_TYPE },
  );
  await app.awaitCheckpoint("view-open");

  // The sidebar wide enough to read prose in, and the explorer's folders open. The folders are
  // clicked, because that is a picture of the explorer and the explorer has no public API for it.
  await app.page.evaluate((sidebar) => window.app.workspace.rightSplit.setSize(sidebar), SIDEBAR_WIDTH);
  for (const folder of ["Research", "Story", "Story/Characters", "Story/Chapters"]) {
    await app.click(`.nav-folder-title[data-path="${folder}"]`);
  }
}

/**
 * Copies the community themes into the scratch vault and has Obsidian register them.
 *
 * The registration matters: `customCss.setTheme` loads a theme the registry has not read as no
 * theme at all, silently, which would shoot Obsidian's default under a community theme's label.
 * So the registry is re-read and every name is checked before any theme is applied.
 */
async function installThemes(app) {
  const names = THEME_SHOTS.map((theme) => theme.css).filter(Boolean);
  const vaultDir = await app.page.evaluate(() => window.app.vault.adapter.basePath);
  for (const name of names) {
    const source = join(THEMES_SOURCE, name);
    if (!existsSync(join(source, "theme.css"))) {
      throw new Error(
        `readme-showcase: the theme "${name}" is not installed in the vault this repository ` +
          `lives in (${THEMES_SOURCE}). The theme pictures need it; install it in Obsidian first.`,
      );
    }
    cpSync(source, join(vaultDir, ".obsidian", "themes", name), { recursive: true });
  }
  await app.page.evaluate(() => window.app.customCss.readThemes());
  await app.page.waitForFunction(
    (wanted) => wanted.every((name) => Boolean(window.app.customCss.themes[name])),
    names,
    { timeout: 15_000 },
  );
}

/**
 * Switches theme and waits for it to be in effect: the body carries the base theme's class and
 * the theme style element holds different text than before (or none, for no community theme).
 * A predicate, not a duration: the theme loader is debounced and reads from disk.
 */
async function applyTheme(app, { base, css }) {
  const before = await app.page.evaluate(
    (theme) => {
      const previous = window.app.customCss.styleEl?.textContent ?? "";
      window.app.changeTheme(theme.base);
      window.app.customCss.setTheme(theme.css);
      return previous;
    },
    { base, css },
  );
  await app.page.waitForFunction(
    (theme) => {
      const light = document.body.classList.contains("theme-light");
      if ((theme.base === "moonstone") !== light) return false;
      if (window.app.customCss.theme !== theme.css) return false;
      const text = window.app.customCss.styleEl?.textContent ?? "";
      return theme.css === "" ? text === "" : text.length > 0 && text !== theme.before;
    },
    { base, css, before },
    { timeout: 15_000 },
  );
}

/**
 * The last user turn at the top of the transcript, so a picture holds the whole exchange.
 *
 * A settled transcript rests at its bottom, which clips the top of the user bubble when the turn
 * is nearly as tall as the panel. Done after each theme switch, because a theme changes line
 * heights and with them where the bottom is.
 */
async function showLastExchange(app) {
  await app.page.evaluate(() => {
    const rows = document.querySelectorAll(".lmsa-chat-window-message--user");
    const last = rows[rows.length - 1];
    if (!last) throw new Error("readme-showcase: there is no user turn to scroll to.");
    last.scrollIntoView({ block: "start" });
  });
}

/**
 * Screenshots the chat panel as fast as the page will give them, until `action` resolves.
 *
 * Each frame is written beside a timestamp, so the assembler can give it the delay it actually
 * had rather than a nominal one. The loop is not a wait: nothing after it depends on how many
 * frames it took, and the action inside it is driven and checkpointed like any other.
 */
async function recordFrames(app, name, action) {
  const dir = join(app.dir, "frames", name);
  mkdirSync(dir, { recursive: true });
  const clip = await app.page.$eval(CHAT_ROOT, (element) => {
    const box = element.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  });

  let recording = true;
  const frames = [];
  const loop = (async () => {
    let index = 0;
    while (recording) {
      const file = `${String(index).padStart(3, "0")}.png`;
      const at = Date.now();
      await app.page.screenshot({ path: join(dir, file), clip, scale: "css" });
      frames.push({ file, at });
      index += 1;
    }
  })();

  try {
    await action();
  } finally {
    recording = false;
    await loop;
    writeFileSync(join(dir, "timing.json"), `${JSON.stringify({ clip, frames }, null, 2)}\n`);
  }
}

export default {
  id: "readme-showcase",
  description:
    "The README's pictures: a grounded answer, an edit review, a gated write, a comparison, four themes.",
  vault: "readme-showcase",
  theme: "dark",
  provider: { kind: "scripted", frames: "readme-grounded-answer" },

  async run(app) {
    await stage(app);
    await app.shot("the stage, before anything is typed");

    // Turn one, recorded. The note chip on the user turn is the open chapter.
    await recordFrames(app, "grounded-answer", async () => {
      await app.click(COMPOSER_TEXTAREA);
      await app.type("Does my belt crossing in this chapter hold up against my research notes?");
      await app.click(COMPOSER_SEND);
      await app.awaitCheckpoint("turn-started");
      await app.awaitCheckpoint("turn-settled");
    });
    await app.shot("a grounded answer beside the note");
    await app.shot("the grounded answer, chat alone", { selector: CHAT_ROOT });

    // Turn two: an edit to the open chapter, stopped for review, then approved. The editor on the
    // left changes with it, which is the picture.
    await arm(app, "readme-edit-review");
    await app.send("Fix the belt paragraph so it matches the notes. Keep her boredom.");
    await app.awaitCheckpoint("approval-raised");
    await app.shot("an edit waiting for review");
    await app.shot("the edit review, chat alone", { selector: CHAT_ROOT });

    await app.click(APPROVAL_APPROVE);
    await app.click(APPROVAL_SUBMIT);
    await app.awaitCheckpoint("interaction-submitted");
    // Off the bubble the drawer collapses into, or its action toolbar and a tooltip sit in every
    // later picture. Blank editor space below the chapter, because the window corner is the
    // ribbon toggle and it has a tooltip of its own. A real pointer move, like every other input.
    await app.page.mouse.move(WINDOW.width * 0.42, WINDOW.height - 40);
    await app.awaitCheckpoint("turn-settled");
    await app.shot("the edit applied, and the chapter changed with it");
    await app.shot("the applied edit, chat alone", { selector: CHAT_ROOT });

    // Turn three: a synthesis note at the same gate.
    await arm(app, "readme-new-note");
    await app.send("Start a note that pulls together every ring fact the station scenes have to respect.");
    await app.awaitCheckpoint("approval-raised");
    await app.shot("a new note waiting at the gate");
    await app.shot("the write review, chat alone", { selector: CHAT_ROOT });

    await app.click(APPROVAL_APPROVE);
    await app.click(APPROVAL_SUBMIT);
    await app.awaitCheckpoint("interaction-submitted");
    // Off the bubble the drawer collapses into, or its action toolbar and a tooltip sit in every
    // later picture. Blank editor space below the chapter, because the window corner is the
    // ribbon toggle and it has a tooltip of its own. A real pointer move, like every other input.
    await app.page.mouse.move(WINDOW.width * 0.42, WINDOW.height - 40);
    await app.awaitCheckpoint("turn-settled");
    await app.shot("the note created");
    await app.shot("the note created, chat alone", { selector: CHAT_ROOT });

    // Turn four: a table, a list, bold runs, and a link, which is what a theme restyles. The theme
    // pictures are taken with this turn on screen.
    await arm(app, "readme-comparison");
    await app.send("Give me a quick comparison of the belt and the rings for the series bible.");
    await app.awaitCheckpoint("turn-started");
    await app.awaitCheckpoint("turn-settled");
    await app.page.mouse.move(WINDOW.width * 0.42, WINDOW.height - 40);
    await showLastExchange(app);
    await app.shot("the comparison, chat alone", { selector: CHAT_ROOT });

    // The same conversation under other themes, for the README's theme pictures.
    await installThemes(app);
    for (const theme of THEME_SHOTS) {
      await applyTheme(app, theme);
      await showLastExchange(app);
      await app.shot(theme.label, { selector: CHAT_ROOT });
    }
  },
};
