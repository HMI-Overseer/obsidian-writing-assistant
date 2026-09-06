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

**Status: Stage 3, live mode, 2026-07-31.** Ten scripted scenarios over the composer, the
transcript, the turn timeline, approvals, and the `ask_user` drawer, one of which
([`readme-showcase`](scenarios/readme-showcase.mjs)) takes the pictures in the top-level README,
plus three that run against a real provider, including RFC-0011's live Obsidian walk. See
[the implementation plan](../../docs/work/plans/2026-07-30-live-scenario-driver-plan.md) and
[dev/readme](../readme/README.md).

## Usage

```
npm run drive                # ask what to do
npm run drive -- --last      # repeat the previous run's choices
npm run drive -- --no-build  # reuse the artifacts already on disk
```

Every question is a list you move through with the **arrow keys** (or `wasd`, or `jk`) and confirm
with **enter**. Entries are still numbered and a number still jumps to one: type `1`, or `1` then
`1` for entry 11, and the highlight moves as you type so what a number means is visible before enter
commits it. The list is replaced by the answer once it is chosen, so a session's scrollback is what
was picked rather than every menu it was picked from.

**Ctrl-C** ends a run. At a question it unwinds: the app closes and the run directory is finished
like any other ending. Away from one it stops the app before it stops the driver, because the app is
launched detached and would otherwise outlive it. Anything else typed while the driver is not asking
is discarded at the moment it arrives, never held to answer the next question with.

If stdin is not a terminal (a pipe, a CI job), the same lists are printed numbered and read a line
at a time. Answers may arrive ahead of their questions, one per line, and are held until asked for,
so `printf '2
11
1
' | npm run drive -- --no-build` is a complete run. Nothing else changes.

The first question is what to do:

```
  scenario
  arrows or wasd to move, a number to jump, enter to choose

    everything at once
  >  1) sweep the scenarios               9 runs in series, one directory each, no tokens spent
     2) sweep the instrument's own alarms 2 runs that must fail. run this after changing the driver.

    simulated, authored frames. free, repeatable, and where most defects turn up
     3) abort-mid-turn                 Stop a streaming turn from the composer, and read what it settled as.
     4) approval-approve               A write_file stopped at the ask gate, approved in the composer drawer.
     ...
    11) regenerate-settled-turn        Settle a turn, then regenerate it from the bubble's own action toolbar.

    live, a real provider. real tokens or a real local model, and not repeatable
    12) live-orphan-recovery           Approve a write, kill the renderer under it, and read what recovery left.
    13) live-rfc0011-walk              RFC-0011's live Obsidian walk: search, write, approve, stop, re-send.
    14) live-tool-turn                 A real model, asked to read a note and answer from it. The matrix scenario.

    the instrument's own alarms. these are meant to fail, and have a sweep of their own
    15) _selftest-missed-click         Clicks a selector that does not exist. Must fail visibly.
    16) _selftest-missing-checkpoint   Waits for a turn it never starts. Must fail visibly.
```

A list taller than the window scrolls with the highlight, and says how many entries are hidden above
and below it rather than quietly showing the first ten.

What a choice costs is a **group**, not a word inside a description. Simulated first, because that
is where most defects turn up and none of it spends anything; live second; the instrument's own
alarms last, so nothing that is meant to fail sits at entry 1 where somebody picks it by accident.

### Sweeping them all

The first entry runs every scenario that is meant to complete, in series, one seeded vault and one
launch each, and writes a sheet above them. It is the answer to "I want to look at everything and
see what broke", and it is an entry in the list rather than a flag for the same reason the matrix
is:

```
dev/driver/out/<timestamp>-sweep-simulated/index.html
```

That sheet is a table of every scenario's outcome plus **the last picture each one reached**, side
by side, so one page shows the whole surface. Each row links into that scenario's own run
directory.

A failing scenario does **not** stop the sweep. Stopping would hide every scenario after the first
defect, which is the opposite of what a sweep is for.

**The self-tests are a sweep of their own**, and the second entry is it. They are meant to fail, so
a sweep run to look for defects in the *application* should not spend two of its launches, and two
of its breakpoints under pause mode, on runs whose failure means nothing is wrong. They keep an
entry because the question they ask ("does this still notice a missed click") is worth asking after
any change to the driver, and a check nobody can find in a list is a check nobody runs. What the
scenario sweep therefore no longer covers is printed on its own sheet rather than left to be
assumed.

