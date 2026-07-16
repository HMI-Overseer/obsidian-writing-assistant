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

      // Staged. Options are written out only where a severity-only override would inherit an
      // unwanted one; see the doc's Gotchas.
      "@typescript-eslint/no-deprecated": "warn",
      "@typescript-eslint/no-explicit-any": ["warn", { fixToUnknown: false }],
      "obsidianmd/prefer-active-doc": "warn",
      "obsidianmd/prefer-create-el": "warn",
      "no-restricted-globals": "warn",
    },
  },
  {
    ignores: ["main.js", "node_modules/", "esbuild.config.mjs"],
  }
);
