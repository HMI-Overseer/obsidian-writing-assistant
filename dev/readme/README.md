# README assets

The pictures in the top-level [README](../../README.md) are taken from the running plugin by the
[live scenario driver](../driver/README.md), not drawn or mocked. They live in `assets/readme/` and
are committed, because the README is read on GitHub and in Obsidian's plugin browser, neither of
which can run the driver.

## Refreshing them

```
npm run drive               # choose "walk", then the readme-showcase scenario, then dark
npm run readme:assets       # copies the shots and encodes the animation from that run
```

The scenario is [`readme-showcase`](../driver/scenarios/readme-showcase.mjs). It seeds the
[`readme-showcase`](../driver/fixtures/readme-showcase/) fixture vault, resizes the window, opens a
chapter, and walks four scripted turns: a chapter checked against the research notes it is meant
to respect, an edit that brings it in line and stops for review, a synthesis note that stops at the
same gate, and a comparison table with a list, bold runs, and a link, which is what the theme
pictures are taken on because those are what a theme restyles. The vault is a small research-and-draft project for a story set in Saturn's rings;
its Research notes carry the figures of the Wikipedia articles they were clipped from, and every
figure the assistant states comes from them. The first turn is recorded frame by frame for the
animation.

The theme pictures switch the finished conversation through Obsidian's light theme and three
community themes: Minimal, Things, and Obsidian gruvbox. Those are copied at run time from the vault
this repository is installed in (`.obsidian/themes`, two directories up) and are never committed;
install them in Obsidian first, and the scenario names any that are missing.

[`assemble.mjs`](./assemble.mjs) takes the newest complete run of that scenario and writes
`assets/readme/`. Pictures are picked by the shot's label, so adding a shot to the scenario does not
move any README image; changing a label does, and the assembler says which label it could not find.

Refresh them when the chat surface changes in a way a reader would notice. A README whose pictures
show a control the plugin no longer has is the same kind of lie the driver exists to remove.

## What is and is not real in them

The assistant's prose is scripted, in [`frames/readme-*.json`](../driver/frames/). Everything the
plugin does with it is real: the reads run against the fixture vault, the edit goes through the
review pipeline and lands in the open editor, and the synthesis note is created on disk after
approval. The model name in the header is a display name on a fixture entry; no request reaches a provider.
