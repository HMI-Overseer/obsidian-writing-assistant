// The README's assets, from the newest readme-showcase run.
//
//   npm run readme:assets
//
// It asks nothing and takes no flags: there is exactly one run it can mean, the newest complete
// `readme-showcase` walk under dev/driver/out, and it says which one it used. Run the scenario
// first (`npm run drive`, then readme-showcase) if there is none.
//
// Pictures are picked by the label the scenario gave them, never by the number in the file name,
// so reordering shots in the scenario cannot silently swap a README image for a different moment.
//
// The animation is a GIF, which allows 256 colours per frame, and the composer's glow and its
// spinning border are gradients that move every frame. Three choices keep that from turning into
// banding that flickers, which is what the first encoding of it did:
//
//   - one palette for the whole run, built from sampled frames, so a colour means the same thing
//     in every frame and nothing shimmers as palettes change under it;
//   - the palette is built and applied at full colour precision with Atkinson dithering, so a
//     gradient becomes fine noise rather than steps;
//   - only the pixels that changed are written for each frame after the first, with the rest left
//     transparent over the previous frame, which is also what keeps the file small.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// gifenc and pngjs are CommonJS, so ESM sees only a default export.
import gifenc from "gifenc";
import * as iq from "image-q";
import pngjs from "pngjs";

const { GIFEncoder } = gifenc;
const { PNG } = pngjs;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const RUNS = join(REPO, "dev", "driver", "out");
const ASSETS = join(REPO, "assets", "readme");
const SCENARIO = "readme-showcase";

/** README file name, by the shot label in the scenario. A label missing from the run fails. */
const PICTURES = {
  "hero.png": "a grounded answer beside the note",
  "edit-review.png": "the edit review, chat alone",
  "edit-applied.png": "the edit applied, and the chapter changed with it",
  "note-created.png": "the note created, chat alone",
  "theme-light.png": "the conversation in Obsidian's light theme",
  "theme-minimal.png": "the conversation in Minimal",
  "theme-things.png": "the conversation in Things",
  "theme-gruvbox.png": "the conversation in Obsidian gruvbox",
};

/** Animation file name, by the name the scenario recorded frames under. */
const ANIMATIONS = {
  "grounded-answer.gif": "grounded-answer",
};

/** How long the last frame of an animation stays before it loops, in ms. */
const END_HOLD_MS = 2500;

/** Every Nth frame, plus the last, feeds the palette. Enough to see every colour the run uses. */
const PALETTE_SAMPLE_EVERY = 6;
/** One slot of the 256 is kept back to mark pixels a frame leaves unchanged. */
const PALETTE_COLOURS = 255;
const UNCHANGED_INDEX = 255;
/** GIF disposal 1: leave the frame in place, so the next one can paint only what changed. */
const DISPOSE_KEEP = 1;

function newestRun() {
  if (!existsSync(RUNS)) return null;
  const runs = readdirSync(RUNS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(`-${SCENARIO}`))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const name of runs) {
    const manifestPath = join(RUNS, name, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.complete === true) return { dir: join(RUNS, name), name, manifest };
  }
  return null;
}

function copyPictures(run) {
  const shots = run.manifest.steps.filter((step) => step.kind === "shot" && step.ok);
  for (const [asset, label] of Object.entries(PICTURES)) {
    const shot = shots.find((step) => step.label === label);
    if (!shot) {
      throw new Error(
        `The run has no shot labelled "${label}", which ${asset} is picked by. ` +
          `Its labels: ${shots.map((step) => `"${step.label}"`).join(", ")}.`,
      );
    }
    copyFileSync(join(run.dir, shot.shot), join(ASSETS, asset));
    console.log(`  ${asset}  <-  ${shot.shot}`);
  }
}

/** The recorded frames, each with how long it was on screen, identical neighbours folded. */
function readFrames(dir, name) {
  const timingPath = join(dir, "timing.json");
  if (!existsSync(timingPath)) {
    throw new Error(`The run recorded no frames named "${name}" (no ${timingPath}).`);
  }
  const { frames } = JSON.parse(readFileSync(timingPath, "utf8"));
  if (frames.length < 2) throw new Error(`"${name}" has ${frames.length} frame(s); nothing to animate.`);

  const kept = [];
  let previous = null;
  for (const [index, frame] of frames.entries()) {
    const png = PNG.sync.read(readFileSync(join(dir, frame.file)));
    const next = frames[index + 1];
    const shown = next ? next.at - frame.at : END_HOLD_MS;
    if (previous && previous.png.data.equals(png.data)) {
      previous.delay += shown;
      continue;
    }
    previous = { png, delay: shown };
    kept.push(previous);
  }
  kept[kept.length - 1].delay = Math.max(kept[kept.length - 1].delay, END_HOLD_MS);

  const { width, height } = kept[0].png;
  for (const [index, frame] of kept.entries()) {
    if (frame.png.width !== width || frame.png.height !== height) {
      throw new Error(
        `Frame ${index} of "${name}" is ${frame.png.width}x${frame.png.height}, not ${width}x${height}.`,
      );
    }
  }
  return { kept, width, height, recorded: frames.length };
}

