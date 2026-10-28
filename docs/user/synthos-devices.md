# SynthOS device captures

The local companion imports saved Harness, Fieldy, or Even G2 captures into SynthOS for review. Captures arrive as untrusted proposals; importing one does not start a task. It works on a Mac or another host running Node.js 22 or newer, with a running T3 server and an existing authenticated connection.

The companion accepts JSONL, pulls processed Fieldy recordings on request, connects to an explicitly selected Harness USB port, and serves a restricted Even Hub phone capture page with glasses status and STOP controls. A successful import proves delivery to SynthOS. Hardware operation still needs qualification with your devices.

## Connect through your existing SSH setup

Keep your existing SSH account, keys, and host verification. Start a local forward using the actual T3 server port; this example uses port 3773:

```sh
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:43773:127.0.0.1:3773 user@host
```

The companion does not open SSH connections, install an SSH server, create accounts, or change your tunnel. Setting `transport` to `ssh` means you are supplying that tunnel. It cannot verify who owns the local forwarded port.

Create a bearer session on the T3 host using `t3 auth session issue --scope orchestration:operate`. Check that command's `--help` for your installation's options. Set its credential in `SYNTHOS_DEVICE_TOKEN` on the companion host through your existing secret manager or environment. Keep the credential out of config files, JSONL captures, command arguments, and shell history. This is T3's current operation scope; it permits more than device intake. Revoke the session through T3's existing access controls when no longer needed. See [Manage or revoke access](./remote-access.md#manage-or-revoke-access).

Save the following as a private local config file, replacing `/Users/you` with your actual home directory:

```json
{
  "endpoint": "http://127.0.0.1:43773/api/synthos/connections",
  "transport": "ssh",
  "tokenEnv": "SYNTHOS_DEVICE_TOKEN",
  "spoolDir": "/Users/you/Library/Application Support/SynthOS/device-spool",
  "requestTimeoutMs": 5000,
  "maxQueueEntries": 100,
  "maxQueueBytes": 2097152,
  "maxRequestsPerFlush": 20
}
```

For an existing local HTTPS endpoint, use `transport: "loopback-https"` and its `https://127.0.0.1:…/api/synthos/connections` or `https://[::1]:…/api/synthos/connections` URL. The certificate must be trusted and valid for that address; a private CA can be supplied using Node's `NODE_EXTRA_CA_CERTS`. Certificate verification stays enabled. Public endpoints, LAN addresses, embedded credentials, query strings, and redirects are rejected.

## Import and review a capture

Produce one JSON object per line. Each capture needs an immutable ID from its source and an explicit capture time with a timezone. Reuse the same ID and content after interruption; assign a new ID to a different capture.

```jsonl
{"source":"fieldy","sourceId":"conversation-123","title":"Follow-up thought","content":"The processed transcript or summary to review.","capturedAt":"2026-10-28T12:00:00Z"}
```

Use `harness`, `fieldy`, or `g2` for `source`. From your SynthOS checkout, enqueue the file, resume forwarding, then send one bounded batch:

```sh
node scripts/synthos-companion/cli.mjs --config /absolute/companion.json ingest < captures.jsonl
node scripts/synthos-companion/cli.mjs --config /absolute/companion.json status
node scripts/synthos-companion/cli.mjs --config /absolute/companion.json resume
node scripts/synthos-companion/cli.mjs --config /absolute/companion.json flush
```

A new spool starts stopped. `ingest` only saves captures; `resume` only enables forwarding. `flush` sends at most 20 captures with the example config, one request at a time, and stops on the first failure. Repeat `flush` explicitly for another batch. Successful output reports acknowledged counts, including server-detected duplicates, without printing capture content or credentials. Review imported proposals in SynthOS before using their contents in any task.

The source adapter must stay within 12,000 characters of content and 32 KiB per JSON line and request. Oversized captures are rejected without silent truncation. Each ingest invocation accepts at most 1,000 lines, including blank lines. If a later line fails, earlier accepted records remain saved; reimporting the same file deduplicates those records locally. The queue defaults to 100 captures and 2 MiB, with configurable ceilings of 1,000 captures and 8 MiB. A request has a complete 5-second deadline by default, configurable up to 10 seconds, and a 64 KiB response limit.

## Stop and recover

```sh
node scripts/synthos-companion/cli.mjs --config /absolute/companion.json stop
```

STOP persists across process restarts and prevents dispatch of the next queued capture. It can run while a flush owns the spool. A request already sent may still be accepted; STOP cannot recall it. Captures remain saved until an explicit `resume` followed by `flush`. This command stops companion forwarding; use SynthOS's workflow STOP to cancel workflow activity.

A lost connection, deadline, malformed receipt, or interrupted process leaves an uncertain capture in the spool. Explicitly flushing again resends the same source ID, which the server deduplicates. The companion removes a record only after a matching acknowledgement for the same content. A reused ID with different content remains blocked for review. Authentication failures and other rejections retain captures too; fix the cause before retrying. There is no background retry loop.

The spool contains private capture text in files restricted to your account. Keep it outside your checkout and protect it with your normal disk encryption and backups. One operation owns it at a time. After a crash, a leftover `lock.json` deliberately blocks further writes: inspect its recorded PID, confirm that the companion process has ended, and remove only that lock file before restarting. Preserve any `.tmp` file left in the queue for manual recovery; it signals an interrupted save and blocks forwarding until moved aside. Never remove a lock belonging to a running process. No capture cleanup or eviction happens automatically.

## Pull processed Fieldy recordings

Use your existing Fieldy account's REST API key from Settings → Developer Settings. Make it available as `FIELDY_API_KEY` through your secret manager, then add this optional section to the companion config:

```json
"fieldy": { "tokenEnv": "FIELDY_API_KEY", "maxItems": 10 }
```

Run a read-only pull for an explicit window of at most 31 days:

```sh
node scripts/synthos-companion/cli.mjs --config /absolute/companion.json fieldy-pull --start 2026-10-01T00:00:00Z --end 2026-10-02T00:00:00Z
```

Each invocation reads one page from Fieldy's documented public v2 conversations endpoint, then fetches the listed conversation details. The default is at most 11 GET requests; `maxItems` can be 1–20. Requests use the fixed official origin, a complete five-second deadline, and a 1 MiB response ceiling. The Fieldy credential is never sent to T3 or the phone. No Fieldy write, microphone, or unsigned webhook route is used.

The cursor advances only after the page is saved in the local spool. Repeat the same command while `hasMore` is true. Interrupted pages replay with stable conversation IDs. Add `--restart` to recheck a window or start a different window; after failure of a restarted pull, repeat with `--restart`. Locked or unprocessed recordings count as `skipped`; restart the window later to check for newly available transcripts. Long transcripts include a visible truncation notice and retain the original conversation ID for reference. A changed transcript under an already imported ID requires review instead of replacing the earlier capture silently.

All captures stay in the local queue until explicit forwarding. Errors, including HTTP 429, stop the pull without automatic retries. API availability, account permissions, and physical Fieldy capture have not been verified against your account. See the official [REST guide](https://fieldyai.github.io/docs/#/public-api) and [API reference](https://api.fieldy.ai/docs).

## Connect the Harness USB puck

The direct adapter implements the stock puck's framed OpenHarness cable protocol. It publishes actual companion queue and forwarding status, accepts the puck's STOP confirmation, and saves supported protocol text captures for review. It does not start agents or require the old GCH daemon.

Install the companion's pinned dependencies once, then add the explicit serial path to its config:

```sh
npm ci --ignore-scripts --no-audit --no-fund --prefix scripts/synthos-companion
```

```json
"harnessSerial": {
  "path": "/dev/cu.usbmodemYOUR_DEVICE",
  "sessionTimeoutMs": 60000,
  "maxCaptures": 20
}
```

Use your device's actual macOS `/dev/cu.…` or Linux `/dev/ttyACM…` path. Close OpenHarness's device connection and any serial monitor first; the bridge never takes over another application's port. The host needs `lsof` and your existing serial-port permission. The adapter checks that the selected path resolves to a character device under `/dev`, matches USB VID/PID `303a:1001`, has no existing owner, and can be opened with the serial driver's exclusive lock. A positive `product: harness`, protocol-3 hello is required before sending any device command. USB IDs alone do not establish identity.

```sh
node scripts/synthos-companion/cli.mjs --config /absolute/companion.json harness-serial
```

Connected status appears only after device identification and the initial queue cards are written. The puck's Stop confirmation persists the same local forwarding STOP used by the CLI and phone. It can stop forwarding while another process owns the spool; it cannot resume forwarding or cancel an unrelated workflow. Queue cards refresh when the actual status changes. When the spool is busy, the device says status is unavailable; an unsaved text capture receives an explicit retry message.

The session ends after 60 seconds or 20 new captures with this config. You can configure up to five minutes and 100 captures per attachment, then reconnect explicitly. The bridge bounds handshake, writes, frame size, input bytes, and queued work. Cable loss, identity changes, corrupt input, and missed heartbeat close the selected connection. Ctrl-C closes only that connection. No firmware, pet-pack, device-setting, or microphone-upload writes are sent.

**Voice transcription is unavailable.** The stock puck's freeform input is voice; this adapter rejects voice requests and discards PCM. Text capture works only with compatible firmware or clients that emit the documented `turn.send` text message. Such messages have no firmware-provided capture ID: the bridge assigns a UUID before saving and reuses it for recent identical repeats during the connection. Durable forwarding retries reuse the stored UUID; the bridge cannot guarantee deduplication of a hardware message replayed after reconnecting. No capture starts a task.

The wire implementation follows the previously verified [OpenHarness cable source](https://github.com/autonomous-ai/openharness/tree/ce68e2fac27b8523c145f79d9d22f2ad7e589aad) and the GCH adapter. Its CRC/frame vectors, handshake failures, ownership checks, STOP, text capture, limits, and cable-loss handling are tested with fake ports. The pinned `serialport@13.0.0` dependency is MIT licensed. Physical USB operation and the user's firmware remain untested.

## Import an existing Harness JSONL export or TTY

Add this section for a saved export from your existing adapter:

```json
"harness": {
  "inputPath": "/Users/you/Exports/harness.jsonl",
  "maxRecords": 20,
  "readTimeoutMs": 5000
}
```

```sh
node scripts/synthos-companion/cli.mjs --config /absolute/companion.json harness-import
```

Each record uses the same JSONL format with `source: "harness"`; the producing adapter must supply a stable `sourceId` and `capturedAt`. A file import persists progress, so later invocations continue after saved captures and completed files are not reread. If the file changes, it is read from the beginning with the existing IDs used for deduplication. Keep exports below 3,276,800 bytes and 1,000 lines. Each invocation imports at most `maxRecords` (1–100), within its complete read deadline (up to 30 seconds).

For an already configured JSONL terminal stream, set the explicit `/dev/tty…`, `/dev/cu.…`, or `/dev/pts/…` path and `allowTty: true`. The adapter reads it without serial configuration or protocol writes; ensure exclusive ownership yourself. It closes only the reader process it launched when the deadline or record limit is reached. The default `allowTty: false` prevents opening a terminal accidentally.

This JSONL reader is for an existing export or adapter. For the stock binary puck port, use `harness-serial` above. The JSONL reader does not configure serial settings, perform the hardware handshake, or provide device controls.

## Capture thoughts from a G2 phone companion

Provide a separate random pairing credential of at least 32 characters in `SYNTHOS_G2_PAIRING_TOKEN`, using your existing secret manager. It must differ from the T3 bearer token. Add:

```json
"g2": { "port": 43800, "pairingTokenEnv": "SYNTHOS_G2_PAIRING_TOKEN" }
```

```sh
npm ci --ignore-scripts --no-audit --no-fund --prefix scripts/synthos-companion
npm run build:g2 --prefix scripts/synthos-companion
node scripts/synthos-companion/cli.mjs --config /absolute/companion.json g2-serve
```

The optional glasses adapter bundles the official MIT-licensed `@evenrealities/even_hub_sdk@0.0.16` locally, with its license included. The scoped package and lock file leave the T3 workspace dependencies unchanged. The SDK lists Even app 2.2.10 as its minimum version. No runtime CDN is used. Rebuild and restart the listener after updating the adapter. Phone capture remains available without the optional SDK bundle.

The capture page listens only at `http://127.0.0.1:43800`. Establish the equivalent private forward in your phone's existing SSH client:

```sh
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:43800:127.0.0.1:43800 user@companion-host
```

Keep both ports equal, then open `http://127.0.0.1:43800` in Even Hub or a phone browser and enter the separate pairing credential. The phone needs its own tunnel; a Mac's loopback address is not the phone's loopback address. Background suspension of the phone SSH client interrupts access until it reconnects. No public listener or signup is needed.

Pairing creates a one-hour HttpOnly session with capture, queue counts, STOP-forwarding, and signout access. It grants no resume, flush, task execution, T3 API, or host bearer access. There are at most four sessions and five pairing attempts per minute. Stopping the listener revokes its sessions. Keep the pairing credential in your secret manager; it is never included in URLs or page assets.

Type or dictate with the normal phone keyboard, then save for review. The page retains the same capture ID while retrying an uncertain save and keeps its text visible after a failure. Keep the page open until it confirms the save. A host `flush` may temporarily make the spool busy; retry after that operation finishes. Phone STOP persists the same forwarding stop as the CLI and cannot resume it.

For an existing Even Hub integration, the forwarding contract is a same-origin `POST /api/g2/capture` with the normal JSONL object's fields and `source: "g2"`, `Content-Type: application/json`, and the paired HttpOnly cookie. Generate a capture UUID and timestamp once, retain them for retries, and accept only a matching `sourceId` with `executionAllowed: false` in the response. No credential belongs in the capture. Only the host subsequently forwards it to authenticated T3.

After pairing your glasses normally in the Even app, choose **Connect glasses through Even Hub** on the capture page. The adapter requires the native phone bridge and a completed SDK device query. Browser preview, available phone bridge, and SDK-reported connected G2 glasses are distinct states. A page opening or SDK initialization alone does not establish attachment.

On the 576×288 glasses glance card, tap to refresh the actual queue count and forwarding state. Scroll to the STOP card and tap to persist STOP; scroll back to return to status. Double tap exits through the SDK. Device disconnect events clear the connected indication. SDK calls have three-second deadlines and the gesture queue is bounded to eight actions. The adapter does not access microphone audio, camera, location, task execution, or resume controls.

The integration follows the [official Even Hub templates](https://github.com/even-realities/evenhub-templates) and the previously verified GCH SDK bridge contract. Its handshake, display payloads, touch mapping, failure states, and cleanup are tested with a fake SDK; the locally bundled official SDK builds successfully. Physical pairing, actual display rendering, and a specific phone SSH client have not been tested.
