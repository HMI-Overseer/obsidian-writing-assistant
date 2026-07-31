// Retention, and the mode that acts on it (RFC-0013 plan section 4.4).
//
// Every run leaves a scratch profile holding a pinned asar plus a seeded vault, 40 to 47 MB
// apiece, and nothing cleaned them: one session of fifteen verification runs came to 647 MB. The
// 2026-07-31 run record raised it and deliberately did not fix it there.
//
// Deleting them automatically is wrong, and that is the whole design constraint. Sandbox mode's
// entire point is that the vault survives the run so it can be inspected, and `detach` leaves a
// real Obsidian running on one. An instrument that tidied up after itself would delete the thing
// the maintainer asked it to leave behind.
//
// So retention is explicit. Cleaning is a mode in the picker rather than a flag, for the same
// reason hand driving is: a flag is something you reach for after you already know you want it,
// and flags here only ever repeat a choice already made. A run that finishes says how much has
// accumulated, so the mode is discoverable at the moment it matters.

import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRATCH_PREFIX = "lmsa-driver-";
/** Written into every scratch root, so cleaning knows what it is looking at. */
const MARKER = "driver-run.json";

export function writeScratchMarker(root, facts) {
  writeFileSync(join(root, MARKER), `${JSON.stringify(facts, null, 2)}\n`);
}

export function markScratchDetached(root) {
  const path = join(root, MARKER);
  if (!existsSync(path)) return;
  try {
    const marker = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, `${JSON.stringify({ ...marker, detached: true }, null, 2)}\n`);
  } catch {
    // A scratch root whose marker cannot be read is still cleanable by hand; losing the flag is
    // not worth failing a detach the maintainer already committed to.
  }
}

/**
 * Removes a scratch root the driver knows nobody wants, and never fails a run over it.
 *
 * Measured on Windows: for a second or two after the app is killed, the OS still holds handles
 * inside the profile's graphite cache, and an immediate delete throws `EPERM`. Housekeeping must
 * not be the thing that takes a run down, so this reports rather than throws, and what it leaves
 * behind is exactly what the clean mode lists.
 */