Either way the expectation is inverted rather than skipped: a scenario declaring `mustFail` reads as
`failed as designed`, and one that *completes* reads as `passed, so the instrument has stopped
noticing`, in the same red as any other gap. A sweep's exit code counts only the scenarios that did
not do what they said they would.

Live scenarios are not swept: each needs a model chosen and spends real tokens, so they are run one
at a time. A model sweep is what the matrix is for.

**Theme is a run's identity, not a matrix axis.** A run directory records one theme and its sheet
prints one, so "in both themes" is two runs, and there is no `--themes` flag. `--last` already
repeats every choice including the theme, so running the other one costs a single picker pass, and
an unattended sweep writes `.last.json` per run.

There is no `--sandbox`, no `--keep-open`, and no `--clean`. Those are modes, and a mode that
exists only as a flag is a mode nobody finds. Flags only ever repeat a choice already made.

A run opens a real Obsidian window under a scratch profile in the OS temp directory. The
maintainer's own Obsidian can stay open throughout: the profile, its registered vaults, and its
plugin settings are never touched.

### Driving by hand

Sandbox is the mode to reach for when the question is "what does this actually do". It seeds a
disposable vault, launches it, optionally arms a scripted provider, and hands the app over:

```
  the app is yours

    vault    C:\Users\...\Temp\lmsa-driver-y9FbCt\vault
    profile  C:\Users\...\Temp\lmsa-driver-y9FbCt\profile
    run      dev\driver\out\20260731-133325-sandbox-writing-basic
    provider scripted, prose-turn

  now what
    1) close   close the app and finish the run directory
    2) shot    screenshot and state snapshot into the run directory
    3) state   print what the bridge sees right now
    4) detach  leave the app running and exit the driver (nothing more is recorded)
```

The driver holds its connection while you drive, so console capture, `state()`, and labelled shots
keep working. The vault is throwaway: write to it, break it, delete notes in it.

Pause mode turns every `shot()` in a scenario into a breakpoint, which is how you take over from a
state a scenario built rather than one you had to reach by hand. Takeover does the same at the end.
Inside a sweep the header says which scenario of how many you are stopped in, and `close` there
finishes that run and goes on to the next rather than ending everything.

**One kind of moment is not a breakpoint**, and a scenario declares it:

```js
await app.shot("streaming, with the send button showing stop", {
  perishable: "a turn that is still streaming, which the stop below needs",
});
```

A handover does not pause the application. A turn that is streaming when the console opens has
settled by the time anyone continues, so a breakpoint there guarantees the step after it fails, for
a reason belonging to the instrument rather than to the app. Pause mode declines to stop, names what
the moment held, and takes the shot anyway: what perishes is the chance to sit in the state, not the
evidence of it. Sandbox mode is where you sit in one.

A review parked at an approval gate is the opposite and is deliberately not declared. It waits for a
person, which is exactly what a handover is.

**Two things a breakpoint tells you when continuing appears to do nothing.** Most scenarios end by
shooting the whole window and then the transcript alone, so the next breakpoint is the same moment
in a tighter frame, and it says so:

```
  the app has not moved. this shot re-frames the last one, cropped to
  .lmsa-root, for the sheet. nothing was clicked between the two.
```

It is measured, not assumed: a shot counts as a re-framing only when it is scoped **and** the
bridge's state is unchanged since the previous one. A scoped shot after something happened is a new
moment, and an unscoped shot with an unchanged state is the opposite case, a hover or a selected
radio that the bridge cannot see and the picture is the only evidence of.

Pause mode also stops at the end of the walk and says it is the end:

```
  the scenario has ended. continue closes this run and opens scenario 4 of 9.
```

While a walk is running, one line at the bottom says what it is waiting on and for how long, and
takes itself back when the wait is over. It appears a second in, so a step that takes 40ms prints
nothing and a step that has stopped arriving names itself. A click at a selector that does not exist
waits 15 seconds and a checkpoint that never comes waits five minutes; both used to be silent, and
silence from an instrument is indistinguishable from a wedged terminal.

`npm run drive` builds the **release** bundle, because there is no special build any more, so a run
leaves a production artifact in place rather than a development one.

