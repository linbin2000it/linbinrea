import { it, expect, onTestFinished } from "vitest";
import { writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { SigrokRecordingProvider } from "../../../src/signals/SigrokRecordingProvider.js";
import { SignalRecordingService } from "../../../src/application/signals/SignalRecordingService.js";
import { signalRecordingSchema } from "../../../src/domain/signals/signalRecording.js";
import { PrivateRuntimeRoot } from "../../../src/process/PrivateRuntimeRoot.js";
import { spawnOwnedProviderProcess } from "../../../src/process/ProviderProcess.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

// A command-boundary simulator: real process ownership/filesystem, not real sigrok coverage.
const fixture = async (mode = "ok", failCleanup = false) => {
  const directory = await createTestTempDirectory("rea-signal-test-");
  const path = join(directory, "recorded bytes.vcd");
  await writeFile(path, "recording bytes");
  const script = join(directory, "producer.mjs");
  await writeFile(
    script,
    `import {readFileSync, writeFileSync, chmodSync} from 'node:fs';
if (process.argv.includes('--version')) console.log('sigrok-cli 0.7.2\\nlibsigrokdecode 0.5.3');
else if (${JSON.stringify(mode)} === 'nonzero') { console.error('invalid decoder'); process.exitCode = 1; }
else if (${JSON.stringify(mode)} === 'malformed-copy') { chmodSync('recording', 0o600); writeFileSync('recording', 'changed'); }
else if (${JSON.stringify(mode)} === 'overflow') process.stdout.write('x'.repeat(5 * 1024 * 1024));
else if (${JSON.stringify(mode)} === 'wait') { console.log('ready'); setInterval(() => {}, 1000); }
else { if(readFileSync('recording', 'utf8') !== 'recording bytes') throw Error('wrong copy'); console.log('10-20 uart-1: 42'); console.error('producer warning'); }
`,
  );
  const controller = new AbortController();
  let calls = 0;
  let mayClean = !failCleanup;
  const provider = new SigrokRecordingProvider(
    { ...process.env, REA_SIGROK_COMMAND: process.execPath },
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
  const service = new SignalRecordingService(provider);
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

it("decodes an immutable copy, preserves options and warnings, and releases its directory", async () => {
  const f = await fixture();
  const result = await f.service.decode({
    path: f.path,
    decoders: "uart:rx=RX:baudrate=9600",
    annotations: "uart=rx-data",
  });
  if (!result.ok) throw result.error;
  const report = signalRecordingSchema.parse(result.value.normalized_result);
  expect(report.annotations_text).toBe("10-20 uart-1: 42\n");
  expect(report.diagnostics).toBe("producer warning\n");
  expect(report.selection.input_format).toBeNull();
  expect(report.tool.arguments).toEqual([
    "--dont-scan",
    "--input-file=recording",
    "--protocol-decoders=uart:rx=RX:baudrate=9600",
    "--protocol-decoder-samplenum",
    "--protocol-decoder-annotations=uart=rx-data",
  ]);
  expect((await readdir(f.directory)).sort()).toEqual([
    "producer.mjs",
    "recorded bytes.vcd",
  ]);
});

it.each([
  ["nonzero", "ProviderAdapterError"],
  ["malformed-copy", "AnalysisArtifactChangedError"],
  ["overflow", "AnalysisResourceConstraintError"],
  ["wait", "AnalysisCancelledError"],
])(
  "preserves %s failure and releases the process and snapshot",
  async (mode, tag) => {
    const f = await fixture(mode);
    const result = await f.service.decode(
      { path: f.path, decoders: "uart" },
      { signal: f.controller.signal },
    );
    if (result.ok) throw new Error("Expected decoder failure");
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
  const result = await f.service.decode({ path: f.path, decoders: "uart" });
  if (result.ok) throw new Error("Expected cleanup failure");
  expect(result.error.cleanupIncomplete).toBe(true);
  expect(result.error.partialObservation).toMatchObject({
    operation: "decode_signal_recording",
  });
  const retry = await f.service.decode({ path: f.path, decoders: "uart" });
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
    { path: "relative.vcd", decoders: "uart" },
    { path: f.path, decoders: "uart", driver: "demo" },
  ]) {
    const result = await f.service.decode(input);
    expect(result.ok).toBe(false);
  }
  const result = await f.service.decode(
    { path: f.path, decoders: "uart" },
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
    decoders: "uart",
    input_format: null,
    annotations: null,
  };
  const execution = await f.service.provider.decode(input);
  if (!execution.ok) throw execution.error;
  const service = new SignalRecordingService({
    decode: async () => {
      f.controller.abort();
      return execution;
    },
    close: async () => {},
  });
  const result = await service.decode(input, { signal: f.controller.signal });
  if (result.ok) throw new Error("Expected late cancellation");
  expect(result.error._tag).toBe("AnalysisCancelledError");
  expect(result.error.partialObservation).toMatchObject({
    operation: "decode_signal_recording",
    normalized_result: { annotations_text: "10-20 uart-1: 42\n" },
  });
});
