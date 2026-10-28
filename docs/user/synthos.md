# SynthOS Night Riders

SynthOS brings GCH's mission workflow into the Night Riders control room. **GCH** supplies the operating rules, model roles, budgets, verification requirements, and human decision gates. **T3 Code** supplies the projects, provider connections, threads, authentication, editor, and terminal. **SynthOS** brings those together with knowledge, mail, tools, and device intake.

GCH missions run inside this application, so you do not need to start the old GCH daemon separately. Use **Create mission** in SynthOS or the `gch synthos` commands below to enter that workflow. Ordinary T3 threads and commands entered directly in its terminal do not automatically enter the GCH mission controller.

## Desktop app

SynthOS also runs as a native desktop application through its Electron shell, with the same cockpit, editor, terminal, and GCH missions. The Apple silicon package includes the local server and uses a separate app identity and data directory from upstream T3. See the [macOS build guide](../operations/synthos-desktop.md) to produce this fork's DMG or ZIP. Signing and notarization are separate release steps; an unsigned package does not provide signed-app passkeys.

## Start this checkout

From the repository root, install [Vite+](https://viteplus.dev/guide/) and use the Node version required by the repository, then run:

```sh
vp i
vp run dev
```

Open the local URL printed by the development runner and complete pairing if prompted. Select **SynthOS** in the sidebar footer, or open `/synthos` on that same origin. Do not install the upstream `t3` package to obtain this fork.

New web and desktop clients start in **Midnight Protocol**, the shared blue, cyan, and pink palette for threads, settings, editor, and terminal. Existing saved theme choices remain intact; choose **Settings → Appearance → Midnight Protocol** to switch.

Use **Workspace** to return to T3 threads. The cockpit's **Thread uplink** opens the existing thread, with its editor and terminal. The environment selector chooses which host owns workflows, files, credentials, and device captures. Remote access uses the existing T3 connection and pairing system.

## Private remote access

For a private SSH forward, replace `HOST_WEB_PORT` with the web port printed by the development runner on the host:

```sh
ssh -N -L 3737:127.0.0.1:HOST_WEB_PORT user@host
```

Keep that connection open, then open `http://127.0.0.1:3737/synthos` on the client. Complete pairing through that forwarded origin. For LAN pairing and existing connection options, see [Remote access](./remote-access.md). The [background service guide](./background-service.md) describes the existing service lifecycle; use the CLI built from this checkout and do not update it from an upstream release channel.

## Create a mission

1. Create or select a project in the T3 workspace. Configure your installed providers under **Settings → Providers**.
2. Open **SynthOS → Cockpit**. Select the project and write the mission brief.
3. Bind the architect, construction, lead writer, and independent reviewer to models reported by the selected host. Additional scout and advisory bindings appear under **Scouts + advisory roles**. Display labels do not imply that a provider is installed, signed in, or qualified.
4. Enter the actual verification commands, one per line, and select **Create mission**. This saves a proposal without starting a provider turn.
5. Inspect the proposal, then select **Start workflow**. Real provider turns can consume your provider subscription or API allowance.
6. Bound optional roles run as sequential planning attempts: router, search, grep, docs, architect, then PM. Construction, verification, and independent review follow. Inspect **Workflow** for stage receipts and source threads. **Reconcile** reads the current T3 result and advances a completed stage. **Stop workflow** cancels the selected workflow. A blocked workflow shows its recorded reason.
7. Review the check and independent review evidence in **Decisions**. Approve the package, request a revision, reject it, or consult a bound advisor within its remaining budget.

The lead car and three motorcycles represent persistent roles. An assigned role is different from a dispatched attempt. Their activity derives from the selected workflow's recorded running attempt, and disconnects freeze execution motion. Camera, pause, and compact Focus view remain inspection controls. Reduced motion, hidden pages, and offscreen scenes suspend animation.

Approval creates a publication package bound to its evidence and candidate checkpoint. It does not itself establish a live publisher or claim that a remote branch, pull request, or deployment was published. Token usage that cannot be accounted for blocks progression rather than being treated as zero.

## Inspect GCH integration

Open the cockpit's **GCH** inspector or run `gch synthos policy` to inspect the server's policy source and integration limits. The read-only API is `GET /api/synthos/policy`, using an authenticated session with `orchestration:read`.

The pinned policy is **GCH 3.0 / rules 1.9**: every managed mission turn receives the complete **GCH 2.0.0 / rules 1.9** operating rules and a frozen role task packet. The 3.0 factory documents and earlier editions preserve the source lineage; conflicting historical rules are not loaded together. This build uses the **2026-10-13** source capture at GCH commit [`a11ebfb`](https://github.com/Synthminds/GCH/tree/a11ebfb89bbc7fcf9cb47df54454b66412ddeedc), not a live Google Drive sync. A mission retains its policy fingerprint; a changed policy blocks further dispatch on that mission.

The controller enforces persisted attempt and token reservations, bounded retries, immutable task packets, observed command results, candidate checks, and a separate human approval step. Missing token usage or failed verification blocks progression. Provider reservations limit admission of further work; they are not guaranteed hard spending caps inside a running provider.

Some GCH requirements still need enforcement beyond instructions: qualified worker guards and read-only boundaries, freezing test files before construction, construction proposals applied only by the lead, and live Jev/TypeSafe routing. T3's approval-required mode does not establish those guarantees. The current crew can edit its worktree directly. Autonomous publication and merging remain disabled; use the existing workspace controls to review and publish approved work.

## Connect knowledge and mail

Set configuration on the host running the server, through its process environment or the development checkout's gitignored `.env.local`, then restart the server. Never put credentials in the browser bundle.

| Variable                      | Connection                                               |
| ----------------------------- | -------------------------------------------------------- |
| `AGENTMAIL_API_KEY`           | AgentMail inbox and reviewed sending                     |
| `MEM_API_KEY`                 | Mem note search, reading, and writing                    |
| `SYNTHOS_OBSIDIAN_VAULT_ROOT` | Absolute path to the allowed Obsidian vault on that host |

**Configured** means the credential or vault root is present. Connectivity and access are checked when an operation runs.

In **Knowledge**, select Obsidian or Mem. List or search notes, open the full Markdown, and save changes. Mem updates include the loaded note version; Obsidian updates include the loaded content hash. If the source changed, reload it before saving. Obsidian access stays inside the configured vault and accepts Markdown files; symlink escapes are rejected.

In **Tools + mail**, the original 41-entry CLI supply catalog is searchable by capability and category. Its host inventory checks whether executables can be found, without running a probe or authenticating services. Open a cartridge to inspect its interface and availability. Copy its terminal handoff into the existing T3 workspace terminal; this handoff is untracked by the workflow and its Stop control. Installation does not light an activity indicator. A tool lights only when the host identifies its running child process in a T3 terminal; the deck refreshes while visible and clears activity on disconnect. Other terminal sessions remain untracked. The separate provider inventory reports provider installation, sign-in, and model availability. For AgentMail, enter the sender inbox ID, recipients, subject, and body, then select **Prepare exact preview**. Inspect the complete envelope before **Send approved message**. Delivery receipts distinguish prepared, pending, sent, and unknown outcomes. An unknown outcome must be reconciled before preparing a replacement; it is not proof of failure.

## Device review inbox

**Devices** accepts manual Harness, Fieldy, and Even Realities G2 captures with a source reference, title, and content. Captures are stored as untrusted proposals with execution disabled. These controls do not claim that a live USB bridge, Fieldy polling account, or G2 phone companion is connected. Those hardware and companion transports require separate qualification. The original T3 [device guide](./devices.md) covers its separate iOS Simulator and Android Emulator workspace panel.

## Current verification limits

The responsive cockpit is implemented for the web and the desktop's shared web surface. Native mobile customization is deferred. Provider API calls, actual email delivery, Mem credentials, vault access, and physical devices must be qualified with the intended host and credentials. Availability shown in the interface is based on observed host state, not placeholder model names or fabricated live activity.

## Control workflows from the CLI

Use the `gch` binary from this fork with a running SynthOS server. These commands use the same authenticated API and saved workflows as the cockpit; they do not start another workflow runtime. Each prints JSON. Add `--base-dir <directory>` when the server uses an explicit data directory.

```sh
gch synthos policy
gch synthos list
gch synthos get mission-1
gch synthos create mission.json
gch synthos command mission-1 command.json
gch synthos connection connection.json
gch synthos knowledge knowledge.json
```

`create` saves a proposal only. Put a real project ID and provider/model IDs from the host's inventory into `mission.json`, for example:

```json
{
  "commandId": "create:mission-1",
  "workflowId": "mission-1",
  "projectId": "YOUR_PROJECT_ID",
  "title": "Verify a scoped change",
  "task": "Describe the intended change and acceptance criteria.",
  "bindings": [
    {
      "role": "architect",
      "modelSelection": { "instanceId": "YOUR_PROVIDER_ID", "model": "YOUR_MODEL_ID" },
      "inputTokenLimit": 40000,
      "outputTokenLimit": 8000
    },
    {
      "role": "crew",
      "modelSelection": { "instanceId": "YOUR_PROVIDER_ID", "model": "YOUR_MODEL_ID" },
      "inputTokenLimit": 40000,
      "outputTokenLimit": 8000
    },
    {
      "role": "lead",
      "modelSelection": { "instanceId": "YOUR_PROVIDER_ID", "model": "YOUR_MODEL_ID" },
      "inputTokenLimit": 40000,
      "outputTokenLimit": 8000
    },
    {
      "role": "reviewer",
      "modelSelection": { "instanceId": "YOUR_PROVIDER_ID", "model": "YOUR_MODEL_ID" },
      "inputTokenLimit": 40000,
      "outputTokenLimit": 8000
    }
  ],
  "checkCommands": ["YOUR_VERIFICATION_COMMAND"]
}
```

Starting work requires an explicit command and can consume provider allowance. Read the workflow's current revision, then put it in `command.json`:

```json
{ "commandId": "start:mission-1", "expectedRevision": 0, "action": "start" }
```

Supported actions are `start`, `reconcile`, `retry`, `approve`, `revise`, `reject`, `cancel`, and `advisor`. Use a new `commandId` for each new action and the current `expectedRevision`; the server enforces the allowed transition and remaining budget. Files must be regular UTF-8 JSON, at most 128 KiB, and match the request schema. Unknown fields and actions are rejected.

For scripts that may retry requests, keep a stable credential in `GCH_AUTH_TOKEN`. Issue a scoped session through the existing auth command without printing its token:

```sh
export GCH_AUTH_TOKEN="$(gch auth session issue --scope orchestration:read --scope orchestration:operate --scope source-control:write --ttl 1h --token-only)"
```

Use the same `--base-dir` for token issuance and workflow commands when needed. Workflow reads need `orchestration:read`; workflow mutations need `orchestration:operate`, and approval also needs `source-control:write`. Omit scopes your script does not need. Treat the token as a secret.

Without `GCH_AUTH_TOKEN`, each invocation creates and revokes a temporary local session with only the scopes needed for that action. Repeating an earlier mutation's `commandId` under a different session is an idempotency conflict. After a timeout, inspect the saved workflow before retrying: preserve both the original JSON and credential so the server can replay its receipt without dispatching duplicate work.

`connection` sends a `SynthosConnectionCommand` through the shared knowledge, mail, devices, and inventory API. Save one request in `connection.json`, for example:

```json
{ "type": "tools.inventory" }
```

Other read requests include `{ "type": "status" }`, `{ "type": "mem.search", "query": "mission" }`, `{ "type": "obsidian.read", "path": "Notes/Mission.md" }`, and `{ "type": "device.list" }`. Obsidian requires `filesystem:read` or `filesystem:write`; other connection reads require `orchestration:read`, and Mem writes, mail changes, and device intake require `orchestration:operate`. Inventory includes terminal activity only when the credential also has `terminal:read`. An explicitly supplied token must contain these scopes; the CLI does not expand it.

Mail preparation, sending, outbox reads, and reconciliation require `GCH_AUTH_TOKEN` because the server binds drafts to that session. Prepare with a JSON file containing `type: "mail.prepare"`, `inboxId`, `to`, `subject`, and `text`. Inspect the returned envelope, then send a separate request containing `type: "mail.send"` and the exact returned `id` and `contentHash`. Keep the same credential for both requests. To check an ambiguous outcome, use `{ "type": "mail.reconcile", "id": "RETURNED_DRAFT_ID" }`; do not prepare a replacement merely because a request timed out.

Knowledge writes retain the server's conflict checks: an `obsidian.write` request includes the loaded `expectedVersion` hash (or `null` when creating a new note), while an existing Mem note update includes `expectedVersion`. Device intake remains an untrusted proposal and does not execute a workflow.

`knowledge` uses the environment's shared semantic graph. A read request can be `{ "type": "graph", "limit": 40 }` or `{ "type": "history", "entity": "node", "id": "decision:example" }`. Node and edge writes use `node.upsert` and `edge.upsert`, with provenance, rationale, source references, and `expectedVersion` (`null` for a new entity). Corrections preserve version history; deletions also require the current version and a reason. Graph and history reads require `orchestration:read`; changes require `orchestration:operate`. These records are shared by authorized sessions on that environment, so a temporary CLI session can use them.

In the cockpit, **Knowledge graph** is the default Knowledge view; **Source notes** opens Mem and Obsidian. Every graph node needs a typed source reference and a rationale.

To restore a deleted graph record after leaving the view, use `gch synthos knowledge history.json` with a `history` request for its ID. Submit `node.upsert` or `edge.upsert` using the editable fields from its last live revision, the latest deleted revision's version as `expectedVersion`, and a `correctionReason` explaining the restoration. Copy the input fields only; server metadata such as `ownerId`, `version`, `deleted`, and timestamps is not accepted inside the node or edge input. An edge can be restored only when both endpoint nodes exist and are active.

## Source and policy provenance

The Night Riders scene, vehicle geometry, and brand direction originate from the sibling GCH project: [PRODUCT.md](https://github.com/Synthminds/GCH/blob/a11ebfb89bbc7fcf9cb47df54454b66412ddeedc/PRODUCT.md), [DESIGN.md](https://github.com/Synthminds/GCH/blob/a11ebfb89bbc7fcf9cb47df54454b66412ddeedc/DESIGN.md), and [vehicle provenance](../../apps/web/public/synthos/vehicles/asset-provenance.json). The source [principles](https://github.com/Synthminds/GCH/blob/a11ebfb89bbc7fcf9cb47df54454b66412ddeedc/docs/PRINCIPLES.md) document the inherited control rules and gaps in historical source material. This fork preserves T3 Code's upstream license and attribution.

Verification requires numeric exit receipts for the configured commands. Providers that do not expose those receipts, including the current Claude command adapter, remain unqualified for the lead verification role; the workflow holds at that evidence gate.
