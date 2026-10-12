import { it, expect, onTestFinished } from "vitest";
import { writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { TsharkCaptureProvider } from "../../../src/captures/TsharkCaptureProvider.js";
import { PacketCaptureService } from "../../../src/application/captures/PacketCaptureService.js";
import { packetCaptureSchema } from "../../../src/domain/captures/packetCapture.js";
import { PrivateRuntimeRoot } from "../../../src/process/PrivateRuntimeRoot.js";
import { spawnOwnedProviderProcess } from "../../../src/process/ProviderProcess.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

// A command-boundary simulator: real process ownership/filesystem, not real TShark coverage.
const fixture = async (mode = "ok", failCleanup = false) => {
  const directory = await createTestTempDirectory("rea-capture-test-");
  const path = join(directory, "recorded bytes.pcap");
  await writeFile(path, "recording bytes");
  const script = join(directory, "producer.mjs");
  await writeFile(
    script,
    `import {readFileSync, writeFileSync, chmodSync} from 'node:fs';
if (process.argv.includes('--version')) console.log('TShark (Wireshark) 4.6.9 (fixture)');
else if (${JSON.stringify(mode)} === 'nonzero') { console.error('invalid decoder'); process.exitCode = 1; }
else if (${JSON.stringify(mode)} === 'malformed-copy') { chmodSync('capture', 0o600); writeFileSync('capture', 'changed'); }
else if (${JSON.stringify(mode)} === 'overflow') process.stdout.write('x'.repeat(5 * 1024 * 1024));
else if (${JSON.stringify(mode)} === 'wait') { console.log('ready'); setInterval(() => {}, 1000); }
else if (${JSON.stringify(mode)} === 'invalid-json') console.log('not json');
else { if(readFileSync('capture', 'utf8') !== 'recording bytes') throw Error('wrong copy'); console.log(JSON.stringify([{_source:{layers:{"frame.number":["1"],"ip.addr":["192.0.2.1","192.0.2.2"]}}}])); console.error('producer warning'); }
`,
  );
  const controller = new AbortController();
  let calls = 0;
  let mayClean = !failCleanup;
  const provider = new TsharkCaptureProvider(
    { ...process.env, REA_TSHARK_COMMAND: process.execPath },
    async (input) => {
      calls++;
      const spawned = await spawnOwnedProviderProcess({
        ...input,
        command: process.execPath,
        arguments: [script, ...input.arguments],
        expectedCommand: process.execPath,
      });
      if (mode === "wait" && !input.arguments.includes("--version"))
        spawned.process.stdout?.once("data", () => controller.abort());
      return spawned;
    },
    async () => {
      const root = await PrivateRuntimeRoot.create({
        parent: directory,
        prefix: "decoder-",
      });
      return {
        path: root.path,
        close: async () => {
          if (!mayClean) throw new Error("cleanup fixture failure");
          await root.close();
        },
      };
    },
  );
  onTestFinished(async () => {
    mayClean = true;
    await provider.close();
  });
  const service = new PacketCaptureService(provider);
  return {
    service,
    directory,
    path,
    controller,
    calls: () => calls,
    allowCleanup: () => {
      mayClean = true;
    },
  };
};

it("inspects an immutable copy, preserves options and warnings, and releases its directory", async () => {
  const f = await fixture();
  const result = await f.service.inspect({
    path: f.path,
    fields: ["ip.addr"],
    display_filter: "udp",
    packet_limit: 10,
    decode_as: ["udp.port==5555,dns"],
  });
  if (!result.ok) throw result.error;
  const report = packetCaptureSchema.parse(result.value.normalized_result);
  expect(report.packets).toEqual([
    { "frame.number": ["1"], "ip.addr": ["192.0.2.1", "192.0.2.2"] },
  ]);
  expect(report.diagnostics).toBe("producer warning\n");
  expect(report.read_scope).toBe("up-to-input-packet-limit");
  expect(report.tool.arguments).toEqual([
    "-n",
    "-r",
    "capture",
    "-T",
    "json",
    "--no-duplicate-keys",
    "--temp-dir=.",
    "-2",
    "-c",
    "10",
    "-Y",
    "udp",
    "-d",
    "udp.port==5555,dns",
    "-e",
    "frame.number",
    "-e",
    "ip.addr",
  ]);
  expect((await readdir(f.directory)).sort()).toEqual([
    "producer.mjs",
    "recorded bytes.pcap",
  ]);
});

it.each([
  ["invalid-json", "AnalysisOutputError"],
  ["nonzero", "ProviderAdapterError"],
  ["malformed-copy", "AnalysisArtifactChangedError"],
  ["overflow", "AnalysisResourceConstraintError"],
  ["wait", "AnalysisCancelledError"],
])(
  "preserves %s failure and releases the process and snapshot",
  async (mode, tag) => {
    const f = await fixture(mode);
    const result = await f.service.inspect(
      { path: f.path, fields: ["ip.addr"] },
      { signal: f.controller.signal },
    );
    if (result.ok) throw new Error("Expected capture analysis failure");
    expect(result.error._tag).toBe(tag);
    expect(result.error.cleanupIncomplete).toBe(false);
    expect(
      (await readdir(f.directory)).filter((name) =>
        name.startsWith("decoder-"),
      ),
    ).toEqual([]);
  },
);

it("retains a completed observation and cleanup ownership for retry", async () => {
  const f = await fixture("ok", true);
  const result = await f.service.inspect({ path: f.path, fields: ["ip.addr"] });
  if (result.ok) throw new Error("Expected cleanup failure");
  expect(result.error.cleanupIncomplete).toBe(true);
  expect(result.error.partialObservation).toMatchObject({
    operation: "inspect_packet_capture",
  });
  const retry = await f.service.inspect({ path: f.path, fields: ["ip.addr"] });
  expect(retry.ok).toBe(false);
  expect(f.calls()).toBe(2);
  f.allowCleanup();
  await f.service.close();
  expect(
    (await readdir(f.directory)).filter((name) => name.startsWith("decoder-")),
  ).toEqual([]);
});

it("rejects cancelled and invalid requests before any provider work", async () => {
  const f = await fixture();
  for (const input of [
    { path: "relative.pcap", fields: ["ip.addr"] },
    { path: f.path, fields: ["ip.addr"], interface: "lo0" },
  ]) {
    const result = await f.service.inspect(input);
    expect(result.ok).toBe(false);
  }
  const result = await f.service.inspect(
    { path: f.path, fields: ["ip.addr"] },
    { signal: AbortSignal.abort() },
  );
  if (result.ok) throw new Error("Expected cancellation");
  expect(result.error._tag).toBe("AnalysisCancelledError");
  expect(f.calls()).toBe(0);
});

it("retains a completed observation when cancellation arrives at the service boundary", async () => {
  const f = await fixture();
  const input = {
    path: f.path,
    fields: ["ip.addr"],
    display_filter: null,
    decode_as: [],
    packet_limit: null,
    two_pass: true,
  };
  const execution = await f.service.provider.inspect(input);
  if (!execution.ok) throw execution.error;
  const service = new PacketCaptureService({
    inspect: async () => {
      f.controller.abort();
      return execution;
    },
    close: async () => {},
  });
  const result = await service.inspect(input, { signal: f.controller.signal });
  if (result.ok) throw new Error("Expected late cancellation");
  expect(result.error._tag).toBe("AnalysisCancelledError");
  expect(result.error.partialObservation).toMatchObject({
    operation: "inspect_packet_capture",
    normalized_result: {
      packets: [
        { "frame.number": ["1"], "ip.addr": ["192.0.2.1", "192.0.2.2"] },
      ],
    },
  });
});
