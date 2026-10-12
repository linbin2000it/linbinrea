#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Ajv2020 } from "ajv/dist/2020.js";
import { PrivateRuntimeRoot } from "../dist/process/PrivateRuntimeRoot.js";
import { parseEvidence } from "../dist/domain/evidence.js";
import { createVerifierRun, completeVerifierRun } from "./lib/verifier-run.mjs";

if (!isAbsolute(process.env.REA_SIGROK_COMMAND ?? ""))
  throw new Error(
    "Supply an absolute REA_SIGROK_COMMAND for sigrok-cli 0.7.2.",
  );
const entrypoint =
  process.argv[2] ?? fileURLToPath(new URL("./rea.mjs", import.meta.url));
const run = createVerifierRun();
const root = await PrivateRuntimeRoot.create({
  prefix: "rea-signal-verifier-",
});
const path = join(root.path, "recording with spaces.vcd");
const execute = promisify(execFile);
const environment = {
  ...process.env,
  TMPDIR: root.path,
  TMP: root.path,
  TEMP: root.path,
};
const client = new Client({ name: "signal-recording-verifier", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entrypoint, "mcp"],
  env: environment,
  stderr: "pipe",
});
// Independently synthesize 9600-baud 8N1 samples at 1 MHz: bytes 52 45 41.
const lines = [
  "$timescale 1 us $end",
  "$scope module logic $end",
  "$var wire 1 ! RX $end",
  "$upscope $end",
  "$enddefinitions $end",
  "#0",
  "1!",
];
let tick = 1000;
for (const byte of Buffer.from("REA")) {
  for (const bit of [
    0,
    ...Array.from({ length: 8 }, (_, i) => (byte >> i) & 1),
    1,
  ]) {
    lines.push(`#${tick}`, `${bit}!`);
    tick += 104;
  }
  tick += 208;
}
lines.push(`#${tick + 1000}`, "1!");
const source = lines.join("\n") + "\n";
let cases = 0;
try {
  await writeFile(path, source);
  await client.connect(transport);
  const advertised = (await client.listTools()).tools.find(
    ({ name }) => name === "decode_signal_recording",
  );
  assert.ok(advertised?.outputSchema);
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  assert.ok(ajv.validateSchema(advertised.inputSchema));
  assert.ok(ajv.validateSchema(advertised.outputSchema));
  for (const extra of [
    { input_format: "vcd", annotations: "uart=rx-data" },
    {},
  ]) {
    const input = { path, decoders: "uart:rx=RX:baudrate=9600", ...extra };
    const response = await client.callTool({
      name: advertised.name,
      arguments: input,
    });
    assert.notEqual(response.isError, true, JSON.stringify(response));
    assert.ok(
      ajv.validate(advertised.outputSchema, response.structuredContent),
      JSON.stringify(ajv.errors),
    );
    const evidence = parseEvidence(response.structuredContent);
    const report = evidence.normalized_result;
    for (const byte of ["52", "45", "41"])
      assert.match(
        report.annotations_text,
        new RegExp(`\\d+-\\d+ uart-1: ${byte}\\n`),
      );
    assert.equal(
      report.artifact.sha256,
      createHash("sha256").update(source).digest("hex"),
    );
    assert.equal(report.hardware_acquisition, "not-performed");
    assert.equal(report.diagnostics, "");
    const flags = Object.entries(input)
      .filter(([key]) => key !== "path")
      .flatMap(([key, value]) => [`--${key}`, value]);
    const cli = JSON.parse(
      (
        await execute(
          process.execPath,
          [
            entrypoint,
            "decode-signal-recording",
            path,
            ...flags,
            "--format",
            "json",
          ],
          { env: environment, timeout: 60000, maxBuffer: 16 * 1024 * 1024 },
        )
      ).stdout,
    );
    assert.equal(parseEvidence(cli).evidence_id, evidence.evidence_id);
    const bundle = await client.callTool({
      name: "get_evidence_bundle",
      arguments: {},
    });
    assert.ok(JSON.stringify(bundle).includes(evidence.evidence_id));
    assert.equal(await readFile(path, "utf8"), source);
    cases++;
  }
  for (const input of [
    { path, decoders: "no_such_decoder" },
    { path: join(root.path, "absent.vcd"), decoders: "uart" },
    { path, decoders: "uart", driver: "demo" },
  ]) {
    const response = await client.callTool({
      name: advertised.name,
      arguments: input,
    });
    assert.equal(response.isError, true);
    await client.ping();
    cases++;
  }
  await writeFile(path, "not a recording");
  const invalid = await client.callTool({
    name: advertised.name,
    arguments: { path, decoders: "uart" },
  });
  assert.equal(invalid.isError, true);
  cases++;
  await client.close();
  assert.deepEqual(await readdir(root.path), ["recording with spaces.vcd"]);
} finally {
  await client.close();
  await transport.close();
  await root.close();
}
console.log(
  JSON.stringify(
    {
      status: "passed",
      cases,
      host: `${process.platform}/${process.arch}`,
      scope:
        "real sigrok UART VCD through compiled CLI/MCP; no physical acquisition",
      ...(await completeVerifierRun(run)),
    },
    null,
    2,
  ),
);
