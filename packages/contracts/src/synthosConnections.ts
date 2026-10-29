import * as Schema from "effect/Schema";
import type { AuthEnvironmentScope } from "./auth.ts";

const ShortText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const Content = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200_000));
const Limit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }));

export const SynthosConnectionStatus = Schema.Struct({
  id: Schema.Literals(["agentmail", "mem", "obsidian", "harness", "fieldy", "g2"]),
  label: Schema.String,
  state: Schema.Literals(["unavailable", "configured", "companion"]),
  capabilities: Schema.Array(Schema.String),
  reason: Schema.String,
});
export type SynthosConnectionStatus = typeof SynthosConnectionStatus.Type;

export const SynthosMailEnvelope = Schema.Struct({
  inboxId: ShortText,
  to: Schema.Array(ShortText).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  subject: Schema.String.check(Schema.isMaxLength(998)),
  text: Content,
});
export type SynthosMailEnvelope = typeof SynthosMailEnvelope.Type;

export const SynthosMailDraft = Schema.Struct({
  id: Schema.String,
  envelope: SynthosMailEnvelope,
  contentHash: Schema.String,
  state: Schema.Literals(["prepared", "pending", "sent", "unknown", "rejected"]),
  messageId: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(Schema.String),
});
export type SynthosMailDraft = typeof SynthosMailDraft.Type;

export const SynthosDeviceIntake = Schema.Struct({
  source: Schema.Literals(["harness", "fieldy", "g2"]),
  sourceId: ShortText,
  title: ShortText,
  content: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(12_000)),
  capturedAt: ShortText,
});
export type SynthosDeviceIntake = typeof SynthosDeviceIntake.Type;

export const SynthosDeviceProposal = Schema.Struct({
  id: Schema.String,
  fingerprint: Schema.String,
  source: Schema.Literals(["harness", "fieldy", "g2"]),
  sourceId: Schema.String,
  title: Schema.String,
  body: Schema.String,
  capturedAt: Schema.String,
  status: Schema.Literal("proposed"),
  trust: Schema.Literal("untrusted-input"),
  executionAllowed: Schema.Literal(false),
});
export type SynthosDeviceProposal = typeof SynthosDeviceProposal.Type;

export const SynthosToolProbe = Schema.Struct({
  toolId: ShortText,
  state: Schema.Literals(["working", "failed"]),
  scope: Schema.Literal("cli_version"),
  checkedAt: Schema.String,
  executableFingerprint: Schema.NullOr(ShortText),
  reason: Schema.Literals([
    "completed",
    "nonzero_exit",
    "timeout",
    "output_limit",
    "spawn_failed",
    "missing",
    "unsupported",
  ]),
  exitCode: Schema.NullOr(Schema.Int),
  outputBytes: Schema.Int,
});
export type SynthosToolProbe = typeof SynthosToolProbe.Type;
export const SynthosToolProbeStatus = Schema.Struct({
  supported: Schema.Boolean,
  state: Schema.Literals(["unmeasured", "working", "failed", "stale"]),
  scope: Schema.Literal("cli_version"),
  observation: Schema.NullOr(SynthosToolProbe),
});
export type SynthosToolProbeStatus = typeof SynthosToolProbeStatus.Type;

export const SynthosConnectionCommand = Schema.Union([
  Schema.Struct({ type: Schema.Literal("status") }),
  Schema.Struct({ type: Schema.Literal("tools.inventory") }),
  Schema.Struct({ type: Schema.Literal("tools.probe"), toolId: ShortText }),
  Schema.Struct({
    type: Schema.Literal("mail.list"),
    inboxId: ShortText,
    limit: Schema.optionalKey(Limit),
    pageToken: Schema.optionalKey(ShortText),
  }),
  Schema.Struct({ type: Schema.Literal("mail.prepare"), ...SynthosMailEnvelope.fields }),
  Schema.Struct({ type: Schema.Literal("mail.send"), id: ShortText, contentHash: ShortText }),
  Schema.Struct({ type: Schema.Literal("mail.reconcile"), id: ShortText }),
  Schema.Struct({ type: Schema.Literal("mail.outbox") }),
  Schema.Struct({ type: Schema.Literal("mem.read"), noteId: ShortText }),
  Schema.Struct({
    type: Schema.Literal("mem.search"),
    query: ShortText,
    limit: Schema.optionalKey(Limit),
  }),
  Schema.Struct({
    type: Schema.Literal("mem.write"),
    noteId: Schema.optionalKey(ShortText),
    content: Content,
    expectedVersion: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  }),
  Schema.Struct({
    type: Schema.Literal("obsidian.list"),
    query: Schema.optionalKey(ShortText),
    limit: Schema.optionalKey(Limit),
  }),
  Schema.Struct({ type: Schema.Literal("obsidian.read"), path: ShortText }),
  Schema.Struct({
    type: Schema.Literal("obsidian.write"),
    path: ShortText,
    content: Content,
    expectedVersion: Schema.NullOr(ShortText),
  }),
  Schema.Struct({ type: Schema.Literal("device.intake"), ...SynthosDeviceIntake.fields }),
  Schema.Struct({ type: Schema.Literal("device.list") }),
]);
export type SynthosConnectionCommand = typeof SynthosConnectionCommand.Type;

