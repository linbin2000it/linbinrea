import {
  decodeSignalRecordingInputSchema,
  signalRecordingSchema,
} from "../../domain/signals/signalRecording.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";
export const SIGNAL_TOOL_CONTRACTS = [
  {
    name: "decode_signal_recording",
    ...toolContractMetadata("decode_signal_recording"),
    kind: "artifact-provider",
    description:
      "Decode a caller-selected local logic/signal recording with sigrok-cli 0.7.2. Supply the decoder stack, channel assignments and options explicitly; optionally select input format and annotation classes. Returns verbatim annotations with sample-number ranges, stderr, source digest and tool identity inline. Configure absolute REA_SIGROK_COMMAND. File-only analysis; no hardware acquisition or device communication. Empty output does not prove absence of traffic.",
    inputSchema: decodeSignalRecordingInputSchema,
    outputSchema: evidenceResultOf(signalRecordingSchema),
    examples: [
      {
        title: "Decode recorded UART RX bytes",
        input: {
          path: "/artifacts/uart.vcd",
          input_format: "vcd",
          decoders: "uart:rx=RX:baudrate=9600",
          annotations: "uart=rx-data",
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
