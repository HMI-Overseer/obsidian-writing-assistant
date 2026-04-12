import type { CustomCommand } from "../shared/types";

export interface CommandCategory {
  label: string;
  commands: readonly CustomCommand[];
}

export const BUILTIN_COMMAND_CATEGORIES: readonly CommandCategory[] = [
  {
    label: "Revision",
    commands: [
      {
        id: "builtin-tighten",
        name: "Tighten",
        icon: "scissors",
        prompt:
          "Rewrite the following more concisely — cut filler words and redundancy while preserving the meaning and tone:\n\n{{selection}}",
      },
      {
        id: "builtin-expand",
        name: "Expand",
        icon: "unfold-vertical",
        prompt:
          "Expand the following with richer detail, description, or supporting points:\n\n{{selection}}",
      },
      {
        id: "builtin-fix-prose",
        name: "Fix prose",
        icon: "spell-check",
        prompt:
          "Fix grammar, spelling, and punctuation in the following text — correct mistakes only, don't restyle:\n\n{{selection}}",
      },
      {
        id: "builtin-simplify",
        name: "Simplify",
        icon: "minimize-2",
        prompt:
          "Rewrite the following in plainer, more direct language:\n\n{{selection}}",
      },
    ],
  },
  {
    label: "Creative",
    commands: [
      {
        id: "builtin-continue",
        name: "Continue",
        icon: "arrow-right",
        prompt:
          "Continue writing from where the note leaves off, matching the existing style and voice:\n\n{{note}}",
      },
      {
        id: "builtin-brainstorm",
        name: "Brainstorm",
        icon: "lightbulb",
        prompt:
          "Suggest 5 different directions I could take the following text next:\n\n{{selection}}",
      },
      {
        id: "builtin-show-dont-tell",
        name: "Show don't tell",
        icon: "eye",
        prompt:
          "Rewrite the following to show rather than tell, using concrete sensory details:\n\n{{selection}}",
      },
    ],
  },
  {
    label: "Analysis",
    commands: [
      {
        id: "builtin-summarize",
        name: "Summarize",
        icon: "list",
        prompt:
          "Provide a concise summary of the following text, capturing the key points and main ideas:\n\n{{selection}}",
      },
      {
        id: "builtin-critique",
        name: "Critique",
        icon: "message-circle",
        prompt:
          "Give constructive feedback on the following — what works, what doesn't, and specific suggestions for improvement:\n\n{{selection}}",
      },
    ],
  },
];

export const BUILTIN_COMMANDS: readonly CustomCommand[] =
  BUILTIN_COMMAND_CATEGORIES.flatMap((c) => c.commands);
