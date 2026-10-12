import { z } from "zod";
import { localPathStringSchema } from "../localPath.js";

// These strings are single sigrok arguments, never shell fragments.
const selection = z
  .string()
  .min(1)
  .refine((value) => !value.includes("\0"), "NUL is not an argument character");
export const decodeSignalRecordingInputSchema = z.strictObject({
  path: localPathStringSchema.describe("Absolute local recording path"),
  decoders: selection.describe(
    "sigrok decoder stack, options and channel assignments, e.g. uart:rx=RX:baudrate=9600",
  ),
  input_format: selection
    .nullable()
    .default(null)
    .describe(
      "Explicit sigrok input format and options; omitted means autodetection",
    ),
  annotations: selection
    .nullable()
    .default(null)
    .describe("Optional annotation selection, e.g. uart=rx-data"),
});
export type DecodeSignalRecordingInput = z.infer<
  typeof decodeSignalRecordingInputSchema
>;

export const signalRecordingSchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().nonnegative(),
  }),
  selection: decodeSignalRecordingInputSchema,
  annotations_text: z
    .string()
    .describe(
      "Unmodified sigrok annotation output, with sample-number ranges; display text is not a lossless binary protocol representation",
    ),
  diagnostics: z.string(),
  tool: z.strictObject({
    path: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    version_banner: z.string(),
    arguments: z.array(z.string()),
  }),
  limits: z.strictObject({
    input_bytes: z.number().int().positive(),
    output_bytes: z.number().int().positive(),
    command_timeout_ms: z.number().int().positive(),
  }),
  hardware_acquisition: z.literal("not-performed"),
});