Output lands in `dev/driver/out/` (gitignored):

```
out/index.html                every retained run, newest first
out/<timestamp>-<scenario>/
  index.html                  the review sheet
  manifest.json               scenario, engines, pinned asar, build hashes, steps, console count
  shots/                      one PNG per shot, labelled with the checkpoint it followed
  state/                      the bridge's structured readout beside each shot
  transcript.json             the conversation as the plugin stored it
  transcript.canonical.json   the same, with generated identity and wall clock removed
  state.json                  the bridge's structured readout at the end of the scenario
  console.log                 renderer console and uncaught errors, from attachment onward
```

The run directory is written as the scenario proceeds, not buffered to the end, so a run that dies
partway leaves its artifacts on disk with a manifest that says it is incomplete and a sheet that
shows where it stopped. Those are the runs most worth reading.

Every shot on the sheet carries the bridge's readout taken with it: whether a turn was generating,
what it had settled as, what the composer drawer was asking, and every turn item with a tool
step's arguments and its result. The sheet ends on the turn as the run left it. That is what makes
a verdict on a tool step, an approval, or an aborted turn reachable without opening Obsidian,
which is the whole of Stage 2's gate.

### Live mode

A live scenario names a provider *kind*, never a model, and often not even that:

```js
provider: { kind: "live" }                       // ask for provider and model
provider: { kind: "live", only: "claudecode" }   // harness-specific, ask for the model only
```

The picker's list comes from the running app. `selectableModels()` reaches the chat selector's own
`getModels` closure, so the driver reads through `getSelectableCompletionModels()` like every other
consumer of "what models can I pick"; composing a second answer from settings would make provider
enablement advisory, which is the invariant that module states. That is also why an Obsidian window
opens *before* the terminal asks anything, and why it closes again once the answer is in. The
driver says so first, and `--last` skips that launch entirely for a model you have already chosen.

```
  live-tool-turn runs live, so it needs a real model.
  Provider settings and credentials come from ...\data.json.
  Obsidian opens now so the app itself can say what you can pick, then closes.

  provider
    1) lmstudio    5 models, 1 reachable
    2) claudecode  4 models, 4 reachable
  > 1

  model
    1) all 1 reachable models from lmstudio, as a matrix   4 skipped, not reachable
    2) gemma4-26b-a4b-uncensored-hauhaucs-balanced         loaded, tools, vision, 37k
    3) qwen/qwen3.5-9b                                     not loaded, fails the preflight
```

**Credentials come from the installed plugin's own `data.json`.** This repository *is* the
installed plugin, so that file is beside the build the driver installs, it is gitignored, and it is
already the answer to "which providers are configured on this machine". Two consequences, both
deliberate: the **scratch vault** holds real credentials for the life of the run, under the OS temp
directory with the rest of the profile, and the **run directory does not**. A manifest records that
credentials came from the installed plugin, never the patch itself.

**A model is checked before the walk, not during it.** LM Studio's catalog is a last-seen cache, so
a model can be selectable and not loaded. The preflight resolves the chosen model against the app
that is about to walk and fails there, with a plain reason, rather than halfway through a scenario
that then reads as a defect in the plugin. Its honest limit is stated where it is decided: a cloud
model reports reachable with no network call, so a wrong key still surfaces mid-turn.

The model is then selected **through the real UI**, four real clicks and real typing on the rail,
the search field, and the row, and the app is asked what it resolved. A run that resolved something
other than what was asked for stops there rather than walking under the wrong label.

A live run **arms no script**: a real model decides how many rounds a turn has, so the epilogue is
never appended and the installed artifact is the release build untouched. Its manifest says
`repeatable: false`, because a live run's whole value is that it caught something that cannot be
recreated.

**Matrix mode is an entry in the model list, not a flag.** It writes one run directory per model
plus a sheet above them placing the same shot from every model side by side. A model the preflight
refused is a **column**, not an omission, naming why it was not run: "not judged" and "judged and
did badly" are different findings, and the standing judgements about local models in this project
are suspect precisely because nobody can now reconstruct which was which.

### Cleaning up

A run leaves a scratch profile and vault in the OS temp directory, 40 to 47 MB apiece, and nothing
removes them on its own. That is deliberate: sandbox mode exists so the vault survives for
inspection, and `detach` leaves a real Obsidian running on one. So retention is explicit, and the
clean mode lists what has accumulated and asks. A scratch root the driver detached from is listed
and left alone. Every run ends by saying how much is sitting there.

