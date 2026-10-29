import * as Schema from "effect/Schema";
import { ProjectId } from "./baseSchemas.ts";
import type { AuthEnvironmentScope } from "./auth.ts";
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024));
const Source = Schema.Literals(["synthome", "synthbrain"]);
const Provenance = Schema.Literals(["manual", "extracted", "inferred"]);
export const SynthosGraphNode = Schema.Struct({
  id: Text,
  source: Source,
  originalId: Text,
  label: Text,
  body: Schema.String.check(Schema.isMaxLength(12000)),
  kind: Text,
  ref: Text,
  revision: Text,
  sensitivity: Schema.Literals(["public", "private", "local_only"]),
  review: Text,
  provenance: Provenance,
});
export type SynthosGraphNode = typeof SynthosGraphNode.Type;
export const SynthosGraphEdge = Schema.Struct({
  id: Text,
  source: Text,
  target: Text,
  predicate: Text,
  directed: Schema.optionalKey(Schema.Boolean),
  provenance: Provenance,
  rationale: Text,
  reviewed: Schema.Boolean,
});
export type SynthosGraphEdge = typeof SynthosGraphEdge.Type;
export const SynthosGraphSnapshot = Schema.Struct({
  source: Source,
  revision: Text,
  partial: Schema.Boolean,
  nodes: Schema.Array(SynthosGraphNode).check(Schema.isMaxLength(5000)),
  edges: Schema.Array(SynthosGraphEdge).check(Schema.isMaxLength(20000)),
});
export type SynthosGraphSnapshot = typeof SynthosGraphSnapshot.Type;
export const SynthosGraphSettings = Schema.Struct({
  projectId: ProjectId,
  version: Schema.Int,
  enabledSources: Schema.Array(Source).check(Schema.isMaxLength(2)),
  approvedFolders: Schema.Array(Text).check(Schema.isMaxLength(100)),
  autoRecall: Schema.Boolean,
  pinned: Schema.Array(Text).check(Schema.isMaxLength(5)),
});
export type SynthosGraphSettings = typeof SynthosGraphSettings.Type;
export const SynthosBrainExport = Schema.Struct({
  nodes: Schema.Array(
    Schema.Struct({ id: Text, title: Text, group: Schema.optionalKey(Text) }),
  ).check(Schema.isMaxLength(5000)),
  links: Schema.Array(Schema.Struct({ source: Text, target: Text, value: Schema.Number })).check(
    Schema.isMaxLength(20000),
  ),
});
export type SynthosBrainExport = typeof SynthosBrainExport.Type;
export const SynthosGraphHistory = Schema.Array(
  Schema.Struct({ version: Schema.Int, revision: Text, operation: Text, actor: Text }),
);
export const SynthosGraphCommand = Schema.Union([
  Schema.Struct({ type: Schema.Literal("history"), projectId: ProjectId }),
  Schema.Struct({
    type: Schema.Literal("unalign"),
    projectId: ProjectId,
    expectedVersion: Schema.Int,
    id: Text,
    reason: Text,
  }),
  Schema.Struct({
    type: Schema.Literal("import_brain"),
    projectId: ProjectId,
    expectedVersion: Schema.Int,
    data: SynthosBrainExport,
  }),
  Schema.Struct({ type: Schema.Literal("settings"), projectId: ProjectId }),
  Schema.Struct({ type: Schema.Literal("configure"), settings: SynthosGraphSettings }),
  Schema.Struct({
    type: Schema.Literal("import"),
    projectId: ProjectId,
    expectedVersion: Schema.Int,
    snapshot: SynthosGraphSnapshot,
  }),
  Schema.Struct({
    type: Schema.Literal("refresh"),
    projectId: ProjectId,
    expectedVersion: Schema.Int,
    query: Schema.String.check(Schema.isMaxLength(300)),
    focusId: Schema.optionalKey(Text),
  }),
  Schema.Struct({
    type: Schema.Literal("explore"),
    workflowId: Schema.optionalKey(Text),
    projectId: ProjectId,
    query: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(300))),
    focusId: Schema.optionalKey(Text),
    targetId: Schema.optionalKey(Text),
    direction: Schema.optionalKey(Schema.Literals(["incoming", "outgoing", "both"])),
    hops: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 }))),
  }),
  Schema.Struct({
    type: Schema.Literal("align"),
    projectId: ProjectId,
    expectedVersion: Schema.Int,
    edge: SynthosGraphEdge,
  }),
  Schema.Struct({
    type: Schema.Literal("select"),
    workflowId: Schema.optionalKey(Text),
    projectId: ProjectId,
    expectedVersion: Schema.Int,
    ids: Schema.Array(Text).check(Schema.isMaxLength(5)),
  }),
]);
export type SynthosGraphCommand = typeof SynthosGraphCommand.Type;
export const SynthosGraphResult = Schema.Struct({
  history: Schema.optionalKey(SynthosGraphHistory),
  selection: Schema.optionalKey(Schema.Array(Text)),
  settings: SynthosGraphSettings,
  revision: Schema.String,
  nodes: Schema.Array(SynthosGraphNode),
  edges: Schema.Array(SynthosGraphEdge),
  partial: Schema.Boolean,
});
export type SynthosGraphResult = typeof SynthosGraphResult.Type;
export function synthosGraphRequiredScope(command: SynthosGraphCommand): AuthEnvironmentScope {
  return command.type === "settings" || command.type === "explore" || command.type === "history"
    ? "orchestration:read"
    : "orchestration:operate";
}
export class SynthosGraphError extends Schema.TaggedError<SynthosGraphError>()(
  "SynthosGraphError",
  {
    reason: Schema.Literals([
      "invalid",
      "forbidden",
      "not_found",
      "conflict",
      "unavailable",
      "storage",
    ]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message() {
    return `Graph operation failed: ${this.reason}.`;
  }
}
