import { z } from "incur";
import { resolve } from "node:path";
import { createPacketCaptureService } from "../composition/captures.js";
import { inspectPacketCaptureInputSchema } from "../domain/captures/packetCapture.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
export const registerCaptureCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
): void => {
  const service = createPacketCaptureService(environment);
  cli.command(CLI_COMMANDS.inspectPacketCapture, {
    description:
      "Inspect selected packet fields in an existing capture with TShark",
    args: z.object({ path: z.string().describe("Local capture file") }),
    options: inspectPacketCaptureInputSchema.omit({ path: true }),
    // The provider cleans each call before returning, including failed calls.
    // A second close here could replace a cleanup error carrying partial Evidence.
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectPacketCapture, async () => {
          const result = await service.inspect(
            { ...options, path: resolve(args.path) },
            { signal },
          );
          return result.ok ? result.value : projectAnalysisError(result.error);
        }),
      ),
  });
};
