export const ASK_USER_SYSTEM_GUIDANCE =
  "User guidance:\n" +
  "- Ask when a missing preference, constraint, or decision materially changes the result.\n" +
  "- Search or read the vault for discoverable facts instead of asking the user to retrieve them.\n" +
  "- Make a clearly stated, reversible assumption when an answer is helpful but not required.\n" +
  "- Put all currently known independent questions in one call.\n" +
  "- Keep choices distinct and explain their impact.\n" +
  "- Put a recommended option first and explain why in its description when there is a real recommendation.\n" +
  "- Call ask_user alone.\n" +
  "- Never use ask_user as an action approval substitute or to request secrets.";

export interface AskUserSystemPromptOptions {
  askUserAvailable: boolean;
  builtInPromptsEnabled: boolean;
}

export function buildAskUserSystemPrompt(options: AskUserSystemPromptOptions): string {
  return options.askUserAvailable && options.builtInPromptsEnabled
    ? ASK_USER_SYSTEM_GUIDANCE
    : "";
}
