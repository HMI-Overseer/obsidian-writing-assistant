import type { SyntheticVaultFixture } from "../sandbox/types";

export const WRITE_CONTROL_FIXTURE: SyntheticVaultFixture = {
  schemaVersion: 1,
  id: "write-control-vault",
  version: 1,
  description: "Small synthetic vault for replaying one reviewed note overwrite.",
  files: [
    {
      path: "Projects/Lighthouse.md",
      content: "# Lighthouse\n\nStatus: draft\n",
    },
  ],
};
