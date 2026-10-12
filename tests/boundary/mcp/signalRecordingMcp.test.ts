import { expect, it, onTestFinished } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";

it("advertises valid target-free signal decoding schemas and actionable missing-tool diagnostics", async () => {
  const harness = await createApplicationMcpHarness({
    serverOptions: { environment: {} },
  });
  onTestFinished(harness.close);
  const tool = (await harness.client.listTools()).tools.find(
    ({ name }) => name === "decode_signal_recording",
  );
  if (tool?.outputSchema === undefined) throw new Error("Signal tool missing");
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const inputSchema: Record<string, unknown> = tool.inputSchema;
  const outputSchema: Record<string, unknown> = tool.outputSchema;
  expect(ajv.validateSchema(inputSchema)).toBe(true);
  expect(ajv.validateSchema(outputSchema)).toBe(true);
  const input = {
    path: process.platform === "win32" ? "C:\\recording.vcd" : "/recording.vcd",
    decoders: "uart",
  };
  expect(ajv.validate(inputSchema, input)).toBe(true);
  expect(ajv.validate(inputSchema, { ...input, driver: "demo" })).toBe(false);
  const result = await harness.client.callTool({
    name: tool.name,
    arguments: input,
  });
  expect(parseMcpToolError(result)).toMatchObject({
    error: {
      code: "capability_unavailable",
      details: {
        operation: tool.name,
        reason: expect.stringContaining("REA_SIGROK_COMMAND"),
      },
    },
  });
  await harness.client.ping();
});