## How it is put together

| Piece | What it is |
|---|---|
| `run.mjs` | build, seed, launch, attach, then walk or hand over |
| `lib/picker.mjs` | who owns stdin, the status line, Ctrl-C, and `--last` |
| `lib/menu.mjs` | the menu itself: keys in, lines out, and nothing else |
| `lib/handoff.mjs` | hand the app over and wait for the terminal |
| `lib/clean.mjs` | what has accumulated, and the mode that removes it |
| `lib/seed.mjs` | the launch and seeding recipe, in RFC-0013's own order |
| `lib/liveSettings.mjs` | what a live run boots on, out of the installed plugin's own settings |
| `lib/models.mjs` | the model question, the reachability preflight, and selecting one by hand |
| `lib/bridge.mjs` | `window.__lmsaDriver`, injected: the shape assertion, and the checkpoint engine |
| `lib/scenario.mjs` | the scenario shape validated before anything launches, and how the list reads |
| `lib/scenarioApi.mjs` | what a scenario is handed: real input out, structured state back |
| `lib/runDirectory.mjs` | the step ledger, written as the run proceeds |
| `lib/sheet.mjs` | the review sheet and the index over runs |
| `lib/scriptedProvider.mjs` | the deterministic provider, and the epilogue that installs it |
| `lib/script.mjs` | the frame schema and its validator |
| `lib/canonical.mjs` | the comparison form two runs are diffed in |
| `scenarios/*.mjs` | the walks, versioned with the code they exercise |
| `frames/*.json` | authored provider-neutral fact streams, never captured |
| `fixtures/*/` | disposable vault contents plus the plugin settings baseline |
| `../lib/contactSheet.mjs` | the sheet frame this shares with `dev/visual` |

The division of labour is a rule, not a preference:

> **Drive through the real UI. Observe and set up through the bridge.**

Interaction is real keys, clicks, and hover against real DOM, because interaction fidelity is the
entire reason for driving the live app. `ChatView.seedPrompt` exists and is tempting; it is not
used, because a scenario that seeds the composer through a method is not exercising the composer.
Readout is structured state from the bridge, because scraping rendered DOM is how these harnesses
become brittle and start lying.

## Nothing here is in the plugin

The plugin's source, build, lint config, and test config carry **nothing** for the driver. No
`src/dev/`, no `DEV_DRIVER` define, no guarded call sites, no driver build.

The bridge is injected over CDP and reaches for `view.sessionStore`, `view.orchestrator`, and
`view.interactionHost`, which are ordinary properties at run time because TypeScript's `private` is
erased. The scripted provider is an epilogue appended to the *installed copy* of `main.js`, which
reassigns the bundle's own `createChatClient` binding, redirecting all eight call sites at once.

Both of those reach by name, and nothing typechecks them, so **both assert what they expect and
fail the run naming the path they could not find**, one before the launch and one right after
attach:

```
dev/driver bridge: the plugin no longer exposes app.plugins.plugins["writing-assistant-chat"],
plugin.activateChatView. The driver reaches for these by name, so a rename lands here.
Fix dev/driver/lib/bridge.mjs.
```

Those assertions are load-bearing, not decoration. They are the only thing standing between a
renamed field and a driver that screenshots the wrong state while looking healthy. Do not weaken
one to make a run go green; fix the reach, or change what the driver depends on.

## Checkpoints, and the one thing this asserts

A scenario never waits out a duration. `app.awaitCheckpoint(name)` resolves when a named
predicate over the bridge's `state()` becomes true, re-evaluated on a `MutationObserver` plus a
low-frequency backstop, so nothing can fire early and there is no cadence to tune.

Shipped, and as of Stage 2 all seven have been observed arriving in a real run:
`plugin-ready`, `view-open`, `turn-started`, `approval-raised`, `ask-raised`,
`interaction-submitted`, `turn-settled`. Each names a state that persists rather than a moment
that passes, because a predicate is edge-blind: anything that appears and disappears between two
evaluations is invisible to it. `frame-published`, `tool-step-rendered`, and `run-quiesced` are
therefore **unavailable**, and asking for one fails naming the reason. Every manifest carries that
list, so a run states what the instrument could not observe rather than leaving it inferred. A
scenario author who reaches for a transient state records the gap; a sleep would reintroduce
exactly the flakiness this design removes.

