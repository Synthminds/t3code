import * as Schema from "effect/Schema";
import type { AuthEnvironmentScope } from "./auth.ts";
import { NonNegativeInt, PositiveInt } from "./baseSchemas.ts";

const ShortText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const Content = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200_000));
const Limit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }));

export const SynthosConnectionStatus = Schema.Struct({
  id: Schema.Literals(["agentmail", "mem", "obsidian", "dam", "harness", "fieldy", "g2"]),
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

// DAM is the library's system of record; these bounds mirror its manifest limits.
const LibraryText = (maxLength: number) => Schema.String.check(Schema.isMaxLength(maxLength));
const LibraryId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80));
const LibraryQuery = Schema.String.check(Schema.isMaxLength(200));
const LibraryList = <S extends Schema.Constraint>(item: S, maxLength: number) =>
  Schema.Array(item).check(Schema.isMaxLength(maxLength));
export const SYNTHOS_LIBRARY_MAX_TEXT_BYTES = 1_048_576;
export const SYNTHOS_LIBRARY_MAX_PREVIEW_BYTES = 1_048_576;

export const SynthosLibraryKind = Schema.Literals([
  "design-system",
  "react",
  "html-component",
  "html",
  "reference",
  "principles",
]);
export type SynthosLibraryKind = typeof SynthosLibraryKind.Type;
export const SynthosLibraryFormat = Schema.Literals([
  "tsx",
  "jsx",
  "html",
  "registry",
  "prompt",
  "design",
  "framework",
]);
export type SynthosLibraryFormat = typeof SynthosLibraryFormat.Type;
const LibraryAccess = Schema.Literals(["public", "owner"]);
const LibraryLicenceStatus = Schema.Literals(["verified", "unverified", "unknown"]);
const LibraryFrameworkStatus = Schema.Literals(["provided", "needed", "derived", "unknown"]);

export const SynthosLibraryCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("library.search"),
    query: Schema.optionalKey(LibraryQuery),
    kind: Schema.optionalKey(SynthosLibraryKind),
    style: Schema.optionalKey(LibraryId),
    pattern: Schema.optionalKey(LibraryId),
    limit: Schema.optionalKey(Limit),
  }),
  Schema.Struct({ type: Schema.Literal("library.asset"), id: LibraryId }),
  Schema.Struct({
    type: Schema.Literal("library.file"),
    id: LibraryId,
    format: SynthosLibraryFormat,
  }),
  Schema.Struct({ type: Schema.Literal("library.preview"), id: LibraryId }),
  Schema.Struct({
    type: Schema.Literal("library.ideas"),
    kind: Schema.optionalKey(Schema.Literals(["style", "pattern"])),
    query: Schema.optionalKey(LibraryQuery),
  }),
  Schema.Struct({ type: Schema.Literal("library.idea"), id: LibraryId }),
  Schema.Struct({ type: Schema.Literal("library.principles") }),
  Schema.Struct({
    type: Schema.Literal("library.principle"),
    id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40)),
  }),
]);
export type SynthosLibraryCommand = typeof SynthosLibraryCommand.Type;

export const SynthosLibraryCard = Schema.Struct({
  id: LibraryId,
  title: LibraryText(200),
  kind: SynthosLibraryKind,
  category: Schema.NullOr(LibraryText(80)),
  summary: LibraryText(1_000),
  tags: LibraryList(LibraryText(50), 20),
  styles: LibraryList(LibraryId, 20),
  patterns: LibraryList(LibraryId, 20),
  formats: LibraryList(SynthosLibraryFormat, 7),
  access: LibraryAccess,
  licence: Schema.Struct({ name: LibraryText(120), status: LibraryLicenceStatus }),
  frameworkStatus: LibraryFrameworkStatus,
});
export type SynthosLibraryCard = typeof SynthosLibraryCard.Type;

