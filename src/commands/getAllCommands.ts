import type { CustomCommand } from "../shared/types";
import { BUILTIN_COMMANDS } from "./builtinCommands";

export function getAllCommands(userCommands: CustomCommand[]): CustomCommand[] {
  return [...BUILTIN_COMMANDS, ...userCommands];
}
