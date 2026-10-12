import { expect, it, onTestFinished } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";

it("advertises valid target-free packet capture schemas and actionable missing-tool diagnostics", async () => {
  const harness = await createApplicationMcpHarness({
    serverOptions: { environment: {} },
  });
  onTestFinished(harness.close);
  const tool = (await harness.client.listTools()).tools.find(
    ({ name }) => name === "inspect_packet_capture",
  );
  if (tool?.outputSchema === undefined) throw new Error("Capture tool missing");
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const inputSchema: Record<string, unknown> = tool.inputSchema;
  const outputSchema: Record<string, unknown> = tool.outputSchema;
  expect(ajv.validateSchema(inputSchema)).toBe(true);
  expect(ajv.validateSchema(outputSchema)).toBe(true);
  const input = {
    path:
      process.platform === "win32" ? "C:\\recording.pcap" : "/recording.pcap",
    fields: ["ip.addr"],
  };
  expect(ajv.validate(inputSchema, input)).toBe(true);
  expect(ajv.validate(inputSchema, { ...input, interface: "lo0" })).toBe(false);
  const result = await harness.client.callTool({
    name: tool.name,
    arguments: input,
  });
  expect(parseMcpToolError(result)).toMatchObject({
    error: {
      code: "capability_unavailable",
      details: {
        operation: tool.name,
        reason: expect.stringContaining("REA_TSHARK_COMMAND"),
      },
    },
  });
  await harness.client.ping();
});
