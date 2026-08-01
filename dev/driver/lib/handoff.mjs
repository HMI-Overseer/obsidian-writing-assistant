// Handing the seeded app to the maintainer (RFC-0013).
//
// This is the one primitive under all three of the driver's hand-drivable modes, placed at three
// different points in a run:
//
//   sandbox   hand over at step zero, with no walk at all
//   pause     hand over at a named shot, then resume the walk
//   takeover  hand over once the walk has finished, instead of exiting
//
// What breaks without it, and it is the reason RFC unresolved question 5 was settled against
// `--keep-open`: the assembled running application is the hole this instrument exists to fill,
// and Stage 0 filled it with a walk that ran to completion and closed the window. The one thing
// the manual walk was good at, seeing the real app and following a suspicion wherever it goes,
// was automated away. An escape-hatch flag does not give that back, because a flag is something
// you reach for after you already know you want it.
//
// The driver keeps its connection open while the app is handed over, which is what lets console
// capture, screenshots, and the transcript keep working under hand driving. That is the whole
// reason this waits on the terminal rather than simply exiting.

/**
 * Why a breakpoint was not taken, in the words of the scenario that declared it.
 *
 * Pause mode stops at every shot, and there is one kind of moment it must not stop at: one the
 * stopping destroys. A handover does not pause the application, so a turn that is streaming when
 * the breakpoint opens has settled by the time anyone continues, and the step that needed it in
 * flight then fails. That is an instrument reporting a defect it caused itself, which is the one
 * thing this instrument is built not to do.
 *
 * Said out loud rather than skipped quietly, and it names where to go instead: sandbox mode hands
 * the app over with no walk waiting on the far side of it.
 */
export function perishableNotice(label, perishable) {
  return [
    `  not stopping at "${label}": it holds ${perishable}, and a handover cannot.`,
    "  the shot and its state are recorded. sandbox mode is where you sit in a state like this.",
  ];
}

/**
 * Blocks until the maintainer says what to do next.
 *
 * @returns "continue" to resume a walk, "close" to shut the app down and finish the run
 *   directory, or "detach" to leave the app running and exit the driver.
 */
export async function handOver({
  terminal,
  seeded,
  record,
  shot,
  snapshot,
  resumable,
  at,
  provider,
  sweep = null,
  alarm = false,
  reframes = null,
  finished = false,
}) {
  terminal.say("");
  terminal.say("  ────────────────────────────────────────────────────────────");
  terminal.say(`  the app is yours${at ? `, at ${at}` : ""}`);
  terminal.say("");
  terminal.say(`    vault    ${seeded.vaultDir}`);
  terminal.say(`    profile  ${seeded.profileDir}`);
  terminal.say(`    run      ${record.dir}`);
  // Which run of how many, because a breakpoint inside a sweep otherwise looks exactly like a
  // breakpoint inside a single walk, and "close" means very different things in the two.
  if (sweep) terminal.say(`    sweep    scenario ${sweep.position} of ${sweep.total}`);
  terminal.say(
    `    provider ${provider ?? (seeded.scriptId ? `scripted, ${seeded.scriptId}` : "none, the vault's own settings")}`,
  );

  // What the app is doing right now, not what it was doing when the shot was taken. The two are
  // the same only if nothing is in flight, and the case where they differ is the one worth
  // warning about: a handover does not stop the application, so a turn keeps streaming, a tool
  // keeps running, and the state resumed into is not the state on the screen.
  const now = await snapshot().catch(() => null);
  if (now) {
    terminal.say(
      `    state    ${now.generating ? "a turn is in flight" : `turn ${now.turnStatus ?? "none yet"}`}, ` +
        `${now.messageCount} messages, drawer ${now.interactionKind ?? "empty"}`,
    );
  }
  terminal.say("");
  terminal.say("  the vault is disposable. write to it, break it, delete notes in it.");
  // Said before you continue, not explained after the error. This scenario is the instrument
  // testing itself, and resuming it produces a failure that means nothing is wrong.
  if (alarm) {
    terminal.say("  this one is an alarm: it is meant to fail, and continuing is what makes it.");
  }
  // Why the screen did not change when you continued into this one. It is a second framing of the
  // moment you were already handed, taken for the sheet rather than for the app, and without this
  // line it reads as a driver that ignored the keypress.
  if (reframes) {
    terminal.say(`  the app has not moved. this shot re-frames the last one, cropped to`);
    terminal.say(`  ${reframes}, for the sheet. nothing was clicked between the two.`);
  }
  // The walk is over, and the run does not end until you say so. Otherwise the last few stops of a
  // scenario are indistinguishable from its middle, and the only way to learn that a scenario had
  // finished was that the next one started.
  if (finished) {
    terminal.say(
      `  the scenario has ended. continue closes this run${
        sweep
          ? sweep.position < sweep.total
            ? ` and opens scenario ${sweep.position + 1} of ${sweep.total}`
            : ", the last of the sweep"
          : ""
      }.`,
    );
  }
  // A turn in flight is two different situations, and telling them apart is the difference between
  // a true warning and a false one. A turn parked on the drawer is *waiting for a person*, which is
  // exactly what a handover is, so it is still there when you resume however long you take. Only a
  // turn nothing is waiting on runs itself out while you read.
  if (now?.generating) {
    if (now.interactionKind) {
      terminal.say(
        `  the turn is parked on the ${now.interactionKind} drawer, waiting for an answer, so it is`,
      );
      terminal.say("  still in flight when you resume however long you take.");
    } else {
      terminal.say("  the turn keeps running while you read this. it will not be in flight when you");
      terminal.say("  resume, so anything the walk does next that needs it in flight will miss.");
    }
  }

  for (;;) {
    const choice = await terminal.choose("now what", [
      ...(resumable
        ? [
            {
              label: "continue",
              // There is no walk left to resume at the end of one, and an option that says there is
              // is the same small lie as a screen that stopped changing with no explanation.
              detail: finished ? "the walk is over: close this run and go on" : "resume the walk from here",
              value: "continue",
            },
          ]
        : []),
      {
        label: "close",
        detail: sweep
          ? "finish this run directory and go on to the next scenario"
          : "close the app and finish the run directory",
        value: "close",
      },
      { label: "shot", detail: "screenshot and state snapshot into the run directory", value: "shot" },
      { label: "state", detail: "print what the bridge sees right now", value: "state" },
      {
        label: "detach",
        detail: "leave the app running and exit the driver (nothing more is recorded)",
        value: "detach",
      },
    ]);

    if (choice === "shot") {
      const label = (await terminal.line("  label > ")) || "by hand";
      await shot(label);
      terminal.say(`  recorded "${label}"`);
      continue;
    }

    if (choice === "state") {
      const state = await snapshot();
      terminal.say(
        `  view ${state.viewOpen ? "open" : "closed"}, ` +
          `${state.messageCount} messages, ` +
          `${state.generating ? "generating" : "idle"}, ` +
          `interaction ${state.interactionKind ?? "none"}, ` +
          `${state.turnItems.length} turn items`,
      );
      continue;
    }

    return choice;
  }
}
