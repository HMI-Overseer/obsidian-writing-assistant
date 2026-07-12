import type { SyntheticVaultFixture } from "../sandbox/types";

export const METAMORPHIC_READ_CONTROL_FIXTURE: SyntheticVaultFixture = {
  schemaVersion: 1,
  id: "metamorphic-read-control-vault",
  version: 1,
  description: "Renamed path and fact variant of the explicit synthetic read control.",
  files: [
    {
      path: "People/Iris.md",
      content: "# Iris\n\nIris carries a silver key inherited from her uncle.",
    },
    {
      path: "Places/North Pier.md",
      content: "# North Pier\n\nThe lamps are lit before dusk.",
    },
  ],
};
