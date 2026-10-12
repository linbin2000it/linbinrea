# Recorded signal decoding

`decode_signal_recording` answers what a selected protocol decoder observes in
an existing recording. It uses caller-supplied **sigrok-cli 0.7.2** with
libsigrokdecode. It does not acquire samples or communicate with hardware.

```sh
export REA_SIGROK_COMMAND=/absolute/path/to/sigrok-cli
rea decode-signal-recording /artifacts/uart.vcd \
  --decoders uart:rx=RX:baudrate=9600 --input_format vcd \
  --annotations uart=rx-data --format json
```

The corresponding MCP request is:

```json
{
  "name": "decode_signal_recording",
  "arguments": {
    "path": "/artifacts/uart.vcd",
    "decoders": "uart:rx=RX:baudrate=9600",
    "input_format": "vcd",
    "annotations": "uart=rx-data"
  }
}
```

`decoders` uses sigrok's decoder stack and option/channel syntax. Channel names
must match the recording; REA does not guess wiring, baud rate or protocol.
Omitting `input_format` requests sigrok's autodetection. Omitting `annotations`
retains every annotation class. Both omitted selections are recorded as null.
See the [upstream manual](https://sigrok.org/wiki/Sigrok-cli) for formats,
decoder stacking and annotation selectors. No arbitrary command flags are accepted.

The returned Evidence includes the input path/digest, exact selections, tool
path/digest, full version banner (including library versions), annotation text
with sample-number ranges, and stderr. For example, `1104-1938 uart-1: 52`
is producer display text over a sample range, not a timestamp or an independently
verified protocol fact. Text is retained verbatim; it is not parsed as a lossless
binary payload. Empty output does not establish absence of traffic. Warnings
remain visible even when sigrok exits zero.

REA decodes a private, read-only copy of the recording, verifies that copy and
the selected executable after decoding, and removes the workspace after owned
process cleanup. Failed cleanup retains ownership for retry. The source file is
never passed to sigrok. Caller-supplied tools and their libraries/decoder modules
are trusted, and hashes identify bytes rather than publisher authenticity.

The input copy is bounded at 32 MiB before reading, each command has a 30-second
deadline, and combined stdout/stderr is bounded at 4 MiB during collection.
Oversized output fails rather than becoming truncated success. These limits do
not constrain the decoder's heap or archive expansion and are not an OS sandbox.

## Verification

```sh
npm run build:cached
REA_SIGROK_COMMAND=/absolute/path/to/sigrok-cli node scripts/verify-signal-recording.mjs
```

The verifier synthesizes a 9600-baud 8N1 UART VCD carrying `REA`, then checks
actual CLI/MCP parity, advertised schemas, stored Evidence, source hashes,
annotation filtering/autodetection, invalid decoder/input failures and cleanup.
An optional positional REA entrypoint verifies an installed package.
The local real-tool run covers macOS arm64, sigrok-cli 0.7.2, libsigrok 0.5.2 and
libsigrokdecode 0.5.3. Other formats/decoders, Windows, and physical acquisition
are not verified by this lane. The separate CI lane exercises Ubuntu's sigrok
package; its result must be checked before claiming Linux verification.
