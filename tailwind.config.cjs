/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{ts,css}"],
  prefix: "lmsa-",
  corePlugins: {
    preflight: false,
  },
  theme: {
    extend: {
      colors: {
        obsidian: {
          accent: "var(--interactive-accent)",
          "accent-hover": "var(--interactive-accent-hover)",
          border: "var(--background-modifier-border)",
          "surface-primary": "var(--background-primary)",
          "surface-secondary": "var(--background-secondary)",
          text: "var(--text-normal)",
          muted: "var(--text-muted)",
        },
      },
      fontFamily: {
        interface: ["var(--font-interface)"],
      },
      boxShadow: {
        panel: "0 14px 40px rgba(0, 0, 0, 0.05)",
      },
    },
  },
};
