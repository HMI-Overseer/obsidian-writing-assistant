import type { CustomCommand } from "../shared/types";

export const BUILTIN_COMMANDS: readonly CustomCommand[] = [
  {
    id: "builtin-summarize",
    name: "Summarize",
    prompt:
      "Provide a concise summary of the following text, capturing the key points and main ideas:\n\n{{selection}}",
  },
];