export function removeScratchQuietly(root) {
  try {
    rmSync(root, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function directorySize(dir) {
  let bytes = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    try {
      if (entry.isDirectory()) bytes += directorySize(path);
      else if (entry.isFile()) bytes += statSync(path).size;
    } catch {
      // A file that vanished between the listing and the stat contributes nothing.
    }
  }
  return bytes;
}

export function formatBytes(bytes) {
  if (bytes === 0) return "nothing";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Scratch profiles and vaults left in the OS temp directory, newest first. */
export function listScratch() {
  const root = tmpdir();
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(SCRATCH_PREFIX))
    .map((entry) => {
      const path = join(root, entry.name);
      let marker = null;
      try {
        marker = JSON.parse(readFileSync(join(path, MARKER), "utf8"));
      } catch {
        marker = null;
      }
      return {
        path,
        name: entry.name,
        bytes: directorySize(path),
        mtime: statSync(path).mtimeMs,
        detached: marker?.detached === true,
        run: marker?.run ?? null,
      };
    })
    .sort((left, right) => right.mtime - left.mtime);
}

/**
 * Retained run directories, newest first, each saying whether it could ever be produced again.
 *
 * `repeatable` is read from the run's own manifest, which is what makes the distinction below
 * possible: a scripted run can be recreated in twenty seconds for nothing, and a live one cannot
 * be recreated at all. RFC-0013 says a live run's artifacts "are worth keeping precisely because
 * the run cannot be recreated", and a cleaner that offered both under one "keep the 5 newest" was
 * quietly contradicting that.
 */
export function listRunDirectories(outDir) {
  if (!existsSync(outDir)) return [];
  return readdirSync(outDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const path = join(outDir, entry.name);
      let manifest = null;
      try {
        manifest = JSON.parse(readFileSync(join(path, "manifest.json"), "utf8"));
      } catch {
        manifest = null;
      }
      return {
        path,
        name: entry.name,
        bytes: directorySize(path),
        mtime: statSync(path).mtimeMs,
        // Absent means a directory too old or too broken to say so, and the safe reading of "I do
        // not know whether this can be recreated" is that it cannot: it costs a second question
        // to keep something cheap, and it costs the thing itself to remove something that was not.
        repeatable: manifest?.repeatable === true,
      };
    })
    .sort((left, right) => right.mtime - left.mtime);
}

export function scratchSummary() {
  const scratch = listScratch();
  const bytes = scratch.reduce((total, entry) => total + entry.bytes, 0);
  return { count: scratch.length, bytes, text: `${scratch.length} scratch vaults, ${formatBytes(bytes)}` };
}

function totalBytes(entries) {
  return entries.reduce((total, entry) => total + entry.bytes, 0);
}

/**
 * One class of leftovers, offered as a numbered list.
 *
 * `keep` is the number of newest entries the first option preserves, because the useful default
 * is "the last few, in case I want to look at one again", not "all or nothing".
 */
async function askRemoval(terminal, title, entries, keep, protectedNote, keepFirst = false) {
  if (entries.length === 0) {
    terminal.say(`  ${title}: nothing to remove`);
    return [];
  }

  terminal.say("");
  terminal.say(`  ${title}: ${entries.length}, ${formatBytes(totalBytes(entries))}`);
  if (protectedNote) terminal.say(`  ${protectedNote}`);

  const older = entries.slice(keep);
  const options = [];
  // For anything that cannot be produced again, "keep everything" is the first entry rather than
  // the last, because the ordering of a destructive list is itself a default.
  if (keepFirst) options.push({ label: "keep everything", detail: "remove nothing", value: [] });
  if (older.length > 0) {
    options.push({
      label: `keep the ${keep} newest`,
      detail: `remove ${older.length}, ${formatBytes(totalBytes(older))}`,
      value: older,
    });
  }
  options.push({
    label: "remove all",
    detail: `${entries.length}, ${formatBytes(totalBytes(entries))}`,
    value: entries,
  });
  if (!keepFirst) options.push({ label: "keep everything", detail: "remove nothing", value: [] });

  const chosen = await terminal.choose(title, options);
  for (const entry of chosen) {
    rmSync(entry.path, { recursive: true, force: true });
  }
  if (chosen.length > 0) {
    terminal.say(`  removed ${chosen.length}, ${formatBytes(totalBytes(chosen))}`);
  }
  return chosen;
}

/**
 * The clean mode. Lists what has accumulated, asks, removes.
 *
 * A scratch root the maintainer detached from is listed and left alone: a real Obsidian is
 * running on that vault, and this instrument does not delete a vault out from under an
 * application the maintainer is still using.
 */
export async function runClean(terminal, outDir) {
  const scratch = listScratch();
  const detached = scratch.filter((entry) => entry.detached);
  const removable = scratch.filter((entry) => !entry.detached);

  await askRemoval(
    terminal,
    "scratch vaults",
    removable,
    3,
    // "plus", because the count above is what can be removed. A destructive prompt that leaves a
    // reader working out whether the protected ones are inside the number is a bad prompt.
    detached.length > 0
      ? `plus ${detached.length} left alone: the driver detached from ${
          detached.length === 1 ? "it" : "them"
        }, so an app may still be open on ${detached.length === 1 ? "it" : "them"}. ` +
        `Stop the app and remove ${detached.length === 1 ? "it" : "them"} by hand.`
      : null,
  );

  // Two questions, not one, and the split is the point. A scripted run can be produced again in
  // twenty seconds for nothing. A live run cannot be produced again at all: it caught a real
  // session, which is the only reason it exists. Offering both under one "keep the 5 newest" is
  // how a gate artifact gets swept up with eleven cheap ones, which is exactly what happened on
  // 2026-07-31.
  const runs = listRunDirectories(outDir);
  await askRemoval(
    terminal,
    "run directories, repeatable",
    runs.filter((entry) => entry.repeatable),
    5,
    null,
  );
  await askRemoval(
    terminal,
    "run directories, NOT repeatable",
    runs.filter((entry) => !entry.repeatable),
    5,
    "these are live runs. each one caught a real session and none of them can be produced again.",
    true,
  );
}
