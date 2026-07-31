# Live scenario driver

Launches the **real Obsidian** under an isolated profile, attaches over the Chrome DevTools
Protocol, and walks the plugin through a scripted scenario against a seeded disposable vault,
writing every step to a re-readable run directory. Implements [RFC-0013](../../docs/work/rfcs/RFC-0013-live-scenario-driver.md).

Sibling of [`dev/visual`](../visual/README.md), same stance: **it produces evidence, the
maintainer produces the verdict.** No assertions about content, no pass/fail, no CI. The one
thing it does assert is that a wait it was told to make actually arrived, because a walk whose
click missed will otherwise screenshot a perfectly plausible earlier state under the label of a
later one.

The two instruments do not overlap. `dev/visual` renders hand-written static HTML against real
Obsidian CSS and never executes the plugin's own render code, so it is structurally blind to any
change in how the plugin builds DOM. This runs the assembled application.

**Status: Stage 0, the spike.** One hardcoded walk, no picker and no scenario loader. Stage 0 is
a withdrawal gate rather than a phase: it exists to show that launch, attach, and drive hold
together well enough to produce two runs a person can compare. The scenario loader, checkpoint
engine, review sheet, and live mode are Stages 1 to 3 of
[the implementation plan](../../docs/work/plans/2026-07-30-live-scenario-driver-plan.md).

## Usage

```
npm run drive                     # build, seed, launch, walk, write a run directory
npm run drive -- --no-build       # reuse the artifacts already on disk
npm run drive -- --theme light    # pin the theme (a run never inherits a profile default)
```

A run opens a real Obsidian window under a scratch profile in the OS temp directory. The
maintainer's own Obsidian can stay open throughout: the profile, its registered vaults, and its
plugin settings are never touched.

`npm run drive` builds first, and it builds the **development** bundle, because a production
build compiles the driver out by design. The gate at the end of a working session is
`npm run build`, which puts the release artifact back in place.

Output lands in `dev/driver/out/` (gitignored):

```
out/<timestamp>-<scenario>/
  manifest.json               scenario, engines, pinned asar, build hashes, waits, console count
  shots/                      one PNG per step, named for the wait it followed
  transcript.json             the conversation as the plugin stored it
  transcript.canonical.json   the same, with generated identity and wall clock removed
  state.json                  the bridge's structured readout at the end of the walk
  console.log                 renderer console and uncaught errors, from attachment onward
```

The run directory is written as the walk proceeds, not buffered to the end, so a run that dies
partway leaves its artifacts on disk with a manifest that says it is incomplete. Those are the
runs most worth reading.

## How it is put together

| Piece | What it is |
|---|---|
| `run.mjs` | the walk: build, seed, launch, attach, drive, record |
| `lib/seed.mjs` | the eight-step launch and seeding recipe, in RFC-0013's own order |
| `lib/canonical.mjs` | the comparison form two runs are diffed in |
| `frames/*.json` | authored provider-neutral fact streams, never captured |
| `fixtures/*/` | disposable vault contents plus the plugin settings baseline |
| `src/dev/driverBridge.ts` | `window.__lmsaDriver`, the setup and readout seam |
| `src/dev/scriptedChatClient.ts` | the deterministic provider, installed at `createChatClient()` |

The division of labour is a rule, not a preference:

> **Drive through the real UI. Observe and set up through the bridge.**

Interaction is real keys, clicks, and hover against real DOM, because interaction fidelity is the
entire reason for driving the live app. `ChatView.seedPrompt` exists and is tempting; it is not
used, because a scenario that seeds the composer through a method is not exercising the composer.
Readout is structured state from the bridge, because scraping rendered DOM is how these harnesses
become brittle and start lying.

Everything under `src/dev/` is behind the `DEV_DRIVER` compile-time constant, defined as a literal
`false` for a release build, so the bridge and the scripted provider are absent from a shipped
plugin rather than merely unreachable in it.

## Frames are authored, never captured

A frame is one transport frame's worth of provider-neutral facts, the same unit the capture layer
carries (ADR-0031). Scripts hold real fixture prose and paths that exist inside the fixture vault.

`tests/fixtures/provider-capture/` cannot supply them: those are sanitized, deliberately
content-free protocol-shape fixtures for the Claude translator, carrying `fixture-model` and
`fixture-path` and no prose at all, and they are consumed below the `ChatClient` seam. Replaying
one would produce a timeline with no prose and paths that exist in no vault.

Because the fact stream is provider-neutral at that seam, one script drives any provider, and
because the scripted client goes through the production `createOwnedStreamRun` and
`createCaptureBatch` rather than around them, cancellation and capture identity are real: an
abort-mid-turn scenario exercises ADR-0032 settlement, and a script that repeats a frame key
drives ADR-0031 redelivery.

## What a scripted run does and does not prove

It proves the plugin. It says nothing about whether a real provider still emits those frames.
The manifest records which mode ran, which is what keeps that honest. Live mode is Stage 3.

## Standing hazards

- **Obsidian internals carry no compatibility promise.** The `obsidian.json` vault registry and
  the `enable-plugin-<vaultId>` trust key are both internal. Pinning the asar contains this by
  making the version an explicit recorded choice, but an upgrade will eventually cost repair
  work, and the repair surfaces as this spike no longer running.
- **Scenarios bind to CSS class names and will drift.** The loud-arrival-failure rule keeps the
  drift visible, which is the important half; the repair cost is real and recurring.
- **Runs are slow.** A real Obsidian launch per run is seconds. This is not an inner loop and
  must not be sold as one. The fast loops stay the unit tests and the visual harness.
- **The fixture vault will accrete.** Every scenario is tempted to add a note. Each note added
  should name the scenario that needs it.
