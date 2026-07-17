/** @type {import('stylelint').Config} */
export default {
  // Discovery aid for the Obsidian review's CSS findings, not parity with its
  // bot (its exact config is unpublished). Warnings only; rules never gate.
  defaultSeverity: "warning",
  // Lint source CSS, never the built bundle (its counts differ post-Tailwind).
  ignoreFiles: ["styles.css"],
  rules: {
    "declaration-no-important": true, // load-bearing anti-collision overrides; surface, do not force
    "declaration-block-no-duplicate-properties": true, // duplicate right/left (some are anchor() fallbacks)
    "selector-pseudo-class-disallowed-list": ["has"], // deterministic :has flag, avoids browserslist guessing
  },
};
