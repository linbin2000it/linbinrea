import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  createAnalysisExecution,
  type AnalysisExecution,
  type ExecutionOptions,
} from "../application/AnalysisProvider.js";
import type { SignalRecordingPort } from "../application/signals/SignalRecordingService.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { createEvidence } from "../domain/evidence.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  type DecodeSignalRecordingInput,
  signalRecordingSchema,
} from "../domain/signals/signalRecording.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  runOwnedCommand,
  OwnedCommandFailure,
} from "../process/OwnedCommand.js";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import type { ProviderProcessSupervisor } from "../process/ProviderProcess.js";

const OPERATION = "decode_signal_recording";
export const SIGROK_PROVIDER_IDENTITY = {
  id: "sigrok-recording",
  name: "REA sigrok recording adapter",
  version: "sigrok-cli@0.7.2",
} as const;
// Bound the resident input copy and retained text before allocation/collection.
const LIMITS = {
  input_bytes: 32 * 1024 * 1024,
  output_bytes: 4 * 1024 * 1024,
  command_timeout_ms: 30_000,
} as const;
type Runtime = Pick<PrivateRuntimeRoot, "path" | "close">;
type Launcher = NonNullable<Parameters<typeof runOwnedCommand>[2]>["launcher"];

/** Decode selected recordings only, retaining cleanup ownership across failures. */
export class SigrokRecordingProvider implements SignalRecordingPort {
  readonly #pending = new Map<Runtime, ProviderProcessSupervisor | undefined>();
  #tail: Promise<void> = Promise.resolve();
  constructor(
    readonly environment: Readonly<NodeJS.ProcessEnv> = process.env,
    readonly launcher?: Launcher,
    readonly createRuntime: () => Promise<Runtime> = () =>
      PrivateRuntimeRoot.create({ prefix: "rea-sigrok-" }),
  ) {}
  decode(
    input: DecodeSignalRecordingInput,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const work = this.#tail.then(() => this.#decode(input, options));
    this.#tail = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  }
  close(): Promise<void> {
    const work = this.#tail.then(() => this.#release());
    this.#tail = work.catch(() => undefined);
    return work;
  }
  async #release(): Promise<void> {
    for (const [root, owner] of this.#pending) {
      try {
        if (owner !== undefined) {
          const stopped = await owner.stop();
          if (stopped.status === "incomplete") throw new Error(stopped.reason);
          this.#pending.set(root, undefined);
        }
        await root.close();
        this.#pending.delete(root);
      } catch (cause) {
        throw new ProviderCleanupError(
          SIGROK_PROVIDER_IDENTITY.id,
          [root.path],
          { reason: String(cause) },
          { operation: OPERATION, cause },
        );
      }
    }
  }
  async #decode(
    input: DecodeSignalRecordingInput,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    let phase: "configuration" | "artifact" | "producer" = "configuration";
    let root: Runtime | undefined;
    let result: Result<AnalysisExecution, AnalysisError>;
    try {
      if (options?.signal?.aborted) throw new AnalysisCancelledError(OPERATION);
      await this.#release();
      const configured = this.environment.REA_SIGROK_COMMAND ?? "";
      if (!isAbsolute(configured))
        throw new Error(
          "Supply absolute REA_SIGROK_COMMAND for sigrok-cli 0.7.2 with libsigrokdecode.",
        );
      const command = await realpath(configured);
      await access(command, constants.X_OK);
      const tool = await readStableArtifact(
        command,
        64 * 1024 * 1024,
        options?.signal,
      );
      root = await this.createRuntime();
      this.#pending.set(root, undefined);
      const snapshotPath = join(root.path, "recording");
      const execute = async (args: readonly string[]) => {
        const output = await runOwnedCommand(
          {
            command,
            arguments: args,
            ...(root === undefined ? {} : { cwd: root.path }),
            expectedCommand: command,
            runId: `rea-sigrok-${randomUUID()}`,
            hostEnvironment: this.environment,
          },
          {
            timeoutMs: LIMITS.command_timeout_ms,
            diagnosticBytes: LIMITS.output_bytes,
            acceptNonZeroExit: true,
          },
          {
            ...(options?.signal === undefined
              ? {}
              : { signal: options.signal }),
            ...(this.launcher === undefined ? {} : { launcher: this.launcher }),
          },
        );
        const current = await readStableArtifact(
          command,
          64 * 1024 * 1024,
          options?.signal,
        );
        if (current.sha256 !== tool.sha256)
          throw new AnalysisOutputError(
            OPERATION,
            "Configured decoder executable changed during analysis.",
          );
        if (output.exitCode !== 0)
          throw new ProviderAdapterError(
            SIGROK_PROVIDER_IDENTITY.id,
            OPERATION,
            {
              diagnostics: {
                exit_code: output.exitCode ?? null,
                stdout: output.stdout.text,
                stderr: output.stderr.text,
              },
            },
          );
        return output;
      };
      const version = await execute(["--version"]);
      if (
        !/^sigrok-cli 0\.7\.2(?:\r?\n|$)/u.test(version.stdout.text) ||
        !version.stdout.text.includes("libsigrokdecode")
      )
        throw new Error(
          "Expected sigrok-cli 0.7.2 with libsigrokdecode; inspect the selected installation.",
        );
      phase = "artifact";
      const selected = await readStableArtifact(
        input.path,
        LIMITS.input_bytes,
        options?.signal,
      );
      await writeFile(snapshotPath, selected.bytes, {
        flag: "wx",
        mode: 0o400,
      });
      phase = "producer";
      const args = [
        "--dont-scan",
        "--input-file=recording",
        `--protocol-decoders=${input.decoders}`,
        "--protocol-decoder-samplenum",
        ...(input.input_format === null
          ? []
          : [`--input-format=${input.input_format}`]),
        ...(input.annotations === null
          ? []
          : [`--protocol-decoder-annotations=${input.annotations}`]),
      ];
      const output = await execute(args);
      if (
        (
          await readStableArtifact(
            snapshotPath,
            LIMITS.input_bytes,
            options?.signal,
          )
        ).sha256 !== selected.sha256
      )
        throw new AnalysisArtifactChangedError(
          OPERATION,
          input.path,
          "Decoder changed the private recording copy.",
        );
      const report = signalRecordingSchema.parse({
        artifact: {
          path: input.path,
          sha256: selected.sha256,
          bytes: selected.bytes.length,
        },
        selection: input,
        annotations_text: output.stdout.text,
        diagnostics: output.stderr.text,
        tool: {
          path: command,
          sha256: tool.sha256,
          version_banner: version.stdout.text,
          arguments: args,
        },
        limits: LIMITS,
        hardware_acquisition: "not-performed",
      });
      result = ok(
        createAnalysisExecution(report, SIGROK_PROVIDER_IDENTITY, {
          subject: {
            path: input.path,
            sha256: selected.sha256,
            format: "file",
          },
          locations: [{ kind: "artifact-path", path: input.path }],
          limitations: [
            "Annotations are the selected decoder's interpretation of the recorded samples and caller-selected settings, not independently verified protocol semantics. Empty output does not establish absence of traffic.",
            "Sample-number ranges and display text are preserved verbatim, not converted to timestamps or parsed as a lossless byte stream. All producer stderr is retained, including warnings on exit zero.",
            "Only a private copy of the selected file is decoded. Hardware discovery/acquisition and target execution are not requested. Caller-supplied tools, plugins and decoder modules are trusted; this is not an OS sandbox.",
            "Resident input is capped at 32 MiB, each command at 30 seconds and combined output at 4 MiB. Exceeding output limits fails rather than returning truncated success. Child heap usage and format expansion are not bounded by these limits.",
          ],
        }),
      );
    } catch (cause) {
      if (
        root !== undefined &&
        cause instanceof OwnedCommandFailure &&
        cause.cleanupOwner !== undefined
      )
        this.#pending.set(root, cause.cleanupOwner);
      result = err(this.#failure(cause, phase, input.path));
    }
    try {
      await this.#release();
    } catch (cause) {
      const partialObservation = result.ok
        ? createEvidence(
            result.value.subject ?? undefined,
            result.value.provider,
            {
              operation: OPERATION,
              parameters: input,
              result: result.value.result,
              confidence: "observed",
              locations: result.value.locations,
              limitations: result.value.limitations,
            },
          )
        : result.error.partialObservation;
      return err(
        new ProviderCleanupError(
          SIGROK_PROVIDER_IDENTITY.id,
          [...this.#pending.keys()].map((item) => item.path),
          {
            reason: String(cause),
            previous_error: result.ok
              ? null
              : projectAnalysisError(result.error),
          },
          {
            operation: OPERATION,
            cause,
            ...(partialObservation === undefined ? {} : { partialObservation }),
          },
        ),
      );
    }
    return result;
  }
  #failure(
    cause: unknown,
    phase: "configuration" | "artifact" | "producer",
    path: string,
  ): AnalysisError {
    if (cause instanceof AnalysisError) return cause;
    if (
      (cause instanceof Error && cause.name === "AbortError") ||
      (cause instanceof ArtifactReaderFailure && cause.reason === "cancelled")
    )
      return new AnalysisCancelledError(OPERATION, { cause });
    const reason = cause instanceof Error ? cause.message : String(cause);
    if (cause instanceof OwnedCommandFailure) {
      const capturedOutput =
        cause.snapshot === null
          ? undefined
          : {
              stdout: cause.snapshot.stdout.text,
              stderr: cause.snapshot.stderr.text,
              truncated: cause.snapshot.diagnosticTruncated ?? false,
            };
      const detail = {
        cause,
        ...(capturedOutput === undefined ? {} : { capturedOutput }),
      };
      if (cause.reason === "cancelled")
        return new AnalysisCancelledError(OPERATION, detail);
      if (cause.reason === "timeout")
        return new AnalysisTimeoutError(
          OPERATION,
          LIMITS.command_timeout_ms,
          detail,
        );
      if (cause.reason === "output-limit")
        return new AnalysisResourceConstraintError(
          OPERATION,
          "memory",
          reason,
          { output_bytes: LIMITS.output_bytes },
          detail,
        );
      return new AnalysisOutputError(OPERATION, reason, detail);
    }
    if (phase === "configuration")
      return new AnalysisCapabilityUnavailableError(
        SIGROK_PROVIDER_IDENTITY.id,
        OPERATION,
        reason,
        {
          cause,
          userMessage: `${reason} Configure an existing sigrok-cli 0.7.2 through REA_SIGROK_COMMAND.`,
        },
      );
    if (cause instanceof ArtifactReaderFailure && cause.reason === "limit")
      return new AnalysisResourceConstraintError(
        OPERATION,
        "file-size",
        reason,
        { input_bytes: LIMITS.input_bytes },
        { cause },
      );
    if (cause instanceof ArtifactReaderFailure && cause.reason === "integrity")
      return new AnalysisArtifactChangedError(OPERATION, path, reason, {
        cause,
      });
    if (
      cause instanceof Error &&
      "code" in cause &&
      (cause.code === "EACCES" || cause.code === "EPERM")
    )
      return new AnalysisAccessDeniedError(OPERATION, path, cause.code, {
        cause,
      });
    if (phase === "artifact")
      return new AnalysisInputError(OPERATION, { cause }, [
        { path: ["path"], reason: "invalid_value", message: reason },
      ]);
    return new AnalysisOutputError(OPERATION, reason, { cause });
  }
}
