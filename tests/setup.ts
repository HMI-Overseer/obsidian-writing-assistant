// Obsidian plugins run in an Electron renderer, where `window` and the global object are the
// same object. Vitest runs in Node, which supplies the timer functions as globals but has no
// `window` binding, so renderer code calling `window.setTimeout` throws here.
//
// Aliasing the two restates that identity rather than emulating a DOM: every `window.X`
// resolves to exactly the binding a bare `X` already resolved to, so this cannot make a test
// pass that the global alone would not. Keeps the Node environment (no jsdom) intact.
(globalThis as { window?: typeof globalThis }).window ??= globalThis;