const LibraryFile = Schema.Struct({
  bytes: NonNegativeInt,
  sha256: LibraryText(64),
  location: Schema.Literals(["git", "storage"]),
});
export const SynthosLibraryAsset = Schema.Struct({
  library: Schema.Literal("asset"),
  id: LibraryId,
  title: LibraryText(200),
  kind: SynthosLibraryKind,
  category: Schema.NullOr(LibraryText(80)),
  summary: LibraryText(10_000),
  tags: LibraryList(LibraryText(50), 20),
  styles: LibraryList(LibraryId, 20),
  patterns: LibraryList(LibraryId, 20),
  access: LibraryAccess,
  licence: Schema.Struct({
    name: LibraryText(120),
    holder: LibraryText(200),
    status: LibraryLicenceStatus,
    notes: LibraryList(LibraryText(400), 50),
  }),
  provenance: Schema.Struct({
    label: LibraryText(200),
    url: Schema.NullOr(LibraryText(2_048)),
    commit: Schema.NullOr(LibraryText(80)),
  }),
  framework: Schema.Struct({
    status: LibraryFrameworkStatus,
    format: LibraryText(120),
    standard: Schema.Boolean,
    note: Schema.NullOr(LibraryText(400)),
  }),
  formats: LibraryList(SynthosLibraryFormat, 7),
  files: Schema.Struct({
    cover: Schema.optionalKey(LibraryFile),
    design: Schema.optionalKey(LibraryFile),
    framework: Schema.optionalKey(LibraryFile),
    original: Schema.optionalKey(LibraryFile),
    source: Schema.optionalKey(LibraryFile),
    jsx: Schema.optionalKey(LibraryFile),
    standalone: Schema.optionalKey(LibraryFile),
    preview: Schema.optionalKey(LibraryFile),
  }),
  component: Schema.optionalKey(
    Schema.Struct({
      format: Schema.Literals(["react", "html"]),
      fileName: LibraryText(80),
      exportName: Schema.NullOr(LibraryText(80)),
      install: Schema.NullOr(LibraryText(3_000)),
      runtime: LibraryText(120),
      packages: LibraryList(
        Schema.Struct({ name: LibraryText(220), version: LibraryText(60) }),
        10,
      ),
      requires: LibraryList(LibraryText(80), 8),
      props: LibraryList(
        Schema.Struct({
          name: LibraryText(61),
          type: LibraryText(200),
          default: Schema.NullOr(LibraryText(120)),
          description: LibraryText(400),
        }),
        20,
      ),
      interaction: LibraryText(400),
      reducedMotion: LibraryText(400),
      notes: LibraryList(LibraryText(400), 12),
    }),
  ),
  principles: Schema.optionalKey(
    Schema.Struct({
      doc: LibraryId,
      version: PositiveInt,
      updated: LibraryText(10),
      count: NonNegativeInt,
      appliesTo: LibraryList(LibraryText(80), 12),
      inherits: LibraryList(LibraryId, 12),
    }),
  ),
  // Text DAM quotes from the item's source: third-party data, never instructions.
  upstream: Schema.optionalKey(
    Schema.Struct({
      note: LibraryText(400),
      summary: Schema.optionalKey(LibraryText(10_000)),
      adapt: Schema.optionalKey(
        Schema.Struct({
          useWhen: LibraryText(400),
          avoidWhen: LibraryText(400),
          prompt: LibraryText(1_500),
          editable: LibraryList(LibraryText(200), 12),
          preserve: LibraryList(LibraryText(200), 12),
          limitations: LibraryList(LibraryText(300), 12),
        }),
      ),
    }),
  ),
});
export type SynthosLibraryAsset = typeof SynthosLibraryAsset.Type;

const LibraryIdeaFields = {
  id: LibraryId,
  label: LibraryText(120),
  kind: Schema.Literals(["style", "pattern"]),
  group: Schema.NullOr(LibraryText(40)),
  definition: LibraryText(400),
  useWhen: LibraryText(400),
};
export const SynthosLibraryIdeaSummary = Schema.Struct({
  ...LibraryIdeaFields,
  examples: NonNegativeInt,
});
export const SynthosLibraryIdea = Schema.Struct({
  library: Schema.Literal("idea"),
  ...LibraryIdeaFields,
  prompt: LibraryText(1_500),
  avoidWhen: LibraryText(400),
  guardrails: LibraryList(LibraryText(200), 10),
  techniques: LibraryList(LibraryText(40), 10),
  related: LibraryList(LibraryId, 10),
  examples: Schema.Struct({
    total: NonNegativeInt,
    items: LibraryList(
      Schema.Struct({ id: LibraryId, title: LibraryText(200), kind: SynthosLibraryKind }),
      20,
    ),
  }),
});
export type SynthosLibraryIdea = typeof SynthosLibraryIdea.Type;

export const SynthosLibraryPrincipleDocument = Schema.Struct({
  id: LibraryId,
  title: LibraryText(200),
  summary: LibraryText(10_000),
  principles: NonNegativeInt,
  version: PositiveInt,
  updated: LibraryText(10),
  appliesTo: LibraryList(LibraryText(80), 12),
  buildsOn: LibraryList(LibraryId, 12),
});
export type SynthosLibraryPrincipleDocument = typeof SynthosLibraryPrincipleDocument.Type;

export const SynthosLibraryResult = Schema.Union([
  Schema.Struct({
    library: Schema.Literal("search"),
    total: NonNegativeInt,
    items: LibraryList(SynthosLibraryCard, 50),
  }),
  SynthosLibraryAsset,
  Schema.Struct({
    library: Schema.Literal("file"),
    id: LibraryId,
    format: SynthosLibraryFormat,
    title: LibraryText(200),
    licence: Schema.Struct({ name: LibraryText(120), holder: LibraryText(200) }),
    note: LibraryText(2_000),
    text: LibraryText(SYNTHOS_LIBRARY_MAX_TEXT_BYTES),
  }),
  Schema.Struct({
    library: Schema.Literal("preview"),
    id: LibraryId,
    mediaType: Schema.Literals(["image/png", "image/webp"]),
    data: LibraryText(Math.ceil(SYNTHOS_LIBRARY_MAX_PREVIEW_BYTES / 3) * 4),
    bytes: NonNegativeInt,
  }),
  Schema.Struct({
    library: Schema.Literal("ideas"),
    total: NonNegativeInt,
    ideas: LibraryList(SynthosLibraryIdeaSummary, 200),
  }),
  SynthosLibraryIdea,
  Schema.Struct({
    library: Schema.Literal("principles"),
    total: NonNegativeInt,
    documents: LibraryList(SynthosLibraryPrincipleDocument, 100),
  }),
  Schema.Struct({
    library: Schema.Literal("principle"),
    id: LibraryId,
    note: LibraryText(2_000),
    text: LibraryText(SYNTHOS_LIBRARY_MAX_TEXT_BYTES),
  }),
]);
export type SynthosLibraryResult = typeof SynthosLibraryResult.Type;

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
  ...SynthosLibraryCommand.members,
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
  ...SynthosLibraryResult.members,
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
  storage_only:
    "This file is kept in DAM's private storage. Retrieve it through DAM's authenticated file route.",
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