export function synthosConnectionRequiredScope(
  command: SynthosConnectionCommand,
): AuthEnvironmentScope {
  if (command.type === "tools.probe") return "orchestration:operate";
  if (command.type === "obsidian.write") return "filesystem:write";
  if (command.type.startsWith("obsidian.")) return "filesystem:read";
  return ["mail.prepare", "mail.send", "mail.reconcile", "mem.write", "device.intake"].includes(
    command.type,
  )
    ? "orchestration:operate"
    : "orchestration:read";
}

export const SynthosNativeTool = Schema.Struct({
  probe: Schema.optionalKey(SynthosToolProbeStatus),
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  category: Schema.Literals([
    "code",
    "research",
    "assets",
    "operations",
    "planning",
    "markets",
    "time",
    "system",
    "memory",
    "connections",
  ]),
  interface: Schema.Literals(["cli", "tui", "desktop", "mcp"]),
  docs: Schema.String,
  commandName: Schema.NullOr(Schema.String),
  installed: Schema.Boolean,
  configuration: Schema.Literals(["configured", "unknown", "not_required"]),
  authentication: Schema.Literals(["not_checked", "not_required"]),
  availability: Schema.Literals(["installed", "missing", "external", "unsupported"]),
  activity: Schema.Literals(["running", "untracked"]),
  activeTerminals: Schema.Int,
  handoff: Schema.NullOr(
    Schema.Struct({ kind: Schema.Literal("terminal"), command: Schema.String }),
  ),
  reason: Schema.String,
});
export type SynthosNativeTool = typeof SynthosNativeTool.Type;

export const SynthosNativeToolInventory = Schema.Struct({
  tools: Schema.Array(SynthosNativeTool),
  checkedAt: Schema.String,
  activityObservedAt: Schema.NullOr(Schema.String),
});
export type SynthosNativeToolInventory = typeof SynthosNativeToolInventory.Type;

export const SynthosMemNote = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  content: Schema.String,
  version: Schema.Int,
  updatedAt: Schema.String,
  trashed: Schema.Boolean,
});
export type SynthosMemNote = typeof SynthosMemNote.Type;

export const SynthosConnectionResult = Schema.Union([
  Schema.Struct({ connections: Schema.Array(SynthosConnectionStatus) }),
  SynthosNativeToolInventory,
  Schema.Struct({ probe: SynthosToolProbe }),
  Schema.Struct({
    messages: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        threadId: Schema.String,
        from: Schema.String,
        to: Schema.Array(Schema.String),
        subject: Schema.String,
        preview: Schema.String,
        timestamp: Schema.String,
      }),
    ),
    nextPageToken: Schema.NullOr(Schema.String),
  }),
  SynthosMailDraft,
  Schema.Struct({ drafts: Schema.Array(SynthosMailDraft) }),
  SynthosMemNote,
  Schema.Struct({
    notes: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        title: Schema.String,
        snippet: Schema.String,
        updatedAt: Schema.String,
      }),
    ),
    truncated: Schema.Boolean,
  }),
  Schema.Struct({ path: Schema.String, content: Schema.String, version: Schema.String }),
  Schema.Struct({
    notes: Schema.Array(Schema.Struct({ path: Schema.String, title: Schema.String })),
    truncated: Schema.Boolean,
  }),
  Schema.Struct({ proposal: SynthosDeviceProposal, duplicate: Schema.Boolean }),
  Schema.Struct({ proposals: Schema.Array(SynthosDeviceProposal) }),
]);
export type SynthosConnectionResult = typeof SynthosConnectionResult.Type;

const CONNECTION_FAILURES = {
  unavailable: "This connection is not configured on this host.",
  forbidden: "This session cannot perform this connection operation.",
  invalid_input: "The connection request contains invalid input.",
  conflict: "The content changed. Read the latest version before saving or approving.",
  not_found: "The requested connection resource was not found.",
  response_invalid: "The connection returned an unsupported response.",
  response_too_large: "The connection response exceeds the size limit.",
  remote_rejected: "The connection rejected the request.",
  transport: "The connection could not be reached.",
  storage: "The connection state could not be saved.",
  unsafe_path: "The note path must stay within the configured vault and cannot use symbolic links.",
} as const;

export class SynthosConnectionError extends Schema.TaggedError<SynthosConnectionError>()(
  "SynthosConnectionError",
  {
    reason: Schema.Literals(
      Object.keys(CONNECTION_FAILURES) as Array<keyof typeof CONNECTION_FAILURES>,
    ),
    connection: Schema.String,
    status: Schema.optionalKey(Schema.Int),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return CONNECTION_FAILURES[this.reason];
  }
}