const container = (png) => iq.utils.PointContainer.fromUint8Array(png.data, png.width, png.height);
const key = (r, g, b) => (r << 16) | (g << 8) | b;

/** One palette for the run, and the lookup that turns a dithered pixel back into its index. */
function buildPalette(kept) {
  const sampled = kept.filter(
    (_, index) => index % PALETTE_SAMPLE_EVERY === 0 || index === kept.length - 1,
  );
  const palette = iq.buildPaletteSync(
    sampled.map((frame) => container(frame.png)),
    { colorDistanceFormula: "euclidean", paletteQuantization: "wuquant", colors: PALETTE_COLOURS },
  );
  const colours = palette
    .getPointContainer()
    .getPointArray()
    .map((point) => [point.r, point.g, point.b]);
  if (colours.length > PALETTE_COLOURS) {
    throw new Error(
      `The quantiser returned ${colours.length} colours; ${PALETTE_COLOURS} was the most allowed.`,
    );
  }
  const indexOf = new Map(colours.map(([r, g, b], index) => [key(r, g, b), index]));
  // gifenc sizes the colour table from the array, so it is padded out to hold the unchanged slot.
  while (colours.length <= UNCHANGED_INDEX) colours.push([0, 0, 0]);
  return { palette, colours, indexOf };
}

/** A frame as palette indices, dithered against the run's palette. */
function indexFrame(png, { palette, indexOf }) {
  const dithered = iq
    .applyPaletteSync(container(png), palette, {
      colorDistanceFormula: "euclidean",
      imageQuantization: "atkinson",
    })
    .toUint8Array();
  const indexed = new Uint8Array(png.width * png.height);
  for (let pixel = 0, at = 0; pixel < indexed.length; pixel += 1, at += 4) {
    const index = indexOf.get(key(dithered[at], dithered[at + 1], dithered[at + 2]));
    if (index === undefined) {
      throw new Error(`Pixel ${pixel} was dithered to a colour that is not in the palette.`);
    }
    indexed[pixel] = index;
  }
  return indexed;
}

function encodeAnimation(run, asset, name) {
  const { kept, width, height, recorded } = readFrames(join(run.dir, "frames", name), name);
  const paletteInfo = buildPalette(kept);

  const gif = GIFEncoder();
  let previous = null;
  let painted = 0;
  for (const [index, frame] of kept.entries()) {
    const indexed = indexFrame(frame.png, paletteInfo);
    let pixels = indexed;
    if (previous) {
      pixels = new Uint8Array(indexed.length);
      for (let at = 0; at < indexed.length; at += 1) {
        const same = indexed[at] === previous[at];
        pixels[at] = same ? UNCHANGED_INDEX : indexed[at];
        if (!same) painted += 1;
      }
    } else {
      painted += indexed.length;
    }
    gif.writeFrame(pixels, width, height, {
      ...(index === 0
        ? { palette: paletteInfo.colours, repeat: 0 }
        : { transparent: true, transparentIndex: UNCHANGED_INDEX }),
      dispose: DISPOSE_KEEP,
      // GIF delays are hundredths of a second, and a browser treats anything under 2 as 10.
      delay: Math.max(2, Math.round(frame.delay / 10)),
    });
    previous = indexed;
  }
  gif.finish();
  const bytes = gif.bytes();
  writeFileSync(join(ASSETS, asset), bytes);
  const share = Math.round((100 * painted) / (kept.length * width * height));
  console.log(
    `  ${asset}  <-  ${recorded} frames, ${kept.length} kept, ${width}x${height}, ` +
      `${share}% of pixels painted, ${(bytes.length / 1024 / 1024).toFixed(2)} MB`,
  );
}

const run = newestRun();
if (!run) {
  console.error(
    `No complete ${SCENARIO} run under dev/driver/out. Run \`npm run drive\`, choose the ` +
      `${SCENARIO} scenario, and try again.`,
  );
  process.exit(1);
}
console.log(`assembling from ${run.name}`);
mkdirSync(ASSETS, { recursive: true });
copyPictures(run);
for (const [asset, name] of Object.entries(ANIMATIONS)) encodeAnimation(run, asset, name);
console.log(`written to assets/readme`);
