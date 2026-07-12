import { describe, expect, it } from "vitest";
import { READ_CONTROL_FIXTURE } from "../../../experimental/fixtures/readControl";
import { SyntheticVault } from "../../../experimental/sandbox/syntheticVault";
import { SandboxToolRegistry } from "../../../experimental/sandbox/toolRegistry";

describe("SandboxToolRegistry", () => {
  it("advertises and executes only the production read_file contract", async () => {
    const vault = new SyntheticVault(READ_CONTROL_FIXTURE);
    const registry = new SandboxToolRegistry(vault);

    expect(registry.definitions.map((definition) => definition.name)).toEqual(["read_file"]);
    const before = vault.snapshot();
    const result = await registry.execute({
      id: "call-1",
      name: "read_file",
      arguments: { path: "Characters/Mara.md" },
    });

    expect(result).toEqual({
      content:
        "[Characters/Mara.md]\n\n" +
        "1\t# Mara\n" +
        "2\t\n" +
        "3\tMara carries a brass compass inherited from her grandmother.",
      isReadOnly: true,
    });
    expect(vault.snapshot()).toEqual(before);
  });

  it("returns structured failures for escape attempts and unavailable tools", async () => {
    const registry = new SandboxToolRegistry(new SyntheticVault(READ_CONTROL_FIXTURE));
    const escape = await registry.execute({
      id: "call-1",
      name: "read_file",
      arguments: { path: "../../secret.md" },
    });
    const write = await registry.execute({
      id: "call-2",
      name: "write_file",
      arguments: { path: "New.md", content: "no" },
    });

    expect(escape).toMatchObject({ isError: true, failure: { kind: "invalid-args" } });
    expect(write).toMatchObject({ isError: true, failure: { kind: "denied" } });
  });

  it("applies only a reviewed write_file proposal and records its disposition", async () => {
    const vault = new SyntheticVault(READ_CONTROL_FIXTURE);
    const registry = new SandboxToolRegistry(vault, {
      disposition: "applied",
      reason: "Frozen test approval.",
    });

    expect(registry.definitions.map((definition) => definition.name)).toEqual([
      "read_file",
      "write_file",
    ]);
    const execution = await registry.executeWithEvidence({
      id: "write",
      name: "write_file",
      arguments: { path: "Notes/Result.md", content: "# Result\n" },
    });

    expect(execution).toMatchObject({
      result: { isReadOnly: false, disposition: "applied" },
      review: {
        proposal: { path: "Notes/Result.md", previousContent: null },
        disposition: "applied",
        applied: true,
      },
    });
    expect(vault.readFile("Notes/Result.md")?.content).toBe("# Result\n");
  });

  it("blocks escape, reserved, executable, and unadvertised destructive writes", async () => {
    const vault = new SyntheticVault(READ_CONTROL_FIXTURE);
    const registry = new SandboxToolRegistry(vault, {
      disposition: "applied",
      reason: "Frozen test approval.",
    });
    const calls = [
      { id: "escape", name: "write_file", arguments: { path: "../outside.md", content: "x" } },
      { id: "config", name: "write_file", arguments: { path: ".obsidian/x.md", content: "x" } },
      { id: "exe", name: "write_file", arguments: { path: "run.exe", content: "x" } },
      { id: "trash", name: "trash_file", arguments: { path: "Characters/Mara.md" } },
      { id: "move", name: "move_file", arguments: { from: "A.md", to: "B.md" } },
    ];

    for (const call of calls) {
      const result = await registry.execute(call);
      expect(result).toMatchObject({ isError: true });
    }
    expect(vault.snapshot()).toEqual(new SyntheticVault(READ_CONTROL_FIXTURE).snapshot());
  });

  it("records declined and fault-injected write dispositions without changing state", async () => {
    for (const disposition of ["declined", "failed"] as const) {
      const vault = new SyntheticVault(READ_CONTROL_FIXTURE);
      const before = vault.snapshot();
      const registry = new SandboxToolRegistry(vault, {
        disposition,
        reason: disposition === "failed" ? "Injected apply fault." : "Frozen decline.",
      });
      const execution = await registry.executeWithEvidence({
        id: disposition,
        name: "write_file",
        arguments: { path: "Characters/Mara.md", content: "changed" },
      });

      expect(execution.review).toMatchObject({ disposition, applied: false });
      expect(execution.result.isError).toBe(disposition === "failed" ? true : undefined);
      expect(vault.snapshot()).toEqual(before);
    }
  });
});
