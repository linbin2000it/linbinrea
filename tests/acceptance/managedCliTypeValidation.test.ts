import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { buildManagedPeFixture } from "../../src/dotnet/ManagedPe.fixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest(
  "inspect-managed-members --type rejects repeated and empty type names at the CLI boundary",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-managed-type-validation-");
    const path = join(root, "types.dll");
    await writeFile(path, buildManagedPeFixture({ additionalEmptyTypes: 2 }));
    const environment = { REA_LOG_LEVEL: "silent" };

    const repeated = await cli.run({
      arguments: [
        "inspect-managed-members",
        path,
        "--type",
        "Fixture.Empty0",
        "--type",
        "Fixture.Empty0",
        "--json",
      ],
      environment,
      timeoutMs: 30_000,
    });
    expect(repeated.exitCode).toBe(1);
    expect(repeated.json).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(JSON.stringify(repeated.json)).toContain("must not repeat a name");
    expect(repeated.json).toMatchObject({
      fieldErrors: expect.arrayContaining([
        expect.objectContaining({ path: "type" }),
      ]),
    });
    expect(JSON.stringify(repeated.json)).not.toContain("execution_failure");

    const empty = await cli.run({
      arguments: ["inspect-managed-members", path, "--type", "", "--json"],
      environment,
      timeoutMs: 30_000,
    });
    expect(empty.exitCode).toBe(1);
    expect(empty.json).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(empty.json).toMatchObject({
      fieldErrors: expect.arrayContaining([
        expect.objectContaining({ path: expect.stringMatching(/^type/) }),
      ]),
    });
    expect(JSON.stringify(empty.json)).not.toContain("execution_failure");

    const valid = await cli.run({
      arguments: [
        "inspect-managed-members",
        path,
        "--type",
        "Fixture.Empty0",
        "--type",
        "Fixture.Empty1",
        "--json",
      ],
      environment,
      timeoutMs: 30_000,
    });
    expect(valid.exitCode).toBe(0);
  },
);
