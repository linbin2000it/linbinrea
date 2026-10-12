# Recorded packet capture inspection

`inspect_packet_capture` answers which selected protocol fields TShark observes
in an existing capture. Network, USB or Bluetooth recordings can use the same
field/filter interface when the installed TShark supports their encapsulation
and dissectors. This tool does not acquire traffic, open an interface or control
a device. HAR/mitmproxy web-capture workflows remain separate.

Supply an existing TShark 4.x installation:

```sh
export REA_TSHARK_COMMAND=/absolute/path/to/tshark
rea inspect-packet-capture /artifacts/device.pcapng \
  --fields ip.addr --fields udp.port --fields data.data \
  --display_filter 'udp' --format json
```

The corresponding MCP call is:

```json
{
  "name": "inspect_packet_capture",
  "arguments": {
    "path": "/artifacts/device.pcapng",
    "fields": ["ip.addr", "udp.port", "data.data"],
    "display_filter": "udp"
  }
}
```

`frame.number` is always included. Repeated values are ordered string arrays,
for example `"ip.addr": ["192.0.2.1", "192.0.2.2"]`. Missing fields remain
absent; they are not converted to zero or empty arrays. Export-only index/score
metadata is discarded. No payload bytes are automatically added; select a
supported byte field such as `data.data` or `@data` when needed.

Additional selections:

- `display_filter`: Wireshark display-filter syntax; omitted means no filter.
- `decode_as`: explicit dissector overrides, such as `["udp.port==5555,dns"]`.
  Repeat `--decode_as` in the CLI for multiple overrides.
- `packet_limit`: optional maximum **input packets read before filtering**.
  A limit of 1 can therefore yield zero matching packets even when later frames
  match. Omitted means read to EOF within resource limits. The report records
  `to-eof` or `up-to-input-packet-limit`, never inferring total capture size from
  the returned packet count.
- `two_pass`: defaults to true for fields that need later packets and reassembly
  dependencies. MCP may set false; CLI uses `--no-two_pass` for a single pass.

See the [TShark manual](https://www.wireshark.org/docs/man-pages/tshark.html)
for field names, display filters, decode-as syntax and pass semantics. Invalid
fields or filters return producer diagnostics. An empty result does not prove
absence of traffic outside the selected recording, filter or read range.
Dissector results are observations, not independently verified device behavior.

Evidence includes source path/digest/size, exact selections, typed packet fields,
executable path/digest/full version banner, arguments and stderr. Warnings remain
visible even on exit zero. Two-pass mode cannot recover missing capture bytes.

Each call uses a private read-only capture copy and an empty personal
configuration directory (`WIRESHARK_CONFIG_DIR`), with name resolution disabled.
The executable and private input copy are rechecked after execution. Owned
processes and private files are cleaned up; failed cleanup retains ownership and
completed observations for retry. Source files are never passed to TShark.
Installed libraries, global configuration and plugins remain trusted, are not
fully fingerprinted, and can influence dissection. This is not an OS sandbox.

Input is limited to 32 MiB before reading, each command to 30 seconds, and
combined stdout/stderr to 4 MiB during collection. Output overflow fails instead
of returning truncated success. These limits do not bound child heap usage or
compressed-capture expansion. No arbitrary process flags are accepted.

## Verification

```sh
npm run build:cached
REA_TSHARK_COMMAND=/absolute/path/to/tshark node scripts/verify-packet-capture.mjs
```

The verifier generates its own Ethernet/IPv4/UDP/DNS and Bluetooth HCI PCAPs.
It exercises real compiled CLI/MCP parity, advertised schemas, repeated/missing
fields, filtering, decode-as, both pass modes, a packet limit before matching
frames, Evidence persistence, failure diagnostics, source identity and cleanup.
An optional positional REA entrypoint verifies an installed package.

The local real-tool lane covers TShark 4.6.9 on macOS arm64. The added Ubuntu CI
lane uses its distribution package; check its outcome before claiming that
version/platform verified. Other formats (including PCAPNG), USB, BLE ATT,
Windows and actual physical capture are not established by these fixtures.
