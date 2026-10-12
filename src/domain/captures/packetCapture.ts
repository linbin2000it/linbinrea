import { z } from "zod";
import { localPathStringSchema } from "../localPath.js";

const argument = z
  .string()
  .min(1)
  .refine((value) => !value.includes("\0"), "NUL is not an argument character");
export const inspectPacketCaptureInputSchema = z.strictObject({
  path: localPathStringSchema.describe("Absolute local capture path"),
  fields: z
    .array(argument)
    .min(1)
    .describe(
      "TShark field names to return, e.g. ip.addr, usb.endpoint_address, btatt.opcode; frame.number is always included",
    ),
  display_filter: argument
    .nullable()
    .default(null)
    .describe(
      "Optional Wireshark display filter (-Y), applied within the read limit",
    ),
  decode_as: z
    .array(argument)
    .default([])
    .describe("Explicit TShark decode-as selections, e.g. tcp.port==8888,http"),
  packet_limit: z
    .number()
    .int()
    .positive()
    .max(2147483647)
    .nullable()
    .default(null)
    .describe(
      "Maximum input packets to read before filtering; omitted scans to EOF within resource limits",
    ),
  two_pass: z
    .boolean()
    .default(true)
    .describe(
      "Use two-pass analysis for fields requiring later packets; false requests a single pass",
    ),
});
export type InspectPacketCaptureInput = z.infer<
  typeof inspectPacketCaptureInputSchema
>;

/** Values remain strings; repeated occurrences remain ordered arrays. */
export const packetFieldsSchema = z
  .object({
    "frame.number": z.tuple([z.string().regex(/^[1-9][0-9]*$/)]),
  })
  .catchall(z.array(z.string()));
export const packetCaptureSchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().nonnegative(),
  }),
  selection: inspectPacketCaptureInputSchema,
  packets: z.array(packetFieldsSchema),
  read_scope: z.enum(["to-eof", "up-to-input-packet-limit"]),
  diagnostics: z.string(),
  tool: z.strictObject({
    path: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    version_banner: z.string(),
    arguments: z.array(z.string()),
  }),
  configuration: z.literal("private-empty-personal-profile"),
  limits: z.strictObject({
    input_bytes: z.number().int().positive(),
    output_bytes: z.number().int().positive(),
    command_timeout_ms: z.number().int().positive(),
  }),
  hardware_acquisition: z.literal("not-performed"),
});
