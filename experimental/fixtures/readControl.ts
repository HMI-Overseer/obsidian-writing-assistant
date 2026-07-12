import type { SyntheticVaultFixture } from "../sandbox/types";

export const READ_CONTROL_FIXTURE: SyntheticVaultFixture = {
  schemaVersion: 1,
  id: "read-control-vault",
  version: 1,
  description: "Small synthetic vault for validating isolated note reads.",
  files: [
    {
      path: "Characters/Mara.md",
      content: "# Mara\n\nMara carries a brass compass inherited from her grandmother.",
    },
    {
      path: "Locations/Old Harbor.md",
      content: "# Old Harbor\n\nThe harbor bell rings at sunset.",
    },
  ],
};
