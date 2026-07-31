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
 * Blocks until the maintainer says what to do next.
 *
 * @returns "continue" to resume a walk, "close" to shut the app down and finish the run
 *   directory, or "detach" to leave the app running and exit the driver.
 */
export async function handOver({ terminal, seeded, record, shot, snapshot, resumable, at, provider }) {
  terminal.say("");
  terminal.say("  ────────────────────────────────────────────────────────────");
  terminal.say(`  the app is yours${at ? `, at ${at}` : ""}`);
  terminal.say("");
  terminal.say(`    vault    ${seeded.vaultDir}`);
  terminal.say(`    profile  ${seeded.profileDir}`);
  terminal.say(`    run      ${record.dir}`);
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
  if (now?.generating) {
    terminal.say("  the turn keeps running while you read this. it will not be in flight when you");
    terminal.say("  resume, so anything the walk does next that needs it in flight will miss.");
  }

  for (;;) {
    const choice = await terminal.choose("now what", [
      ...(resumable
        ? [{ label: "continue", detail: "resume the walk from here", value: "continue" }]
        : []),
      { label: "close", detail: "close the app and finish the run directory", value: "close" },
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
