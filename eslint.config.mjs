import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";
import { DEFAULT_BRANDS } from "eslint-plugin-obsidianmd/dist/lib/rules/ui/brands.js";
import { DEFAULT_ACRONYMS } from "eslint-plugin-obsidianmd/dist/lib/rules/ui/acronyms.js";

// Why this config is shaped this way, why each rule below departs from `recommended`, and which
// "warn" severities are staged pending promotion to "error":
// docs/02-architecture/quality/lint-configuration.md
export default tseslint.config(
  ...obsidianmd.configs.recommended,
  {
    // Type-aware rules need parserOptions, which `recommended` does not supply. Scoped to TS so the
    // TS parser never sees package.json, which is linted with the JSON language.
    files: ["**/*.{ts,cts,mts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "obsidianmd/ui/sentence-case": ["error", {
        enforceCamelCaseLower: true,
        brands: [...DEFAULT_BRANDS, "LM Studio", "OpenAI", "Claude", "Claude Code", "Anthropic", "Electron"],
        acronyms: [...DEFAULT_ACRONYMS, "CORS", "TTL", "GPT", "LLM"],
        ignoreRegex: ["^sk-", "^https?://", "^\\d+\\s", "^e\\.g\\.\\s"],
      }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      eqeqeq: ["error", "always"],
      "@typescript-eslint/no-non-null-assertion": "warn",
      "@typescript-eslint/explicit-function-return-type": "off",
      "no-console": ["warn", { allow: ["error", "warn"] }],
      "import/no-extraneous-dependencies": "error",
      "obsidianmd/prefer-window-timers": "error",
      "@typescript-eslint/require-await": "error",
      "obsidianmd/prefer-active-doc": "error",
      "no-restricted-globals": "error",
      "obsidianmd/prefer-create-el": "error",

      // Staged. Options are written out only where a severity-only override would inherit an
      // unwanted one; see the doc's Gotchas.
      "@typescript-eslint/no-deprecated": "warn",
      "@typescript-eslint/no-explicit-any": ["warn", { fixToUnknown: false }],
    },
  },
  {
    // ADR-0025 (won't-fix): the two provider network paths, fetchRequest (non-streaming)
    // and streamFetch (streaming), must forward an AbortSignal that the composer Stop
    // control depends on. RequestUrlParam cannot express it (no signal, no cancellation),
    // and requestUrl buffers the whole body, which breaks SSE. CORS is already handled by
    // the separate bypassCors -> nodeRequest path, not requestUrl. Kept as a files-scoped
    // override (ADR-0024 mechanism; inline disable is itself an error under
    // eslint-comments/no-restricted-disable). See lint-configuration.md.
    files: ["src/api/httpTransport.ts", "src/api/streamingTransport.ts"],
    rules: {
      "no-restricted-globals": "off",
    },
  },
  {
    // ADR-0024 class 5 (the finding is false). prefer-active-doc flags the `document`
    // key of the `BenchmarkTestCase.document: string` interface field: the rule skips
    // object-literal Property keys but not TS TSPropertySignature keys, so it mistakes a
    // type-level field name for a global-`document` reference. There is no DOM access here
    // to redirect; obeying it would rename a correctly-named data field. Kept as a scoped
    // override rather than suppressed inline (ADR-0024 mechanism; inline disable is itself
    // an error under eslint-comments/no-restricted-disable). See lint-configuration.md.
    files: ["src/settings/benchmark/types.ts"],
    rules: {
      "obsidianmd/prefer-active-doc": "off",
    },
  },
  {
    // ADR-0026 (won't-fix): five createElement sites build DOM on a non-main-window
    // document (X.ownerDocument), which Phase 7's promoted prefer-active-doc requires
    // for popout safety. Obsidian's createEl helper cannot express that: Node.createEl
    // always appends to its receiver and the global createEl has no document parameter,
    // so neither can create a detached (or specific-sibling) element on that document.
    // Kept as a files-scoped override (ADR-0024 mechanism; inline disable is itself an
    // error under eslint-comments/no-restricted-disable). See lint-configuration.md.
    files: [
      "src/chat/composer/ChatComposer.ts",
      "src/chat/messages/DiffHunkView.ts",
      "src/chat/models/ProfileSelectorUI.ts",
      "src/editing/inlineDiff/inlineDiffState.ts",
    ],
    rules: {
      "obsidianmd/prefer-create-el": "off",
    },
  },
  {
    ignores: ["main.js", "node_modules/", "esbuild.config.mjs"],
  }
);