Two of the seven describe a change rather than a condition, so they compare against a baseline:
**the state before the last action the scenario took**, not the state when the wait began. The
difference only shows up when something happens in between, and pause mode is where it does: a
breakpoint at a mid-turn shot hands the app over, the turn settles while you look at it, and a
wait that sampled afterwards could never see the change and would run to its ceiling in silence. A
shot deliberately does not move the baseline; observing is not acting.

`turn-settled` also compares **which** revisions are settled, not how many: a regeneration replaces
the active revision of a message that already counted, so a count predicate waits out its whole
timeout on a turn that has finished. Both are still reads, so plan decision D12's reserve (wrapping
the app's own methods to observe true edges) stays unspent.

**Pausing does not stop the application.** A turn keeps streaming while you read the handover
banner, which now says so when one is in flight. Anything the walk does next that needs a transient
affordance, the stop button on `abort-mid-turn` being the clearest case, will miss it and fail
loudly. That is inherent: freezing a provider mid-stream would destroy the real settlement the
scenario exists to exercise.

That gives the driver its one assertion, and it is not about content:

> A checkpoint that does not arrive within its timeout fails the run loudly, marks the scenario
> incomplete, and the review sheet renders it as a red gap rather than omitting it.

Arrival is asserted. Correctness is not. Every shot carries the checkpoint it followed, so a
picture is never separated from its claim about when it was taken. Two committed scenarios keep
that mechanism honest and are **meant to fail**: `_selftest-missed-click` clicks a selector that
does not exist, and `_selftest-missing-checkpoint` waits for a turn it never starts. Run either
after a refactor; if it passes, the instrument has stopped noticing.

## Frames are authored, never captured

A frame is one transport frame's worth of provider-neutral facts, the same unit the capture layer
carries (ADR-0031). Scripts hold real fixture prose and paths that exist inside the fixture vault.

`tests/fixtures/provider-capture/` cannot supply them: those are sanitized, deliberately
content-free protocol-shape fixtures for the Claude translator, carrying `fixture-model` and
`fixture-path` and no prose at all, and they are consumed below the `ChatClient` seam. Replaying
one would produce a timeline with no prose and paths that exist in no vault.

Because the fact stream is provider-neutral at that seam, one script drives any provider, and
because the scripted client goes through the production `createOwnedStreamRun` and
`createCaptureBatch` rather than around them, cancellation and capture identity are real:
`abort-mid-turn` exercises ADR-0032 settlement and settles `proven`, `duplicate-frame` drives
ADR-0031 redelivery, and `capture-conflict` drives its fingerprint mismatch through to a failed
turn carrying the real diagnostic.

**A script is also a list of rounds.** One `ChatClient.stream()` call is one provider response,
and the agentic loop makes one per round, so the frames are partitioned at the `turn_end` fact
that already means "this response ended". The validator insists on it: `turn_end` must be the last
fact of its frame and the last frame must carry one, so a round boundary is never ambiguous. A
client that replayed its whole script on every call would spin a tool-bearing scenario to the
round cap; one that runs out of rounds fails naming the script and the round the app asked for.
Each round declares its own stop reason and its own tool correlation, derived from its own facts.

## What a scripted run does and does not prove

It proves the plugin. It says nothing about whether a real provider still emits those frames. A
live run is the other half and proves nothing twice: it cannot be re-run. The manifest records
which mode ran and whether the run is repeatable, which is what keeps both honest.

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
- **A live run's scratch vault holds real credentials.** It is a copy of the installed plugin's
  provider settings, in the OS temp directory, for the life of the run. The clean mode removes it,
  and a run that is detached from is left alone, so an abandoned detach leaves a vault with a key in
  it until it is cleaned by hand.
- **A live run costs real tokens, or a real local model.** The picker asks, and only ever asks; no
  flag reaches a provider a choice has not been made about. `--last` repeats a spend, so
  `.last.json` is left holding a self-test rather than a live scenario.
- **A cloud model's reachability is not checked.** The preflight asks the app, and the app
  short-circuits every cloud provider to reachable with no network call. A wrong or expired key
  surfaces mid-turn, and the run directory shows where it did.
