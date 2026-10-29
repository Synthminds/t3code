import * as Schema from "effect/Schema";
import { ProjectId } from "./baseSchemas.ts";
import type { AuthEnvironmentScope } from "./auth.ts";

const Text = Schema.String.check(Schema.isMaxLength(1024));
const Paths = Schema.Array(Text).check(Schema.isMaxLength(100));
export const SynthosContextSettingsInput = Schema.Struct({
  autoRecall: Schema.Boolean,
  approvedNotes: Paths,
  projectFolders: Paths,
  neighborhoodFolders: Paths,
  pinnedNotes: Paths,
  excludedPaths: Paths,
});
export type SynthosContextSettingsInput = typeof SynthosContextSettingsInput.Type;
export const SynthosContextSettings = Schema.Struct({
  ...SynthosContextSettingsInput.fields,
  projectId: ProjectId,
  version: Schema.Int,
});
export type SynthosContextSettings = typeof SynthosContextSettings.Type;
export const SynthosContextSource = Schema.Struct({
  kind: Schema.Literals(["repository", "obsidian", "graph"]),
  path: Text,
  version: Text,
  tier: Schema.Literals([0, 1, 2]),
  reason: Text,
  excerpt: Schema.String,
  required: Schema.Boolean,
  graph: Schema.optionalKey(
    Schema.Struct({
      nodeId: Text,
      originalId: Text,
      source: Text,
      sourceRevision: Text,
      edgeIds: Schema.Array(Text),
      provenance: Text,
      review: Text,
      ref: Text,
    }),
  ),
});
export type SynthosContextSource = typeof SynthosContextSource.Type;
export const SynthosContextManifest = Schema.Struct({
  version: Schema.Literal(1),
  projectId: ProjectId,
  settingsVersion: Schema.Int,
  graphRevision: Schema.optionalKey(Schema.NullOr(Text)),
  workflowId: Schema.optionalKey(Text),
  role: Text,
  repositoryRevision: Schema.NullOr(Text),
  routes: Schema.Array(Text),
  sources: Schema.Array(SynthosContextSource),
  omissions: Schema.Array(Schema.Struct({ path: Text, reason: Text })),
  status: Schema.Literals(["ready", "degraded", "blocked"]),
  neighborhoodUsed: Schema.Boolean,
  query: Schema.String,
  bytes: Schema.Int,
  estimatedTokens: Schema.Int,
  hash: Text,
});
export type SynthosContextManifest = typeof SynthosContextManifest.Type;
export const SynthosContextCommand = Schema.Union([
  Schema.Struct({ type: Schema.Literal("get_settings"), projectId: ProjectId }),
  Schema.Struct({
    type: Schema.Literal("save_settings"),
    projectId: ProjectId,
    expectedVersion: Schema.Int,
    settings: SynthosContextSettingsInput,
  }),
  Schema.Struct({
    type: Schema.Literal("preview"),
    workflowId: Schema.optionalKey(Text),
    projectId: ProjectId,
    task: Schema.String.check(Schema.isMaxLength(12000)),
    role: Text,
  }),
]);
export type SynthosContextCommand = typeof SynthosContextCommand.Type;
export const SynthosContextResult = Schema.Union([
  Schema.Struct({ type: Schema.Literal("settings"), settings: SynthosContextSettings }),
  Schema.Struct({ type: Schema.Literal("preview"), manifest: SynthosContextManifest }),
]);
export type SynthosContextResult = typeof SynthosContextResult.Type;
export function synthosContextRequiredScope(command: SynthosContextCommand): AuthEnvironmentScope {
  return command.type === "save_settings" ? "orchestration:operate" : "orchestration:read";
}
export class SynthosContextError extends Schema.TaggedError<SynthosContextError>()(
  "SynthosContextError",
  {
    reason: Schema.Literals([
      "forbidden",
      "invalid",
      "not_found",
      "conflict",
      "storage",
      "source_changed",
    ]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message() {
    return `Context operation failed: ${this.reason}.`;
  }
}
